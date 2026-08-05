package enforce

import (
	"context"
	"testing"

	"github.com/datacern-ai/tool-plane/internal/domain"
	"github.com/datacern-ai/tool-plane/internal/events"
	"github.com/datacern-ai/tool-plane/internal/mcp"
)

// BRD 74 AC-10 — a delegated call must be identifiable in the audit stream.
//
// ai.tool_invoked.v1 recorded a call that forwarded the caller's bearer to the
// backend identically to one that carried attribution only. "A user token left
// the gateway" is precisely the event an auditor needs to find after the fact,
// and it was the one thing the payload did not say.
//
// These drive the REAL pipeline and read the envelope it actually publishes, and
// pin the distinction in BOTH directions: a marker that were always present, or
// always absent, would be as useless as none at all.

// searchPipelineWithAudit mirrors searchPipeline but keeps the audit double.
func searchPipelineWithAudit(v *domain.ToolVersion) (*Pipeline, *fakeAudit) {
	p, audit := basePipeline()
	p.Catalog = &fakeCatalog{version: v, backend: mcp.BackendTarget{URL: "http://bff"}}
	p.Backend = &fakeBackend{out: map[string]any{"q": "acme"}}
	p.Grants = &fakeGrants{}
	return p, audit
}

func lastPayload(t *testing.T, audit *fakeAudit) map[string]any {
	t.Helper()
	if len(audit.envelopes) == 0 {
		t.Fatal("no audit envelope was published")
	}
	return audit.envelopes[len(audit.envelopes)-1].Payload
}

func TestAudit_MarksADelegatedInvocation(t *testing.T) {
	p, audit := searchPipelineWithAudit(searchVersion())
	oc := p.Run(context.Background(), searchReq())
	if oc.Decision != events.DecisionAllowed {
		t.Fatalf("want allowed, got %s/%s", oc.Decision, oc.Code)
	}

	pl := lastPayload(t, audit)
	if pl["delegated"] != true {
		t.Fatalf("a call that forwarded the caller token must be marked; got %#v", pl["delegated"])
	}
	acts, _ := pl["delegated_actions"].([]string)
	if len(acts) != 2 || acts[0] != "dataset.dataset.list" {
		t.Fatalf("the declared actions must be recorded, got %#v", pl["delegated_actions"])
	}
}

func TestAudit_OmitsTheMarkerForANonDelegatingTool(t *testing.T) {
	// Absence must mean "attribution only", not "unknown" — so the key is not
	// written at all rather than written false.
	v := searchVersion()
	v.DownstreamActions = nil
	p, audit := searchPipelineWithAudit(v)

	req := searchReq()
	req.Scopes = []string{"search.query"}
	if oc := p.Run(context.Background(), req); oc.Decision != events.DecisionAllowed {
		t.Fatalf("want allowed, got %s/%s (%s)", oc.Decision, oc.Code, oc.Message)
	}

	pl := lastPayload(t, audit)
	if _, ok := pl["delegated"]; ok {
		t.Fatalf("a non-delegating call must not carry the marker at all")
	}
	if _, ok := pl["delegated_actions"]; ok {
		t.Fatalf("a non-delegating call must not carry delegated_actions")
	}
}

func TestAudit_ARefusedDelegationIsNotMarkedDelegated(t *testing.T) {
	// A refusal forwards nothing, so it must never look like it did — otherwise
	// the audit stream over-reports token egress, which is its own failure.
	p, audit := searchPipelineWithAudit(searchVersion())
	req := searchReq()
	req.Scopes = []string{"search.query", "*"} // broader than the declaration
	oc := p.Run(context.Background(), req)
	if oc.Decision == events.DecisionAllowed {
		t.Fatal("a wildcard-scoped token must be refused")
	}

	pl := lastPayload(t, audit)
	if _, ok := pl["delegated"]; ok {
		t.Fatalf("a refused delegation must not be marked delegated")
	}
}
