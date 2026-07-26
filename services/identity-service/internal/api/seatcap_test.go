package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// entReaderWithCap builds a domain.EntitlementReader (CPL-FR-031) that
// reports a single kind=seat_cap/"seats" entitlement with the given limit for
// every tenant -- the seat_cap enforcement tests below wire this directly
// onto f.srv.Users.Entitlements (nil by default in the shared fixture, so
// every other invite test in this package is unaffected).
func entReaderWithCap(limit int) domain.EntitlementReaderFunc {
	return func(_ context.Context, tenantID uuid.UUID) (domain.EffectiveSet, bool, error) {
		return domain.EffectiveSet{
			TenantID: tenantID,
			Entitlements: []domain.EffectiveEntitlement{
				{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(limit)}, Provenance: domain.ProvenancePlanDefault},
			},
		}, true, nil
	}
}

// entReaderNotFound simulates "no projection row for this tenant" (never
// assigned a plan / no seat_cap entitlement) -- CPL-NFR-004: this is NOT
// unavailability, it resolves to "no cap configured".
func entReaderNotFound() domain.EntitlementReaderFunc {
	return func(_ context.Context, _ uuid.UUID) (domain.EffectiveSet, bool, error) {
		return domain.EffectiveSet{}, false, nil
	}
}

// entReaderUnavailable simulates a Redis-read failure -- CPL-NFR-004's
// fail-closed path for entitlement-gated writes.
func entReaderUnavailable() domain.EntitlementReaderFunc {
	return func(_ context.Context, _ uuid.UUID) (domain.EffectiveSet, bool, error) {
		return domain.EffectiveSet{}, false, context.DeadlineExceeded
	}
}

// Note: f.activeTenant provisions a "Tenant Owner" user as part of the real
// provisioning saga (engine_steps.go), so a freshly activated tenant already
// has 1 active user before any test-added invites -- every seat count below
// accounts for that baseline explicitly rather than assuming zero.

// TestSeatCap_UnderLimitSucceeds: current(1, the provisioned owner) <
// limit(2) -> invite proceeds.
func TestSeatCap_UnderLimitSucceeds(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco1")
	f.srv.Users.Entitlements = entReaderWithCap(2)

	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "new@capco1.com"})
	if r.status != http.StatusCreated {
		t.Fatalf("invite under cap: status %d body %s", r.status, string(r.raw))
	}
}

// TestSeatCap_AtLimitBlocked covers AC-3 exactly: seat_cap{n:5} reduced to
// n=1 for a fast test -- the provisioned owner already occupies the tenant's
// 1 seat, so inviting a 2nd user is blocked with 403 CAP_EXCEEDED
// {current:1, limit:1}; after the cap is raised, the same request succeeds.
func TestSeatCap_AtLimitBlocked(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco2")
	f.srv.Users.Entitlements = entReaderWithCap(1)

	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "blocked@capco2.com"})
	if r.status != http.StatusForbidden {
		t.Fatalf("invite at cap: status %d body %s, want 403", r.status, string(r.raw))
	}
	if code := r.errCode(t); code != domain.CodeCapExceeded {
		t.Fatalf("error code = %s, want %s", code, domain.CodeCapExceeded)
	}
	det := r.body["error"].(map[string]any)["details"].(map[string]any)
	if int(det["current"].(float64)) != 1 || int(det["limit"].(float64)) != 1 {
		t.Fatalf("details = %+v, want current=1 limit=1", det)
	}

	// AC-3: after the cap is raised, the same invite succeeds.
	f.srv.Users.Entitlements = entReaderWithCap(2)
	r = f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "blocked@capco2.com"})
	if r.status != http.StatusCreated {
		t.Fatalf("invite after cap raised: status %d body %s", r.status, string(r.raw))
	}
}

// TestSeatCap_OverLimitBlocked: owner + 1 invited user = 2 seats in use,
// limit 2 -> blocked with the right current/limit at the boundary.
func TestSeatCap_OverLimitBlocked(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco3")
	f.activeUser(tn, "a@capco3.com")
	f.srv.Users.Entitlements = entReaderWithCap(2)

	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "c@capco3.com"})
	if r.status != http.StatusForbidden || r.errCode(t) != domain.CodeCapExceeded {
		t.Fatalf("status=%d code=%s, want 403 CAP_EXCEEDED", r.status, r.errCode(t))
	}
	det := r.body["error"].(map[string]any)["details"].(map[string]any)
	if int(det["current"].(float64)) != 2 || int(det["limit"].(float64)) != 2 {
		t.Fatalf("details = %+v, want current=2 limit=2", det)
	}
}

// TestSeatCap_NoCapConfigured_Unenforced: the projection has no seat_cap
// entitlement for this tenant (ok=false) -- CPL-NFR-004: not unavailability,
// resolves to unlimited.
func TestSeatCap_NoCapConfigured_Unenforced(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco4")
	f.srv.Users.Entitlements = entReaderNotFound()

	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "x@capco4.com"})
	if r.status != http.StatusCreated {
		t.Fatalf("invite with no projection row: status %d body %s, want 201 (unenforced)", r.status, string(r.raw))
	}
}

