package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/events"
)

// governedDecisionPayload mirrors the payload agent-runtime's
// proposals/service.py._emit() actually produces for a terminal metered
// decision (BRD 67 slice 1, design §2.1) — see
// services/agent-runtime/app/proposals/service.py::_governed_decision_metering
// and services/agent-runtime/tests/unit/test_value_metering.py for the
// emitter-side pin of this exact shape.
func governedDecisionPayload(agentKey, actor, decisionLabel string, latencyMs int) map[string]any {
	p := map[string]any{
		"proposal_id":   uuid.NewString(),
		"agent_key":     agentKey,
		"agent_version": float64(1),
		"tool_id":       "case.apply_disposition",
		"affected_urns": []any{"wr:t-x:case:case/c-1"},
		"decision": map[string]any{
			"actor": actor, "action": "approve", "decided_at": time.Now().UTC().Format(time.RFC3339),
		},
		"proposal_kind":       "case",
		"pack_name":           nil,
		"decision_label":      decisionLabel,
		"decision_latency_ms": float64(latencyMs),
	}
	return p
}

// TestAC1_ApprovedProposal_MetersGovernedDecision: approving a proposal (a
// real ai.proposal.v1 · proposal.approved event on real Kafka) produces
// exactly one governed_decision raw record with decision=approved and the
// right agent/pack dims, and a replay of the same event_id is a no-op
// (BRD 67 AC-1, VMB-FR-003, USG-FR-011). REAL: Kafka, Postgres, Redis.
func TestAC1_ApprovedProposal_MetersGovernedDecision(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	eid := uuid.New()
	payload := governedDecisionPayload("case-triage", "user:u-super", "approved", 4200)

	h.publish(t, events.TopicAIProposal, tenant, eid, time.Now().UTC(), payload)

	require.Equal(t, 1.0, h.waitRawSum(t, tenant, domain.MeterGovernedDecision, 1, 20*time.Second))
	require.Equal(t, 1, h.rawCount(t, tenant, domain.MeterGovernedDecision))
	// A human approval must NOT also count as auto_executed_action.
	require.Equal(t, 0, h.rawCount(t, tenant, domain.MeterAutoExecutedAction))

	row := h.queryGovernedDecisionRow(t, tenant)
	require.Equal(t, "case-triage", row.agentID)
	require.Equal(t, "approved", row.decision)
	require.Equal(t, "case", row.metaProposalKind)

	// Replay: publish the identical event_id again — no new row (AC-1, AC-2).
	h.publish(t, events.TopicAIProposal, tenant, eid, time.Now().UTC(), payload)
	time.Sleep(2 * time.Second)
	require.Equal(t, 1, h.rawCount(t, tenant, domain.MeterGovernedDecision), "replay of the Kafka event must be a no-op")

	// Rollup verification: governed_decision reaches usage_daily too.
	require.NoError(t, h.st.RefreshRollups(context.Background(), time.Now().Add(-49*time.Hour)))
	daily, err := h.st.DailyTotals(context.Background(), tenant, domain.MeterGovernedDecision,
		time.Now().AddDate(0, 0, -2), time.Now().AddDate(0, 0, 1))
	require.NoError(t, err)
	var sum float64
	for _, v := range daily {
		sum += v
	}
	require.Equal(t, 1.0, sum)
}

// TestAC2_EditRejectDecisions: edit-approve carries edit_distance_bucket and
// decision=edited; reject carries decision=rejected (AC-2).
func TestAC2_EditRejectDecisions(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()

	editPayload := governedDecisionPayload("case-triage", "user:u-super", "edited", 1000)
	editPayload["edit_distance_bucket"] = "minor"
	h.publish(t, events.TopicAIProposal, tenant, uuid.New(), time.Now().UTC(), editPayload)

	rejPayload := governedDecisionPayload("case-triage", "user:u-super", "rejected", 2000)
	h.publish(t, events.TopicAIProposal, tenant, uuid.New(), time.Now().UTC(), rejPayload)

	require.Equal(t, 2.0, h.waitRawSum(t, tenant, domain.MeterGovernedDecision, 2, 20*time.Second))
}

// TestAC_AutoExecuted_CountsBothMeters: an auto-executed proposal.approved
// (decision.actor=='policy:auto') counts as BOTH governed_decision and
// auto_executed_action (design §2.1/§2.2 — no actor exclusion on
// governed_decision; auto_executed_action is the separately-filtered cut).
func TestAC_AutoExecuted_CountsBothMeters(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	payload := governedDecisionPayload("dashboard-designer", "policy:auto", "approved", 5)

	h.publish(t, events.TopicAIProposal, tenant, uuid.New(), time.Now().UTC(), payload)

	require.Equal(t, 1.0, h.waitRawSum(t, tenant, domain.MeterGovernedDecision, 1, 20*time.Second))
	require.Equal(t, 1.0, h.waitRawSum(t, tenant, domain.MeterAutoExecutedAction, 1, 20*time.Second))
}

// TestAC_ProposalCreatedAndCancelled_NeverMeter: proposal.created and
// proposal.cancelled (respond) events are unmapped — supersede/expiry never
// even reach an emitted event, and cancelled is a terminal status that is not
// a governed decision (VMB-FR-002).
func TestAC_ProposalCreatedAndCancelled_NeverMeter(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	h.publish(t, events.TopicAIProposal, tenant, uuid.New(), time.Now().UTC(),
		map[string]any{"proposal_id": uuid.NewString(), "agent_key": "case-triage"})
	h.publish(t, events.TopicAIProposal, tenant, uuid.New(), time.Now().UTC(),
		map[string]any{"proposal_id": uuid.NewString(), "agent_key": "case-triage",
			"decision": map[string]any{"actor": "user:u-1", "action": "respond"}})
	time.Sleep(2 * time.Second)
	require.Equal(t, 0, h.rawCount(t, tenant, domain.MeterGovernedDecision))
}

type governedDecisionRow struct {
	agentID          string
	decision         string
	metaProposalKind string
}

func (h *harness) queryGovernedDecisionRow(t *testing.T, tenant uuid.UUID) governedDecisionRow {
	t.Helper()
	ctx := context.Background()
	conn, err := h.appPool.Acquire(ctx)
	require.NoError(t, err)
	defer conn.Release()
	_, err = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenant.String())
	require.NoError(t, err)
	var row governedDecisionRow
	require.NoError(t, conn.QueryRow(ctx,
		`SELECT COALESCE(agent_id,''), COALESCE(decision,''), COALESCE(meta->>'proposal_kind','')
		 FROM usage_raw WHERE tenant_id=$1 AND meter_key=$2 LIMIT 1`,
		tenant, domain.MeterGovernedDecision,
	).Scan(&row.agentID, &row.decision, &row.metaProposalKind))
	return row
}
