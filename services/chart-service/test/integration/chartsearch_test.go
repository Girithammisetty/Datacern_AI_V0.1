package integration

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// This file is the authoritative test of the BRD 74 D2 search SQL: it runs
// against real Postgres through the shipped non-owner chart_app role, so RLS,
// the dashboards JOIN, the documentations EXISTS sub-select and the ILIKE
// ESCAPE clause are all exercised for real (the unit tier only models them).

// seedSearchDashboard creates a dashboard with an explicit workspace/module/tags.
func (h *harness) seedSearchDashboard(t *testing.T, tenant, ws uuid.UUID, name, module string, tags []string) uuid.UUID {
	t.Helper()
	r := h.do(t, "POST", "/api/v1/dashboards", h.token(t, tenant), map[string]any{
		"name": name, "module": module, "workspace_id": ws.String(), "tags": tags,
	}, nil)
	if r.status != http.StatusCreated {
		t.Fatalf("create dashboard: %d %v", r.status, r.body)
	}
	return uuid.MustParse(dataMap(r)["id"].(string))
}

func (h *harness) seedSearchChart(t *testing.T, tenant, dashID uuid.UUID, name, description string) uuid.UUID {
	t.Helper()
	r := h.do(t, "POST", "/api/v1/dashboards/"+dashID.String()+"/charts", h.token(t, tenant), map[string]any{
		"name": name, "chart_type": "vertical_bar_chart", "description": description,
		"sources": []map[string]any{{"source_type": "semantic_measure", "source_urn": "wr:t:semantic:measure/revenue"}},
		"config":  map[string]any{"x": map[string]any{"dimension": "region"}, "y": []map[string]any{{"measure": "revenue", "agg_fn": "sum"}}},
	}, nil)
	if r.status != http.StatusCreated {
		t.Fatalf("create chart %q: %d %v", name, r.status, r.body)
	}
	return uuid.MustParse(dataMap(r)["id"].(string))
}

