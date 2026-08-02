package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/usage-service/internal/billing"
	"github.com/datacern-ai/usage-service/internal/domain"
)

// TestBillingClose_EndToEnd drives the whole period-close job (Runner.CloseBilling,
// the same method cmd/server's daily ticker calls) against real Postgres: seed
// governed_decision usage → refresh rollups → finalize the month → close →
// assert a billing_periods row + its export exist and ListBillingPeriods returns
// them, with the file artifacts written to a temp object store. REAL: Postgres.
//
// It also asserts the two ordering gates: an unfinalized month does NOT close,
// and a re-run of an already-closed month is a no-op (no duplicate version).
func TestBillingClose_EndToEnd(t *testing.T) {
	h := requireHarness(t)
	ctx := context.Background()
	tenant := uuid.New()
	month := "2026-05"
	monthStart := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)

	// Seed a governed_decision meter row and roll it up.
	rec := domain.MeterRecord{
		Time: monthStart, TenantID: tenant, MeterKey: domain.MeterGovernedDecision,
		Quantity: 842, AgentID: ptr("case-triage"), Decision: ptr("approved"),
		EventID: uuid.New(), Cloud: "aws",
	}
	_, err := h.st.InsertRaw(ctx, []domain.MeterRecord{rec})
	require.NoError(t, err)
	require.NoError(t, h.st.RefreshRollups(ctx, monthStart.AddDate(0, 0, -1)))

	// A dedicated runner with a temp-dir artifact store and the default
	// (unconfigured) pusher — close must succeed and record the export whether
	// or not a provider push is wired (file path is truth, AC-6).
	runner := h.runner
	prevArtifacts := runner.Artifacts
	prevPusher := runner.Pusher
	runner.Artifacts = billing.NewFSArtifactStore(t.TempDir())
	runner.Pusher = &domain.UnconfiguredPusher{Adapter: "stripe", Reason: "test: unconfigured"}
	t.Cleanup(func() { runner.Artifacts = prevArtifacts; runner.Pusher = prevPusher })

	// Gate 1: not finalized → no close.
	require.NoError(t, runner.CloseBilling(ctx, tenant, month))
	got, err := h.st.ListBillingPeriods(ctx, tenant, month, 50)
	require.NoError(t, err)
	assert.Empty(t, got, "unfinalized month must not close")

	// Finalize, then close for real.
	require.NoError(t, h.st.FinalizeMonth(ctx, month))
	require.NoError(t, runner.CloseBilling(ctx, tenant, month))

	got, err = h.st.ListBillingPeriods(ctx, tenant, month, 50)
	require.NoError(t, err)
	require.Len(t, got, 1)
	rowRec := got[0]
	assert.Equal(t, month, rowRec.Period)
	assert.Equal(t, 1, rowRec.Version)
	assert.Equal(t, domain.BillingExported, rowRec.Status)
	require.NotNil(t, rowRec.Export)
	assert.Len(t, rowRec.Export.JSONLSHA256, 64)
	assert.Contains(t, rowRec.Export.JSONLKey, "billing/"+tenant.String()+"/"+month+"/1/")
	// Unconfigured pusher → the export is annotated honestly, not left blank.
	require.NotNil(t, rowRec.Export.PushedStatus)
	assert.Equal(t, domain.PushNotConfigured, *rowRec.Export.PushedStatus)

	// Gate 2: re-running an already-closed, uncorrected month is a no-op.
	require.NoError(t, runner.CloseBilling(ctx, tenant, month))
	got, err = h.st.ListBillingPeriods(ctx, tenant, month, 50)
	require.NoError(t, err)
	assert.Len(t, got, 1, "re-close must not mint a duplicate version")
}
