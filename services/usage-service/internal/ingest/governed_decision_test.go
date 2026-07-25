// BRD 67 slice 1 — governed_decision / auto_executed_action ingest mapping
// (design §2.1/§2.2). Covers: catalog mapping correctness (dims from
// agent-runtime's actual payload shape, meta extraction), auto-executed
// double-counting into both meters, and that replaying the same envelope
// twice produces identical per-record identity (time/tenant/event_id/
// meter_key) — the actual no-op-on-replay guarantee (USG-FR-011) lives in
// the store's unique constraint (integration-tested), but this pins that the
// pipeline itself is deterministic and gives the store nothing to disagree on.
package ingest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	gcevent "github.com/datacern-ai/go-common/event"
	"github.com/datacern-ai/usage-service/internal/domain"
)

func approvedPayload(actor string) map[string]any {
	return map[string]any{
		"proposal_id":  "p-1",
		"agent_key":    "case-triage",
		"agent_version": float64(3),
		"tool_id":      "case.apply_disposition",
		"affected_urns": []any{"wr:t-1:case:case/c-91"},
		"decision": map[string]any{
			"actor": actor, "action": "approve", "decided_at": "2026-07-25T12:00:00Z",
		},
		"proposal_kind":       "case",
		"pack_name":           nil,
		"decision_label":      "approved",
		"decision_latency_ms": float64(4200),
	}
}

