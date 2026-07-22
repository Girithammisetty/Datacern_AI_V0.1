//go:build integration

package integration

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/domain"
	"github.com/datacern-ai/audit-service/internal/pgstore"
	"github.com/datacern-ai/audit-service/internal/siemexport"
)

// pgConfigLookup adapts *pgstore.Store to siemexport.ConfigLookup, mirroring
// cmd/server/main.go's unexported siemConfigLookup so this test exercises the
// SAME store method (ActiveSiemConfigForDelivery) against REAL, RLS-enforced
// Postgres rather than the fakeConfigLookup map used by siemexport's own unit
// tests (internal/siemexport/delivery_test.go).
type pgConfigLookup struct{ store *pgstore.Store }

func (l pgConfigLookup) ActiveSiemConfigForDelivery(ctx context.Context, tenant uuid.UUID) (*siemexport.SiemDestination, error) {
	cfg, err := l.store.ActiveSiemConfigForDelivery(ctx, tenant)
	if err != nil || cfg == nil {
		return nil, err
	}
	return &siemexport.SiemDestination{Endpoint: cfg.Endpoint, Format: siemexport.Format(cfg.Format), AuthRef: cfg.AuthRef}, nil
}

// TestSiemConfigTwoTenantsNoCrossDelivery (BRD 59 WS2): two tenants each
// propose + approve (real four-eyes, distinct approver) their own SIEM
// destination against real RLS-enforced Postgres. Delivering one tenant's
// event must reach ONLY that tenant's collector, and a raw predicate-free
// scan under one tenant's session must never see the other tenant's config
// row -- proving isolation is enforced by Postgres RLS (MASTER-FR-001), not
// merely by ActiveSiemConfigForDelivery's own WHERE tenant_id=$1 clause.
func TestSiemConfigTwoTenantsNoCrossDelivery(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	var muA, muB sync.Mutex
	var gotA, gotB []string
	srvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		muA.Lock()
		gotA = append(gotA, string(b))
		muA.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srvA.Close()
	srvB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		muB.Lock()
		gotB = append(gotB, string(b))
		muB.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srvB.Close()

	tenantA, tenantB := uuid.New(), uuid.New()

	cfgA, err := h.pg.ProposeSiemConfig(ctx, tenantA, srvA.URL, "JSON", "", "requester-a")
	if err != nil {
		t.Fatalf("propose A: %v", err)
	}
	if _, err := h.pg.ApproveSiemConfig(ctx, tenantA, cfgA.ID, "approver-a"); err != nil {
		t.Fatalf("approve A: %v", err)
	}
	cfgB, err := h.pg.ProposeSiemConfig(ctx, tenantB, srvB.URL, "CEF", "", "requester-b")
	if err != nil {
		t.Fatalf("propose B: %v", err)
	}
	if _, err := h.pg.ApproveSiemConfig(ctx, tenantB, cfgB.ID, "approver-b"); err != nil {
		t.Fatalf("approve B: %v", err)
	}

	// allowHTTP=true: both destinations are httptest loopback servers (http://),
	// which the real SSRF guard would otherwise reject (its own direct tests
	// live in libs/go-common/httpx).
	delivery := siemexport.NewHTTPDelivery(pgConfigLookup{store: h.pg}, true)

	recA := domain.Record{
		EventID: uuid.New(), EventType: "case.assigned", TenantID: tenantA,
		ActorType: "user", ActorID: "u-a", ResourceURN: "wr:" + tenantA.String() + ":case:case/a-1",
		OccurredAt: time.Now().UTC(),
	}
	recB := domain.Record{
		EventID: uuid.New(), EventType: "case.assigned", TenantID: tenantB,
		ActorType: "user", ActorID: "u-b", ResourceURN: "wr:" + tenantB.String() + ":case:case/b-1",
		OccurredAt: time.Now().UTC(),
	}
	delivery.Deliver(ctx, tenantA, siemexport.Envelope(recA))
	delivery.Deliver(ctx, tenantB, siemexport.Envelope(recB))

	muA.Lock()
	muB.Lock()
	defer muA.Unlock()
	defer muB.Unlock()

	if len(gotA) != 1 || !strings.Contains(gotA[0], recA.EventID.String()) {
		t.Fatalf("tenant A's collector should have received exactly tenant A's event, got %v", gotA)
	}
	if len(gotB) != 1 || !strings.Contains(gotB[0], recB.EventID.String()) {
		t.Fatalf("tenant B's collector should have received exactly tenant B's event, got %v", gotB)
	}
	if strings.Contains(gotA[0], recB.EventID.String()) {
		t.Fatal("cross-delivery: tenant A's collector received tenant B's event")
	}
	if strings.Contains(gotB[0], recA.EventID.String()) {
		t.Fatal("cross-delivery: tenant B's collector received tenant A's event")
	}

	// RLS proof (mirrors TestAC09b_PostgresRLSNonOwner): a raw, predicate-free
	// scan under tenant A's session must see exactly tenant A's own row, even
	// though tenant B's approved row exists in the same shared table.
	conn, err := h.pg.Pool().Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT set_config('app.tenant_id',$1,false)", tenantA.String()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM tenant_siem_configs").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("RLS breach: tenant A's session saw %d siem config rows (want exactly its own 1)", n)
	}
}
