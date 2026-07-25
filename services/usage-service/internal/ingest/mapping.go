// Package ingest turns inbound metering events into raw meter records via a
// declarative mapping catalog (USG-FR-010/015) and runs the idempotent ingest
// pipeline (Redis dedup + unique-constraint dedup + raw insert + budget
// evaluation). The mapping table is validated at startup.
package ingest

import (
	"fmt"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/events"
)

// Mapping maps one (topic, event_type) to one meter record (USG-FR-015).
// An event may match several mappings (e.g. an LLM completion yields both
// input- and output-token records).
type Mapping struct {
	Topic         string
	EventType     string
	MeterKey      string
	QuantityConst float64           // used when QuantityPath is empty
	QuantityPath  string            // dotted path into payload
	DimPaths      map[string]string // dim name -> dotted payload path
	// MetaPaths maps a usage_raw.meta JSONB key to a dotted payload path
	// (BRD 67 slice 1, design §2.2 "raw-detail-only" fields — e.g.
	// proposal_kind, decision_latency_ms, edit_distance_bucket). Never rolled
	// up; absent/empty for every meter that has no meta fields.
	MetaPaths map[string]string
	// Filter, when non-nil, must return true for the event to be metered.
	Filter func(payload map[string]any) bool
}

// stdDims is the common dimension extraction (USG-FR-002).
func stdDims(extra map[string]string) map[string]string {
	base := map[string]string{
		"workspace_id": "workspace_id",
		"user_id":      "user_id",
		"agent_id":     "agent_id",
		"model":        "model",
		"resource_urn": "resource_urn",
		"cloud":        "cloud",
	}
	for k, v := range extra {
		base[k] = v
	}
	return base
}

// Catalog is the seeded declarative mapping table (USG-FR-001/015). ai-gateway
// emits ai.token_usage.v1 as the authoritative LLM token source; the alternate
// usage.metering.v1·llm.request_completed shape is also mapped. ai.tool_invoked.v1
// is consumed but intentionally unmapped for tokens to avoid double counting a
// request already metered via ai.token_usage.v1 (unmapped is legal, USG-FR-015).
func Catalog() []Mapping {
	return []Mapping{
		// LLM tokens — primary source (ai-gateway ai.token_usage.v1).
		{
			Topic: events.TopicAITokenUsage, EventType: events.TopicAITokenUsage,
			MeterKey: domain.MeterLLMInputTokens, QuantityPath: "input_tokens",
			DimPaths: stdDims(map[string]string{"user_id": "principal", "model": "model_alias"}),
		},
		{
			Topic: events.TopicAITokenUsage, EventType: events.TopicAITokenUsage,
			MeterKey: domain.MeterLLMOutputTokens, QuantityPath: "output_tokens",
			DimPaths: stdDims(map[string]string{"user_id": "principal", "model": "model_alias"}),
		},
		// LLM tokens — alternate source (usage.metering.v1 · llm.request_completed).
		{
			Topic: events.TopicUsageMetering, EventType: "llm.request_completed",
			MeterKey: domain.MeterLLMInputTokens, QuantityPath: "gen_ai.usage.input_tokens",
			DimPaths: stdDims(nil),
		},
		{
			Topic: events.TopicUsageMetering, EventType: "llm.request_completed",
			MeterKey: domain.MeterLLMOutputTokens, QuantityPath: "gen_ai.usage.output_tokens",
			DimPaths: stdDims(nil),
		},
		// API calls.
		{
			Topic: events.TopicUsageMetering, EventType: "api.request_completed",
			MeterKey: domain.MeterAPICalls, QuantityConst: 1,
			DimPaths: stdDims(nil),
		},
		// Storage sampler (hourly).
		{
			Topic: events.TopicUsageMetering, EventType: "storage.sampled",
			MeterKey: domain.MeterStorageGBMonth, QuantityPath: "gb",
			DimPaths: stdDims(nil),
		},
		// Query bytes scanned.
		{
			Topic: events.TopicQueryEvents, EventType: "query.executed",
			MeterKey: domain.MeterQueryBytesScanned, QuantityPath: "bytes_scanned",
			DimPaths: stdDims(nil),
		},
		// Pipeline node-minutes (terminal events).
		{
			Topic: events.TopicPipeline, EventType: "pipeline_run.completed",
			MeterKey: domain.MeterPipelineMinutes, QuantityPath: "node_minutes",
			DimPaths: stdDims(nil),
		},
		{
			Topic: events.TopicPipeline, EventType: "pipeline_run.failed",
			MeterKey: domain.MeterPipelineMinutes, QuantityPath: "node_minutes",
			DimPaths: stdDims(nil),
		},
		// Agent tasks completed (only succeeded runs count).
		{
			Topic: events.TopicAIAgentRun, EventType: "agent_run.completed",
			MeterKey: domain.MeterAgentTasksCompleted, QuantityConst: 1,
			DimPaths: stdDims(nil),
			Filter: func(p map[string]any) bool {
				s, _ := p["status"].(string)
				return s == "succeeded"
			},
		},

		// ---- governed_decision (BRD 67 slice 1, VMB-FR-001/002/003) --------
		// Source: agent-runtime's ai.proposal.v1, extending the existing topic
		// rather than a new one (design §2.1). Metering fields are only present
		// on the payload for a terminal metered decision (proposals/service.py
		// _governed_decision_metering) — approve/edit-approve/reject. Quantity
		// extraction still requires SOME quantity source per ValidateCatalog,
		// so QuantityConst=1 (one row per decision, a count meter) even though
		// the real "does this event carry a decision" gate is that the payload
		// simply won't be emitted with these fields otherwise (proposal.created
		// and proposal.cancelled never reach this mapping's event_types at all).
		{
			Topic: events.TopicAIProposal, EventType: "proposal.approved",
			MeterKey: domain.MeterGovernedDecision, QuantityConst: 1,
			DimPaths: governedDecisionDims(),
			MetaPaths: governedDecisionMeta(),
		},
		{
			Topic: events.TopicAIProposal, EventType: "proposal.edited_approved",
			MeterKey: domain.MeterGovernedDecision, QuantityConst: 1,
			DimPaths: governedDecisionDims(),
			MetaPaths: governedDecisionMeta(),
		},
		{
			Topic: events.TopicAIProposal, EventType: "proposal.rejected",
			MeterKey: domain.MeterGovernedDecision, QuantityConst: 1,
			DimPaths: governedDecisionDims(),
			MetaPaths: governedDecisionMeta(),
		},

		// ---- auto_executed_action (BRD 67 slice 1, VMB-FR-001) -------------
		// Same source event as governed_decision's "approved" entry — an
		// auto-executed proposal is ALSO a governed_decision (no actor
		// exclusion there, design §2.1/§2.2) — this mapping additionally,
		// separately counts the auto-executed subset via the same filter
		// pattern already used for agent_run.completed's status=='succeeded'
		// above (design §2.1 "mirrors the existing filter pattern").
		{
			Topic: events.TopicAIProposal, EventType: "proposal.approved",
			MeterKey: domain.MeterAutoExecutedAction, QuantityConst: 1,
			DimPaths:  governedDecisionDims(),
			MetaPaths: governedDecisionMeta(),
			Filter: func(p map[string]any) bool {
				d, _ := p["decision"].(map[string]any)
				actor, _ := d["actor"].(string)
				return actor == "policy:auto"
			},
		},
	}
}

