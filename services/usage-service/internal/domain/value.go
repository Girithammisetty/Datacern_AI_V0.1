// Value & ROI reporting types (BRD 69, docs/initiatives/value-roi-reporting.md
// §2.1/§2.2/§2.3). See internal/valuecalc for the pure summary-building logic
// that consumes these types.
package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ValueAssumptions statuses (design §2.1). No "draft" state — edits apply
// immediately, forward-only.
const (
	AssumptionsActive     = "active"
	AssumptionsSuperseded = "superseded"
)

// ValueAssumptions is one tenant-scoped, versioned value-reporting assumption
// set (ROI-FR-001). Append-only: PutAssumptions inserts a new version and
// supersedes the prior one in the same transaction — rows are never mutated
// in place, so the version history IS the audit trail (ROI-FR-002, design
// §2.1 point 4). A tenant with zero rows *is* the "assumptions unset" state —
// there is no platform default and no sentinel/zero-value row (ROI-FR-001,
// the honesty invariant: a present-but-zero row would be indistinguishable
// from a deliberate zero).
type ValueAssumptions struct {
	ID                  uuid.UUID          `json:"id"`
	TenantID            uuid.UUID          `json:"tenant_id"`
	Version             int                `json:"version"`
	MinutesPerDecision  map[string]float64 `json:"minutes_per_decision"`
	LoadedHourlyRateUSD float64            `json:"loaded_hourly_rate_usd"`
	EffectiveFrom       time.Time          `json:"effective_from"`
	Status              string             `json:"status"`
	CreatedBy           string             `json:"created_by"`
	CreatedAt           time.Time          `json:"created_at"`
}

// EstimatedValue pairs a derived figure with the assumption version that
// produced it (ROI-NFR-004, design §2.2 verbatim). The zero value is unusable
// (no exported fields, no default JSON) — the only way to get a non-nil
// *EstimatedValue is NewEstimatedValue, which requires both the value AND the
// version. Any code path that has an assumption-derived number but no version
// fails to compile, not fails silently at render time.
type EstimatedValue struct {
	value             float64
	assumptionVersion int
}

// NewEstimatedValue is the only constructor (design §2.2).
func NewEstimatedValue(value float64, assumptionVersion int) *EstimatedValue {
	return &EstimatedValue{value: value, assumptionVersion: assumptionVersion}
}

// Value returns the underlying figure (test/read access — the zero value type
// has no exported fields by design).
func (e *EstimatedValue) Value() float64 { return e.value }

// AssumptionVersion returns the assumption version that produced Value().
func (e *EstimatedValue) AssumptionVersion() int { return e.assumptionVersion }

// MarshalJSON is the null-guarantee (ROI-NFR-004): a nil *EstimatedValue
// renders as JSON null, never a fabricated zero.
func (e *EstimatedValue) MarshalJSON() ([]byte, error) {
	if e == nil {
		return []byte("null"), nil
	}
	return json.Marshal(struct {
		Value             float64 `json:"value"`
		AssumptionVersion int     `json:"assumption_version"`
	}{e.value, e.assumptionVersion})
}

// CostPerDecision basis tags (design §2.0 tiers).
const (
	CostBasisBlended    = "blended"    // ai_cost_usd / decisions.total (Tier 1)
	CostBasisAttributed = "attributed" // true per-decision grain (Tier 2, usage_decisions — not built)
)

// CostPerDecision pairs a per-decision cost figure with the tier it was
// computed at (design §2.0/§2.3).
type CostPerDecision struct {
	Value float64 `json:"value"`
	Basis string  `json:"basis"`
}

// DecisionsBreakdown is the governed_decision rollup shape consumed by
// valuecalc.BuildSummary (ROI-FR-010). ByKind is populated from
// usage_monthly's proposal_kind column, a rollup-worthy dimension added by
// BRD 69's migration 000007_governed_decision_kind (docs/initiatives/
// value-roi-reporting.md §3 "Repo-state finding" / "Known limits").
//
// History: BRD 67 slice 1 as originally shipped widened the generic
// usage_hourly/daily/monthly tuple with pack_name/decision only (migrations/
// 000004_value_meters.up.sql), keeping proposal_kind raw-detail-only in
// usage_raw.meta (never rolled up). That left decisions.by_kind — and every
// per-kind *_est figure — stuck returning null for every real tenant even
// with value_assumptions set, a gap beyond what design §2.0/§2.5 anticipated.
// Migration 000007 closes it by promoting proposal_kind to a physical rollup
// column, following the same pattern 000004 used for pack_name/decision.
//
// ByKind can still be empty-but-non-nil for real reasons: a tenant with zero
// decisions this period, or decisions whose events genuinely carried no
// proposal_kind (e.g. rows ingested before this migration). That is the
// honest "data genuinely absent" case ROI-NFR-004 requires — valuecalc still
// renders null for the *_est fields rather than fabricating a number. A nil
// DecisionsBreakdown pointer at the valuecalc layer models Tier 0 (the
// governed_decision meter itself unavailable) — a different, coarser gap.
type DecisionsBreakdown struct {
	Total      int64
	ByDecision map[string]int64
	ByKind     map[string]int64
	ByAgent    map[string]int64
	ByPack     map[string]int64
}

