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

// TestSeatCap_UnderLimitSucceeds: current(1) < limit(2) -> invite proceeds.
func TestSeatCap_UnderLimitSucceeds(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco1")
	f.activeUser(tn, "existing@capco1.com")
	f.srv.Users.Entitlements = entReaderWithCap(2)

	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": "new@capco1.com"})
	if r.status != http.StatusCreated {
		t.Fatalf("invite under cap: status %d body %s", r.status, string(r.raw))
	}
}

// TestSeatCap_AtLimitBlocked covers AC-3 exactly: seat_cap{n:5}-shaped
// scenario reduced to n=1 for a fast test -- 1 active user, invite a 2nd ->
// 403 CAP_EXCEEDED {current, limit}; after the cap is raised, the request
// succeeds.
func TestSeatCap_AtLimitBlocked(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco2")
	f.activeUser(tn, "existing@capco2.com")
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

// TestSeatCap_OverLimitBlocked: 2 existing users, limit 2 -> blocked with the
// right current/limit even when current > 0 and well past the boundary.
func TestSeatCap_OverLimitBlocked(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("capco3")
	f.activeUser(tn, "a@capco3.com")
	f.activeUser(tn, "b@capco3.com")
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