// TestSeatCap_ProjectionUnavailable_FailsClosed covers CPL-NFR-004: a
// Redis-read failure on an entitlement-gated WRITE fails closed, 503
// ENTITLEMENT_UNAVAILABLE -- never silently lets the invite through.
func TestSeatCap_ProjectionUnavailable_FailsClosed(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco5")
	f.srv.Users.Entitlements = entReaderUnavailable()

	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "x@capco5.com"})
	if r.status != http.StatusServiceUnavailable {
		t.Fatalf("invite with unavailable projection: status %d body %s, want 503", r.status, string(r.raw))
	}
	if code := r.errCode(t); code != domain.CodeEntitlementUnavailable {
		t.Fatalf("error code = %s, want %s", code, domain.CodeEntitlementUnavailable)
	}
}

// TestSeatCap_NilReaderUnenforced: the fixture's default (no Entitlements
// wired at all, mirroring a dev/single-replica deployment with no
// REDIS_ADDR) never blocks an invite -- the "feature not wired" honest-nil
// convention, matching Logo/Demo/Lease elsewhere in this service.
func TestSeatCap_NilReaderUnenforced(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco6")
	if f.srv.Users.Entitlements != nil {
		t.Fatal("expected the shared fixture's default UserService.Entitlements to be nil")
	}
	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "x@capco6.com"})
	if r.status != http.StatusCreated {
		t.Fatalf("invite with nil Entitlements: status %d body %s, want 201", r.status, string(r.raw))
	}
}

// TestSeatCap_ResizeViaOverride_TakesEffectThroughRealWritePath: every case
// above wires UserService.Entitlements to entReaderWithCap, a hardcoded fake
// that never touches CommercialService/the store -- so none of them would
// catch a regression in the actual admin resize path (POST .../entitlements/
// overrides -> CommercialService.UpsertOverride -> Store -> the effective-set
// resolution GET /tenants/{id}/entitlements also uses). This test wires the
// reader to that SAME CommercialService.EffectiveEntitlements call instead
// (production wires the identical resolution result through the
// entitlements_flat Redis projection -- cmd/server/main.go's REDIS_ADDR
// branch, internal/projection/worker.go's Loader.Snapshot -- this test just
// skips the Redis hop, which is orthogonal to whether the override itself
// took effect) to prove the full resize->persist->read->enforce chain
// through the real HTTP override handler, not just checkSeatCap's decision
// logic against a canned value.
func TestSeatCap_ResizeViaOverride_TakesEffectThroughRealWritePath(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("resizeco")
	f.srv.Users.Entitlements = domain.EntitlementReaderFunc(
		func(ctx context.Context, tenantID uuid.UUID) (domain.EffectiveSet, bool, error) {
			eff, err := f.srv.Commercial.EffectiveEntitlements(ctx, tenantID)
			if err != nil {
				return domain.EffectiveSet{}, false, err
			}
			return eff, len(eff.Entitlements) > 0, nil
		})

	setCap := func(n int) resp {
		return f.do(http.MethodPost, "/api/v1/platform/tenants/"+tn.ID.String()+"/entitlements/overrides", f.superToken(),
			map[string]any{"kind": "seat_cap", "key": "seats", "value": map[string]any{"n": n}, "reason": "capacity fix"})
	}

	// Owner already occupies the tenant's one seat (f.activeTenant provisions
	// it) -- seat_cap=1 blocks a second invite.
	if r := setCap(1); r.status != http.StatusOK {
		t.Fatalf("set seat_cap=1: %d %s", r.status, string(r.raw))
	}
	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "blocked@resizeco.com"})
	if r.status != http.StatusForbidden || r.errCode(t) != domain.CodeCapExceeded {
		t.Fatalf("invite at seat_cap=1: status=%d code=%s, want 403 CAP_EXCEEDED", r.status, r.errCode(t))
	}

	// The admin resizes the cap -- the same override endpoint an operator
	// hits in production to fix a capacity problem.
	if r := setCap(5); r.status != http.StatusOK {
		t.Fatalf("resize seat_cap to 5: %d %s", r.status, string(r.raw))
	}

	// Read-back reflects the resize immediately.
	get := f.do(http.MethodGet, "/api/v1/tenants/"+tn.ID.String()+"/entitlements", f.superToken(), nil)
	data := get.body["data"].([]any)
	if len(data) != 1 || data[0].(map[string]any)["value"].(map[string]any)["n"] != float64(5) {
		t.Fatalf("entitlements read-back after resize: %v, want seat_cap n=5", data)
	}

	// The same invite that was just blocked now succeeds -- the resize took
	// effect on the enforcement check without any process restart, because
	// checkSeatCap resolves through the identical CommercialService call the
	// GET above (and, in production, the projection worker) use.
	r = f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "blocked@resizeco.com"})
	if r.status != http.StatusCreated {
		t.Fatalf("invite after resize to 5: status=%d body=%s, want 201", r.status, string(r.raw))
	}
}
