package fhirclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// attachAuth sets the request's Authorization per the backend's auth_method.
// Secret material is read from Vault at call time (never cached to disk, never
// stored in Postgres); minted OAuth2/SMART access tokens are cached in-memory
// per backend id until expiry−60s.
func (c *Client) attachAuth(ctx context.Context, req *http.Request, be Backend) error {
	switch be.AuthMethod {
	case "", "none":
		return nil
	case "bearer":
		sec, err := c.secret(ctx, be)
		if err != nil {
			return err
		}
		tok := sec["token"]
		if tok == "" {
			return fmt.Errorf("backend %s: vault secret missing key %q", be.ID, "token")
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		return nil
	case "basic":
		sec, err := c.secret(ctx, be)
		if err != nil {
			return err
		}
		if sec["username"] == "" || sec["password"] == "" {
			return fmt.Errorf("backend %s: vault secret missing username/password", be.ID)
		}
		req.SetBasicAuth(sec["username"], sec["password"])
		return nil
	case "oauth2_client_credentials", "smart_backend_services":
		tok, err := c.tokenFor(ctx, be)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		return nil
	default:
		return fmt.Errorf("backend %s: unsupported auth_method %q", be.ID, be.AuthMethod)
	}
}

func (c *Client) secret(ctx context.Context, be Backend) (map[string]string, error) {
	if c.Secrets == nil {
		return nil, fmt.Errorf("secret store not configured")
	}
	sec, err := c.Secrets.Get(ctx, be.VaultRef)
	if err != nil {
		return nil, fmt.Errorf("backend %s: read vault ref: %w", be.ID, err)
	}
	return sec, nil
}

// tokenFor returns a cached or freshly minted access token for the backend.
func (c *Client) tokenFor(ctx context.Context, be Backend) (string, error) {
	c.mu.Lock()
	if t, ok := c.tokens[be.ID]; ok && c.now().Before(t.expiry) {
		c.mu.Unlock()
		return t.token, nil
	}
	c.mu.Unlock()

	tok, expiresIn, err := c.mintToken(ctx, be)
	if err != nil {
		return "", err
	}
	// Cache until expiry−60s; sub-60s tokens are simply not cached.
	if ttl := time.Duration(expiresIn)*time.Second - 60*time.Second; ttl > 0 {
		c.mu.Lock()
		c.tokens[be.ID] = cachedToken{token: tok, expiry: c.now().Add(ttl)}
		c.mu.Unlock()
	}
	return tok, nil
}

func (c *Client) mintToken(ctx context.Context, be Backend) (string, int64, error) {
	if be.TokenURL == "" {
		return "", 0, fmt.Errorf("backend %s: auth_method %s requires token_url", be.ID, be.AuthMethod)
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	if be.Scopes != "" {
		form.Set("scope", be.Scopes)
	}
	sec, err := c.secret(ctx, be)
	if err != nil {
		return "", 0, err
	}
	switch be.AuthMethod {
	case "oauth2_client_credentials":
		if sec["client_secret"] == "" {
			return "", 0, fmt.Errorf("backend %s: vault secret missing client_secret", be.ID)
		}
		form.Set("client_id", be.ClientID)
		form.Set("client_secret", sec["client_secret"])
	case "smart_backend_services":
		assertion, err := c.smartAssertion(be, sec)
		if err != nil {
			return "", 0, err
		}
		form.Set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer")
		form.Set("client_assertion", assertion)
	default:
		return "", 0, fmt.Errorf("mintToken called for auth_method %q", be.AuthMethod)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, be.TokenURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("backend %s: token endpoint: %w", be.ID, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", 0, err
	}
	if resp.StatusCode != http.StatusOK {
		// Deliberately status-only: token error bodies can echo request detail.
		return "", 0, fmt.Errorf("backend %s: token endpoint status %d", be.ID, resp.StatusCode)
	}
	var tr struct {
		AccessToken string  `json:"access_token"`
		ExpiresIn   float64 `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &tr); err != nil {
		return "", 0, fmt.Errorf("backend %s: token endpoint: decode: %w", be.ID, err)
	}
	if tr.AccessToken == "" {
		return "", 0, fmt.Errorf("backend %s: token endpoint returned no access_token", be.ID)
	}
	return tr.AccessToken, int64(tr.ExpiresIn), nil
}

// smartAssertion builds the SMART Backend Services (RFC 7523) client
// assertion: an RS384 JWS with iss=sub=client_id, aud=token_url, exp=now+4m,
// jti=random, signed with the tenant's registered private key from Vault.
func (c *Client) smartAssertion(be Backend, sec map[string]string) (string, error) {
	pem := sec["private_key_pem"]
	if pem == "" {
		return "", fmt.Errorf("backend %s: vault secret missing private_key_pem", be.ID)
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(pem))
	if err != nil {
		return "", fmt.Errorf("backend %s: parse private_key_pem: %w", be.ID, err)
	}
	now := c.now()
	claims := jwt.MapClaims{
		"iss": be.ClientID,
		"sub": be.ClientID,
		"aud": be.TokenURL,
		"iat": now.Unix(),
		"exp": now.Add(4 * time.Minute).Unix(),
		"jti": uuid.NewString(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS384, claims)
	if kid := sec["kid"]; kid != "" {
		tok.Header["kid"] = kid
	}
	return tok.SignedString(key)
}
