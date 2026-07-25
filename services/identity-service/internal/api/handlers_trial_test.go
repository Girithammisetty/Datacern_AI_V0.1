// Trial lifecycle (BRD 66 slice 2, CPL-FR-021, US-3) API tests:
// start/extend/convert happy paths, requireSuperAdmin gating, validation
// errors, and Idempotency-Key replay (MASTER-FR-025).
package api_test

import (
	"context"
	"net/http"
	"testing"
)

// TestTrialLifecycle_HappyPath drives start -> extend -> convert through the
// real chi router + in-memory store, mirroring AC-2/AC-3's shape end to end.
func TestTrialLifecycle_HappyPath(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("trialco")
	super := f.superToken()

	// Start (CPL-FR-021): explicit trial_days.
	r := f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial", super, map[string]any{"trial_days": 30})
	if r.status != http.StatusOK {
		t.Fatalf("start trial: %d %s", r.status, string(r.raw))
	}
	if r.body["commercial_state"] != "trial" {
		t.Fatalf("commercial_state after start = %v, want trial", r.body["commercial_state"])
	}
	if r.body["trial_ends_at"] == nil {
		t.Fatal("trial_ends_at not set after start")
	}

	// Extend (CPL-FR-021: reason required + audited).
	r = f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial/extend", super,
		map[string]any{"days": 10, "reason": "customer requested more eval time"})
	if r.status != http.StatusOK {
		t.Fatalf("extend trial: %d %s", r.status, string(r.raw))
	}

	// Extend with no reason -> 422.
	r = f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial/extend", super, map[string]any{"days": 5})
	if r.status != http.StatusUnprocessableEntity {
		t.Fatalf("extend without reason: %d %s, want 422", r.status, string(r.raw))
	}

	// Convert (CPL-FR-021: trial->active with target plan).
	if r := f.createPlan("growth", nil); r.status != http.StatusCreated {
		t.Fatalf("create plan: %d %s", r.status, string(r.raw))
	}
	r = f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/convert", super, map[string]any{"plan_key": "growth"})
	if r.status != http.StatusOK {
		t.Fatalf("convert: %d %s", r.status, string(r.raw))
	}
	if r.body["commercial_state"] != "active" {
		t.Fatalf("commercial_state after convert = %v, want active", r.body["commercial_state"])
	}
	if r.body["trial_ends_at"] != nil {
		t.Fatalf("trial_ends_at not cleared after convert: %v", r.body["trial_ends_at"])
	}

	ge := f.do(http.MethodGet, "/api/v1/tenants/"+tn.ID.String()+"/entitlements", super, nil)
	if ge.status != http.StatusOK || ge.body["plan"].(map[string]any)["key"] != "growth" {
		t.Fatalf("post-convert entitlements: %d %+v", ge.status, ge.body)
	}
}

// TestTrialEndpoints_RequireSuperAdmin: a tenant admin token (even with every
// tenant-scoped admin capability) is refused on all three trial endpoints,
// matching the plan-catalog CRUD precedent.
func TestTrialEndpoints_RequireSuperAdmin(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("trialco2")
	tenantAdmin := f.adminToken(tn.ID)

	cases := []struct {
		path string
		body map[string]any
	}{
		{"/api/v1/tenants/" + tn.ID.String() + "/trial", map[string]any{"trial_days": 30}},
		{"/api/v1/tenants/" + tn.ID.String() + "/trial/extend", map[string]any{"days": 5, "reason": "x"}},
		{"/api/v1/tenants/" + tn.ID.String() + "/convert", map[string]any{"plan_key": "growth"}},
	}
	for _, c := range cases {
		if r := f.do(http.MethodPost, c.path, tenantAdmin, c.body); r.status != http.StatusForbidden {
			t.Errorf("%s as tenant admin: %d, want 403", c.path, r.status)
		}
		if r := f.do(http.MethodPost, c.path, "", c.body); r.status != http.StatusUnauthorized {
			t.Errorf("%s unauthenticated: %d, want 401", c.path, r.status)
		}
	}
}

// TestStartTrial_NoDaysNoPlanDefault_Rejected covers the design's explicit
// "no silent default" requirement.
func TestStartTrial_NoDaysNoPlanDefault_Rejected(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("trialco3")
	r := f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial", f.superToken(), map[string]any{})
	if r.status != http.StatusUnprocessableEntity {
		t.Fatalf("start with no trial_days and no plan default: %d %s, want 422", r.status, string(r.raw))
	}
}

// TestExtendTrial_RequiresActiveTrial: extending a tenant with no trial is CONFLICT.
func TestExtendTrial_RequiresActiveTrial(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("trialco5")
	r := f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial/extend", f.superToken(),
		map[string]any{"days": 5, "reason": "x"})
	if r.status != http.StatusConflict {
		t.Fatalf("extend with no active trial: %d %s, want 409", r.status, string(r.raw))
	}
}

// TestConvertTrial_RejectsUnknownPlan.
func TestConvertTrial_RejectsUnknownPlan(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("trialco6")
	super := f.superToken()
	if r := f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial", super, map[string]any{"trial_days": 30}); r.status != http.StatusOK {
		t.Fatalf("start trial: %d", r.status)
	}
	r := f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/convert", super, map[string]any{"plan_key": "does-not-exist"})
	if r.status != http.StatusNotFound {
		t.Fatalf("convert to unknown plan: %d %s, want 404", r.status, string(r.raw))
	}
}

// TestStartTrial_IdempotencyReplay covers MASTER-FR-025 for the new POST
// endpoints (idempotencyMiddleware already wraps this route group; this
// confirms the trial handlers participate in it like every other POST).
func TestStartTrial_IdempotencyReplay(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("trialco7")
	super := f.superToken()
	body := map[string]any{"trial_days": 30}
	key := [2]string{"Idempotency-Key", "trial-start-1"}

	r1 := f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial", super, body, key)
	if r1.status != http.StatusOK {
		t.Fatalf("first start: %d %s", r1.status, string(r1.raw))
	}
	r2 := f.do(http.MethodPost, "/api/v1/tenants/"+tn.ID.String()+"/trial", super, body, key)
	if r2.status != http.StatusOK || r2.headers.Get("Idempotency-Replayed") != "true" {
		t.Fatalf("replay: status=%d replayed=%q", r2.status, r2.headers.Get("Idempotency-Replayed"))
	}
	if string(r1.raw) != string(r2.raw) {
		t.Error("replayed body differs from original")
	}
	rows, err := f.store.ListTrialEvents(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly 1 trial_events row despite the replayed POST, got %d", len(rows))
	}
}
