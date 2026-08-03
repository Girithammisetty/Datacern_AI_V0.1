package triggers

// WS5 evidence-upload registry check: the client's three-way contract against
// dataset-service's public ontology GET — declared / definitive miss /
// unreachable — which the api layer maps to accept / 422 / fail-soft.

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func newClient(t *testing.T, url string) *DatasetHTTP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return NewDatasetHTTP(url, "case-service", "datacern", "kid-1", key)
}

func TestOntologyTypeExistsThreeWayContract(t *testing.T) {
	tenant, ws := uuid.New(), uuid.New()
	var gotPath, gotAuth, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotQuery = r.URL.Path, r.Header.Get("Authorization"), r.URL.RawQuery
		switch {
		case strings.Contains(r.URL.Path, "/policy"):
			_, _ = w.Write([]byte(`{"data":{"entity_key":"policy"}}`))
		case strings.Contains(r.URL.Path, "/ghost"):
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer srv.Close()
	d := newClient(t, srv.URL)

	// Declared -> (true, nil).
	ok, err := d.OntologyTypeExists(context.Background(), tenant, ws, "policy")
	if !ok || err != nil {
		t.Fatalf("declared: want (true, nil), got (%v, %v)", ok, err)
	}
	if gotPath != "/api/v1/ontology/entities/policy" {
		t.Fatalf("wrong path %q", gotPath)
	}
	if !strings.HasPrefix(gotAuth, "Bearer ") {
		t.Fatalf("missing bearer token")
	}
	if !strings.Contains(gotQuery, ws.String()) {
		t.Fatalf("workspace filter missing from %q", gotQuery)
	}

	// 404 -> DEFINITIVE miss: (false, nil) — distinguishable from an outage.
	ok, err = d.OntologyTypeExists(context.Background(), tenant, ws, "ghost")
	if ok || err != nil {
		t.Fatalf("miss: want (false, nil), got (%v, %v)", ok, err)
	}

	// 5xx -> (false, err): the caller fails soft, never treats it as a miss.
	ok, err = d.OntologyTypeExists(context.Background(), tenant, ws, "outage")
	if ok || err == nil {
		t.Fatalf("outage: want (false, err), got (%v, %v)", ok, err)
	}
}

func TestOntologyTypeExistsWithoutKeyOrURLIsAnError(t *testing.T) {
	// No signing key: can't mint -> error (fail-soft at the caller), never a
	// fabricated verdict.
	d := NewDatasetHTTP("http://example.invalid", "i", "a", "", nil)
	if ok, err := d.OntologyTypeExists(context.Background(), uuid.New(), uuid.New(), "x"); ok || err == nil {
		t.Fatalf("keyless: want (false, err), got (%v, %v)", ok, err)
	}
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	d = NewDatasetHTTP("", "i", "a", "", key)
	if ok, err := d.OntologyTypeExists(context.Background(), uuid.New(), uuid.New(), "x"); ok || err == nil {
		t.Fatalf("no URL: want (false, err), got (%v, %v)", ok, err)
	}
}
