package valuecalc

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// TestBuildSummary_Tier0 covers BRD 69 design §2.0 Tier 0: the
// governed_decision meter itself is unavailable (Decisions == nil).
// decisions/cost_per_decision/every *_est field stay nil; ai_cost_usd and
// adoption still populate; provenance.meter_gap explains why.
func TestBuildSummary_Tier0(t *testing.T) {
	out := BuildSummary(Input{
		Period:        "2026-07",
		AICostUSD:     812.44,
		Adoption:      domain.Adoption{ActiveUsers: 84, ByWorkspace: map[string]int64{"ws-7": 40}},
		RollupVersion: "usage_monthly@2026-07-finalized",
	})

	require.Nil(t, out.Decisions)
	require.Nil(t, out.CostPerDecision)
	require.Nil(t, out.HoursSavedEst)
	require.Nil(t, out.LaborValueEstUSD)
	require.Nil(t, out.HumanBaselineCostUSD)
	require.Nil(t, out.NetValueEstUSD)
	require.Nil(t, out.LadderSavingsUSD)
	require.Equal(t, 812.44, out.AICostUSD)
	require.Equal(t, int64(84), out.Adoption.ActiveUsers)
	require.NotNil(t, out.Provenance.MeterGap)
	require.Contains(t, *out.Provenance.MeterGap, "governed_decision meter not emitted")
	require.Nil(t, out.Provenance.AssumptionVersion)
}

// TestBuildSummary_Tier1_NoByKind is the CURRENT repo state (see
// domain.DecisionsBreakdown doc comment): governed_decision is available and
// decisions.total/by_decision/by_agent/by_pack populate, but by_kind is
// empty (proposal_kind not at rollup grain) — so even with assumptions set,
// the *_est fields stay nil (never fabricated) and the gap is disclosed.
func TestBuildSummary_Tier1_NoByKind(t *testing.T) {
	assumptions := &domain.ValueAssumptions{
		Version:             1,
		MinutesPerDecision:  map[string]float64{"claims_disposition": 20},
		LoadedHourlyRateUSD: 180,
	}
	out := BuildSummary(Input{
		Period:    "2026-07",
		AICostUSD: 812.44,
		Decisions: &domain.DecisionsBreakdown{
			Total:      12340,
			ByDecision: map[string]int64{"approved": 11800, "edited": 420, "rejected": 120},
			ByAgent:    map[string]int64{"claims-copilot": 12340},
			ByPack:     map[string]int64{"insurance-claims-payer": 12340},
			// ByKind intentionally nil — the current gap.
		},
		Assumptions:   assumptions,
		Adoption:      domain.Adoption{ActiveUsers: 84},
		RollupVersion: "usage_monthly@2026-07-finalized",
	})

	require.NotNil(t, out.Decisions)
	require.EqualValues(t, 12340, out.Decisions.Total)
	require.NotNil(t, out.CostPerDecision, "blended cost_per_decision is computable from total alone")
	require.Equal(t, domain.CostBasisBlended, out.CostPerDecision.Basis)
	require.InDelta(t, 812.44/12340.0, out.CostPerDecision.Value, 1e-9)

	require.Nil(t, out.HoursSavedEst, "by_kind unavailable -> no fabricated hours estimate")
	require.Nil(t, out.LaborValueEstUSD)
	require.Nil(t, out.HumanBaselineCostUSD)
	require.Nil(t, out.NetValueEstUSD)
	require.Nil(t, out.Provenance.AssumptionVersion, "no assumption was actually applied to any figure")
	require.NotNil(t, out.Provenance.MeterGap)
	require.Contains(t, *out.Provenance.MeterGap, "by_kind")
}

// TestBuildSummary_Tier1_WithByKind_AC1 reproduces BRD 69 AC-1 exactly: a
// synthetic governed_decision_daily-shaped fixture (by_kind populated, as a
// future rollup would carry it — design's own test-plan note that this
// branch is "currently only unit-testable against a synthetic fixture, not a
// real emitter") with 12,340 July decisions all claims_disposition, and
// assumptions {claims_disposition: 20 min, $180/hr}, yields
// hours_saved_est = 4,113.3 and labor_value_est = $740,400, both tagged with
// assumption v1.
func TestBuildSummary_Tier1_WithByKind_AC1(t *testing.T) {
	assumptions := &domain.ValueAssumptions{
		Version:             1,
		MinutesPerDecision:  map[string]float64{"claims_disposition": 20},
		LoadedHourlyRateUSD: 180,
	}
	out := BuildSummary(Input{
		Period:    "2026-07",
		AICostUSD: 812.44,
		Decisions: &domain.DecisionsBreakdown{
			Total:      12340,
			ByDecision: map[string]int64{"approved": 11800, "edited": 420, "rejected": 120},
			ByKind:     map[string]int64{"claims_disposition": 12340},
			ByAgent:    map[string]int64{"claims-copilot": 12340},
			ByPack:     map[string]int64{"insurance-claims-payer": 12340},
		},
		Assumptions:   assumptions,
		Adoption:      domain.Adoption{ActiveUsers: 84, ByWorkspace: map[string]int64{"ws-7": 40, "ws-9": 44}},
		RollupVersion: "usage_monthly@2026-07-finalized",
	})

	require.NotNil(t, out.HoursSavedEst)
	require.InDelta(t, 4113.3, out.HoursSavedEst.Value(), 0.05)
	require.Equal(t, 1, out.HoursSavedEst.AssumptionVersion())

	require.NotNil(t, out.LaborValueEstUSD)
	require.InDelta(t, 740400.0, out.LaborValueEstUSD.Value(), 0.5)
	require.Equal(t, 1, out.LaborValueEstUSD.AssumptionVersion())

	require.NotNil(t, out.HumanBaselineCostUSD)
	require.InDelta(t, 740400.0, out.HumanBaselineCostUSD.Value(), 0.5)

	require.NotNil(t, out.NetValueEstUSD)
	require.InDelta(t, 740400.0-812.44, out.NetValueEstUSD.Value(), 0.5)

	require.NotNil(t, out.Provenance.AssumptionVersion)
	require.Equal(t, 1, *out.Provenance.AssumptionVersion)
}