// Adoption is the active-user rollup (ROI-FR-010).
type Adoption struct {
	ActiveUsers int64
	ByWorkspace map[string]int64
}

// ValueDecisionsView is the wire shape of DecisionsBreakdown (ROI-FR-010).
type ValueDecisionsView struct {
	Total      int64            `json:"total"`
	ByDecision map[string]int64 `json:"by_decision"`
	ByKind     map[string]int64 `json:"by_kind"`
	ByAgent    map[string]int64 `json:"by_agent"`
	ByPack     map[string]int64 `json:"by_pack"`
}

// ValueAdoptionView is the wire shape of Adoption.
type ValueAdoptionView struct {
	ActiveUsers int64            `json:"active_users"`
	ByWorkspace map[string]int64 `json:"by_workspace"`
}

// ValueProvenance carries reproducibility metadata (ROI-NFR-002): the rollup
// version the figures were read from, the assumption version applied (if
// any), and a human-readable gap explanation (design §2.0 — present means
// "here's what's missing and why", nil means fully available).
type ValueProvenance struct {
	RollupVersion     string  `json:"rollup_version"`
	AssumptionVersion *int    `json:"assumption_version"`
	MeterGap          *string `json:"meter_gap"`
}

// ValueSummary is the GET /api/v1/value/summary response body (ROI-FR-010).
// Decisions is a pointer (nil = Tier 0, governed_decision meter unavailable);
// the four *_est fields are *EstimatedValue (nil = not computable, either
// because assumptions are unset or because the by-kind breakdown needed to
// apply per-kind minutes is unavailable — see DecisionsBreakdown doc comment).
type ValueSummary struct {
	Period               string              `json:"period"`
	WorkspaceID          *string             `json:"workspace_id"`
	Decisions            *ValueDecisionsView `json:"decisions"`
	HoursSavedEst        *EstimatedValue     `json:"hours_saved_est"`
	LaborValueEstUSD     *EstimatedValue     `json:"labor_value_est_usd"`
	AICostUSD            float64             `json:"ai_cost_usd"`
	CostPerDecision      *CostPerDecision    `json:"cost_per_decision"`
	HumanBaselineCostUSD *EstimatedValue     `json:"human_baseline_cost_usd"`
	NetValueEstUSD       *EstimatedValue     `json:"net_value_est_usd"`
	LadderSavingsUSD     *float64            `json:"ladder_savings_usd"`
	Adoption             ValueAdoptionView   `json:"adoption"`
	Provenance           ValueProvenance     `json:"provenance"`
}

// ValueTrendPoint is one point of GET /api/v1/value/trend (ROI-FR-011).
type ValueTrendPoint struct {
	Period             string   `json:"period"`
	Value              *float64 `json:"value"`
	Basis              *string  `json:"basis"`
	RollupVersion      string   `json:"rollup_version"`
	DistilledRungShare *float64 `json:"distilled_rung_share"`
}

// ValueExport is a row in value_exports (ROI-FR-021, design §2.8).
type ValueExport struct {
	ID                uuid.UUID `json:"id"`
	TenantID          uuid.UUID `json:"tenant_id"`
	Period            string    `json:"period"`
	WorkspaceID       *string   `json:"workspace_id,omitempty"`
	Version           int       `json:"version"`
	JSONKey           string    `json:"json_key"`
	JSONSHA256        string    `json:"json_sha256"`
	CSVKey            string    `json:"csv_key"`
	CSVSHA256         string    `json:"csv_sha256"`
	AssumptionVersion *int      `json:"assumption_version,omitempty"`
	GeneratedBy       string    `json:"generated_by"`
	CreatedAt         time.Time `json:"created_at"`
}
