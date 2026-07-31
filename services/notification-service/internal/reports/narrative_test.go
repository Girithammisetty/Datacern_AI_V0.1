package reports

import (
	"strings"
	"testing"
	"time"
)

func p50(v int64) *int64 { return &v }

// The narrative is emailed on a schedule, unread by its author, to someone who
// will act on it. These tests pin the claims it must never make.

func TestNarrativeNeverClaimsInstantDecisionsWithoutASample(t *testing.T) {
	// Nothing resolved: there is no median. A "median time to decision" line
	// here would be a fabricated performance claim.
	got := strings.Join(Narrative(&DecisionsDigest{
		WindowDays: 7, Opened: 4, Resolved: 0, OpenTotal: 4,
		P50Seconds: nil, Sample: 0,
	}), " ")
	if strings.Contains(got, "Median time to decision") {
		t.Errorf("narrative claimed a median with no sample: %q", got)
	}
	if !strings.Contains(got, "none were resolved") {
		t.Errorf("narrative should say plainly that nothing was resolved: %q", got)
	}
}

func TestNarrativeQualifiesAThinSample(t *testing.T) {
	got := strings.Join(Narrative(&DecisionsDigest{
		WindowDays: 7, Opened: 5, Resolved: 3, OpenTotal: 2,
		P50Seconds: p50(7200), Sample: 3,
	}), " ")
	// A median over three cases is not a trend, and the executive reading this
	// cannot see the sample size unless it is stated.
	if !strings.Contains(got, "too few to read as a trend") {
		t.Errorf("thin sample not qualified: %q", got)
	}
	if !strings.Contains(got, "2.0h") {
		t.Errorf("median not rendered as a duration: %q", got)
	}
}

func TestNarrativeComparesResolvedAgainstIntake(t *testing.T) {
	// The comparison a manager acts on: neither number says it alone.
	behind := strings.Join(Narrative(&DecisionsDigest{
		WindowDays: 7, Opened: 10, Resolved: 4, OpenTotal: 12}), " ")
	if !strings.Contains(behind, "behind intake by 6") {
		t.Errorf("expected a behind-intake verdict: %q", behind)
	}
	ahead := strings.Join(Narrative(&DecisionsDigest{
		WindowDays: 7, Opened: 2, Resolved: 9, OpenTotal: 1}), " ")
	if !strings.Contains(ahead, "ahead of intake by 7") {
		t.Errorf("expected an ahead-of-intake verdict: %q", ahead)
	}
}

func TestNarrativeLeadsWithSLABreaches(t *testing.T) {
	got := Narrative(&DecisionsDigest{
		WindowDays: 7, Opened: 3, Resolved: 3, OpenTotal: 9, SLABreached: 4})
	last := got[len(got)-1]
	if !strings.Contains(last, "4 of the 9") {
		t.Errorf("SLA breach line missing or malformed: %q", last)
	}
}

func TestNarrativeIsEmptyWithoutData(t *testing.T) {
	// nil decisions must produce NO sentences — the report omits the section
	// rather than narrating an absence as a fact.
	if got := Narrative(nil); len(got) != 0 {
		t.Errorf("narrative invented text from nil decisions: %q", got)
	}
}

// A failed case-service call must omit the section, never render zeroes: "0
// resolved" because HTTP failed is indistinguishable from a genuinely quiet
// week, and one of those is a lie.
func TestRenderOmitsDecisionsWhenUnavailable(t *testing.T) {
	digest := &DashboardDigest{DashboardName: "Ops"}
	out := RenderWithDecisions(digest, nil, time.Date(2026, 7, 12, 9, 0, 0, 0, time.UTC))
	if strings.Contains(out.HTML, "Decisions this period") ||
		strings.Contains(out.Text, "Decisions this period") {
		t.Error("decisions section rendered despite unavailable data")
	}
	if strings.Contains(out.Text, "Resolved: 0") {
		t.Error("rendered a zero that would read as 'nothing was decided'")
	}
}

func TestRenderIncludesDecisionsWhenAvailable(t *testing.T) {
	digest := &DashboardDigest{DashboardName: "Ops"}
	out := RenderWithDecisions(digest, &DecisionsDigest{
		WindowDays: 7, Opened: 5, Resolved: 6, Closed: 2, OpenTotal: 3,
		SLABreached: 1, P50Seconds: p50(255600), Sample: 6,
	}, time.Date(2026, 7, 12, 9, 0, 0, 0, time.UTC))
	for _, want := range []string{"Decisions this period", "Resolved: 6", "Past SLA: 1"} {
		if !strings.Contains(out.Text, want) {
			t.Errorf("text digest missing %q", want)
		}
	}
	// The median carries its sample size wherever it appears.
	if !strings.Contains(out.Text, "n=6") {
		t.Errorf("median rendered without its sample size: %q", out.Text)
	}
}