// TestBuildSummary_AssumptionsUnset covers AC-1's second case: with
// assumptions unset, hours_saved_est/labor_value_est_usd/
// human_baseline_cost_usd/net_value_est_usd are all null; decisions/
// ai_cost_usd/adoption are unaffected.
func TestBuildSummary_AssumptionsUnset(t *testing.T) {
	out := BuildSummary(Input{
		Period:    "2026-07",
		AICostUSD: 812.44,
		Decisions: &domain.DecisionsBreakdown{
			Total:  12340,
			ByKind: map[string]int64{"claims_disposition": 12340},
		},
		Assumptions:   nil,
		RollupVersion: "usage_monthly@2026-07-finalized",
	})

	require.Nil(t, out.HoursSavedEst)
	require.Nil(t, out.LaborValueEstUSD)
	require.Nil(t, out.HumanBaselineCostUSD)
	require.Nil(t, out.NetValueEstUSD)
	require.Nil(t, out.Provenance.AssumptionVersion)
	require.NotNil(t, out.Decisions)
	require.EqualValues(t, 12340, out.Decisions.Total)
	require.Equal(t, 812.44, out.AICostUSD)
}

// TestBuildSummary_ZeroDecisions_NoCostPerDecision: a real (not Tier 0) zero
// decisions count must not divide-by-zero into a fabricated cost_per_decision.
func TestBuildSummary_ZeroDecisions_NoCostPerDecision(t *testing.T) {
	out := BuildSummary(Input{
		Period:    "2026-01",
		AICostUSD: 0,
		Decisions: &domain.DecisionsBreakdown{Total: 0},
	})
	require.NotNil(t, out.Decisions, "meter IS available, the tenant just had zero decisions this period")
	require.Nil(t, out.CostPerDecision)
}

// TestEstimatedValue_MarshalJSON_NilVsPopulated is the ROI-NFR-004 guarantee,
// tested directly (design §2.2): nil -> JSON null; populated -> {value,
// assumption_version}, round-tripping through a containing struct the same
// way domain.ValueSummary embeds the pointer.
func TestEstimatedValue_MarshalJSON_NilVsPopulated(t *testing.T) {
	var nilPtr *domain.EstimatedValue
	b, err := json.Marshal(nilPtr)
	require.NoError(t, err)
	require.JSONEq(t, "null", string(b))

	populated := domain.NewEstimatedValue(4113.3, 1)
	b, err = json.Marshal(populated)
	require.NoError(t, err)
	require.JSONEq(t, `{"value":4113.3,"assumption_version":1}`, string(b))

	type wrapper struct {
		HoursSavedEst *domain.EstimatedValue `json:"hours_saved_est"`
	}
	wNil, _ := json.Marshal(wrapper{})
	require.JSONEq(t, `{"hours_saved_est":null}`, string(wNil))

	wSet, _ := json.Marshal(wrapper{HoursSavedEst: domain.NewEstimatedValue(740400, 1)})
	require.JSONEq(t, `{"hours_saved_est":{"value":740400,"assumption_version":1}}`, string(wSet))
}

// TestValueSummary_JSONRoundTrip_AllTiers proves the whole ValueSummary
// struct (not just EstimatedValue in isolation) never turns a nil estimate
// into 0/omitted-vs-present confusion across the three tiers.
func TestValueSummary_JSONRoundTrip_AllTiers(t *testing.T) {
	tier0 := BuildSummary(Input{Period: "2026-01", RollupVersion: "usage_monthly@2026-01-finalized"})
	b, err := json.Marshal(tier0)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(b, &decoded))
	require.Nil(t, decoded["decisions"])
	require.Nil(t, decoded["hours_saved_est"])
	require.Nil(t, decoded["cost_per_decision"])
	require.Nil(t, decoded["ladder_savings_usd"])
}
