package api_test

import (
	"net/http"
	"testing"
)

// TestDemoTenants_CreateResetClone exercises the full HTTP surface BRD 70
// slice 1/2 adds (DSP-FR-010/012): POST /demo-tenants -> active with the
// forced internal-demo plan; POST .../reset re-seeds; POST .../clone
// provisions an independent sibling. Uses the SAME fake seed runner/loader
// newFixtureOpt wires into every acceptance test (fixture_test.go), so this
// is a real HTTP round-trip through chi routing + requireSuperAdmin + the
// provisioning saga's new SeedDemoContent step, not a domain-layer-only test.
func TestDemoTenants_CreateResetClone(t *testing.T) {
	f := newFixture(t)

	r := f.do(http.MethodPost, "/api/v1/demo-tenants", f.superToken(), map[string]any{
		"name": "acme-demo-http", "owner_email": "owner@acme-demo-http.com",
		"pack": "insurance-claims-payer",
	})
	if r.status != http.StatusAccepted {
		t.Fatalf("create demo tenant: %d %s", r.status, string(r.raw))
	}
	tenant, ok := r.body["tenant"].(map[string]any)
	if !ok {
		t.Fatalf("no tenant in response: %s", string(r.raw))
	}
	if tenant["profile"] != "demo" {
		t.Fatalf("profile = %v, want demo", tenant["profile"])
	}
	if tenant["status"] != "active" {
		t.Fatalf("status = %v, want active", tenant["status"])
	}
	tenantID := tenant["id"].(string)

	// Forced internal-demo plan assignment (DSP-FR-001) is visible via the
	// SAME entitlements endpoint standard tenants use.
	ent := f.do(http.MethodGet, "/api/v1/tenants/"+tenantID+"/entitlements", f.superToken(), nil)
	if ent.status != http.StatusOK {
		t.Fatalf("get entitlements: %d %s", ent.status, string(ent.raw))
	}
	plan, _ := ent.body["plan"].(map[string]any)
	if plan == nil || plan["key"] != "internal-demo" {
		t.Fatalf("plan.key = %v, want internal-demo", plan)
	}
	if ent.body["commercial_state"] != "none" {
		t.Fatalf("commercial_state = %v, want none (AC-3 non-convertibility)", ent.body["commercial_state"])
	}

	// A standard-profile POST /tenants must NOT be reachable at /demo-tenants
	// and vice versa isn't the point here -- but a bare POST /tenants must
	// still default to profile=standard even with this endpoint wired.
	std := f.createTenant("acme-std-http", true)
	if std.status != http.StatusAccepted {
		t.Fatalf("create standard tenant: %d %s", std.status, string(std.raw))
	}
	stdTenant := std.body["tenant"].(map[string]any)
	if stdTenant["profile"] != "standard" {
		t.Fatalf("standard tenant profile = %v, want standard", stdTenant["profile"])
	}

	// Reset.
	reset := f.do(http.MethodPost, "/api/v1/demo-tenants/"+tenantID+"/reset", f.superToken(), nil)
	if reset.status != http.StatusOK {
		t.Fatalf("reset: %d %s", reset.status, string(reset.raw))
	}
	if reset.body["profile"] != "demo" {
		t.Fatalf("reset response profile = %v, want demo", reset.body["profile"])
	}

	// Reset on the standard tenant is rejected.
	badReset := f.do(http.MethodPost, "/api/v1/demo-tenants/"+stdTenant["id"].(string)+"/reset", f.superToken(), nil)
	if badReset.status == http.StatusOK {
		t.Fatal("reset on a standard tenant must be rejected")
	}

	// Clone.
	clone := f.do(http.MethodPost, "/api/v1/demo-tenants/"+tenantID+"/clone", f.superToken(), map[string]any{
		"name": "acme-demo-http-clone",
	})
	if clone.status != http.StatusAccepted {
		t.Fatalf("clone: %d %s", clone.status, string(clone.raw))
	}
	cloneTenant := clone.body["tenant"].(map[string]any)
	if cloneTenant["id"] == tenantID {
		t.Fatal("clone returned the same tenant id as the source")
	}
	if cloneTenant["profile"] != "demo" {
		t.Fatalf("clone profile = %v, want demo", cloneTenant["profile"])
	}
}

// TestDemoTenants_RequireSuperAdmin proves the demo-tenant surface shares
// POST /tenants' requireSuperAdmin gate -- no separate, weaker authz path.
func TestDemoTenants_RequireSuperAdmin(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("acme-gate")
	adminTok := f.adminToken(tn.ID) // tenant-admin, NOT platform.admin
	r := f.do(http.MethodPost, "/api/v1/demo-tenants", adminTok, map[string]any{
		"name": "should-not-exist", "owner_email": "o@x.com", "pack": "insurance-claims-payer",
	})
	if r.status != http.StatusForbidden && r.status != http.StatusUnauthorized {
		t.Fatalf("expected 401/403 for a non-super-admin caller, got %d %s", r.status, string(r.raw))
	}
}
