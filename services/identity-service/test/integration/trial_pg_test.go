//go:build integration

// Trial lifecycle integration tests (BRD 66 slice 2, CPL-FR-020..023):
// the leader-elected sweep transitioning a real Postgres row end to end
// (AC-2), RLS isolation on the new trial_events table, and the invite-path
// seat_cap gate returning the correct current/limit against a real
// entitlements_flat projection (AC-3, CPL-FR-031). Auto-skips (via
// requirePG) when Docker is unavailable, same as every other file in this
// package.
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"
	tc "github.com/testcontainers/testcontainers-go"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"

	"github.com/datacern-ai/identity-service/internal/adapters/keycloak"
	"github.com/datacern-ai/identity-service/internal/api"
	"github.com/datacern-ai/identity-service/internal/authz"
	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/keys"
	"github.com/datacern-ai/identity-service/internal/projection"
	pgstore "github.com/datacern-ai/identity-service/internal/store/postgres"
)

// TestTrialSweep_ExpiresEndToEnd covers AC-2 against real Postgres: a trial
// started via TrialService.Start, backdated past its end date with a direct
// SQL UPDATE (there is no fake-clock seam at the Postgres boundary the way
// the unit tier has), transitions to suspended_commercial via
// TrialSweep.SweepOnce exactly once, with a trial_events(expired) row and a
// commercial.trial_expired.v1 outbox row -- and a second sweep pass is a
// no-op (CPL-NFR-003).
func TestTrialSweep_ExpiresEndToEnd(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)
	tn := newTenantRow(t, store, domain.TenantActive)

	trials := &domain.TrialService{Store: store, Clock: time.Now}
	if _, err := trials.Start(ctx, tn.ID, domain.StartTrialRequest{TrialDays: 30}, domain.Actor{Type: "user", ID: "op"}); err != nil {
		t.Fatalf("start trial: %v", err)
	}

	// Backdate trial_ends_at directly (no fake-clock seam against real PG).
	if _, err := appPool.Exec(ctx, `UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, tn.ID); err != nil {
		t.Fatal(err)
	}

	sweep := &domain.TrialSweep{Store: store, Clock: time.Now}
	expired, _, err := sweep.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if expired != 1 {
		t.Fatalf("swept %d tenants, want 1", expired)
	}
	got, err := store.GetTenant(ctx, tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommercialState != domain.CommercialSuspendedCommercial {
		t.Fatalf("commercial_state = %s, want suspended_commercial", got.CommercialState)
	}
	rows, err := store.ListTrialEvents(ctx, tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range rows {
		if r.EventType == domain.TrialEventExpired {
			found = true
		}
	}
	if !found {
		t.Fatalf("no trial_events(expired) row: %+v", rows)
	}
	var outboxN int
	if err := adminPool.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE tenant_id=$1 AND event_type=$2`,
		tn.ID, domain.EvCommercialTrialExpired).Scan(&outboxN); err != nil {
		t.Fatal(err)
	}
	if outboxN != 1 {
		t.Fatalf("outbox commercial.trial_expired.v1 rows = %d, want 1", outboxN)
	}

	// CPL-NFR-003: a second pass is a silent no-op, not a duplicate transition/event.
	expired2, _, err := sweep.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if expired2 != 0 {
		t.Fatalf("second sweep expired %d, want 0 (idempotent no-op)", expired2)
	}
	if err := adminPool.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE tenant_id=$1 AND event_type=$2`,
		tn.ID, domain.EvCommercialTrialExpired).Scan(&outboxN); err != nil {
		t.Fatal(err)
	}
	if outboxN != 1 {
		t.Fatalf("second sweep added more outbox rows: got %d, want still 1", outboxN)
	}
}

// TestTrialEventsRLSIsolation: tenant A cannot read tenant B's trial_events
// rows through the store (MASTER-FR-001/004), mirroring
// TestCommercialRLSIsolation for the slice-1 tables.
func TestTrialEventsRLSIsolation(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)
	a := newTenantRow(t, store, domain.TenantActive)
	b := newTenantRow(t, store, domain.TenantActive)

	trials := &domain.TrialService{Store: store, Clock: time.Now}
	if _, err := trials.Start(ctx, b.ID, domain.StartTrialRequest{TrialDays: 30}, domain.Actor{Type: "user", ID: "op"}); err != nil {
		t.Fatalf("start trial for B: %v", err)
	}

	aRows, err := store.ListTrialEvents(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(aRows) != 0 {
		t.Fatalf("tenant A sees tenant B's trial_events through RLS: %+v", aRows)
	}
	bRows, err := store.ListTrialEvents(ctx, b.ID)
	if err != nil || len(bRows) != 1 {
		t.Fatalf("tenant B own-tenant trial_events read failed: %v %+v", err, bRows)
	}

	// Raw SQL proof: a session scoped to tenant A sees zero trial_events rows
	// even though tenant B's row exists.
	tx, err := appPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", a.ID.String()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM trial_events").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("raw SQL under tenant A sees %d trial_events rows, want 0", n)
	}
}

// TestInviteOverCap_ReturnsCorrectCurrentLimit covers AC-3 end to end: a real
// Postgres-backed tenant with a seat_cap entitlement projected into a real
// Redis entitlements_flat, and identity-service's own invite handler wired
// to read it (CPL-FR-031) -- inviting past the cap returns 403 CAP_EXCEEDED
// with the correct current/limit.
func TestInviteOverCap_ReturnsCorrectCurrentLimit(t *testing.T) {
	requirePG(t)
	ctx := context.Background()

	rc, err := tcredis.Run(ctx, "redis:7-alpine")
	if err != nil {
		t.Skipf("Docker unavailable (could not start Redis container): %v", err)
	}
	defer func() { _ = tc.TerminateContainer(rc) }()
	redisURI, err := rc.ConnectionString(ctx)
	if err != nil {
		t.Fatal(err)
	}
	opts, err := goredis.ParseURL(redisURI)
	if err != nil {
		t.Fatal(err)
	}
	rdb := goredis.NewClient(opts)
	defer rdb.Close()

	store := pgstore.New(appPool)
	tn := newTenantRow(t, store, domain.TenantActive)
	// newTenantRow calls store.CreateTenant directly -- it does NOT run the
	// real provisioning saga (engine_steps.go), which is what actually
	// creates a tenant's first "Owner" user. This test's own comment below
	// assumes that owner already occupies the seat, so make that true
	// explicitly rather than relying on a saga path this helper never runs.
	_ = newUserRow(t, store, tn.ID, "owner@"+tn.Name+".example")
	commercial := &domain.CommercialService{Store: store, Clock: time.Now}
	plans := &domain.PlanService{Store: store, Clock: time.Now}

	newPlan, err := plans.Create(ctx, domain.CreatePlanRequest{
		Key: freshName("capplan"), Name: "Cap Plan",
		Entitlements: []domain.PlanEntitlementInput{{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(1)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := commercial.AssignPlan(ctx, tn.ID, newPlan.Key, domain.Actor{Type: "user", ID: "op"}); err != nil {
		t.Fatal(err)
	}

	// Project into Redis (the same worker path slice 1 built).
	loader := projection.StoreLoader{Store: store, Commercial: commercial, Now: time.Now}
	writer := projection.NewRedisWriter(rdb, projection.DefaultTTL)
	worker := projection.NewWorker("it-trial-worker", loader, writer)
	if _, err := worker.ProcessOnce(ctx); err != nil {
		t.Fatalf("projection worker: %v", err)
	}

	km := keys.NewKeyManager(store, keys.NewLocalSigner(), time.Now)
	if err := km.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	issuer := keys.NewIssuer(km, time.Now)
	users := &domain.UserService{
		Store: store, Keycloak: keycloak.NewFake(), LastAdmin: domain.AllowAllLastAdminChecker{}, Clock: time.Now,
		Entitlements: domain.EntitlementReaderFunc(func(rctx context.Context, tenantID uuid.UUID) (domain.EffectiveSet, bool, error) {
			return projection.ReadSet(rctx, rdb, tenantID.String())
		}),
	}
	srv := &api.Server{
		Store: store, KM: km, Verifier: issuer, Authz: authz.ScopeAuthorizer{},
		Plans: plans, Commercial: commercial, Users: users,
		TrustedSpiffeIDs: map[string]bool{}, Clock: time.Now,
	}
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()

	tok, _, err := issuer.Issue(domain.Claims{
		Subject: "admin", TenantID: tn.ID, Typ: domain.TypUser, Scopes: []string{"identity.user.admin"},
	})
	if err != nil {
		t.Fatal(err)
	}

	do := func(email string) (int, map[string]any) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"email": email})
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/users/invite", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return res.StatusCode, out
	}

	// First invite: the provisioned "Tenant Owner" already occupies the
	// tenant's 1 seat (see engine_steps.go), so limit=1 is already at
	// capacity -- the very first invite call is blocked.
	status, body := do("first@capping.example")
	if status != http.StatusForbidden {
		t.Fatalf("invite at seat_cap=1 (owner already occupies it): status=%d body=%v", status, body)
	}
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != domain.CodeCapExceeded {
		t.Fatalf("error code = %v, want %s", errBody["code"], domain.CodeCapExceeded)
	}
	det, _ := errBody["details"].(map[string]any)
	if int(det["current"].(float64)) != 1 || int(det["limit"].(float64)) != 1 {
		t.Fatalf("details = %+v, want current=1 limit=1", det)
	}
}
