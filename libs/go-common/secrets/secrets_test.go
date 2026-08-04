package secrets

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeVault is an httptest KV v2 double: it stores write envelopes and serves
// read envelopes exactly in the Vault wire format, asserting the token header
// and the /v1/secret/data/... URL translation.
func fakeVault(t *testing.T, store map[string]map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Vault-Token"); got != "test-token" {
			t.Errorf("X-Vault-Token = %q, want test-token", got)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		const prefix = "/v1/secret/data/"
		if len(r.URL.Path) <= len(prefix) || r.URL.Path[:len(prefix)] != prefix {
			t.Errorf("unexpected path %q (KV v2 URL must be /v1/secret/data/<rel>)", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		rel := r.URL.Path[len(prefix):]
		switch r.Method {
		case http.MethodGet:
			data, ok := store[rel]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"data": data}})
		case http.MethodPost:
			var env struct {
				Data map[string]string `json:"data"`
			}
			if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			store[rel] = env.Data
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"data":{"version":1}}`))
		case http.MethodDelete:
			delete(store, rel)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
}

func TestKVv2RoundTrip(t *testing.T) {
	store := map[string]map[string]string{}
	srv := fakeVault(t, store)
	defer srv.Close()
	c := New(srv.URL, "test-token")
	ctx := context.Background()

	// The stored vault_ref convention is the FULL path including secret/data/.
	ref := "secret/data/tenants/11111111-1111-1111-1111-111111111111/fhir-backends/abc"
	want := map[string]string{"token": "s3cr3t", "kid": "key-1"}
	if err := c.Put(ctx, ref, want); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, ok := store["tenants/11111111-1111-1111-1111-111111111111/fhir-backends/abc"]; !ok {
		t.Fatalf("Put stored under wrong relative path; store keys: %v", keys(store))
	}
	got, err := c.Get(ctx, ref)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got["token"] != "s3cr3t" || got["kid"] != "key-1" {
		t.Fatalf("Get = %v, want %v", got, want)
	}
	if err := c.Delete(ctx, ref); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := c.Get(ctx, ref); err != ErrNotFound {
		t.Fatalf("Get after delete: err = %v, want ErrNotFound", err)
	}
}

func TestRelativePathAccepted(t *testing.T) {
	store := map[string]map[string]string{"plain/path": {"a": "b"}}
	srv := fakeVault(t, store)
	defer srv.Close()
	c := New(srv.URL, "test-token")
	got, err := c.Get(context.Background(), "plain/path")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got["a"] != "b" {
		t.Fatalf("Get = %v", got)
	}
}

func TestUnconfiguredClientFailsLoudly(t *testing.T) {
	c := New("", "")
	if _, err := c.Get(context.Background(), "secret/data/x"); err == nil {
		t.Fatal("Get with empty addr must error")
	}
	if err := c.Put(context.Background(), "secret/data/x", nil); err == nil {
		t.Fatal("Put with empty addr must error")
	}
}

func TestEmptyPathRejected(t *testing.T) {
	c := New("http://localhost:1", "t")
	if _, err := c.Get(context.Background(), "secret/data/"); err == nil {
		t.Fatal("empty relative path must error")
	}
}

func keys(m map[string]map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
