package oidc

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// fakeIdP serves an OIDC discovery doc + JWKS for one RSA key, and signs tokens.
type fakeIdP struct {
	srv *httptest.Server
	key *rsa.PrivateKey
	kid string
	iss string
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{key: key, kid: "test-kid-1"}
	mux := http.NewServeMux()
	f.srv = httptest.NewServer(mux)
	f.iss = f.srv.URL
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": f.iss, "jwks_uri": f.iss + "/jwks"})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]any{{"kty": "RSA", "use": "sig", "kid": f.kid, "n": n, "e": e}},
		})
	})
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIdP) sign(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = f.kid
	s, err := tok.SignedString(f.key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestVerifyIDToken_Valid(t *testing.T) {
	f := newFakeIdP(t)
	p := New(Config{Issuer: f.iss, ClientID: "windrose-web"})
	raw := f.sign(t, jwt.MapClaims{
		"iss": f.iss, "aud": "windrose-web", "sub": "kc-sub-123",
		"email": "ann@x.com", "name": "Ann A", "exp": time.Now().Add(time.Hour).Unix(),
	})
	id, err := p.VerifyIDToken(context.Background(), raw)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if id.Subject != "kc-sub-123" || id.Email != "ann@x.com" || id.Name != "Ann A" {
		t.Fatalf("normalized identity = %+v", id)
	}
}

func TestVerifyIDToken_Rejects(t *testing.T) {
	f := newFakeIdP(t)
	p := New(Config{Issuer: f.iss, ClientID: "windrose-web"})
	cases := map[string]jwt.MapClaims{
		"wrong_aud":  {"iss": f.iss, "aud": "someone-else", "sub": "s", "exp": time.Now().Add(time.Hour).Unix()},
		"wrong_iss":  {"iss": "https://evil.example", "aud": "windrose-web", "sub": "s", "exp": time.Now().Add(time.Hour).Unix()},
		"expired":    {"iss": f.iss, "aud": "windrose-web", "sub": "s", "exp": time.Now().Add(-time.Hour).Unix()},
		"no_subject": {"iss": f.iss, "aud": "windrose-web", "exp": time.Now().Add(time.Hour).Unix()},
	}
	for name, claims := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := p.VerifyIDToken(context.Background(), f.sign(t, claims)); err == nil {
				t.Fatalf("expected rejection for %s", name)
			}
		})
	}
}

func TestVerifyIDToken_RejectsUnknownKid(t *testing.T) {
	f := newFakeIdP(t)
	// A token signed by a DIFFERENT key must not verify against the IdP's JWKS.
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss": f.iss, "aud": "windrose-web", "sub": "s", "exp": time.Now().Add(time.Hour).Unix(),
	})
	tok.Header["kid"] = f.kid // claims the real kid but signs with the wrong key
	raw, _ := tok.SignedString(other)
	p := New(Config{Issuer: f.iss, ClientID: "windrose-web"})
	if _, err := p.VerifyIDToken(context.Background(), raw); err == nil {
		t.Fatal("expected signature-verification failure")
	}
}
