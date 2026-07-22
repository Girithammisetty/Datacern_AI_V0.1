package integration

import (
	"context"
	"testing"

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
