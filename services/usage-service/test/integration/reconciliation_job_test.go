package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/events"
	"github.com/datacern-ai/usage-service/internal/recon"
)

// fakeBillStore is an in-memory recon.BillStore double standing in for a real
// MinIO/S3 bucket (proven separately by internal/jobs.MinioBillStore against
// the real go-common/objectstore client, which itself wraps minio-go — no
// protocol logic to fake-test here). It exists only to drive
// jobs.Runner.Reconcile as the running system does: list the drop prefix,
// then fetch each object, exactly the sequence cmd/server's hourly ticker
// performs. Test double only, per CONVENTIONS (never reachable from runtime).
type fakeBillStore struct {
	objs map[string][]byte
}

func (f *fakeBillStore) List(_ context.Context, prefix string) ([]recon.BillObject, error) {
	var out []recon.BillObject
	for k, v := range f.objs {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			out = append(out, recon.BillObject{Key: k, Size: int64(len(v))})
		}
	}
	return out, nil
}

func (f *fakeBillStore) Get(_ context.Context, key string) ([]byte, error) {
	return f.objs[key], nil
}

// TestAC09_ReconciliationJobBlocksChargeback drives the whole reconciliation
// job (Runner.Reconcile, the same method cmd/server's hourly ticker calls) —
// not just recon.Compute/store.UpsertReconciliation in isolation as
// TestAC09_ReconVarianceBlocksChargeback does. It proves the wiring: a
// provider-bill CSV dropped at the configured object-storage prefix, once the
// job runs, produces a real variance record that actually blocks chargeback
// (AC-9), and that acknowledging it actually unblocks. REAL: Postgres, Kafka.
func TestAC09_ReconciliationJobBlocksChargeback(t *testing.T) {
	h := requireHarness(t)
	ctx := context.Background()
	tenant := uuid.New()
	month := "2026-06"
	monthStart := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

	rec := domain.MeterRecord{Time: monthStart, TenantID: tenant, MeterKey: domain.MeterLLMInputTokens,
		Quantity: 1_000_000, WorkspaceID: ptr("ws-1"), EventID: uuid.New(), Cloud: "aws"}
	_, err := h.st.InsertRaw(ctx, []domain.MeterRecord{rec})
	require.NoError(t, err)
	require.NoError(t, h.st.RefreshRollups(ctx, monthStart.AddDate(0, 0, -1)))
	require.NoError(t, h.st.FinalizeMonth(ctx, month))

	op := domain.Op{Platform: true, Actor: domain.Actor{Type: "service", ID: "ops"}}
	card, err := h.st.CreateRateCard(ctx, op, domain.RateCard{Version: 1,
		EffectiveFrom: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		Items:         map[string]float64{domain.MeterLLMInputTokens: 0.000002}})
	require.NoError(t, err)
	_, err = h.st.ActivateRateCard(ctx, op, card.ID)
	require.NoError(t, err)

	// The bill CSV an operator dropped at bills/openai/2026-06.csv: 1,080,000
	// billed tokens against 1,000,000 metered — an 8% LLM overbill, over the
	// 5% threshold (USG-FR-071).
	billCSV := "meter_key,billed_quantity\nllm_input_tokens,1080000\n"
	h.runner.Bills = &fakeBillStore{objs: map[string][]byte{
		"bills/openai/" + month + ".csv": []byte(billCSV),
	}}
	h.runner.BillPrefix = "bills/"
	t.Cleanup(func() { h.runner.Bills = nil })

	n, err := h.runner.Reconcile(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n, "job should have processed exactly the one dropped bill object")

	status, err := h.st.ReconciliationStatus(ctx, month)
	require.NoError(t, err)
	require.Equal(t, domain.ReconVariance, status, "job-computed variance should mark the month blocking")

	evs := h.consumeUsageEvents(t, uuid.Nil, events.EvReconciliationVariance, 1, 15*time.Second)
	require.GreaterOrEqual(t, len(evs), 1)

	// Chargeback blocked while variance is unresolved -- the gate the job
	// feeds is genuinely live now, not permanently at its pending zero-value.
	tok := h.token(t, tenant, "user", "u", nil)
	rb := h.do(t, "GET", "/api/v1/reports/chargeback?month="+month, tok, nil, nil)
	require.Equal(t, 409, rb.status)
	require.Equal(t, "CONFLICT", errCode(rb))

	recs, err := h.st.ListReconciliations(ctx, 100)
	require.NoError(t, err)
	var found *domain.Reconciliation
	for i := range recs {
		if recs[i].Month == month && recs[i].Provider == "openai" {
			found = &recs[i]
			break
		}
	}
	require.NotNil(t, found, "reconciliation row for the dropped bill should exist")

	// Re-running the job on the same object is idempotent (no duplicate row,
	// no duplicate blocking event storm) -- a slow or repeated hourly tick is
	// harmless.
	n2, err := h.runner.Reconcile(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n2)

	require.NoError(t, h.st.AcknowledgeReconciliation(ctx, found.ID))
	ra := h.do(t, "GET", "/api/v1/reports/chargeback?month="+month, tok, nil, nil)
	require.Equal(t, 200, ra.status)
}

// TestReconcile_NoBillsConfigured_NoOp proves the honest no-op state: when no
// bill store is wired (e.g. MINIO_ENDPOINT unset), Reconcile does nothing
// rather than erroring -- but also does NOT fabricate a "matched" status, so
// the gate correctly stays pending (never silently reports a fake clean bill
// of health).
func TestReconcile_NoBillsConfigured_NoOp(t *testing.T) {
	h := requireHarness(t)
	ctx := context.Background()
	month := "2026-07"

	h.runner.Bills = nil
	n, err := h.runner.Reconcile(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, n)

	status, err := h.st.ReconciliationStatus(ctx, month)
	require.NoError(t, err)
	require.Equal(t, domain.ReconPending, status)
}
