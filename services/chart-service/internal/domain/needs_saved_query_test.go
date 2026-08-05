package domain

import "testing"

// A chart whose parsed config yields no metrics can only resolve through a saved
// query — every render otherwise returns "chart has no measures to resolve",
// forever, and no config edit fixes it.
//
// These pin that the rule is derived from the PARSE, not the family. An earlier
// version gated on family and grouped grid with heatmap and network, which was
// wrong: every family except heatmap decodes through ChartConfig's struct tags,
// so a grid carrying x + y compiles exactly like an axis chart. That version
// would have refused 82 working pack charts at install time.

func parse(t *testing.T, family, raw string) ChartConfig {
	t.Helper()
	cfg, err := ParseConfig(family, []byte(raw))
	if err != nil {
		t.Fatalf("parse %s: %v", family, err)
	}
	return cfg
}

func TestAGridCarryingMeasuresCompilesLikeAnAxisChart(t *testing.T) {
	// The exact shape every pack dashboard and both local seeders write.
	cfg := parse(t, FamilyGrid, `{"columns":["claim_type","claim_count"],
		"x":{"dimension":"claim_type"},
		"y":[{"measure":"claim_count","agg_fn":"count"}]}`)
	if NeedsSavedQuery(FamilyGrid, cfg) {
		t.Fatal("a grid with x+y compiles; demanding a saved query would break 82 pack charts")
	}
}

func TestAGridWithColumnsButNoMeasuresCannotResolve(t *testing.T) {
	// The real defect: columns only, nothing for the compiler to aggregate.
	cfg := parse(t, FamilyGrid, `{"columns":["claim_id","provider","amount"]}`)
	if !NeedsSavedQuery(FamilyGrid, cfg) {
		t.Fatal("a measureless grid must require a saved query")
	}
}

func TestHeatmapAlwaysNeedsASavedQuery(t *testing.T) {
	// Its "y" is a DIMENSION (cfg.YDim), so cfg.Y can never populate.
	cfg := parse(t, FamilyHeatmap, `{"x":{"dimension":"region"},
		"y":{"dimension":"product"},"dataseries":{"dimension":"month"}}`)
	if len(cfg.Y) != 0 {
		t.Fatal("heatmap must not populate cfg.Y — see ParseConfig")
	}
	if !NeedsSavedQuery(FamilyHeatmap, cfg) {
		t.Fatal("heatmap carries no measures and must require a saved query")
	}
}

func TestNetworkWithOnlyNodesAndChildrenNeedsASavedQuery(t *testing.T) {
	cfg := parse(t, FamilyNetwork, `{"nodes":"parent","children":"child"}`)
	if !NeedsSavedQuery(FamilyNetwork, cfg) {
		t.Fatal("a nodes/children network carries no measures")
	}
}

func TestMetricFamilyIsExemptBecauseItResolvesViaAnArtifact(t *testing.T) {
	cfg := parse(t, FamilyMetric, `{}`)
	if NeedsSavedQuery(FamilyMetric, cfg) {
		t.Fatal("metric charts resolve through an artifact, never the compiler")
	}
}
