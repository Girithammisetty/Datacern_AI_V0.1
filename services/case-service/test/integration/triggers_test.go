package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/case-service/internal/domain"
	"github.com/datacern-ai/case-service/internal/triggers"
)

// fakeRows is the test-tier RowsClient double (network substitute only — the
// store, RLS, dedup and case-creation path underneath are all real).
type fakeRows struct {
	page  *triggers.RowsPage
	calls int
}

func (f *fakeRows) BrowseRows(_ context.Context, _ uuid.UUID, _ string,
	_ []domain.TriggerCondition, _ int) (*triggers.RowsPage, error) {
	f.calls++
	return f.page, nil
}

func (f *fakeRows) BrowseDeltaRows(_ context.Context, _ uuid.UUID, _ string, _ string,
	_ []domain.TriggerCondition, _ int) (*triggers.RowsPage, error) {
	return nil, errNoDelta // these tests exercise the legacy path only
}

func (f *fakeRows) CurrentSnapshotID(_ context.Context, _ uuid.UUID, _ string) (string, error) {
	return "", nil
}

var errNoDelta = errors.New("delta browse not wired in this double")

// TestCaseTriggers_CRUD_ApplyAndDedup exercises the full INC-1 core slice
// against real Postgres: trigger CRUD under RLS, the applier materializing
// dataset rows as cases, and idempotency on redelivery (dedup by
// dataset_urn+row_pk — a replayed ingestion.completed creates nothing new).
func TestCaseTriggers_CRUD_ApplyAndDedup(t *testing.T) {
	requireHarness(t)
	ctx := context.Background()
	tenant, ws := uuid.New(), uuid.New()

	// ---- CRUD under RLS ----
	tr := &domain.CaseTrigger{
		ID: domain.NewID(), TenantID: tenant, WorkspaceID: ws,
		Name: "high-value", Enabled: true, DatasetName: "auto-claims",
		Conditions: []domain.TriggerCondition{{Col: "amount", Op: "gt", Value: "5000"}},
		RowPKField: "claim_id", ProjectionFields: []string{"claim_id", "amount"},
	}
	tr.Normalize()
	require.Nil(t, tr.Validate())
	require.NoError(t, h.pg.CreateTrigger(ctx, tr))

	list, err := h.pg.ListTriggers(ctx, tenant, ws)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "high-value", list[0].Name)
	require.Equal(t, "claim_id", list[0].RowPKField)

	// RLS: another tenant sees nothing.
	other, err := h.pg.ListEnabledTriggers(ctx, uuid.New())
	require.NoError(t, err)
	require.Empty(t, other)

	// ---- apply: rows -> cases through the real CreateCases path ----
	datasetURN := "wr:" + tenant.String() + ":dataset:dataset/" + uuid.NewString()
	rows := &fakeRows{page: &triggers.RowsPage{
		Columns: []string{"claim_id", "amount", "claimant"},
		Rows: [][]any{
			{"CLM-1", "9000", "Ada"},
			{"CLM-2", "7500", "Grace"},
		},
	}}
	applier := &triggers.Applier{Store: h.pg, Rows: rows}
	payload := map[string]any{
		"dataset_urn": datasetURN, "dataset_id": uuid.NewString(),
		"dataset_name": "auto-claims", "workspace_id": ws.String(),
	}
	require.NoError(t, applier.ApplyIngestionCompleted(ctx, tenant, payload))
	require.Equal(t, 1, rows.calls, "matching trigger should fetch rows once")

	created, _ := h.pg.OutboxEventsByType(ctx, tenant, "case.created")
	require.Len(t, created, 2, "two rows -> two cases")

	// ---- idempotency: redelivery creates nothing new ----
	require.NoError(t, applier.ApplyIngestionCompleted(ctx, tenant, payload))
	created, _ = h.pg.OutboxEventsByType(ctx, tenant, "case.created")
	require.Len(t, created, 2, "replayed event must not duplicate cases (DedupKey)")

	// ---- non-matching dataset: no fetch, no cases ----
	prevCalls := rows.calls
	require.NoError(t, applier.ApplyIngestionCompleted(ctx, tenant, map[string]any{
		"dataset_urn": "wr:x:dataset:dataset/other", "dataset_id": uuid.NewString(),
		"dataset_name": "unrelated",
	}))
	require.Equal(t, prevCalls, rows.calls, "non-matching source must not fetch rows")

	// ---- disable pauses the trigger ----
	tr.Enabled = false
	require.NoError(t, h.pg.UpdateTrigger(ctx, tr))
	enabled, err := h.pg.ListEnabledTriggers(ctx, tenant)
	require.NoError(t, err)
	require.Empty(t, enabled)

	// ---- delete ----
	require.NoError(t, h.pg.DeleteTrigger(ctx, tenant, ws, tr.ID))
	list, err = h.pg.ListTriggers(ctx, tenant, ws)
	require.NoError(t, err)
	require.Empty(t, list)
}

