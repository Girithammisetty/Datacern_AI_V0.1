package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// These exercise the REAL HTTP client against a stood-up test server, so they
// assert what actually goes on the wire rather than what a double was told.

type captured struct {
	auth   string
	spiffe string
	trace  string
	body   map[string]any
}

func serve(t *testing.T, status int, out map[string]any) (*httptest.Server, *captured) {
	t.Helper()
	got := &captured{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.auth = r.Header.Get("Authorization")
		got.spiffe = r.Header.Get("X-Spiffe-Id")
		got.trace = r.Header.Get("X-Trace-Id")
		_ = json.NewDecoder(r.Body).Decode(&got.body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"output": out})
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

// BRD 74 AC-10: an invocation carrying a delegated token sends it as a bearer.
func TestBackendForwardsDelegatedToken(t *testing.T) {
	srv, got := serve(t, http.StatusOK, map[string]any{"q": "acme"})
	b := NewHTTPBackend()
	res, err := b.Invoke(context.Background(),
		BackendTarget{URL: srv.URL, SpiffeID: "spiffe://datacern/ns/prod/sa/mcp-gateway", P95MS: 500},
		Invocation{ToolID: "search.query", Version: "1.0.0", Args: map[string]any{"q": "acme"},
			Tenant: "t-42", OboSub: "u-1", AgentID: "a-1", TraceID: "trace-1",
			AuthToken: "verified.caller.jwt"}, true)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if res.Output["q"] != "acme" {
		t.Fatalf("output not relayed: %+v", res.Output)
	}
	if got.auth != "Bearer verified.caller.jwt" {
		t.Fatalf("Authorization header = %q, want the delegated bearer", got.auth)
	}
	// The attribution contract and SPIFFE identity are unchanged by delegation.
	if got.spiffe == "" || got.trace != "trace-1" {
		t.Fatalf("spiffe=%q trace=%q — the existing facade contract must be intact", got.spiffe, got.trace)
	}
	if got.body["obo_sub"] != "u-1" || got.body["tenant"] != "t-42" {
		t.Fatalf("facade body lost its attribution: %+v", got.body)
	}
}

// REGRESSION GUARD: with no delegated token the request carries NO Authorization
// header at all — the contract every existing facade was written against.
func TestBackendSendsNoAuthorizationWithoutDelegation(t *testing.T) {
	srv, got := serve(t, http.StatusOK, map[string]any{"case_id": "c1"})
	b := NewHTTPBackend()
	if _, err := b.Invoke(context.Background(),
		BackendTarget{URL: srv.URL, SpiffeID: "spiffe://datacern/ns/prod/sa/mcp-gateway", P95MS: 500},
		Invocation{ToolID: "case.get", Version: "1.0.0", Args: map[string]any{"case_id": "c1"},
			Tenant: "t-42", OboSub: "u-1", AgentID: "a-1", TraceID: "trace-1"}, true); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if got.auth != "" {
		t.Fatalf("Authorization header = %q, want none", got.auth)
	}
}

// A facade rejection stays a rejection — delegation must not turn a 403 into a
// successful-looking empty result.
func TestBackendSurfacesFacadeRejection(t *testing.T) {
	srv, _ := serve(t, http.StatusForbidden, map[string]any{"error": "facade requires an allowed SPIFFE peer identity"})
	b := NewHTTPBackend()
	_, err := b.Invoke(context.Background(), BackendTarget{URL: srv.URL, P95MS: 500},
		Invocation{ToolID: "search.query", AuthToken: "verified.caller.jwt"}, true)
	if err == nil {
		t.Fatal("a 403 from the facade must be an error, never an empty success")
	}
	be, ok := err.(*BackendError)
	if !ok || be.Kind != "backend_rejected" || be.StatusCode != http.StatusForbidden {
		t.Fatalf("want backend_rejected/403, got %+v", err)
	}
	if be.Error() == "" {
		t.Fatal("the rejection must carry the facade's real message")
	}
}
