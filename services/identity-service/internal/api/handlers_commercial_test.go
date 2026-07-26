// Commercial plane (BRD 66 slice 1) API tests: plan catalog CRUD authz
// (super-admin required, CPL-FR-001), tenant plan assignment + entitlement
// overrides, and GET /tenants/{id}/entitlements authz (tenant admin own
// tenant / platform / cross-tenant 404 -- mirrors handleGetTenant's AC-12
// pattern, exercised here for CPL-FR-011/AC-5).
package api_test

import (
	"net/http"
	"testing"
)

func (f *fixture) createPlan(key string, body map[string]any) resp {
	f.t.Helper()
	if body == nil {
		body = map[string]any{}
	}
	if _, ok := body["key"]; !ok {
		body["key"] = key
	}
	if _, ok := body["name"]; !ok {
		body["name"] = key
	}
	return f.do(http.MethodPost, "/api/v1/platform/plans", f.superToken(), body)
}

// TestPlanCRUD_RequiresSuperAdmin covers CPL-FR-001's "CRUD is
// platform-operator scope only": a tenant admin token (even with every
// tenant-scoped admin capability) is refused.
func TestPlanCRUD_RequiresSuperAdmin(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("acme")
	tenantAdmin := f.adminToken(tn.ID)

	if r := f.do(http.MethodGet, "/api/v1/platform/plans", tenantAdmin, nil); r.status != http.StatusForbidden {
		t.Fatalf("GET plans as tenant admin: %d, want 403", r.status)
	}
	if r := f.do(http.MethodPost, "/api/v1/platform/plans", tenantAdmin,
		map[string]any{"key": "rogue", "name": "Rogue"}); r.status != http.StatusForbidden {
		t.Fatalf("POST plan as tenant admin: %d, want 403", r.status)
	}
	if r := f.do(http.MethodGet, "/api/v1/platform/plans", "", nil); r.status != http.StatusUnauthorized {
		t.Fatalf("GET plans unauthenticated: %d, want 401", r.status)
	}
}

// TestPlanCRUD_CreateListGetPatch covers CPL-FR-001/002 end to end at the API
// layer: create with default entitlements, list, get, and a PATCH that bumps
// the plan version.
func TestPlanCRUD_CreateListGetPatch(t *testing.T) {
	f := newFixture(t)
	r := f.createPlan("pilot", map[string]any{
		"name": "Pilot", "trial_days_default": 60,
		"entitlements": []map[string]any{
			{"kind": "seat_cap", "key": "seats", "value": map[string]any{"n": 15}},
		},
	})
	if r.status != http.StatusCreated {
		t.Fatalf("create plan: %d %s", r.status, string(r.raw))
	}
	if r.body["version"] != float64(1) {
		t.Fatalf("new plan version = %v, want 1", r.body["version"])
	}
	ents := r.body["entitlements"].([]any)
	if len(ents) != 1 {
		t.Fatalf("expected 1 seed entitlement, got %d", len(ents))
	}

	list := f.do(http.MethodGet, "/api/v1/platform/plans", f.superToken(), nil)
	if list.status != http.StatusOK {
		t.Fatalf("list plans: %d", list.status)
	}
	data := list.body["data"].([]any)
	// 2, not 1: the fixture now also seeds the internal-demo plan (BRD 70
	// DSP-FR-001's forced demo-tenant plan), mirroring production where
	// migrations/0010_commercial_plans always seeds it -- see fixture_test.go.
	if len(data) != 2 {
		t.Fatalf("expected 2 plans in catalog (pilot + internal-demo), got %d", len(data))
	}

	get := f.do(http.MethodGet, "/api/v1/platform/plans/pilot", f.superToken(), nil)
	if get.status != http.StatusOK || get.body["key"] != "pilot" {
		t.Fatalf("get plan: %d %s", get.status, string(get.raw))
	}

	patch := f.do(http.MethodPatch, "/api/v1/platform/plans/pilot", f.superToken(), map[string]any{
		"entitlements": []map[string]any{
			{"kind": "seat_cap", "key": "seats", "value": map[string]any{"n": 30}},
		},
	})
	if patch.status != http.StatusOK {
		t.Fatalf("patch plan: %d %s", patch.status, string(patch.raw))
	}
	if patch.body["version"] != float64(2) {
		t.Fatalf("patched plan version = %v, want 2 (entitlements field bumps version)", patch.body["version"])
	}

	dup := f.createPlan("pilot", nil)
	if dup.status != http.StatusUnprocessableEntity {
		t.Fatalf("duplicate plan key: %d, want 422", dup.status)
	}
}