// snapRows simulates dataset-service around an APPEND fire: until the
// registered current version "catches up" to the event's snapshot, browse
// serves the pre-append page — exactly the race the slice-6 journey caught
// live (second fire opened zero cases because every stale row deduped).
type snapRows struct {
	checks   int
	catchAt  int    // CurrentSnapshotID calls before the new snapshot appears
	snapshot string // what the event's iceberg_snapshot_id canonicalizes to
	stale    *triggers.RowsPage
	fresh    *triggers.RowsPage
}

func (s *snapRows) CurrentSnapshotID(_ context.Context, _ uuid.UUID, _ string) (string, error) {
	s.checks++
	if s.checks >= s.catchAt {
		return s.snapshot, nil
	}
	return "1010101", nil
}

func (s *snapRows) BrowseRows(_ context.Context, _ uuid.UUID, _ string,
	_ []domain.TriggerCondition, _ int) (*triggers.RowsPage, error) {
	if s.checks >= s.catchAt {
		return s.fresh, nil
	}
	return s.stale, nil
}

func (s *snapRows) BrowseDeltaRows(_ context.Context, _ uuid.UUID, _ string, _ string,
	_ []domain.TriggerCondition, _ int) (*triggers.RowsPage, error) {
	return nil, errNoDelta
}

// TestCaseTriggers_AppendFireWaitsForSnapshotRegistration: an append
// ingestion.completed must not browse until dataset-service has registered
// the event's snapshot — otherwise the increment is invisible and dedup
// swallows the whole event.
func TestCaseTriggers_AppendFireWaitsForSnapshotRegistration(t *testing.T) {
	requireHarness(t)
	ctx := context.Background()
	tenant, ws := uuid.New(), uuid.New()

	tr := &domain.CaseTrigger{
		ID: domain.NewID(), TenantID: tenant, WorkspaceID: ws,
		Name: "orders-stream", Enabled: true, DatasetName: "orders",
		RowPKField: "id",
	}
	tr.Normalize()
	require.NoError(t, h.pg.CreateTrigger(ctx, tr))

	datasetURN := "wr:" + tenant.String() + ":dataset:dataset/" + uuid.NewString()
	stale := &triggers.RowsPage{Columns: []string{"id", "amount"}, Rows: [][]any{{"1", "5000"}}}
	fresh := &triggers.RowsPage{Columns: []string{"id", "amount"}, Rows: [][]any{{"1", "5000"}, {"2", "9000"}}}

	// The event's snapshot id arrives as float64 (plain json decode of an
	// int64 beyond float64's exact range) — the wait must still match it
	// against the detail API's exact decimal string form.
	const snapID = int64(721389546218946213)
	rows := &snapRows{catchAt: 3, snapshot: "721389546218946213", stale: stale, fresh: fresh}
	applier := &triggers.Applier{Store: h.pg, Rows: rows, SnapshotPollInterval: 10 * time.Millisecond}

	// First fire: dataset registered at the event snapshot after 2 stale polls.
	require.NoError(t, applier.ApplyIngestionCompleted(ctx, tenant, map[string]any{
		"dataset_urn": datasetURN, "dataset_id": uuid.NewString(),
		"dataset_name": "orders", "workspace_id": ws.String(),
		"iceberg_snapshot_id": float64(snapID),
	}))
	require.GreaterOrEqual(t, rows.checks, 3, "must poll until registration reaches the event snapshot")

	created, _ := h.pg.OutboxEventsByType(ctx, tenant, "case.created")
	require.Len(t, created, 2, "the browse must see the POST-append page (both rows), not the stale one")
}

// deltaRows counts which read path the applier takes: the snapshot-delta read
// (BrowseDeltaRows), the legacy full browse, and registration polls.
type deltaRows struct {
	deltaCalls int
	fullCalls  int
	snapChecks int
	failDelta  bool
	page       *triggers.RowsPage
}

func (d *deltaRows) BrowseDeltaRows(_ context.Context, _ uuid.UUID, _ string, _ string,
	_ []domain.TriggerCondition, _ int) (*triggers.RowsPage, error) {
	d.deltaCalls++
	if d.failDelta {
		return nil, errors.New("dataset browse_rows: status 500: boom")
	}
	return d.page, nil
}

