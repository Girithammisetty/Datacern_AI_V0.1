package compliance

// Single-decision auditor evidence pack (BRD 60 WS5). Given one governed
// decision (a four-eyes proposal that went agent-proposed -> human-approved
// -> executed -> landed in the WORM chain), assemble everything an examiner
// needs: who proposed, who approved (a DISTINCT human), when, the exact
// governed tool call, and cryptographic proof it hasn't been altered.
//
// The pack IS the evidence: it embeds each event's chain position
// (chain_seq/chain_hash/chain_date) and, per distinct day, a live hash-chain
// re-verification plus the sealed WORM (Object-Lock) manifest reference. An
// auditor can independently recompute the chain from the events, fetch the
// sealed manifest from immutable storage, and confirm the day is sealed — so
// tamper-evidence rests on the same SHA-256 chain + WORM manifest the platform
// itself relies on, not on trusting this endpoint.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/chain"
	"github.com/datacern-ai/audit-service/internal/domain"
)

// evidenceLookbackDays bounds the event search window. A proposal's whole
// lifecycle is short (default 7-day expiry), but a decided-then-later-realized
// outcome can trail; a wide window is cheap for a single indexed resource_urn.
const evidenceLookbackDays = 400

// EvidencePack is the auditor-facing document for one decision.
type EvidencePack struct {
	Kind        string          `json:"kind"` // "evidence_pack"
	TenantID    string          `json:"tenant_id"`
	ProposalID  string          `json:"proposal_id"`
	ProposalURN string          `json:"proposal_urn"`
	GeneratedAt string          `json:"generated_at"`
	Decision    DecisionSummary `json:"decision"`
	Events      []EvidenceEvent `json:"events"`
	ChainProof  []DayProof      `json:"chain_proof"`
	Integrity   string          `json:"integrity"`
}

// DecisionSummary is the human-readable heart of the pack: the four-eyes claim,
// made explicit and provable from the events below.
type DecisionSummary struct {
	AgentID      string   `json:"agent_id"`
	AgentVersion string   `json:"agent_version"`
	OnBehalfOf   string   `json:"on_behalf_of"` // the user the agent acted for (may be empty = autonomous)
	Approver     string   `json:"approver"`     // the DECIDING human (from the terminal decision event)
	Outcome      string   `json:"outcome"`      // proposed | approved | edited | rejected | expired
	FourEyes     bool     `json:"four_eyes"`    // a distinct human approved (approver != on_behalf_of, approver is a user)
	ProposedAt   string   `json:"proposed_at"`
	DecidedAt    string   `json:"decided_at"`
	ToolID       string   `json:"tool_id"`
	ToolVersion  string   `json:"tool_version"`
	ArgsDigest   string   `json:"args_digest"` // the executed call's args digest (never raw args)
	AffectedURNs []string `json:"affected_urns"`
}

// EvidenceEvent is one WORM event with its immutable chain position.
type EvidenceEvent struct {
	EventID       string `json:"event_id"`
	EventType     string `json:"event_type"`
	ResourceURN   string `json:"resource_urn"`
	ActorType     string `json:"actor_type"`
	ActorID       string `json:"actor_id"`
	ViaAgentID    string `json:"via_agent_id,omitempty"`
	OboUserID     string `json:"obo_user_id,omitempty"`
	OccurredAt    string `json:"occurred_at"`
	PayloadDigest string `json:"payload_digest"`
	ChainDate     string `json:"chain_date"`
	ChainSeq      uint64 `json:"chain_seq"`
	ChainHash     string `json:"chain_hash"`
}

// DayProof is the tamper-evidence for every chain-day the decision touches.
type DayProof struct {
	ChainDate      string `json:"chain_date"`
	Sealed         bool   `json:"sealed"`
	Valid          bool   `json:"valid"`          // hash-chain re-verified (only meaningful when sealed)
	ManifestMatch  bool   `json:"manifest_match"` // recomputed head == sealed manifest head
	EventsChecked  uint64 `json:"events_checked"`
	ManifestURI    string `json:"manifest_uri,omitempty"` // s3://... the immutable Object-Lock manifest
	ManifestSHA256 string `json:"manifest_sha256,omitempty"`
	Note           string `json:"note,omitempty"`
}