func TestGovernedDecisionMapping_HumanApprove(t *testing.T) {
	raw := &fakeRaw{}
	p := NewPipeline(Catalog(), raw, nil, nil)

	env := gcevent.Envelope{
		EventID: uuid.New(), EventType: "proposal.approved", TenantID: uuid.New(),
		OccurredAt: time.Now().UTC(), Payload: approvedPayload("user:u-super"),
	}
	if err := p.Handle(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	// human approval -> governed_decision ONLY, not auto_executed_action.
	if len(raw.recs) != 1 {
		t.Fatalf("want 1 record (governed_decision only), got %d: %+v", len(raw.recs), raw.recs)
	}
	r := raw.recs[0]
	if r.MeterKey != domain.MeterGovernedDecision {
		t.Fatalf("want governed_decision, got %s", r.MeterKey)
	}
	if r.AgentID == nil || *r.AgentID != "case-triage" {
		t.Fatalf("agent_id should come from payload.agent_key, got %+v", r.AgentID)
	}
	if r.Decision == nil || *r.Decision != "approved" {
		t.Fatalf("decision dim should be 'approved', got %+v", r.Decision)
	}
	if r.PackName != nil {
		t.Fatalf("pack_name should be nil (null in payload), got %+v", r.PackName)
	}
	if r.Meta["proposal_kind"] != "case" {
		t.Fatalf("meta.proposal_kind should be 'case', got %+v", r.Meta)
	}
	if r.Meta["decision_latency_ms"] != float64(4200) {
		t.Fatalf("meta.decision_latency_ms should be 4200, got %+v", r.Meta)
	}
	if _, ok := r.Meta["edit_distance_bucket"]; ok {
		t.Fatalf("approve should carry no edit_distance_bucket, got %+v", r.Meta)
	}
}

func TestGovernedDecisionMapping_AutoExecuted_CountsBothMeters(t *testing.T) {
	raw := &fakeRaw{}
	p := NewPipeline(Catalog(), raw, nil, nil)

	env := gcevent.Envelope{
		EventID: uuid.New(), EventType: "proposal.approved", TenantID: uuid.New(),
		OccurredAt: time.Now().UTC(), Payload: approvedPayload("policy:auto"),
	}
	if err := p.Handle(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	if len(raw.recs) != 2 {
		t.Fatalf("want 2 records (governed_decision + auto_executed_action), got %d: %+v",
			len(raw.recs), raw.recs)
	}
	byMeter := map[string]domain.MeterRecord{}
	for _, r := range raw.recs {
		byMeter[r.MeterKey] = r
	}
	if _, ok := byMeter[domain.MeterGovernedDecision]; !ok {
		t.Fatalf("auto-executed approval must still count as governed_decision")
	}
	if _, ok := byMeter[domain.MeterAutoExecutedAction]; !ok {
		t.Fatalf("auto-executed approval must count as auto_executed_action")
	}
}

func TestGovernedDecisionMapping_EditApprove_CarriesEditDistanceBucket(t *testing.T) {
	raw := &fakeRaw{}
	p := NewPipeline(Catalog(), raw, nil, nil)

	payload := approvedPayload("user:u-super")
	payload["decision_label"] = "edited"
	payload["edit_distance_bucket"] = "minor"
	env := gcevent.Envelope{
		EventID: uuid.New(), EventType: "proposal.edited_approved", TenantID: uuid.New(),
		OccurredAt: time.Now().UTC(), Payload: payload,
	}
	if err := p.Handle(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	if len(raw.recs) != 1 {
		t.Fatalf("want 1 record, got %d", len(raw.recs))
	}
	r := raw.recs[0]
	if r.Decision == nil || *r.Decision != "edited" {
		t.Fatalf("decision dim should be 'edited', got %+v", r.Decision)
	}
	if r.Meta["edit_distance_bucket"] != "minor" {
		t.Fatalf("meta.edit_distance_bucket should be 'minor', got %+v", r.Meta)
	}
}

func TestGovernedDecisionMapping_Rejected(t *testing.T) {
	raw := &fakeRaw{}
	p := NewPipeline(Catalog(), raw, nil, nil)

	payload := approvedPayload("user:u-super")
	payload["decision_label"] = "rejected"
	env := gcevent.Envelope{
		EventID: uuid.New(), EventType: "proposal.rejected", TenantID: uuid.New(),
		OccurredAt: time.Now().UTC(), Payload: payload,
	}
	if err := p.Handle(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	if len(raw.recs) != 1 || raw.recs[0].MeterKey != domain.MeterGovernedDecision {
		t.Fatalf("want 1 governed_decision record, got %+v", raw.recs)
	}
	if *raw.recs[0].Decision != "rejected" {
		t.Fatalf("decision dim should be 'rejected', got %s", *raw.recs[0].Decision)
	}
}

// TestGovernedDecisionMapping_CreatedAndCancelled_Unmapped: proposal.created
// and proposal.cancelled (the `respond` action) are not governed decisions
// (VMB-FR-002) — they simply have no mapping catalog entry, so they are
// unmapped events, exactly like any other event_type the catalog doesn't
// know about (USG-FR-015).
func TestGovernedDecisionMapping_CreatedAndCancelled_Unmapped(t *testing.T) {
	raw := &fakeRaw{}
	p := NewPipeline(Catalog(), raw, nil, nil)

	for _, et := range []string{"proposal.created", "proposal.cancelled"} {
		env := gcevent.Envelope{
			EventID: uuid.New(), EventType: et, TenantID: uuid.New(),
			OccurredAt: time.Now().UTC(), Payload: map[string]any{"proposal_id": "p-1"},
		}
		if err := p.Handle(context.Background(), env); err != nil {
			t.Fatal(err)
		}
	}
	if len(raw.recs) != 0 {
		t.Fatalf("proposal.created/cancelled must never meter, got %+v", raw.recs)
	}
}

// TestGovernedDecisionMapping_ReplayIsDeterministic: the SAME envelope
// processed twice produces records with identical (time, tenant_id,
// meter_key, event_id) — the exact tuple the store's unique constraint dedups
// on (USG-FR-011). The pipeline itself has no dedup logic (that's Redis
// SETNX one layer up + the store's ON CONFLICT DO NOTHING); this test pins
// that the pipeline gives those layers nothing to disagree about on replay.
func TestGovernedDecisionMapping_ReplayIsDeterministic(t *testing.T) {
	raw := &fakeRaw{}
	p := NewPipeline(Catalog(), raw, nil, nil)

	eventID := uuid.New()
	occurredAt := time.Now().UTC()
	tenant := uuid.New()
	mk := func() gcevent.Envelope {
		return gcevent.Envelope{
			EventID: eventID, EventType: "proposal.approved", TenantID: tenant,
			OccurredAt: occurredAt, Payload: approvedPayload("user:u-super"),
		}
	}
	if err := p.Handle(context.Background(), mk()); err != nil {
		t.Fatal(err)
	}
	if err := p.Handle(context.Background(), mk()); err != nil {
		t.Fatal(err)
	}
	if len(raw.recs) != 2 {
		t.Fatalf("fakeRaw has no dedup (that's the store's job); want 2 identical-key records, got %d", len(raw.recs))
	}
	first, second := raw.recs[0], raw.recs[1]
	if first.Time != second.Time || first.TenantID != second.TenantID ||
		first.MeterKey != second.MeterKey || first.EventID != second.EventID {
		t.Fatalf("replay must produce identical dedup-key fields: %+v vs %+v", first, second)
	}
}

func TestCatalog_GovernedDecisionMetersRegistered(t *testing.T) {
	keys := domain.CatalogKeys()
	if _, ok := keys[domain.MeterGovernedDecision]; !ok {
		t.Fatal("governed_decision missing from catalog")
	}
	if _, ok := keys[domain.MeterAutoExecutedAction]; !ok {
		t.Fatal("auto_executed_action missing from catalog")
	}
	// case_resolved intentionally deferred to a later slice (needs
	// case-service changes) — must NOT be in the catalog yet.
	if _, ok := keys["case_resolved"]; ok {
		t.Fatal("case_resolved should not be registered yet (deferred, out of slice 1 scope)")
	}
}
