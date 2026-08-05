package enforce

import (
	"context"
	"testing"

	"github.com/datacern-ai/tool-plane/internal/authz"
	"github.com/datacern-ai/tool-plane/internal/domain"
	"github.com/datacern-ai/tool-plane/internal/events"
	"github.com/datacern-ai/tool-plane/internal/mcp"
)

// Delegated caller token (BRD 74 AC-10).
//
// A tool whose facade owns no store can only answer by reading other services as
// the caller, so the gateway forwards the VERIFIED caller bearer to it. These
// tests pin both halves of that bargain: the token reaches a tool that declared
// downstream actions and presented a token narrowed to them, and it reaches
// nothing else — not a tool that declared nothing, not a broader token, not a
// policy-denied call, not a cross-tenant call.

// searchVersion is a read tool that DECLARES downstream authority.
func searchVersion() *domain.ToolVersion {
	return &domain.ToolVersion{
		ToolID: "search.query", Version: "1.0.0", Status: domain.StatusPublished,
		PermissionTier: domain.TierRead, CostWeight: 2, SideEffects: domain.SideEffectNone,
		InputSchema: map[string]any{
			"type": "object", "additionalProperties": false, "required": []any{"q"},
			"properties": map[string]any{"q": map[string]any{"type": "string"}},
		},
		DownstreamActions: []string{"dataset.dataset.list", "case.case.list"},
	}
}

func searchPipeline(v *domain.ToolVersion) (*Pipeline, *fakeBackend) {
	p, _ := basePipeline()
	back := &fakeBackend{out: map[string]any{"q": "acme"}}
	p.Catalog = &fakeCatalog{version: v, backend: mcp.BackendTarget{URL: "http://bff"}}
	p.Backend = back
	p.Grants = &fakeGrants{}
	return p, back
}

func searchReq() Request {
	r := baseReq()
	r.ToolID = "search.query"
	r.Args = map[string]any{"q": "acme"}
	r.RawToken = "verified.caller.jwt"
	r.Scopes = []string{"search.query", "dataset.dataset.list", "case.case.list"}
	return r
}

// The capability itself: a declaring tool with a narrowed token gets the
// verified caller bearer forwarded to its facade.
func TestPipeline_DelegatesVerifiedTokenToDeclaringTool(t *testing.T) {
	p, back := searchPipeline(searchVersion())
	oc := p.Run(context.Background(), searchReq())
	if oc.Decision != events.DecisionAllowed {
		t.Fatalf("want allowed, got %s/%s (%s)", oc.Decision, oc.Code, oc.Message)
	}
	if len(back.got) != 1 {
		t.Fatalf("expected one backend invocation, got %d", len(back.got))
	}
	if back.got[0].AuthToken != "verified.caller.jwt" {
		t.Fatalf("declaring tool must receive the verified caller token, got %q", back.got[0].AuthToken)
	}
}

// A token narrowed to a SUBSET of the declaration is fine — the declaration is a
// ceiling, not a floor.
func TestPipeline_DelegatesSubsetOfDeclaration(t *testing.T) {
	p, back := searchPipeline(searchVersion())
	req := searchReq()
	req.Scopes = []string{"search.query", "case.case.list"}
	if oc := p.Run(context.Background(), req); oc.Decision != events.DecisionAllowed {
		t.Fatalf("want allowed, got %s (%s)", oc.Code, oc.Message)
	}
	if len(back.got) != 1 || back.got[0].AuthToken == "" {
		t.Fatalf("a subset-scoped token must still be delegated, got %+v", back.got)
	}
}

// REGRESSION GUARD. Every tool registered before this change declares nothing
// and must keep receiving NO Authorization header, whatever its caller's token
// carries. If this fails, the delegation change has escaped its blast radius.
func TestPipeline_NoTokenForToolsThatDeclareNothing(t *testing.T) {
	for _, scopes := range [][]string{nil, {"*"}, {"case.get"}, {"case.get", "dataset.dataset.list"}} {
		p, _ := basePipeline()
		back := &fakeBackend{out: map[string]any{"case_id": "c1"}}
		p.Backend = back
		req := baseReq() // case.get — DownstreamActions is empty
		req.RawToken = "verified.caller.jwt"
		req.Scopes = scopes
		oc := p.Run(context.Background(), req)
		if oc.Decision != events.DecisionAllowed {
			t.Fatalf("scopes=%v: want allowed, got %s (%s)", scopes, oc.Code, oc.Message)
		}
		if len(back.got) != 1 {
			t.Fatalf("scopes=%v: expected one invocation, got %d", scopes, len(back.got))
		}
		if back.got[0].AuthToken != "" {
			t.Fatalf("scopes=%v: a tool declaring nothing must receive NO Authorization, got %q",
				scopes, back.got[0].AuthToken)
		}
	}
}