// putChartDoc writes a real `documentations` row for a chart. chart-service has
// no HTTP write path for these yet (see the D2 note in BRD 74), so the test
// inserts one directly — through the same RLS-bound app role the service uses.
func (h *harness) putChartDoc(t *testing.T, tenant, chartID uuid.UUID, content string) {
	t.Helper()
	ctx := context.Background()
	err := pgx.BeginFunc(ctx, h.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant.String()); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO documentations (id,tenant_id,documentable_type,documentable_id,content)
			 VALUES ($1,$2,'chart',$3,$4)`, uuid.New(), tenant, chartID, content)
		return err
	})
	if err != nil {
		t.Fatalf("insert documentation: %v", err)
	}
}

func (h *harness) searchIDs(t *testing.T, tenant uuid.UUID, q url.Values) ([]string, resp) {
	t.Helper()
	r := h.do(t, "GET", "/api/v1/charts?"+q.Encode(), h.token(t, tenant), nil, nil)
	var ids []string
	list, _ := r.body["data"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		id, _ := m["id"].(string)
		ids = append(ids, id)
	}
	return ids, r
}

// TestAC04_ChartSearchSQL exercises the real search statement end to end.
func TestAC04_ChartSearchSQL(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	ws := uuid.New()
	dashA := h.seedSearchDashboard(t, tenant, ws, "Claims Ops "+uuid.NewString(), "insights", []string{"claims"})
	dashB := h.seedSearchDashboard(t, tenant, ws, "Finance "+uuid.NewString(), "case_management", []string{"finance"})
	denial := h.seedSearchChart(t, tenant, dashB, "Denial rate by payer", "monthly denial percentage")
	revenue := h.seedSearchChart(t, tenant, dashA, "Revenue by region", "gross revenue")
	h.putChartDoc(t, tenant, revenue, "Owned by the FP&A team; refreshed nightly from the ledger.")

	t.Run("name match across dashboards", func(t *testing.T) {
		ids, r := h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"denial rate"}})
		if r.status != http.StatusOK {
			t.Fatalf("status %d %v", r.status, r.body)
		}
		if len(ids) != 1 || ids[0] != denial.String() {
			t.Fatalf("want denial chart, got %v", ids)
		}
		hit := r.body["data"].([]any)[0].(map[string]any)
		if hit["dashboard_id"] != dashB.String() || hit["dashboard_module"] != "case_management" {
			t.Fatalf("dashboard context wrong: %v", hit)
		}
		if srcs, _ := hit["sources"].([]any); len(srcs) != 1 {
			t.Fatalf("sources not batched onto the hit: %v", hit["sources"])
		}
	})

	t.Run("description match", func(t *testing.T) {
		ids, _ := h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"gross"}})
		if len(ids) != 1 || ids[0] != revenue.String() {
			t.Fatalf("want revenue chart, got %v", ids)
		}
	})

	t.Run("documentation match", func(t *testing.T) {
		ids, _ := h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"FP&A team"}})
		if len(ids) != 1 || ids[0] != revenue.String() {
			t.Fatalf("documentation body not searched: %v", ids)
		}
	})

	t.Run("case insensitive", func(t *testing.T) {
		ids, _ := h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"DENIAL"}})
		if len(ids) != 1 || ids[0] != denial.String() {
			t.Fatalf("ILIKE should be case-insensitive: %v", ids)
		}
	})

	t.Run("like metacharacters are literal", func(t *testing.T) {
		// A bare "%" must not behave as a wildcard (ESCAPE '\' + escaped input).
		ids, _ := h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"%"}})
		if len(ids) != 0 {
			t.Fatalf("%% should match literally, got %v", ids)
		}
		ids, _ = h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"_"}})
		if len(ids) != 0 {
			t.Fatalf("_ should match literally, got %v", ids)
		}
	})

	t.Run("dashboard module and tag filters", func(t *testing.T) {
		ids, _ := h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "module": {"insights"}})
		if len(ids) != 1 || ids[0] != revenue.String() {
			t.Fatalf("module filter: %v", ids)
		}
		ids, _ = h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "tag": {"finance"}})
		if len(ids) != 1 || ids[0] != denial.String() {
			t.Fatalf("tag filter: %v", ids)
		}
		ids, _ = h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "dashboard_id": {dashA.String()}})
		if len(ids) != 1 || ids[0] != revenue.String() {
			t.Fatalf("dashboard_id filter: %v", ids)
		}
	})

	t.Run("archived dashboards excluded", func(t *testing.T) {
		if r := h.do(t, "POST", "/api/v1/dashboards/"+dashA.String()+"/archive", h.token(t, tenant), nil, nil); r.status != http.StatusOK {
			t.Fatalf("archive: %d %v", r.status, r.body)
		}
		defer func() {
			_ = h.do(t, "PATCH", "/api/v1/dashboards/"+dashA.String()+"/restore", h.token(t, tenant), nil, nil)
		}()
		ids, _ := h.searchIDs(t, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"revenue"}})
		if len(ids) != 0 {
			t.Fatalf("archived dashboard leaked: %v", ids)
		}
		ids, _ = h.searchIDs(t, tenant, url.Values{
			"workspace_id": {ws.String()}, "q": {"revenue"}, "include_archived": {"true"}})
		if len(ids) != 1 {
			t.Fatalf("include_archived: %v", ids)
		}
	})

	t.Run("cursor pages without repeats", func(t *testing.T) {
		seen := map[string]bool{}
		cursor := ""
		for i := 0; i < 4; i++ {
			q := url.Values{"workspace_id": {ws.String()}, "limit": {"1"}}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			ids, r := h.searchIDs(t, tenant, q)
			for _, id := range ids {
				if seen[id] {
					t.Fatalf("duplicate id %s", id)
				}
				seen[id] = true
			}
			page := r.body["page"].(map[string]any)
			if page["has_more"] != true {
				if len(seen) != 2 {
					t.Fatalf("saw %d of 2", len(seen))
				}
				return
			}
			cursor, _ = page["next_cursor"].(string)
		}
		t.Fatal("paging did not terminate")
	})
}

// TestAC05_ChartSearchRLS: tenant B searching tenant A's workspace gets nothing
// — enforced by Postgres RLS, not by application filtering.
func TestAC05_ChartSearchRLS(t *testing.T) {
	h := requireHarness(t)
	tenantA := uuid.New()
	ws := uuid.New()
	dash := h.seedSearchDashboard(t, tenantA, ws, "A-only "+uuid.NewString(), "insights", nil)
	chartID := h.seedSearchChart(t, tenantA, dash, "Denial rate secret", "tenant A only")

	ids, r := h.searchIDs(t, uuid.New(), url.Values{"workspace_id": {ws.String()}, "q": {"denial"}})
	if r.status != http.StatusOK {
		t.Fatalf("status %d %v", r.status, r.body)
	}
	if len(ids) != 0 {
		t.Fatalf("RLS leak: %v", ids)
	}
	// And the id itself is a 404 for tenant B.
	g := h.do(t, "GET", "/api/v1/charts/"+chartID.String(), h.token(t, uuid.New()), nil, nil)
	if g.status != http.StatusNotFound {
		t.Fatalf("cross-tenant get want 404, got %d", g.status)
	}
}
