// Package oidc is the generic OpenID-Connect IdentityProvider adapter (BYO-P4).
// It does OIDC discovery (.well-known/openid-configuration) to locate the JWKS,
// caches the signing keys with a bounded refresh, and verifies an ID token's
// RS256 signature + iss/aud/exp — the same shape go-common/authjwt uses for the
// platform's OWN tokens, but reading the OIDC-standard claim set (no tenant_id).
// Keycloak, Okta, Auth0 and Entra are all just a Config of this one adapter —
// no per-vendor code (the design's "Keycloak becomes one config of the generic
// path", increment 5).
package oidc

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// Config configures a generic OIDC provider. DiscoveryURL defaults to
// Issuer + "/.well-known/openid-configuration".
type Config struct {
	Issuer       string
	ClientID     string // expected `aud`
	DiscoveryURL string
}

// Provider is the generic OIDC IdentityProvider (implements domain.IdentityProvider).
type Provider struct {
	cfg    Config
	client *http.Client

	mu        sync.RWMutex
	jwksURL   string
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
	refresh   time.Duration
	leeway    time.Duration
}

// New builds a generic OIDC provider. Discovery + JWKS are fetched lazily on
// the first verification so construction never blocks on the IdP being up.
func New(cfg Config) *Provider {
	if cfg.DiscoveryURL == "" && cfg.Issuer != "" {
		cfg.DiscoveryURL = strings.TrimRight(cfg.Issuer, "/") + "/.well-known/openid-configuration"
	}
	return &Provider{
		cfg:     cfg,
		client:  &http.Client{Timeout: 5 * time.Second},
		refresh: 5 * time.Minute,
		leeway:  60 * time.Second,
	}
}

// Issuer returns the trusted issuer.
func (p *Provider) Issuer() string { return p.cfg.Issuer }

var _ domain.IdentityProvider = (*Provider)(nil)

// VerifyIDToken validates an OIDC ID token and returns the normalized identity.
func (p *Provider) VerifyIDToken(ctx context.Context, raw string) (*domain.NormalizedIdentity, error) {
	claims := jwt.MapClaims{}
	opts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{"RS256"}), // alg=none / HS* rejected
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(p.leeway),
	}
	if p.cfg.Issuer != "" {
		opts = append(opts, jwt.WithIssuer(p.cfg.Issuer))
	}
	if p.cfg.ClientID != "" {
		opts = append(opts, jwt.WithAudience(p.cfg.ClientID))
	}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return p.keyFor(ctx, kid)
	}, opts...)
	if err != nil {
		return nil, fmt.Errorf("oidc: verify id_token: %w", err)
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return nil, errors.New("oidc: id_token missing sub")
	}
	email, _ := claims["email"].(string)
	name, _ := claims["name"].(string)
	if name == "" {
		name, _ = claims["preferred_username"].(string)
	}
	return &domain.NormalizedIdentity{Subject: sub, Email: email, Name: name, Claims: claims}, nil
}

func (p *Provider) keyFor(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	p.mu.RLock()
	key, ok := p.keys[kid]
	fresh := time.Since(p.fetchedAt) < p.refresh
	p.mu.RUnlock()
	if ok && fresh {
		return key, nil
	}
	if err := p.refreshKeys(ctx); err != nil {
		if ok {
			return key, nil // a stale key beats an IdP outage
		}
		return nil, err
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	if key, ok = p.keys[kid]; !ok {
		return nil, fmt.Errorf("oidc: unknown signing key %q", kid)
	}
	return key, nil
}

// refreshKeys resolves the jwks_uri via discovery (once) then fetches the JWKS.
func (p *Provider) refreshKeys(ctx context.Context) error {
	jwksURL := p.jwksURL
	if jwksURL == "" {
		u, err := p.discoverJWKS(ctx)
		if err != nil {
			return err
		}
		jwksURL = u
	}
	keys, err := p.fetchJWKS(ctx, jwksURL)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.jwksURL = jwksURL
	p.keys = keys
	p.fetchedAt = time.Now()
	p.mu.Unlock()
	return nil
}

func (p *Provider) discoverJWKS(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.cfg.DiscoveryURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("oidc: discovery status %d", resp.StatusCode)
	}
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return "", err
	}
	if doc.JWKSURI == "" {
		return "", errors.New("oidc: discovery document has no jwks_uri")
	}
	// Defend against a discovery doc that claims a different issuer than we trust.
	if p.cfg.Issuer != "" && doc.Issuer != "" && doc.Issuer != p.cfg.Issuer {
		return "", fmt.Errorf("oidc: discovery issuer %q != configured %q", doc.Issuer, p.cfg.Issuer)
	}
	return doc.JWKSURI, nil
}

func (p *Provider) fetchJWKS(ctx context.Context, jwksURL string) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidc: jwks status %d", resp.StatusCode)
	}
	var doc struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			Use string `json:"use"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "RSA" || (k.Use != "" && k.Use != "sig") {
			continue
		}
		nb, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		eb, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: int(new(big.Int).SetBytes(eb).Int64())}
	}
	if len(keys) == 0 {
		return nil, errors.New("oidc: jwks had no usable RSA signing keys")
	}
	return keys, nil
}
