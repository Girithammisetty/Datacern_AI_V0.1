package fhirclient

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// fakeSecrets is the unit-tier SecretStore double (never reachable from cmd/).
type fakeSecrets map[string]map[string]string

func (f fakeSecrets) Get(_ context.Context, path string) (map[string]string, error) {
	if m, ok := f[path]; ok {
		return m, nil
	}
	return nil, errors.New("secret not found: " + path)
}

func newBackend(baseURL, method string) Backend {
	return Backend{ID: "be-1", BaseURL: baseURL, AuthMethod: method, VaultRef: "secret/data/t/x"}
}

func TestReadMethodPathHeaders(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/fhir/Patient/abc-123" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Accept"); got != "application/fhir+json" {
			t.Errorf("Accept = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("auth_method none must send no Authorization, got %q", got)
		}
		_, _ = w.Write([]byte(`{"resourceType":"Patient","id":"abc-123"}`))
	}))
	defer srv.Close()
	c := New(fakeSecrets{})
	resp, err := c.Read(context.Background(), newBackend(srv.URL+"/fhir/", "none"), "Patient", "abc-123")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if resp.Status != 200 || !strings.Contains(string(resp.Body), `"Patient"`) {
		t.Fatalf("resp = %d %s", resp.Status, resp.Body)
	}
}

func TestSearchEncodesParamsAndBearer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Observation" {
			t.Errorf("path = %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("patient") != "p/1" || q.Get("code") != "1234-5" {
			t.Errorf("query = %v", r.URL.RawQuery)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer vault-token" {
			t.Errorf("Authorization = %q", got)
		}
		_, _ = w.Write([]byte(`{"resourceType":"Bundle","total":0}`))
	}))
	defer srv.Close()
	c := New(fakeSecrets{"secret/data/t/x": {"token": "vault-token"}})
	resp, err := c.Search(context.Background(), newBackend(srv.URL, "bearer"), "Observation",
		map[string]string{"patient": "p/1", "code": "1234-5"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("status = %d", resp.Status)
	}
}

func TestCreateSendsBodyAndBasicAuth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/Patient" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/fhir+json" {
			t.Errorf("Content-Type = %q", got)
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "u" || pass != "p" {
			t.Errorf("basic auth = %q %q %v", user, pass, ok)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["resourceType"] != "Patient" {
			t.Errorf("body = %v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"resourceType":"Patient","id":"new"}`))
	}))
	defer srv.Close()
	c := New(fakeSecrets{"secret/data/t/x": {"username": "u", "password": "p"}})
	resp, err := c.Create(context.Background(), newBackend(srv.URL, "basic"), "Patient",
		[]byte(`{"resourceType":"Patient"}`))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if resp.Status != 201 {
		t.Fatalf("status = %d", resp.Status)
	}
}

func TestUpdatePut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/Patient/p1" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"resourceType":"Patient","id":"p1"}`))
	}))
	defer srv.Close()
	c := New(fakeSecrets{})
	if _, err := c.Update(context.Background(), newBackend(srv.URL, "none"), "Patient", "p1",
		[]byte(`{"resourceType":"Patient","id":"p1"}`)); err != nil {
		t.Fatalf("Update: %v", err)
	}
}

func TestOAuth2ClientCredentialsMintAndCache(t *testing.T) {
	tokenCalls := 0
	var tokenSrv *httptest.Server
	tokenSrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenCalls++
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.PostForm.Get("grant_type") != "client_credentials" ||
			r.PostForm.Get("client_id") != "cid" ||
			r.PostForm.Get("client_secret") != "csecret" ||
			r.PostForm.Get("scope") != "system/*.read" {
			t.Errorf("token form = %v", r.PostForm)
		}
		_, _ = w.Write([]byte(`{"access_token":"minted-1","expires_in":3600,"token_type":"bearer"}`))
	}))
	defer tokenSrv.Close()
	fhirSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer minted-1" {
			t.Errorf("Authorization = %q", got)
		}
		_, _ = w.Write([]byte(`{"resourceType":"Patient"}`))
	}))
	defer fhirSrv.Close()

	be := Backend{ID: "be-oauth", BaseURL: fhirSrv.URL, AuthMethod: "oauth2_client_credentials",
		TokenURL: tokenSrv.URL, ClientID: "cid", Scopes: "system/*.read", VaultRef: "secret/data/t/x"}
	c := New(fakeSecrets{"secret/data/t/x": {"client_secret": "csecret"}})
	for i := 0; i < 3; i++ {
		if _, err := c.Read(context.Background(), be, "Patient", "p1"); err != nil {
			t.Fatalf("Read #%d: %v", i, err)
		}
	}
	if tokenCalls != 1 {
		t.Fatalf("token endpoint called %d times, want 1 (cache until expiry-60s)", tokenCalls)
	}
}

