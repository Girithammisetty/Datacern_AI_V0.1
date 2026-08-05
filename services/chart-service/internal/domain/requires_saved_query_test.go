package domain

import "testing"

// A chart type whose config carries no measures can only resolve through a saved
// query. Creating one without a source produced a chart that returned "chart has
// no measures to resolve" on EVERY render, forever — unresolvable by
// construction, and not fixable from the chart editor because the config was
// never the problem.
//
// These pin which families are in that position, derived from what ParseConfig
// actually populates rather than from a list someone maintains by hand.

func TestRequiresSavedQuery_CoversExactlyTheMeasurelessFamilies(t *testing.T) {
	want := map[string]bool{
		// ParseConfig maps heatmap's "y" to a DIMENSION (cfg.YDim), never cfg.Y.
		FamilyHeatmap: true,
		// grid carries only cfg.Columns.
		FamilyGrid: true,
		// network carries only cfg.Nodes / cfg.Children.
		FamilyNetwork: true,
		// these two DO carry measures and compile normally.
		FamilyAxis:  false,
		FamilyYOnly: false,
		// metric resolves via an artifact, never through the compiler at all.
		FamilyMetric: false,
	}
	for family, expected := range want {
		if got := RequiresSavedQuery(family); got != expected {
			t.Errorf("RequiresSavedQuery(%q) = %v, want %v", family, got, expected)
		}
	}
}

// Every catalogued chart type must land on one side or the other, so a type
// added later cannot quietly fall through to the compiler with no measures.
func TestEveryChartTypeIsEitherCompilableOrSavedQueryOnly(t *testing.T) {
	for _, ct := range Catalog() {
		savedQueryOnly := RequiresSavedQuery(ct.Family)
		artifact := ct.Family == FamilyMetric
		compilable := ct.Family == FamilyAxis || ct.Family == FamilyYOnly
		if !savedQueryOnly && !artifact && !compilable {
			t.Errorf("%s (family %q) resolves by no known route", ct.Name, ct.Family)
		}
	}
}

// The five heatmap-family types are the ones this bug was actually reported
// against — a dashboard rendering "The request was invalid."
func TestTheHeatmapFamilyTypesAreAllSavedQueryOnly(t *testing.T) {
	for _, name := range []string{
		"heatmap_chart", "sunburst_chart", "sankey_chart", "tree_map_chart", "chord_chart",
	} {
		ct, ok := LookupType(name)
		if !ok {
			t.Fatalf("%s missing from the catalog", name)
		}
		if !RequiresSavedQuery(ct.Family) {
			t.Errorf("%s must be saved-query-only; its config carries no measures", name)
		}
	}
}