// governedDecisionDims: agent-runtime's ai.proposal.v1 payload carries the
// proposing agent under "agent_key" (not "agent_id" — the std-dims default),
// and has no workspace_id/user_id/model/resource_urn fields (a proposal's
// affected resources are a list, "affected_urns", not a single resource_urn) —
// those std dims resolve to NULL for this meter, same as any other meter
// missing a dim (USG-FR-002: unknown dims stored as nil, never dropped).
// pack_name/decision are the physical rollup columns (design §2.2).
func governedDecisionDims() map[string]string {
	return stdDims(map[string]string{
		"agent_id":  "agent_key",
		"pack_name": "pack_name",
		"decision":  "decision_label",
	})
}

// governedDecisionMeta: raw-detail-only fields (design §2.2), carried in
// usage_raw.meta and never rolled up. edit_distance_bucket is absent from the
// payload for approve/reject (only edited_approved carries it) — getPath
// simply omits the key from meta when the path is missing.
func governedDecisionMeta() map[string]string {
	return map[string]string{
		"proposal_kind":        "proposal_kind",
		"decision_latency_ms":  "decision_latency_ms",
		"edit_distance_bucket": "edit_distance_bucket",
	}
}

// ValidateCatalog checks every mapping references a known meter key and has a
// quantity source (USG-FR-015 startup validation).
func ValidateCatalog(mappings []Mapping) error {
	keys := domain.CatalogKeys()
	for i, m := range mappings {
		if _, ok := keys[m.MeterKey]; !ok {
			return fmt.Errorf("mapping[%d] (%s/%s): unknown meter_key %q", i, m.Topic, m.EventType, m.MeterKey)
		}
		if m.QuantityPath == "" && m.QuantityConst == 0 {
			return fmt.Errorf("mapping[%d] (%s/%s): no quantity source", i, m.Topic, m.EventType)
		}
	}
	return nil
}

// index keys mappings by event_type for O(1) lookup. The go-common consumer
// group hands the handler a decoded envelope without the source topic; the
// catalog's event_type values are globally unique across consumed topics, so
// event_type alone is a sound key (validated by ValidateCatalog uniqueness).
type index map[string][]Mapping

func newIndex(mappings []Mapping) index {
	idx := index{}
	for _, m := range mappings {
		idx[m.EventType] = append(idx[m.EventType], m)
	}
	return idx
}

func (i index) lookup(eventType string) []Mapping {
	return i[eventType]
}
