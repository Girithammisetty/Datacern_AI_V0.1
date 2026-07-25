//go:build integration

// Commercial plane integration tests (BRD 66 slice 1): migration apply +
// seed data (§3 "Migrations ... Seed the four plans"), RLS binds on the new
// tenant-scoped tables (tenant_plan, tenant_entitlement_overrides), API
// endpoints with authz (super-admin for plan CRUD, tenant-admin-own-tenant
// for GET .../entitlements, cross-tenant -> 404), and the entitlements_flat
// projection worker end to end against a real Redis. Auto-skips (via
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

// TestCommercialMigrationSeedsPlans: migrations 0010/0011 apply cleanly (this
// itself is proven by every test in the package running at all -- TestMain
// calls pgstore.Migrate before any test runs) and the four CPL-FR-001 plans
// are seeded with their starter default entitlements.
func TestCommercialMigrationSeedsPlans(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)

	plans, err := store.ListPlans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"internal-demo": false, "design-partner": false, "pilot": false, "enterprise": false}
	for _, p := range plans {
		if _, ok := want[p.Key]; ok {
			want[p.Key] = true
			if p.Status != "active" || p.Version != 1 {
				t.Errorf("seeded plan %s: status=%s version=%d, want active/1", p.Key, p.Status, p.Version)
			}
		}
	}
	for key, found := range want {
		if !found {
			t.Errorf("seeded plan %q missing", key)
		}
	}

	pilotDays := 0
	for _, p := range plans {
		if p.Key == "pilot" {
			if p.TrialDaysDefault == nil {
				t.Fatal("pilot plan should seed trial_days_default=60 (CPL-FR-001)")
			}
			pilotDays = *p.TrialDaysDefault
		}
	}
	if pilotDays != 60 {
		t.Errorf("pilot trial_days_default = %d, want 60", pilotDays)
	}

	ents, err := store.ListPlanEntitlements(ctx, "enterprise", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) == 0 {
		t.Error("enterprise plan seeded with no default entitlements")
	}
}

// TestCommercialRLSIsolation: tenant A cannot read tenant B's tenant_plan or
// tenant_entitlement_overrides rows through the store (MASTER-FR-001/004,
// mirrors TestRLSIsolation for the pre-existing tables).
func TestCommercialRLSIsolation(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)
	a := newTenantRow(t, store, domain.TenantActive)
	b := newTenantRow(t, store, domain.TenantActive)

	if err := store.AssignTenantPlan(ctx, &domain.TenantPlan{
		TenantID: b.ID, PlanKey: "pilot", PlanVersionSnapshot: 1, AssignedAt: time.Now().UTC(), AssignedBy: "test",
	}); err != nil {
		t.Fatal(err)
	}
	oID, _ := uuid.NewV7()
	if err := store.UpsertEntitlementOverride(ctx, &domain.TenantEntitlementOverride{
		ID: oID, TenantID: b.ID, Kind: domain.KindFeature, Key: "beta-ui", GrantedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	// Tenant A's own reads: no plan assigned, no overrides -- empty, not an error.
	if _, err := store.GetTenantPlan(ctx, a.ID); err == nil {
		t.Fatal("tenant A should have no plan assignment")
	} else if de, _ := domain.AsError(err); de == nil || de.HTTP != 404 {
		t.Fatalf("want NOT_FOUND, got %v", err)
	}
	aOverrides, err := store.ListEntitlementOverrides(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(aOverrides) != 0 {
		t.Fatalf("tenant A sees tenant B's overrides through RLS: %+v", aOverrides)
	}

	// Tenant B's own reads succeed.
	bPlan, err := store.GetTenantPlan(ctx, b.ID)
	if err != nil || bPlan.PlanKey != "pilot" {
		t.Fatalf("tenant B own-tenant plan read failed: %v %+v", err, bPlan)
	}
	bOverrides, err := store.ListEntitlementOverrides(ctx, b.ID)
	if err != nil || len(bOverrides) != 1 {
		t.Fatalf("tenant B own-tenant override read failed: %v %+v", err, bOverrides)
	}

	// Raw SQL proof: a session scoped to tenant A sees zero rows in either
	// table even though tenant B's rows exist.
	tx, err := appPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", a.ID.String()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM tenant_plan").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("raw SQL under tenant A sees %d tenant_plan rows, want 0", n)
	}
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM tenant_entitlement_overrides").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("raw SQL under tenant A sees %d override rows, want 0", n)
	}
}

