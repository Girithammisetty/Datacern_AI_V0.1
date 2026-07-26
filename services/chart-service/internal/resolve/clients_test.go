package resolve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHTTPSemanticKnownFields: KnownFields merges measure + dimension names
// from the real get_metrics/get_dimensions tool endpoints (CHART-FR-013).
func TestHTTPSemanticKnownFields(t *testing.T) {
	var gotPaths []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		var body struct {
			Model       string `json:"model"`
			WorkspaceID string `json:"workspace_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "sales" || body.WorkspaceID != "ws-1" {
			t.Errorf("unexpected request body: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/tools/get_metrics":
			_, _ = w.Write([]byte(`{"data":{"metrics":[{"name":"revenue"},{"name":"orders"}]}}`))
		case "/api/v1/tools/get_dimensions":
			_, _ = w.Write([]byte(`{"data":{"dimensions":[{"name":"region"},{"name":"segment"}]}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer ts.Close()

	h := NewHTTPSemantic(ts.URL)
	known, err := h.KnownFields(context.Background(), "tok", "sales", "ws-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := map[string]bool{"revenue": true, "orders": true, "region": true, "segment": true}
	if len(known) != len(want) {
		t.Fatalf("known = %v, want %v", known, want)
	}
	for k := range want {
		if !known[k] {
			t.Errorf("missing known field %q", k)
		}
	}
	if len(gotPaths) != 2 {
		t.Fatalf("want 2 upstream calls, got %v", gotPaths)
	}
}

// TestHTTPSemanticKnownFieldsUpstreamError: a non-200 from either tool
// endpoint surfaces as an error (caller treats it as "skip the check").
func TestHTTPSemanticKnownFieldsUpstreamError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`boom`))
	}))
	defer ts.Close()

	h := NewHTTPSemantic(ts.URL)
	if _, err := h.KnownFields(context.Background(), "tok", "sales", "ws-1"); err == nil {
		t.Fatal("expected error")
	}
}
