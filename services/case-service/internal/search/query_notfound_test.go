package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

// A tenant that has never indexed a case has no alias — the projector only
// creates it on the first indexed event. OpenSearch answers such a search
// with 404 index_not_found_exception, which used to bubble up as
// ESearchUnavailable's 503: a fresh self-serve demo tenant's very first
// Cases page load read as an outage (found on the first GCP rollout). An
// empty tenant must read as EMPTY; only real failures may 503.
func TestSearchMissingIndexIsEmptyNotError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"type":"index_not_found_exception","reason":"no such index"},"status":404}`))
	}))
	defer srv.Close()

	c, err := New(srv.URL, Options{})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	res, err := c.Search(context.Background(), uuid.New(), Params{Limit: 10})
	if err != nil {
		t.Fatalf("missing index must not error, got: %v", err)
	}
	if len(res.Docs) != 0 || res.HasMore {
		t.Fatalf("missing index must read as empty, got %d docs (hasMore=%v)", len(res.Docs), res.HasMore)
	}

	// Any other error status must still surface — the empty-result path is
	// strictly for the never-indexed-tenant 404.
	srv500 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv500.Close()
	c500, err := New(srv500.URL, Options{})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	if _, err := c500.Search(context.Background(), uuid.New(), Params{Limit: 10}); err == nil {
		t.Fatal("a real 5xx must still return an error")
	}
}