func (d *deltaRows) BrowseRows(_ context.Context, _ uuid.UUID, _ string,
	_ []domain.TriggerCondition, _ int) (*triggers.RowsPage, error) {
	d.fullCalls++
	return d.page, nil
}

func (d *deltaRows) CurrentSnapshotID(_ context.Context, _ uuid.UUID, _ string) (string, error) {
	d.snapChecks++
	return "", nil
}

// TestCaseTriggers_DeltaBrowseSkipsRegistrationWait: with TRIGGER_DELTA_BROWSE
// on and an ingestion_id in the event, the applier evaluates conditions over
// the ingestion's delta directly — zero CurrentSnapshotID polls, zero
// full-snapshot browses — and cases still flow through the real CreateCases
// path with dedup intact.
func TestCaseTriggers_DeltaBrowseSkipsRegistrationWait(t *testing.T) {
	requireHarness(t)
	ctx := context.Background()
	tenant, ws := uuid.New(), uuid.New()

	tr := &domain.CaseTrigger{
		ID: domain.NewID(), TenantID: tenant, WorkspaceID: ws,
		Name: "delta-stream", Enabled: true, DatasetName: "orders",
		RowPKField: "id",
	}
	tr.Normalize()
	require.NoError(t, h.pg.CreateTrigger(ctx, tr))

	datasetURN := "wr:" + tenant.String() + ":dataset:dataset/" + uuid.NewString()
	rows := &deltaRows{page: &triggers.RowsPage{
		Columns: []string{"id", "amount"},
		Rows:    [][]any{{"D1", "5000"}, {"D2", "9000"}},
	}}
	applier := &triggers.Applier{Store: h.pg, Rows: rows, DeltaBrowse: true,
		SnapshotPollInterval: 10 * time.Millisecond}

	payload := map[string]any{
		"dataset_urn": datasetURN, "dataset_id": uuid.NewString(),
		"dataset_name": "orders", "workspace_id": ws.String(),
		"iceberg_snapshot_id": float64(721389546218946213),
		"ingestion_id":        uuid.NewString(),
	}
	require.NoError(t, applier.ApplyIngestionCompleted(ctx, tenant, payload))
	require.Equal(t, 1, rows.deltaCalls, "delta path must browse the ingestion delta")
	require.Equal(t, 0, rows.fullCalls, "delta path must not rescan the full snapshot")
	require.Equal(t, 0, rows.snapChecks, "delta path must not wait on version registration")

	created, _ := h.pg.OutboxEventsByType(ctx, tenant, "case.created")
	require.Len(t, created, 2)

	// Redelivery stays idempotent on the delta path too.
	require.NoError(t, applier.ApplyIngestionCompleted(ctx, tenant, payload))
	created, _ = h.pg.OutboxEventsByType(ctx, tenant, "case.created")
	require.Len(t, created, 2, "replayed event must not duplicate cases")
}

// TestCaseTriggers_DeltaBrowseFallsBackToFullBrowse: a delta failure must
// degrade to the legacy full-snapshot browse (with its registration wait) —
// enabling the flag can cost latency, never a lost fire.
func TestCaseTriggers_DeltaBrowseFallsBackToFullBrowse(t *testing.T) {
	requireHarness(t)
	ctx := context.Background()
	tenant, ws := uuid.New(), uuid.New()

	tr := &domain.CaseTrigger{
		ID: domain.NewID(), TenantID: tenant, WorkspaceID: ws,
		Name: "delta-fallback", Enabled: true, DatasetName: "orders",
		RowPKField: "id",
	}
	tr.Normalize()
	require.NoError(t, h.pg.CreateTrigger(ctx, tr))

	datasetURN := "wr:" + tenant.String() + ":dataset:dataset/" + uuid.NewString()
	rows := &deltaRows{failDelta: true, page: &triggers.RowsPage{
		Columns: []string{"id", "amount"},
		Rows:    [][]any{{"F1", "5000"}},
	}}
	applier := &triggers.Applier{Store: h.pg, Rows: rows, DeltaBrowse: true,
		SnapshotPollInterval: 10 * time.Millisecond}

	require.NoError(t, applier.ApplyIngestionCompleted(ctx, tenant, map[string]any{
		"dataset_urn": datasetURN, "dataset_id": uuid.NewString(),
		"dataset_name": "orders", "workspace_id": ws.String(),
		"ingestion_id": uuid.NewString(),
	}))
	require.Equal(t, 1, rows.deltaCalls, "delta must be attempted first")
	require.Equal(t, 1, rows.fullCalls, "failure must fall back to the full browse")

	created, _ := h.pg.OutboxEventsByType(ctx, tenant, "case.created")
	require.Len(t, created, 1, "the fallback fire must still open the case")
}