// A token wider than the declaration is REFUSED — not trimmed, not forwarded.
// This is what stops a read tool becoming a universal proxy for the caller's
// whole authority.
func TestPipeline_RefusesTokenBroaderThanDeclaration(t *testing.T) {
	cases := []struct {
		name   string
		scopes []string
	}{
		{"wildcard", []string{"*"}},
		{"wildcard alongside the tool", []string{"search.query", "*"}},
		{"undeclared read action", []string{"search.query", "chart.dashboard.list"}},
		{"undeclared write action", []string{"search.query", "case.case.update"}},
		{"another tool id", []string{"search.query", "case.assign"}},
		{"not scoped to this tool", []string{"dataset.dataset.list"}},
		{"no scopes at all", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, back := searchPipeline(searchVersion())
			req := searchReq()
			req.Scopes = tc.scopes
			oc := p.Run(context.Background(), req)
			if oc.Code != domain.CodeScopeNotDelegable || oc.HTTP != 403 {
				t.Fatalf("want SCOPE_NOT_DELEGABLE/403, got %s/%d (%s)", oc.Code, oc.HTTP, oc.Message)
			}
			if len(back.got) != 0 {
				t.Fatalf("the backend must not be reached at all; got %d invocations", len(back.got))
			}
			details, _ := oc.Details.(map[string]any)
			if details == nil || details["required_scopes"] == nil {
				t.Fatalf("the denial must name the scopes the caller needs, got %+v", oc.Details)
			}
		})
	}
}

// A declaring tool with no verified token is refused loudly, never downgraded to
// a tokenless call whose empty result would read as "nothing matched".
func TestPipeline_RefusesDelegationWithoutAVerifiedToken(t *testing.T) {
	p, back := searchPipeline(searchVersion())
	req := searchReq()
	req.RawToken = ""
	oc := p.Run(context.Background(), req)
	if oc.Code != domain.CodeScopeNotDelegable {
		t.Fatalf("want SCOPE_NOT_DELEGABLE, got %s (%s)", oc.Code, oc.Message)
	}
	if len(back.got) != 0 {
		t.Fatalf("the backend must not be reached, got %d invocations", len(back.got))
	}
}

// Defence in depth: registration refuses a non-read declaration, so a stored row
// carrying one is corrupt and must not delegate.
func TestPipeline_RefusesDelegationForNonReadTier(t *testing.T) {
	v := searchVersion()
	v.PermissionTier = domain.TierWriteDirect
	p, back := searchPipeline(v)
	oc := p.Run(context.Background(), searchReq())
	if oc.Code != domain.CodeScopeNotDelegable {
		t.Fatalf("want SCOPE_NOT_DELEGABLE, got %s (%s)", oc.Code, oc.Message)
	}
	if len(back.got) != 0 {
		t.Fatalf("the backend must not be reached, got %d invocations", len(back.got))
	}
}

// The delegation gate sits AFTER the OPA check, so a policy denial still wins
// and no token leaves the gateway for a call policy refused.
func TestPipeline_NoDelegationWhenPolicyDenies(t *testing.T) {
	p, back := searchPipeline(searchVersion())
	p.OPA = &fakeOPA{dec: authz.Decision{Allow: false, Reason: "toolset_scope"}}
	oc := p.Run(context.Background(), searchReq())
	if oc.Code != domain.CodePermission {
		t.Fatalf("want PERMISSION_DENIED, got %s", oc.Code)
	}
	if len(back.got) != 0 {
		t.Fatalf("a policy-denied call must never delegate a token; got %d invocations", len(back.got))
	}
}

// Cross-tenant still 404s before dispatch, so nothing is delegated
// (MASTER-FR-003 — a 403 would leak existence).
func TestPipeline_NoDelegationCrossTenant(t *testing.T) {
	v := searchVersion()
	v.InputSchema = map[string]any{
		"type": "object", "additionalProperties": false, "required": []any{"q", "dataset_id"},
		"properties": map[string]any{
			"q": map[string]any{"type": "string"},
			"dataset_id": map[string]any{"type": "string",
				"x-datacern-urn": "wr:{tenant}:dataset:dataset/{value}"},
		},
	}
	p, back := searchPipeline(v)
	req := searchReq()
	// A fully-qualified URN pinned to ANOTHER tenant is the cross-tenant probe.
	req.Args = map[string]any{"q": "acme", "dataset_id": "wr:t-77:dataset:dataset/ds-9"}
	oc := p.Run(context.Background(), req)
	if oc.Code != domain.CodeNotFound || oc.HTTP != 404 {
		t.Fatalf("cross-tenant URN must 404, got %s/%d (%s)", oc.Code, oc.HTTP, oc.Message)
	}
	if len(back.got) != 0 {
		t.Fatalf("a cross-tenant call must never delegate a token; got %d invocations", len(back.got))
	}
}

// A killed tool delegates nothing either — the kill recheck runs before dispatch.
func TestPipeline_NoDelegationWhenKilled(t *testing.T) {
	p, back := searchPipeline(searchVersion())
	p.Kill = &fakeKill{killed: true}
	oc := p.Run(context.Background(), searchReq())
	if oc.Code != domain.CodeToolKilled {
		t.Fatalf("want TOOL_KILLED, got %s", oc.Code)
	}
	if len(back.got) != 0 {
		t.Fatalf("a killed tool must never delegate a token; got %d invocations", len(back.got))
	}
}