// TestAssignPlanAndEntitlements_HappyPath covers US-2/CPL-FR-011: assign a
// plan, read effective entitlements back with provenance, add an override
// that shadows a default, and remove it.
func TestAssignPlanAndEntitlements_HappyPath(t *testing.T) {
	f := newFixture(t)
	f.createPlan("pilot", map[string]any{
		"name": "Pilot",
		"entitlements": []map[string]any{
			{"kind": "seat_cap", "key": "seats", "value": map[string]any{"n": 15}},
		},
	})
	tn := f.activeTenant("acme")

	assign := f.do(http.MethodPost, "/api/v1/platform/tenants/"+tn.ID.String()+"/plan", f.superToken(),
		map[string]any{"plan_key": "pilot"})
	if assign.status != http.StatusOK {
		t.Fatalf("assign plan: %d %s", assign.status, string(assign.raw))
	}
	if assign.body["plan_version_snapshot"] != float64(1) {
		t.Fatalf("snapshot version = %v, want 1", assign.body["plan_version_snapshot"])
	}

	get := f.do(http.MethodGet, "/api/v1/tenants/"+tn.ID.String()+"/entitlements", f.superToken(), nil)
	if get.status != http.StatusOK {
		t.Fatalf("get entitlements: %d %s", get.status, string(get.raw))
	}
	if get.body["commercial_state"] != "active" {
		t.Fatalf("commercial_state = %v, want active (CPL-FR-020 none->active on direct assignment)", get.body["commercial_state"])
	}
	data := get.body["data"].([]any)
	if len(data) != 1 {
		t.Fatalf("expected 1 effective entitlement, got %d: %v", len(data), data)
	}
	first := data[0].(map[string]any)
	if first["provenance"] != "plan_default" {
		t.Fatalf("provenance = %v, want plan_default", first["provenance"])
	}

	override := f.do(http.MethodPost, "/api/v1/platform/tenants/"+tn.ID.String()+"/entitlements/overrides", f.superToken(),
		map[string]any{"kind": "seat_cap", "key": "seats", "value": map[string]any{"n": 40}, "reason": "negotiated"})
	if override.status != http.StatusOK {
		t.Fatalf("upsert override: %d %s", override.status, string(override.raw))
	}

	get2 := f.do(http.MethodGet, "/api/v1/tenants/"+tn.ID.String()+"/entitlements", f.superToken(), nil)
	data2 := get2.body["data"].([]any)
	first2 := data2[0].(map[string]any)
	if first2["provenance"] != "override" {
		t.Fatalf("after override: provenance = %v, want override", first2["provenance"])
	}
	if first2["value"].(map[string]any)["n"] != float64(40) {
		t.Fatalf("after override: value = %v, want n=40", first2["value"])
	}

	del := f.do(http.MethodDelete, "/api/v1/platform/tenants/"+tn.ID.String()+"/entitlements/overrides/seat_cap/seats", f.superToken(), nil)
	if del.status != http.StatusNoContent {
		t.Fatalf("delete override: %d %s", del.status, string(del.raw))
	}
	get3 := f.do(http.MethodGet, "/api/v1/tenants/"+tn.ID.String()+"/entitlements", f.superToken(), nil)
	data3 := get3.body["data"].([]any)
	if data3[0].(map[string]any)["provenance"] != "plan_default" {
		t.Fatalf("after override removal: provenance = %v, want plan_default", data3[0].(map[string]any)["provenance"])
	}
}

// TestGetTenantEntitlements_Authz covers CPL-FR-011/AC-5: a tenant admin
// reads its OWN tenant's entitlements; a cross-tenant admin read is 404 +
// security.cross_tenant_denied is audited (same shape as AC-12 for
// GET /tenants/{id}).
func TestGetTenantEntitlements_Authz(t *testing.T) {
	f := newFixture(t)
	a := f.activeTenant("acme")
	b := f.activeTenant("beta")

	own := f.do(http.MethodGet, "/api/v1/tenants/"+a.ID.String()+"/entitlements", f.adminToken(a.ID), nil)
	if own.status != http.StatusOK {
		t.Fatalf("own-tenant read: %d %s", own.status, string(own.raw))
	}

	cross := f.do(http.MethodGet, "/api/v1/tenants/"+b.ID.String()+"/entitlements", f.adminToken(a.ID), nil)
	if cross.status != http.StatusNotFound {
		t.Fatalf("cross-tenant read: %d, want 404", cross.status)
	}
	if code := cross.errCode(t); code != "NOT_FOUND" {
		t.Errorf("cross-tenant error code = %s, want NOT_FOUND", code)
	}
	found := false
	for _, ev := range f.store.EventsOfType("security.cross_tenant_denied") {
		if ev.TenantID == a.ID {
			found = true
		}
	}
	if !found {
		t.Error("expected a security.cross_tenant_denied audit event for the cross-tenant entitlements read")
	}

	asSuper := f.do(http.MethodGet, "/api/v1/tenants/"+b.ID.String()+"/entitlements", f.superToken(), nil)
	if asSuper.status != http.StatusOK {
		t.Fatalf("super-admin cross-tenant read: %d %s", asSuper.status, string(asSuper.raw))
	}
}

// TestGetTenantEntitlements_NoPlanAssignedYet: a tenant with no plan
// assignment still resolves (empty effective set, no error) -- CPL-FR-010
// does not require a plan for the endpoint to succeed.
func TestGetTenantEntitlements_NoPlanAssignedYet(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("freshco")
	r := f.do(http.MethodGet, "/api/v1/tenants/"+tn.ID.String()+"/entitlements", f.superToken(), nil)
	if r.status != http.StatusOK {
		t.Fatalf("entitlements for unassigned tenant: %d %s", r.status, string(r.raw))
	}
	if r.body["commercial_state"] != "none" {
		t.Fatalf("commercial_state = %v, want none", r.body["commercial_state"])
	}
	data := r.body["data"].([]any)
	if len(data) != 0 {
		t.Fatalf("expected empty effective set, got %v", data)
	}
}