// TestCommercialAPI_Authz: super-admin required for plan CRUD + assignment;
// a tenant admin reads its own tenant's entitlements; cross-tenant read is
// 404 (MASTER-FR-002/003, AC-5), all against the real Postgres/RLS store.
func TestCommercialAPI_Authz(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)

	km := keys.NewKeyManager(store, keys.NewLocalSigner(), time.Now)
	if err := km.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	issuer := keys.NewIssuer(km, time.Now)
	plans := &domain.PlanService{Store: store, Clock: time.Now}
	commercial := &domain.CommercialService{Store: store, Clock: time.Now}
	srv := &api.Server{
		Store: store, KM: km, Verifier: issuer, Authz: authz.ScopeAuthorizer{},
		Plans: plans, Commercial: commercial,
		TrustedSpiffeIDs: map[string]bool{}, Clock: time.Now,
		Users: &domain.UserService{Store: store, Keycloak: keycloak.NewFake(), LastAdmin: domain.AllowAllLastAdminChecker{}, Clock: time.Now},
	}
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()

	a := newTenantRow(t, store, domain.TenantActive)
	b := newTenantRow(t, store, domain.TenantActive)

	mint := func(c domain.Claims) string {
		tok, _, err := issuer.Issue(c)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	superTok := mint(domain.Claims{Subject: "staff", Typ: domain.TypUser, Scopes: []string{"platform.admin"}})
	aAdminTok := mint(domain.Claims{Subject: "a-admin", TenantID: a.ID, Typ: domain.TypUser, Scopes: []string{"identity.user.admin"}})

	do := func(method, path, token string, body any) (int, map[string]any) {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			rd = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, rd)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	// Plan CRUD: tenant admin refused, super-admin allowed.
	if status, _ := do(http.MethodPost, "/api/v1/platform/plans", aAdminTok,
		map[string]any{"key": "rogue-pg", "name": "Rogue"}); status != http.StatusForbidden {
		t.Fatalf("tenant admin create plan: %d, want 403", status)
	}
	if status, body := do(http.MethodPost, "/api/v1/platform/plans", superTok,
		map[string]any{"key": "pg-pilot", "name": "PG Pilot"}); status != http.StatusCreated {
		t.Fatalf("super-admin create plan: %d %v", status, body)
	}

	// Assign + read entitlements.
	if status, _ := do(http.MethodPost, "/api/v1/platform/tenants/"+b.ID.String()+"/plan", superTok,
		map[string]any{"plan_key": "pg-pilot"}); status != http.StatusOK {
		t.Fatalf("assign plan to tenant B: %d", status)
	}

	// Own-tenant read (tenant A has no assignment, but the read itself must succeed).
	if status, _ := do(http.MethodGet, "/api/v1/tenants/"+a.ID.String()+"/entitlements", aAdminTok, nil); status != http.StatusOK {
		t.Fatalf("tenant A own-tenant entitlements read: %d", status)
	}
	// Cross-tenant read -> 404.
	if status, _ := do(http.MethodGet, "/api/v1/tenants/"+b.ID.String()+"/entitlements", aAdminTok, nil); status != http.StatusNotFound {
		t.Fatalf("tenant A reading tenant B's entitlements: %d, want 404", status)
	}
	// Super-admin cross-tenant read -> 200.
	if status, body := do(http.MethodGet, "/api/v1/tenants/"+b.ID.String()+"/entitlements", superTok, nil); status != http.StatusOK {
		t.Fatalf("super-admin reading tenant B's entitlements: %d %v", status, body)
	}
}

// TestCommercialProjection_RedisRoundTrip: an entitlement mutation enqueues a
// commercial_dirty row (in the SAME transaction, per the store methods under
// test); the projection worker claims it, recomputes via
// CommercialService.EffectiveEntitlements, and writes ent:{tenant}:flat to a
// REAL Redis (CPL-FR-011) -- proving the outbox/dirty-queue -> Redis path end
// to end, the one piece TestWorker_* (unit tier, fake Loader/Writer) cannot
// cover.
func TestCommercialProjection_RedisRoundTrip(t *testing.T) {
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
	commercial := &domain.CommercialService{Store: store, Clock: time.Now}

	if err := store.AssignTenantPlan(ctx, &domain.TenantPlan{
		TenantID: tn.ID, PlanKey: "pilot", PlanVersionSnapshot: 1, AssignedAt: time.Now().UTC(), AssignedBy: "test",
	}); err != nil {
		t.Fatal(err)
	}

	loader := projection.StoreLoader{Store: store, Commercial: commercial, Now: time.Now}
	writer := projection.NewRedisWriter(rdb, projection.DefaultTTL)
	worker := projection.NewWorker("it-worker", loader, writer)

	sub := rdb.Subscribe(ctx, projection.InvalidateChannel)
	defer sub.Close()

	n, err := worker.ProcessOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1 (the AssignTenantPlan dirty row)", n)
	}

	raw, err := rdb.Get(ctx, projection.Key(tn.ID.String())).Result()
	if err != nil {
		t.Fatalf("ent:%s:flat not written: %v", tn.ID, err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["plan_key"] != "pilot" {
		t.Errorf("projected plan_key = %v, want pilot", payload["plan_key"])
	}
	if payload["commercial_state"] != "active" {
		t.Errorf("projected commercial_state = %v, want active", payload["commercial_state"])
	}

	msgCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	msg, err := sub.ReceiveMessage(msgCtx)
	if err != nil {
		t.Fatalf("ent.invalidate not published: %v", err)
	}
	var inv struct {
		Tenant string `json:"tenant"`
	}
	if err := json.Unmarshal([]byte(msg.Payload), &inv); err != nil || inv.Tenant != tn.ID.String() {
		t.Errorf("ent.invalidate payload = %q, want tenant=%s", msg.Payload, tn.ID)
	}

	// The dirty queue is now empty for this tenant: a second pass is a no-op.
	n2, err := worker.ProcessOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 {
		t.Fatalf("second pass processed = %d, want 0 (dirty row already consumed)", n2)
	}
}