// summarizeDecision derives the four-eyes decision summary from the gathered
// events. Pure (no I/O) so it is unit-testable with hand-built records.
//
//   - proposal.created gives the proposer (an agent), the on-behalf-of user,
//     and the proposed timestamp.
//   - the terminal decision event (approved/edited_approved/rejected) gives the
//     DECIDING human and the decided timestamp.
//   - four-eyes = a distinct human decided: the approver is a `user` actor and
//     is not the same person the agent acted on behalf of. (Upstream
//     ProposalService already REFUSES a same-actor approval on anything but a
//     low-risk self-approval-enabled cell; this surfaces that invariant to the
//     auditor rather than re-enforcing it.)
//   - the tool_invoked event gives the exact executed call + args digest.
func summarizeDecision(events []domain.Record) DecisionSummary {
	var s DecisionSummary
	for _, e := range events {
		switch {
		case e.EventType == "proposal.created" || e.EventType == "proposal.proposed":
			s.AgentID = firstNonEmpty(e.ViaAgentID, e.ActorID)
			s.AgentVersion = e.ViaAgentVersion
			s.OnBehalfOf = e.OboUserID
			s.ProposedAt = e.OccurredAt.UTC().Format(time.RFC3339Nano)
			if s.Outcome == "" {
				s.Outcome = "proposed"
			}
		case isTerminalDecision(e.EventType):
			// last terminal decision wins (there is only one in practice)
			s.Outcome = decisionOutcome(e.EventType)
			s.DecidedAt = e.OccurredAt.UTC().Format(time.RFC3339Nano)
			if e.ActorType == "user" {
				s.Approver = e.ActorID
			}
		case e.EventType == "ai.tool_invoked.v1":
			// The AUTHORITATIVE record of what actually executed: tool id +
			// version + the args digest (never raw args) + affected resources.
			tid, tver, adigest, urns := toolCallFields(e.PayloadJSON)
			s.ToolID = firstNonEmpty(s.ToolID, firstNonEmpty(tid, e.ResourceType))
			s.ToolVersion = firstNonEmpty(s.ToolVersion, tver)
			s.ArgsDigest = firstNonEmpty(s.ArgsDigest, adigest)
			if len(s.AffectedURNs) == 0 {
				s.AffectedURNs = urns
			}
		}
	}
	s.FourEyes = s.Approver != "" && s.Approver != s.OnBehalfOf
	return s
}

// EvidencePack assembles the pack for one proposal. Requires b.PG.
func (b *Builder) EvidencePack(ctx context.Context, tenant uuid.UUID, proposalID string, now time.Time) (*EvidencePack, error) {
	if b.PG == nil {
		return nil, fmt.Errorf("evidence pack requires a Postgres store")
	}
	proposalURN := fmt.Sprintf("wr:%s:agent:proposal/%s", tenant.String(), proposalID)
	from := now.AddDate(0, 0, -evidenceLookbackDays)
	to := now.AddDate(0, 0, 1)

	// 1) the proposal lifecycle (exact resource_urn).
	lifecycle, err := b.CH.Search(ctx, domain.SearchFilter{
		TenantID: tenant, ResourceURN: proposalURN, From: from, To: to,
		IncludeAuto: true, Limit: 500,
	})
	if err != nil {
		return nil, fmt.Errorf("lifecycle search: %w", err)
	}
	if len(lifecycle) == 0 {
		return nil, domain.ENotFound()
	}

	// 2) the executed tool call(s) sharing the decision's trace id.
	traces := map[string]bool{}
	for _, e := range lifecycle {
		if e.TraceID != "" {
			traces[e.TraceID] = true
		}
	}
	var toolEvents []domain.Record
	for tid := range traces {
		te, err := b.CH.Search(ctx, domain.SearchFilter{
			TenantID: tenant, TraceID: tid, EventType: "ai.tool_invoked.v1",
			From: from, To: to, IncludeAuto: true, Limit: 200,
		})
		if err != nil {
			return nil, fmt.Errorf("tool search: %w", err)
		}
		toolEvents = append(toolEvents, te...)
	}

	all := append(append([]domain.Record{}, lifecycle...), toolEvents...)
	// chronological order for the auditor's reading + deterministic output.
	sort.SliceStable(all, func(i, j int) bool {
		if !all[i].OccurredAt.Equal(all[j].OccurredAt) {
			return all[i].OccurredAt.Before(all[j].OccurredAt)
		}
		return all[i].ChainSeq < all[j].ChainSeq
	})

	pack := &EvidencePack{
		Kind: "evidence_pack", TenantID: tenant.String(), ProposalID: proposalID,
		ProposalURN: proposalURN, GeneratedAt: now.UTC().Format(time.RFC3339Nano),
		Decision: summarizeDecision(all),
		Integrity: "Each event carries its immutable chain position " +
			"(chain_seq/chain_hash). Per chain_proof entry, the day's hash chain " +
			"was re-verified against its sealed WORM (Object-Lock) manifest; an " +
			"unsealed day is verifiable once the daily export seals it. Recompute " +
			"the chain from the events and confirm against the referenced manifest " +
			"to prove this decision was not altered after the fact.",
	}
	for _, e := range all {
		pack.Events = append(pack.Events, EvidenceEvent{
			EventID: e.EventID.String(), EventType: e.EventType, ResourceURN: e.ResourceURN,
			ActorType: e.ActorType, ActorID: e.ActorID, ViaAgentID: e.ViaAgentID,
			OboUserID: e.OboUserID, OccurredAt: e.OccurredAt.UTC().Format(time.RFC3339Nano),
			PayloadDigest: e.PayloadDigest, ChainDate: e.ChainDate, ChainSeq: e.ChainSeq,
			ChainHash: e.ChainHash,
		})
	}

	// 3) tamper-evidence: per distinct chain_date, re-verify + reference the manifest.
	pack.ChainProof, err = b.chainProof(ctx, tenant, all)
	if err != nil {
		return nil, err
	}
	return pack, nil
}

