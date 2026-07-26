package valuecalc

import "testing"

func TestBuildAllowanceViewComputesRemaining(t *testing.T) {
	used := 2500.0
	got := BuildAllowanceView("governed_decision", 10000, "calendar_month", &used)

	if got.MeterKey != "governed_decision" || got.IncludedQty != 10000 || got.Period != "calendar_month" {
		t.Fatalf("contract fields = %+v", got)
	}
	if got.UsedQty == nil || *got.UsedQty != 2500 {
		t.Fatalf("UsedQty = %v, want 2500", got.UsedQty)
	}
	if got.RemainingQty == nil || *got.RemainingQty != 7500 {
		t.Fatalf("RemainingQty = %v, want 7500", got.RemainingQty)
	}
}

func TestBuildAllowanceViewLeavesUsageNilWhenRollupUnreadable(t *testing.T) {
	// The contract and the consumption come from different sources. When the
	// rollup can't be read, "included 10000, used unknown" is truthful --
	// used=0 would assert the tenant consumed nothing.
	got := BuildAllowanceView("governed_decision", 10000, "calendar_month", nil)

	if got.IncludedQty != 10000 {
		t.Errorf("IncludedQty = %v, want the contracted figure to survive", got.IncludedQty)
	}
	if got.UsedQty != nil || got.RemainingQty != nil {
		t.Fatalf("UsedQty=%v RemainingQty=%v, want both nil", got.UsedQty, got.RemainingQty)
	}
}

func TestBuildAllowanceViewReportsOverageRatherThanClampingIt(t *testing.T) {
	// Going past the allowance is a real fact the cost panel must show; this
	// is a surfacing requirement (CPL-FR-032), and nothing refuses the overage.
	used := 12000.0
	got := BuildAllowanceView("governed_decision", 10000, "calendar_month", &used)

	if got.RemainingQty == nil || *got.RemainingQty != -2000 {
		t.Fatalf("RemainingQty = %v, want -2000 (overage reported, not clamped to 0)", got.RemainingQty)
	}
}

func TestBuildAllowanceViewRoundsToCents(t *testing.T) {
	used := 33.3333
	got := BuildAllowanceView("m", 100, "calendar_month", &used)
	if *got.UsedQty != 33.33 || *got.RemainingQty != 66.67 {
		t.Fatalf("used=%v remaining=%v, want 33.33/66.67", *got.UsedQty, *got.RemainingQty)
	}
}
