// Package valuecalc builds domain.ValueSummary from already-aggregated
// rollup inputs (BRD 69 ROI-FR-010, design §2.0/§2.2/§2.3). It is a pure
// function with no store/HTTP dependency by design — the tier/branch logic
// here is exercised directly with synthetic domain.DecisionsBreakdown
// fixtures, independent of whatever the real store query supplies, which
// keeps this package's tests fast and infra-free.
//
// Historical note: this package's by-kind branch was originally written
// against only a synthetic fixture because store.ValueSummaryInputs could
// not yet populate DecisionsBreakdown.ByKind from any real rollup (BRD 67
// slice 1 shipped without a proposal_kind rollup column — see
// docs/initiatives/value-roi-reporting.md §3 "Repo-state finding"). BRD 69's
// migration 000007_governed_decision_kind closed that gap: ByKind now comes
// from real usage_monthly data (internal/store/value_summary.go), and this
// package's logic — which needed no change — is what makes hours_saved_est/
// labor_value_est_usd/human_baseline_cost_usd/net_value_est_usd compute real
// numbers whenever a tenant has decisions carrying a proposal_kind that also
// has a minutes_per_decision entry.
package valuecalc

import (
	"math"
	"strings"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// Gap messages (design §2.0 "provenance.meter_gap ... here's what's missing
// and why"). Composed into one semicolon-joined string per response.
const (
	GapTier0 = "governed_decision meter not emitted yet (BRD 67 VMB-FR-001)"

	// GapNoByKind fires when this period's decisions genuinely carry no
	// proposal_kind at rollup grain — e.g. zero decisions this period, or
	// rows ingested before BRD 69's migration 000007_governed_decision_kind
	// promoted proposal_kind to a physical rollup column (docs/initiatives/
	// value-roi-reporting.md §3). It is no longer a permanent schema gap:
	// once a tenant has real governed_decision rows carrying proposal_kind,
	// ByKind populates and this message is not appended.
	GapNoByKind = "decisions.by_kind and hours_saved_est/labor_value_est_usd/human_baseline_cost_usd/net_value_est_usd are unavailable this period: no governed_decision rows carry a proposal_kind at rollup grain (either zero decisions this period, or the decisions predate proposal_kind becoming a rollup column)"

	// GapNoAttribution reflects that BRD 67's usage_decisions hypertable and
	// an ai-gateway savings_usd_est are not built (design §2.0 Tier 2).
	GapNoAttribution = "cost_per_decision is blended (tenant/period average), not true per-decision grain, and ladder_savings_usd is unavailable: BRD 67's usage_decisions hypertable and an ai-gateway savings estimate (VMB-FR-010) are not built"

	// GapNoMatchingAssumption fires when decisions.by_kind IS populated (real
	// proposal_kind data exists) but none of the kinds present this period
	// have a minutes_per_decision entry in the tenant's active value
	// assumptions — e.g. the tenant only set minutes for "claims_disposition"
	// but every decision this period was kind "underwriting_review". The
	// honest answer is null, not a fabricated 0 hours saved (ROI-NFR-004).
	GapNoMatchingAssumption = "hours_saved_est/labor_value_est_usd/human_baseline_cost_usd/net_value_est_usd are unavailable: none of this period's decision kinds have a minutes_per_decision entry in the active value_assumptions version"
)

// Input is everything BuildSummary needs. Decisions nil = Tier 0 (the
// governed_decision meter itself is unavailable — kept as a real, tested
// code path for graceful degradation even though the CURRENT repo state
// always has the meter seeded, per BRD 67 slice 1 commit 417afd2).
// Assumptions nil = tenant has not set value_assumptions (ROI-FR-001).
type Input struct {
	Period        string
	WorkspaceID   *string
	Decisions     *domain.DecisionsBreakdown
	Assumptions   *domain.ValueAssumptions
	AICostUSD     float64
	Adoption      domain.Adoption
	RollupVersion string
}

// BuildSummary implements ROI-FR-010's response contract, branching on the
// data-availability tier (design §2.0) and the assumption-provenance
// invariant (design §2.2/ROI-NFR-004): every *_est field is either a
// non-nil *domain.EstimatedValue carrying the assumption version that
// produced it, or nil — never a bare number.
func BuildSummary(in Input) domain.ValueSummary {
	out := domain.ValueSummary{
		Period:      in.Period,
		WorkspaceID: in.WorkspaceID,
		AICostUSD:   in.AICostUSD,
		Adoption: domain.ValueAdoptionView{
			ActiveUsers: in.Adoption.ActiveUsers,
			ByWorkspace: orEmptyI64(in.Adoption.ByWorkspace),
		},
	}

	if in.Decisions == nil {
		// Tier 0: decisions/cost-per-decision/every *_est stay nil.
		out.Provenance = domain.ValueProvenance{RollupVersion: in.RollupVersion, MeterGap: strPtr(GapTier0)}
		return out
	}

	d := in.Decisions
	out.Decisions = &domain.ValueDecisionsView{
		Total:      d.Total,
		ByDecision: orEmptyI64(d.ByDecision),
		ByKind:     orEmptyI64(d.ByKind),
		ByAgent:    orEmptyI64(d.ByAgent),
		ByPack:     orEmptyI64(d.ByPack),
	}

	gaps := []string{GapNoAttribution} // Tier 2 (attributed cost, ladder savings) never available today
	if len(d.ByKind) == 0 {
		gaps = append(gaps, GapNoByKind)
	}

	if d.Total > 0 {
		out.CostPerDecision = &domain.CostPerDecision{
			Value: in.AICostUSD / float64(d.Total),
			Basis: domain.CostBasisBlended,
		}
	}

	var assumptionVersion *int
	if in.Assumptions != nil && len(d.ByKind) > 0 {
		// Per-kind formula (ROI-FR-010/AC-1): sum over proposal_kind of
		// (decisions_in_kind * minutes_for_kind) / 60, using ONLY kinds the
		// tenant has set minutes for (a kind with no assumption entry
		// contributes no estimate for its decisions — never a fabricated
		// default minute value, ROI-NFR-004).
		var minutes float64
		matchedAnyKind := false
		for kind, count := range d.ByKind {
			if m, ok := in.Assumptions.MinutesPerDecision[kind]; ok {
				minutes += float64(count) * m
				matchedAnyKind = true
			}
		}
		if matchedAnyKind {
			hoursExact := minutes / 60.0
			// labor/net are computed from the EXACT hours figure, not the
			// 1-decimal display rounding of hours_saved_est below —
			// otherwise compounding two roundings would drift the dollar
			// figures away from AC-1's exact $740,400 (12340 * 20min/60 *
			// $180/hr).
			labor := round2(hoursExact * in.Assumptions.LoadedHourlyRateUSD)
			net := round2(labor - in.AICostUSD)

			v := in.Assumptions.Version
			assumptionVersion = &v
			out.HoursSavedEst = domain.NewEstimatedValue(round1(hoursExact), v)
			out.LaborValueEstUSD = domain.NewEstimatedValue(labor, v)
			out.HumanBaselineCostUSD = domain.NewEstimatedValue(labor, v)
			out.NetValueEstUSD = domain.NewEstimatedValue(net, v)
		} else {
			// ROI-NFR-004: this period's decisions carry proposal_kind values,
			// but NONE of them has a minutes_per_decision entry in the active
			// assumptions version. Computing "0 hours saved" here would be a
			// fabricated number (it reads as "we checked and it's zero", not
			// "we can't tell") — so the *_est fields stay nil, same as the
			// assumptions-unset case, and the gap is disclosed explicitly.
			gaps = append(gaps, GapNoMatchingAssumption)
		}
	}

	out.Provenance = domain.ValueProvenance{
		RollupVersion:     in.RollupVersion,
		AssumptionVersion: assumptionVersion,
		MeterGap:          strPtr(strings.Join(gaps, "; ")),
	}
	return out
}

func orEmptyI64(m map[string]int64) map[string]int64 {
	if m == nil {
		return map[string]int64{}
	}
	return m
}

func strPtr(s string) *string { return &s }

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round2(v float64) float64 { return math.Round(v*100) / 100 }
