package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// fakeFieldValidator is a unit-tier double for FieldValidator (never wired
// from cmd/server) — it answers KnownFields from a fixed model->fields map,
// standing in for the real semantic-service metadata lookup.
type fakeFieldValidator struct {
	fields map[string]map[string]bool // model -> known field set
	calls  int
}

func (f *fakeFieldValidator) KnownFields(_ context.Context, _, model, _ string) (map[string]bool, error) {
	f.calls++
	return f.fields[model], nil
}

// TestCreateChartAcceptsKnownFields: a chart referencing fields that really
// exist in the resolved semantic model is created (CHART-FR-013 happy path).
func TestCreateChartAcceptsKnownFields(t *testing.T) {
	h := newHarness(t)
	h.srv.Fields = &fakeFieldValidator{fields: map[string]map[string]bool{
		"sales": {"revenue": true, "region": true},
	}}
	tenant := uuid.New()
	tok := h.token(t, tenant)
	ws := uuid.New()
	dcr := h.do(t, "POST", "/api/v1/dashboards", tok, map[string]any{
		"name": "D1", "module": "insights", "workspace_id": ws.String(),
	}, nil)
	if dcr.status != http.StatusCreated {
		t.Fatalf("create dashboard: %d %v", dcr.status, dcr.body)
	}
	dashID := dataMap(dcr)["id"].(string)

	body := map[string]any{
		"name": "Revenue by region", "chart_type": "vertical_bar_chart",
		"sources":      []map[string]any{{"source_type": "semantic_measure", "source_urn": "wr:t:semantic:measure/revenue"}},
		"config":       map[string]any{"x": map[string]any{"dimension": "region"}, "y": []map[string]any{{"measure": "revenue", "agg_fn": "sum"}}},
		"display_meta": map[string]any{"semantic_model": "sales", "workspace_id": ws.String()},
	}
	r := h.do(t, "POST", "/api/v1/dashboards/"+dashID+"/charts", tok, body, nil)
	if r.status != http.StatusCreated {
		t.Fatalf("create chart: want 201, got %d %v", r.status, r.body)
	}
}

// TestCreateChartRejectsUnknownField: a chart referencing a measure that does
// not exist in the resolved semantic model is rejected with a per-field
// UNKNOWN_DIMENSION detail (CHART-FR-013), not silently accepted.
func TestCreateChartRejectsUnknownField(t *testing.T) {
	h := newHarness(t)
	h.srv.Fields = &fakeFieldValidator{fields: map[string]map[string]bool{
		"sales": {"revenue": true, "region": true},
	}}
	tenant := uuid.New()
	tok := h.token(t, tenant)
	ws := uuid.New()
	dcr := h.do(t, "POST", "/api/v1/dashboards", tok, map[string]any{
		"name": "D1", "module": "insights", "workspace_id": ws.String(),
	}, nil)
	if dcr.status != http.StatusCreated {
		t.Fatalf("create dashboard: %d %v", dcr.status, dcr.body)
	}
	dashID := dataMap(dcr)["id"].(string)

	body := map[string]any{
		"name": "Bogus measure", "chart_type": "vertical_bar_chart",
		"sources":      []map[string]any{{"source_type": "semantic_measure", "source_urn": "wr:t:semantic:measure/does_not_exist"}},
		"config":       map[string]any{"x": map[string]any{"dimension": "region"}, "y": []map[string]any{{"measure": "does_not_exist", "agg_fn": "sum"}}},
		"display_meta": map[string]any{"semantic_model": "sales", "workspace_id": ws.String()},
	}
	r := h.do(t, "POST", "/api/v1/dashboards/"+dashID+"/charts", tok, body, nil)
	if r.status != http.StatusUnprocessableEntity {
		t.Fatalf("create chart: want 422, got %d %v", r.status, r.body)
	}
	if errCode(r) != "VALIDATION_FAILED" {
		t.Fatalf("want VALIDATION_FAILED, got %v", r.body)
	}
	errObj, _ := r.body["error"].(map[string]any)
	details, _ := errObj["details"].([]any)
	found := false
	for _, d := range details {
		dm, _ := d.(map[string]any)
		if dm["field"] == "config.y[0].measure" && dm["code"] == "UNKNOWN_DIMENSION" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing UNKNOWN_DIMENSION detail for config.y[0].measure; got %v", details)
	}
}

// TestUpdateChartRejectsUnknownField: known-field validation also runs on
// update (CHART-FR-013), not just create.
func TestUpdateChartRejectsUnknownField(t *testing.T) {
	h := newHarness(t)
	h.srv.Fields = &fakeFieldValidator{fields: map[string]map[string]bool{
		"sales": {"revenue": true, "region": true},
	}}
	tenant := uuid.New()
	_, chartID := h.seedChart(t, tenant, `{"semantic_model":"sales"}`)
	tok := h.token(t, tenant)

	body := map[string]any{
		"config": map[string]any{"x": map[string]any{"dimension": "not_a_real_dimension"}, "y": []map[string]any{{"measure": "revenue", "agg_fn": "sum"}}},
	}
	r := h.do(t, "PATCH", "/api/v1/charts/"+chartID.String(), tok, body, nil)
	if r.status != http.StatusUnprocessableEntity {
		t.Fatalf("update chart: want 422, got %d %v", r.status, r.body)
	}
	if errCode(r) != "VALIDATION_FAILED" {
		t.Fatalf("want VALIDATION_FAILED, got %v", r.body)
	}
}

// TestPreviewRejectsUnknownField: the ad hoc preview ("render") path also
// runs known-field validation, matching create/update.
func TestPreviewRejectsUnknownField(t *testing.T) {
	h := newHarness(t)
	h.srv.Fields = &fakeFieldValidator{fields: map[string]map[string]bool{
		"sales": {"revenue": true, "region": true},
	}}
	tenant := uuid.New()
	tok := h.token(t, tenant)
	ws := uuid.New()
	r := h.do(t, "POST", "/api/v1/charts/preview", tok, map[string]any{
		"chart_type":   "vertical_bar_chart",
		"config":       map[string]any{"x": map[string]any{"dimension": "not_real"}, "y": []map[string]any{{"measure": "revenue", "agg_fn": "sum"}}},
		"sources":      []map[string]any{{"source_type": "semantic_measure", "source_urn": "wr:t:semantic:measure/revenue"}},
		"display_meta": map[string]any{"semantic_model": "sales", "workspace_id": ws.String()},
	}, nil)
	if r.status != http.StatusUnprocessableEntity {
		t.Fatalf("preview: want 422, got %d %v", r.status, r.body)
	}
}
