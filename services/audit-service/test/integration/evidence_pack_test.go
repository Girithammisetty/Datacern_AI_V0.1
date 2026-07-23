//go:build integration

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/compliance"
	"github.com/datacern-ai/audit-service/internal/domain"
)

// TestEvidencePack_FourEyesDecisionWithSealedChain seeds one real governed
// decision (proposal.created by an agent on behalf of u-alice → tool executed →
// proposal.approved by a DISTINCT human u-bob) into real ClickHouse with a
// correctly-computed hash chain, seals the day, then asserts the assembled
// evidence pack proves four-eyes AND tamper-evidence end to end (BRD 60 WS5).
func TestEvidencePack_FourEyesDecisionWithSealedChain(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	tenant := uuid.New() // fresh tenant → the day's chain is exactly our 3 events
	date := time.Now().UTC().AddDate(0, 0, -2).Format("2006-01-02")
	day, _ := time.Parse("2006-01-02", date)
	proposalID := uuid.NewString()
	proposalURN := "wr:" + tenant.String() + ":agent:proposal/" + proposalID
	caseURN := "wr:" + tenant.String() + ":case:case/c-evidence"
	toolURN := "wr:" + tenant.String() + ":tool:case.apply_disposition/1.0.0"
	trace := "trace-" + uuid.NewString()

	// millisecond-precision timestamps so ClickHouse DateTime64(3) round-trips
	// exactly and the recomputed chain hash matches on verify.
	t0 := day.Add(12 * time.Hour)
	mk := func(seq int, etype, resURN, actorType, actorID, via, obo, payloadJSON string, occ time.Time) domain.Record {
		return domain.Record{
			EventID: uuid.New(), EventType: etype, SourceTopic: "test",
			TenantID: tenant, ActorType: actorType, ActorID: actorID, ViaAgentID: via,
			ViaAgentVersion: "1", OboUserID: obo, ResourceURN: resURN,
			Action: etype, OccurredAt: occ, IngestedAt: occ, TraceID: trace,
			PayloadDigest: domain.SHA256Hex([]byte(etype + "|" + resURN)),
			PayloadJSON:   payloadJSON, ChainDate: date, ChainSeq: uint64(seq),
		}
	}
	toolPayload := `{"tool_id":"case.apply_disposition","tool_version":"1.0.0","args_digest":"deadbeef","affected_urns":["` + caseURN + `"]}`
	recs := []domain.Record{
		mk(1, "proposal.created", proposalURN, "agent", "acme-ext-bot", "acme-ext-bot", "u-alice", "", t0),
		mk(2, "ai.tool_invoked.v1", toolURN, "user", "u-bob", "acme-ext-bot", "u-bob", toolPayload, t0.Add(time.Minute)),
		mk(3, "proposal.approved", proposalURN, "user", "u-bob", "", "", "", t0.Add(2*time.Minute)),
	}
	// Compute the genuine hash chain the way chain.Verify recomputes it.
	prev := domain.GenesisHash(tenant, date)
	for i := range recs {
		recs[i].ChainHash = domain.ChainHash(prev, recs[i].EventID, recs[i].PayloadDigest, recs[i].OccurredAt)
		prev = recs[i].ChainHash
	}
	head := prev

	if err := h.ch.InsertBatch(ctx, recs); err != nil {
		t.Fatalf("insert events: %v", err)
	}
	if err := h.pg.UpsertChainHead(ctx, tenant, date, head, 3); err != nil {
		t.Fatalf("upsert chain head: %v", err)
	}
	if err := h.pg.SealChainHead(ctx, tenant, date); err != nil {
		t.Fatalf("seal chain head: %v", err)
	}

	b := &compliance.Builder{CH: h.ch, WORM: h.worm, PG: h.pg}
	pack, err := b.EvidencePack(ctx, tenant, proposalID, time.Now())
	if err != nil {
		t.Fatalf("evidence pack: %v", err)
	}

	// --- the four-eyes claim, proven from the events ---
	d := pack.Decision
	if !d.FourEyes {
		t.Fatalf("expected four_eyes true (approver u-bob != on_behalf_of u-alice): %+v", d)
	}
	if d.Approver != "u-bob" || d.OnBehalfOf != "u-alice" || d.Outcome != "approved" {
		t.Fatalf("decision summary wrong: %+v", d)
	}
	if d.AgentID != "acme-ext-bot" || d.ToolID != "case.apply_disposition" || d.ArgsDigest != "deadbeef" {
		t.Fatalf("agent/tool fields wrong: %+v", d)
	}

	// --- every event carries its immutable chain position ---
	if len(pack.Events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(pack.Events))
	}
	for _, e := range pack.Events {
		if e.ChainHash == "" || e.ChainSeq == 0 || e.ChainDate != date {
			t.Fatalf("event missing chain position: %+v", e)
		}
	}

	// --- tamper-evidence: the day re-verifies against its sealed manifest ---
	if len(pack.ChainProof) != 1 {
		t.Fatalf("expected 1 chain-proof day, got %d", len(pack.ChainProof))
	}
	pf := pack.ChainProof[0]
	if !pf.Sealed || !pf.Valid || !pf.ManifestMatch || pf.EventsChecked != 3 {
		t.Fatalf("chain proof not valid/sealed/matched: %+v", pf)
	}
}

// TestEvidencePack_UnknownProposalIs404 confirms a nonexistent decision returns
// not-found, not a fabricated empty pack.
func TestEvidencePack_UnknownProposalIs404(t *testing.T) {
	h := newHarness(t)
	b := &compliance.Builder{CH: h.ch, WORM: h.worm, PG: h.pg}
	_, err := b.EvidencePack(context.Background(), uuid.New(), uuid.NewString(), time.Now())
	if err == nil {
		t.Fatal("expected an error for an unknown proposal")
	}
	if de, ok := err.(*domain.Error); !ok || de.Code != domain.CodeNotFound {
		t.Fatalf("expected NOT_FOUND, got %v", err)
	}
}
