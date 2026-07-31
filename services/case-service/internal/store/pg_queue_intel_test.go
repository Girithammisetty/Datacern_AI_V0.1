package store_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datacern-ai/case-service/internal/store"
)

// Queue-intelligence aggregation, exercised against a REAL Postgres with the
// service's own migrations applied.
//
// Deliberately not a hand-rolled schema or a fake: every claim here is about
// SQL semantics — FILTER clauses, interval arithmetic, percentile_cont, NULL
// handling — and none of that can be verified by anything except the database
// that will actually run it. A mock would only assert that I wrote down what I
// intended to write down.
//
// Skips when CASE_TEST_DATABASE_URL is unset so the default `go test ./...`
// stays hermetic. THE SKIP IS THE RISK: if CI never sets the variable these
// tests are a silent no-op, so the log line below says which one happened
// rather than quietly passing.
func testPool(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()
	url := os.Getenv("CASE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CASE_TEST_DATABASE_URL unset — queue-intelligence SQL NOT verified in this run")
	}
	if err := store.Migrate(url); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	return pool, pool.Close
}

// seedCase inserts one case directly, so each test states its own timeline
// (created/resolved/due) instead of depending on the API's clock.
func seedCase(t *testing.T, pool *pgxpool.Pool, tenant, ws uuid.UUID, n int64,
	status int16, createdAgo, dueIn time.Duration, resolvedAgo, closedAgo *time.Duration,
	createdBy ...string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	id := uuid.New()
	var resolved, closed *time.Time
	if resolvedAgo != nil {
		r := now.Add(-*resolvedAgo)
		resolved = &r
	}
	if closedAgo != nil {
		c := now.Add(-*closedAgo)
		closed = &c
	}
	// One transaction: app.tenant_id must be set on the SAME connection that
	// runs the INSERT or RLS rejects it. Setting it on the pool would land on
	// whichever connection came free — fine until it isn't.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	// The schema enforces (assigned_to_id IS NULL) = (status = 3): "unassigned"
	// IS the no-assignee state, it is not an independent flag. Honour it here so
	// the fixture is a shape the service could actually produce.
	by := "u-seed"
	if len(createdBy) > 0 && createdBy[0] != "" {
		by = createdBy[0]
	}
	var assignee *uuid.UUID
	var assignedAt *time.Time
	if status != 3 {
		a := uuid.New()
		at := now.Add(-createdAgo)
		assignee, assignedAt = &a, &at
	}
	_, err = tx.Exec(ctx, `INSERT INTO cases
		(id, tenant_id, workspace_id, case_number, status, severity, created_by_id,
		 dataset_urn, row_pk, display_projection, source_query_urns, due_date,
		 custom_fields, created_at, updated_at, resolved_at, closed_at,
		 assigned_to_id, assigned_to_at)
		VALUES ($1,$2,$3,$4,$5,'high',$13,'wr:t:dataset:dataset/d',$6,'{}','{}',
		        $7,'{}',$8,$8,$9,$10,$11,$12)`,
		id, tenant, ws, n, status, fmt.Sprintf("ROW-%d", n),
		now.Add(dueIn), now.Add(-createdAgo), resolved, closed, assignee, assignedAt, by)
	if err != nil {
		t.Fatalf("seed case: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return id
}

func TestQueueIntelligenceAggregates(t *testing.T) {
	pool, done := testPool(t)
	defer done()
	st := store.NewPG(pool)
	ctx := context.Background()
	tenant, ws := uuid.New(), uuid.New()
	hour := time.Hour
	day := 24 * hour

	// Open backlog spread across the aging buckets.
	seedCase(t, pool, tenant, ws, 1, 3, 2*hour, 5*day, nil, nil)  // unassigned, <24h
	seedCase(t, pool, tenant, ws, 2, 1, 2*day, 5*day, nil, nil)   // in_progress, 1-3d
	seedCase(t, pool, tenant, ws, 3, 1, 5*day, -1*hour, nil, nil) // in_progress, 3-7d, BREACHED
	seedCase(t, pool, tenant, ws, 4, 3, 10*day, 6*hour, nil, nil) // unassigned, >7d, due soon
	// Resolved + closed: must not count as open, but must count as throughput.
	r1 := 1 * hour
	seedCase(t, pool, tenant, ws, 5, 2, 3*day, 1*day, &r1, nil)
	// A CLOSED case still carries resolved_at — the real lifecycle is
	// resolve -> close, so it counts as resolved throughput and as a latency
	// sample. Only closed_at makes it "closed".
	r2, c2 := 2*hour, 1*hour
	seedCase(t, pool, tenant, ws, 6, 4, 4*day, 1*day, &r2, &c2)

	got, err := st.QueueIntelligence(ctx, tenant, ws, 7)
	if err != nil {
		t.Fatalf("QueueIntelligence: %v", err)
	}

	if got.Open.Total != 4 {
		t.Errorf("open total = %d, want 4 (resolved+closed must be excluded)", got.Open.Total)
	}
	if got.Open.Unassigned != 2 || got.Open.InProgress != 2 {
		t.Errorf("open split = %d unassigned / %d in_progress, want 2/2",
			got.Open.Unassigned, got.Open.InProgress)
	}

	want := map[string]int{"under_24h": 1, "1_to_3d": 1, "3_to_7d": 1, "over_7d": 1}
	for _, b := range got.Aging {
		if b.Count != want[b.Label] {
			t.Errorf("aging[%s] = %d, want %d", b.Label, b.Count, want[b.Label])
		}
	}
	// The buckets partition the open set — no case counted twice or dropped.
	sum := 0
	for _, b := range got.Aging {
		sum += b.Count
	}
	if sum != got.Open.Total {
		t.Errorf("aging buckets sum to %d but %d cases are open — buckets must partition",
			sum, got.Open.Total)
	}

	if got.SLA.Breached != 1 {
		t.Errorf("breached = %d, want 1", got.SLA.Breached)
	}
	if got.SLA.DueWithin24h != 1 {
		t.Errorf("due_within_24h = %d, want 1 (breached must NOT be counted again here)",
			got.SLA.DueWithin24h)
	}

	// Both the resolved case AND the closed one carry resolved_at, so both are
	// resolved throughput; only one has closed_at.
	if got.Throughput.Resolved != 2 || got.Throughput.Closed != 1 {
		t.Errorf("throughput = %d resolved / %d closed, want 2/1",
			got.Throughput.Resolved, got.Throughput.Closed)
	}
	// 5, not 6: the >7d case was created OUTSIDE a 7-day window, so it is
	// backlog but not intake. Counting it would overstate arrival rate.
	if got.Throughput.Opened != 5 {
		t.Errorf("opened = %d, want 5 (the 10-day-old case is outside the window)",
			got.Throughput.Opened)
	}

	// Two resolved-in-window cases: 3d-1h and 4d-2h from creation to resolution.
	if got.Latency.Sample != 2 {
		t.Fatalf("latency sample = %d, want 2", got.Latency.Sample)
	}
	if got.Latency.P50Seconds == nil || got.Latency.P90Seconds == nil {
		t.Fatal("percentiles nil despite resolved cases in the window")
	}
	lo := int64((3*day - 1*hour).Seconds())
	hi := int64((4*day - 2*hour).Seconds())
	// Asserting the bracket rather than an exact interpolation: the point is
	// that the percentile is a real created->resolved duration, not that I can
	// reproduce percentile_cont's arithmetic.
	if *got.Latency.P50Seconds < lo-60 || *got.Latency.P50Seconds > hi+60 {
		t.Errorf("p50 = %ds, want within [%d,%d]", *got.Latency.P50Seconds, lo, hi)
	}
	if *got.Latency.P90Seconds < *got.Latency.P50Seconds {
		t.Errorf("p90 (%d) < p50 (%d) — percentiles inverted",
			*got.Latency.P90Seconds, *got.Latency.P50Seconds)
	}
}

// An empty window must report "no data", not "zero latency" — a p50 of 0 would
// tell an approver decisions are instant.
func TestQueueIntelligenceNullPercentilesOnEmptyWindow(t *testing.T) {
	pool, done := testPool(t)
	defer done()
	st := store.NewPG(pool)
	tenant, ws := uuid.New(), uuid.New()
	seedCase(t, pool, tenant, ws, 1, 1, 2*time.Hour, 5*24*time.Hour, nil, nil) // open, never resolved

	got, err := st.QueueIntelligence(context.Background(), tenant, ws, 7)
	if err != nil {
		t.Fatalf("QueueIntelligence: %v", err)
	}
	if got.Latency.Sample != 0 {
		t.Errorf("sample = %d, want 0", got.Latency.Sample)
	}
	if got.Latency.P50Seconds != nil || got.Latency.P90Seconds != nil {
		t.Errorf("percentiles = %v/%v, want nil/nil — 0 would read as instant decisions",
			got.Latency.P50Seconds, got.Latency.P90Seconds)
	}
}

// Department isolation: the aggregate must not count another workspace's cases.
// A count is a disclosure too — "how big is their backlog" is exactly what the
// /cases workspace rules exist to withhold.
func TestQueueIntelligenceIsWorkspaceScoped(t *testing.T) {
	pool, done := testPool(t)
	defer done()
	st := store.NewPG(pool)
	tenant := uuid.New()
	wsA, wsB := uuid.New(), uuid.New()
	seedCase(t, pool, tenant, wsA, 1, 1, time.Hour, 24*time.Hour, nil, nil)
	seedCase(t, pool, tenant, wsB, 2, 1, time.Hour, 24*time.Hour, nil, nil)
	seedCase(t, pool, tenant, wsB, 3, 1, time.Hour, 24*time.Hour, nil, nil)

	got, err := st.QueueIntelligence(context.Background(), tenant, wsA, 7)
	if err != nil {
		t.Fatalf("QueueIntelligence: %v", err)
	}
	if got.Open.Total != 1 {
		t.Errorf("workspace A sees %d open cases, want 1 — workspace B's 2 must not leak",
			got.Open.Total)
	}
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}


// A case raised by a TRIGGER is counted separately from one a person opened.
// "12 new cases" and "12 new cases, 11 raised by a rule" are different facts,
// and only the second tells an approver to go look at the rule.
func TestQueueIntelligenceSeparatesAutoOpenedCases(t *testing.T) {
	pool, done := testPool(t)
	defer done()
	st := store.NewPG(pool)
	tenant, ws := uuid.New(), uuid.New()
	hour := time.Hour

	seedCase(t, pool, tenant, ws, 1, 3, 2*hour, 24*hour, nil, nil)                        // human
	seedCase(t, pool, tenant, ws, 2, 3, 2*hour, 24*hour, nil, nil, "trigger/high-amount") // rule
	seedCase(t, pool, tenant, ws, 3, 3, 2*hour, 24*hour, nil, nil, "trigger/high-amount") // rule
	// Outside the window: opened long ago, so neither count includes it.
	seedCase(t, pool, tenant, ws, 4, 3, 30*24*hour, 24*hour, nil, nil, "trigger/old-rule")

	got, err := st.QueueIntelligence(context.Background(), tenant, ws, 7)
	if err != nil {
		t.Fatalf("QueueIntelligence: %v", err)
	}
	if got.Throughput.Opened != 3 {
		t.Errorf("opened = %d, want 3 (the 30-day-old case is outside the window)",
			got.Throughput.Opened)
	}
	if got.Throughput.AutoOpened != 2 {
		t.Errorf("auto_opened = %d, want 2", got.Throughput.AutoOpened)
	}
	// AutoOpened is a SUBSET of Opened, never a parallel total — a UI showing
	// "3 new, 5 automatic" would be nonsense.
	if got.Throughput.AutoOpened > got.Throughput.Opened {
		t.Errorf("auto_opened (%d) exceeds opened (%d) — it must be a subset",
			got.Throughput.AutoOpened, got.Throughput.Opened)
	}
}