// chainProof re-verifies every distinct chain-day the events span.
func (b *Builder) chainProof(ctx context.Context, tenant uuid.UUID, events []domain.Record) ([]DayProof, error) {
	seen := map[string]bool{}
	var dates []string
	for _, e := range events {
		if e.ChainDate != "" && !seen[e.ChainDate] {
			seen[e.ChainDate] = true
			dates = append(dates, e.ChainDate)
		}
	}
	sort.Strings(dates)

	var out []DayProof
	for _, date := range dates {
		p := DayProof{ChainDate: date}
		ch, err := b.PG.GetChainHead(ctx, tenant, date)
		if err != nil {
			return nil, fmt.Errorf("chain head %s: %w", date, err)
		}
		if ch == nil || ch.SealedAt == nil {
			p.Note = "day not sealed yet; verifiable once the daily WORM export seals it"
			out = append(out, p)
			continue
		}
		p.Sealed = true
		rows, err := b.CH.ChainScan(ctx, tenant, date)
		if err != nil {
			return nil, fmt.Errorf("chain scan %s: %w", date, err)
		}
		res := chain.Verify(rows, tenant, date, ch.HeadHash)
		p.Valid, p.ManifestMatch, p.EventsChecked = res.Valid, res.ManifestMatch, res.EventsChecked
		if man, err := b.PG.LatestManifest(ctx, tenant, date); err == nil && man != nil {
			p.ManifestURI, p.ManifestSHA256 = man.URI, man.ManifestSHA256
		}
		out = append(out, p)
	}
	return out, nil
}

func isTerminalDecision(eventType string) bool {
	switch eventType {
	case "proposal.approved", "proposal.edited_approved", "proposal.rejected", "proposal.expired":
		return true
	}
	return false
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// toolCallFields defensively parses an ai.tool_invoked.v1 payload for the
// executed call's identity + args digest + affected resources. Any missing/
// malformed field returns empty rather than erroring — the pack degrades
// gracefully (the lifecycle events still carry the core four-eyes evidence).
func toolCallFields(payloadJSON string) (toolID, toolVersion, argsDigest string, affectedURNs []string) {
	if payloadJSON == "" {
		return "", "", "", nil
	}
	var p struct {
		ToolID       string   `json:"tool_id"`
		ToolVersion  string   `json:"tool_version"`
		ArgsDigest   string   `json:"args_digest"`
		AffectedURNs []string `json:"affected_urns"`
	}
	if err := json.Unmarshal([]byte(payloadJSON), &p); err != nil {
		return "", "", "", nil
	}
	return p.ToolID, p.ToolVersion, p.ArgsDigest, p.AffectedURNs
}
