package integration

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// The reported bug, end to end: a dashboard rendering "The request was invalid /
// chart has no measures to resolve", with a Retry button that could never help
// because the chart was unresolvable by construction.
//
// The API used to accept such a chart — ValidateConfig checked the config and
// never the SOURCE — so the failure surfaced only at render time, as an error
// naming an internal state ("no measures") rather than the missing thing.

func TestCreatingAMeasurelessChartWithoutASavedQueryIsRefused(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant)
	_, dashID, _ := h.seedChart(t, tenant, nil)

	// grid WITHOUT measures, plus the heatmap family (whose "y" is a dimension,
	// so cfg.Y can never populate).
	for _, ct := range []string{"grid_chart", "heatmap_chart", "sunburst_chart", "sankey_chart"} {
		body := map[string]any{"name": "x", "chart_type": ct, "config": configFor(ct)}
		resp := h.do(t, "POST", "/api/v1/dashboards/"+dashID.String()+"/charts", tok, body, nil)
		if resp.status != http.StatusUnprocessableEntity {
			t.Errorf("%s without a saved query: got %d, want 422 (it could never render)",
				ct, resp.status)
		}
	}
}

func TestTheRefusalNamesTheMissingSourceNotTheConfig(t *testing.T) {
	// The whole point: the old failure blamed "measures", which is a fact about
	// cfg.Y that the user cannot act on and cannot fix from the chart editor.
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant)
	_, dashID, _ := h.seedChart(t, tenant, nil)

	resp := h.do(t, "POST", "/api/v1/dashboards/"+dashID.String()+"/charts", tok,
		map[string]any{"name": "x", "chart_type": "grid_chart", "config": configFor("grid_chart")}, nil)
	errObj, _ := resp.body["error"].(map[string]any)
	details, _ := errObj["details"].([]any)
	if len(details) == 0 {
		t.Fatalf("expected a field detail, got %v", resp.body)
	}
	d, _ := details[0].(map[string]any)
	if d["field"] != "sources" {
		t.Errorf("the error must point at sources, not the config; got field=%v", d["field"])
	}
}

func TestTheSameChartIsAcceptedWithASavedQuery(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant)
	_, dashID, _ := h.seedChart(t, tenant, nil)

	resp := h.do(t, "POST", "/api/v1/dashboards/"+dashID.String()+"/charts", tok, map[string]any{
		"name": "x", "chart_type": "grid_chart", "config": configFor("grid_chart"),
		"sources": []map[string]any{{
			"position": 0, "source_type": "saved_query",
			"source_urn": "wr:t:query:saved_query/" + uuid.New().String(),
		}},
	}, nil)
	if resp.status != http.StatusCreated {
		t.Fatalf("with a saved query: got %d %v, want 201", resp.status, resp.body)
	}
}

// A GRID carrying x + y — the shape every pack dashboard writes — must still
// create. An earlier family-based version of this rule refused it, which would
// have broken the install of 27 packs.
func TestAPackShapedGridChartStillCreates(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant)
	_, dashID, _ := h.seedChart(t, tenant, nil)

	resp := h.do(t, "POST", "/api/v1/dashboards/"+dashID.String()+"/charts", tok, map[string]any{
		"name": "pack grid", "chart_type": "grid_chart",
		"config": map[string]any{
			"columns": []string{"program", "determination_count"},
			"x":       map[string]any{"dimension": "program"},
			"y":       []map[string]any{{"measure": "determination_count", "agg_fn": "count"}},
		},
		"sources": []map[string]any{{
			"position": 0, "source_type": "semantic_measure",
			"source_urn": "wr:t:semantic:measure/determination_count",
		}},
	}, nil)
	if resp.status != http.StatusCreated {
		t.Fatalf("a pack-shaped grid must create: %d %v", resp.status, resp.body)
	}
}

// The families that DO carry measures must be untouched — this rule must not
// start demanding a saved query from charts that compile perfectly well.
func TestMeasureCarryingChartsAreUnaffected(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant)
	_, dashID, _ := h.seedChart(t, tenant, nil)

	resp := h.do(t, "POST", "/api/v1/dashboards/"+dashID.String()+"/charts", tok, map[string]any{
		"name": "bar", "chart_type": "vertical_bar_chart",
		"config": map[string]any{
			"x": map[string]any{"dimension": "region"},
			"y": []map[string]any{{"measure": "claim_count", "agg_fn": "count"}},
		},
	}, nil)
	if resp.status != http.StatusCreated {
		t.Fatalf("an axis chart with measures must still create: %d %v", resp.status, resp.body)
	}
}

func configFor(chartType string) map[string]any {
	switch chartType {
	case "grid_chart":
		return map[string]any{"columns": []string{"region"}}
	default: // heatmap family
		return map[string]any{
			"x":          map[string]any{"dimension": "region"},
			"y":          map[string]any{"dimension": "product"},
			"dataseries": map[string]any{"dimension": "month"},
		}
	}
}
