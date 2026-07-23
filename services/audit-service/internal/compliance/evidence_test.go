package compliance

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/domain"
)

func rec(t time.Time, etype, actorType, actorID, viaAgent, obo, payloadJSON string) domain.Record {
	return domain.Record{
		EventID: uuid.New(), EventType: etype, ActorType: actorType, ActorID: actorID,
		ViaAgentID: viaAgent, ViaAgentVersion: "1", OboUserID: obo, OccurredAt: t,
		PayloadJSON: payloadJSON,
	}
}

func TestSummarizeDecision_FourEyesTrue(t *testing.T) {
	base := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	toolPayload := `{"tool_id":"case.apply_disposition","tool_version":"1.0.0","args_digest":"abc123","affected_urns":["wr:t:case:case/c1"]}`
	events := []domain.Record{
		rec(base, "proposal.created", "agent", "acme-ext-bot", "acme-ext-bot", "u-alice", ""),
		rec(base.Add(time.Minute), "ai.tool_invoked.v1", "user", "u-bob", "acme-ext-bot", "", toolPayload),
		rec(base.Add(2*time.Minute), "proposal.approved", "user", "u-bob", "", "", ""),
	}
	s := summarizeDecision(events)
	if !s.FourEyes {
		t.Fatalf("expected four_eyes true (approver u-bob != on_behalf_of u-alice), got %+v", s)
	}
	if s.Approver != "u-bob" || s.OnBehalfOf != "u-alice" {
		t.Fatalf("approver/on_behalf_of mismatch: %+v", s)
	}
	if s.AgentID != "acme-ext-bot" || s.Outcome != "approved" {
		t.Fatalf("agent/outcome mismatch: %+v", s)
	}
	if s.ToolID != "case.apply_disposition" || s.ToolVersion != "1.0.0" || s.ArgsDigest != "abc123" {
		t.Fatalf("tool fields not extracted from payload: %+v", s)
	}
	if len(s.AffectedURNs) != 1 || s.AffectedURNs[0] != "wr:t:case:case/c1" {
		t.Fatalf("affected_urns not extracted: %+v", s)
	}
}

func TestSummarizeDecision_SelfApprovalIsNotFourEyes(t *testing.T) {
	base := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	// The same user the agent acted on-behalf-of also decided — NOT four-eyes.
	events := []domain.Record{
		rec(base, "proposal.created", "agent", "acme-ext-bot", "acme-ext-bot", "u-alice", ""),
		rec(base.Add(time.Minute), "proposal.approved", "user", "u-alice", "", "", ""),
	}
	s := summarizeDecision(events)
	if s.FourEyes {
		t.Fatalf("expected four_eyes FALSE when approver == on_behalf_of, got %+v", s)
	}
	if s.Approver != "u-alice" {
		t.Fatalf("approver should still be recorded: %+v", s)
	}
}

func TestSummarizeDecision_RejectedOutcome(t *testing.T) {
	base := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	events := []domain.Record{
		rec(base, "proposal.created", "agent", "bot", "bot", "u-alice", ""),
		rec(base.Add(time.Minute), "proposal.rejected", "user", "u-bob", "", "", ""),
	}
	s := summarizeDecision(events)
	if s.Outcome != "rejected" {
		t.Fatalf("expected outcome rejected, got %q", s.Outcome)
	}
	if !s.FourEyes {
		t.Fatalf("a distinct human rejecting is still a distinct-approver decision: %+v", s)
	}
}

func TestSummarizeDecision_AutonomousNoApproverIsNotFourEyes(t *testing.T) {
	base := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	// Autonomous agent (no on_behalf_of), proposal created but never decided.
	events := []domain.Record{
		rec(base, "proposal.created", "agent", "bot", "bot", "", ""),
	}
	s := summarizeDecision(events)
	if s.FourEyes {
		t.Fatalf("a still-pending proposal has no approver -> not four_eyes: %+v", s)
	}
	if s.Outcome != "proposed" {
		t.Fatalf("expected outcome proposed, got %q", s.Outcome)
	}
}