func TestSMARTBackendServicesAssertion(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	var tokenURL string
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.PostForm.Get("grant_type") != "client_credentials" {
			t.Errorf("grant_type = %q", r.PostForm.Get("grant_type"))
		}
		if got := r.PostForm.Get("client_assertion_type"); got != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" {
			t.Errorf("client_assertion_type = %q", got)
		}
		if r.PostForm.Get("scope") != "system/*.read" {
			t.Errorf("scope = %q", r.PostForm.Get("scope"))
		}
		assertion := r.PostForm.Get("client_assertion")
		tok, err := jwt.Parse(assertion, func(tk *jwt.Token) (any, error) {
			if tk.Method.Alg() != "RS384" {
				t.Errorf("alg = %s, want RS384", tk.Method.Alg())
			}
			if kid, _ := tk.Header["kid"].(string); kid != "key-1" {
				t.Errorf("kid = %q", kid)
			}
			return &key.PublicKey, nil
		}, jwt.WithValidMethods([]string{"RS384"}), jwt.WithAudience(tokenURL),
			jwt.WithIssuer("smart-client"), jwt.WithExpirationRequired())
		if err != nil || !tok.Valid {
			t.Errorf("client_assertion invalid: %v", err)
		}
		claims, _ := tok.Claims.(jwt.MapClaims)
		if claims["sub"] != "smart-client" {
			t.Errorf("sub = %v, want iss=sub=client_id", claims["sub"])
		}
		if claims["jti"] == "" || claims["jti"] == nil {
			t.Error("jti must be set")
		}
		_, _ = w.Write([]byte(`{"access_token":"smart-token","expires_in":300}`))
	}))
	defer tokenSrv.Close()
	tokenURL = tokenSrv.URL

	fhirSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer smart-token" {
			t.Errorf("Authorization = %q", got)
		}
		_, _ = w.Write([]byte(`{"resourceType":"Bundle"}`))
	}))
	defer fhirSrv.Close()

	be := Backend{ID: "be-smart", BaseURL: fhirSrv.URL, AuthMethod: "smart_backend_services",
		TokenURL: tokenSrv.URL, ClientID: "smart-client", Scopes: "system/*.read", VaultRef: "secret/data/t/x"}
	c := New(fakeSecrets{"secret/data/t/x": {"private_key_pem": string(keyPEM), "kid": "key-1"}})
	if _, err := c.Search(context.Background(), be, "Observation", nil); err != nil {
		t.Fatalf("Search: %v", err)
	}
}

func TestResponseSizeCap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		big := make([]byte, MaxResponseBytes+1024)
		for i := range big {
			big[i] = 'x'
		}
		_, _ = w.Write(big)
	}))
	defer srv.Close()
	c := New(fakeSecrets{})
	if _, err := c.Read(context.Background(), newBackend(srv.URL, "none"), "Patient", "p1"); err != ErrResponseTooLarge {
		t.Fatalf("err = %v, want ErrResponseTooLarge", err)
	}
}

func TestResourceValidationRejectsTraversal(t *testing.T) {
	c := New(fakeSecrets{})
	be := newBackend("http://127.0.0.1:1", "none")
	bad := [][2]string{
		{"../admin", "p1"},
		{"Patient/..", "p1"},
		{"Pat ient", "p1"},
		{"", "p1"},
		{"Patient", "../../etc/passwd"},
		{"Patient", "a/b"},
		{"Patient", "p?x=1"},
		{"Patient", ""},
	}
	for _, tc := range bad {
		if _, err := c.Read(context.Background(), be, tc[0], tc[1]); err == nil {
			t.Errorf("Read(%q, %q) must reject", tc[0], tc[1])
		}
	}
	if !ValidResourceType("Patient") || !ValidResourceID("abc-1.2") {
		t.Error("legit values must validate")
	}
}

func TestRedirectToDifferentHostRefused(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("request must never reach the other host")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/Patient/p1", http.StatusFound)
	}))
	defer srv.Close()
	c := New(fakeSecrets{})
	if _, err := c.Read(context.Background(), newBackend(srv.URL, "none"), "Patient", "p1"); err == nil ||
		!strings.Contains(err.Error(), "different host") {
		t.Fatalf("err = %v, want redirect refusal", err)
	}
}

func TestTokenCacheExpiry(t *testing.T) {
	calls := 0
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"access_token":"t","expires_in":120}`))
	}))
	defer tokenSrv.Close()
	fhirSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer fhirSrv.Close()
	be := Backend{ID: "be-exp", BaseURL: fhirSrv.URL, AuthMethod: "oauth2_client_credentials",
		TokenURL: tokenSrv.URL, ClientID: "cid", VaultRef: "secret/data/t/x"}
	c := New(fakeSecrets{"secret/data/t/x": {"client_secret": "s"}})
	now := time.Now()
	c.now = func() time.Time { return now }
	if _, err := c.Read(context.Background(), be, "Patient", "p1"); err != nil {
		t.Fatal(err)
	}
	// 120s token cached for 60s; advance past it.
	now = now.Add(61 * time.Second)
	if _, err := c.Read(context.Background(), be, "Patient", "p1"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("token endpoint calls = %d, want 2 (expiry-60s honored)", calls)
	}
}
