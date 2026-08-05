package integration

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"
)

// The authoritative test of the BRD 74 D3 dashboard-search SQL: real Postgres
// through the shipped non-owner chart_app role, so RLS and the
// `ILIKE … ESCAPE '\'` clause are exercised for real (the unit tier models them).

func (h *harness) listDashboardIDs(t *testing.T, tenant uuid.UUID, q url.Values) ([]string, resp) {
	t.Helper()
	r := h.do(t, "GET", "/api/v1/dashboards?"+q.Encode(), h.token(t, tenant), nil, nil)
	var ids []string
	list, _ := r.body["data"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		id, _ := m["id"].(string)
		ids = append(ids, id)
	}
	return ids, r
}

func (h *harness) seedDescribedDashboard(t *testing.T, tenant, ws uuid.UUID, name, module, description string, tags []string) uuid.UUID {
	t.Helper()
	r := h.do(t, "POST", "/api/v1/dashboards", h.token(t, tenant), map[string]any{
		"name": name, "module": module, "workspace_id": ws.String(),
		"description": description, "tags": tags,
	}, nil)
	if r.status != http.StatusCreated {
		t.Fatalf("create dashboard %q: %d %v", name, r.status, r.body)
	}
	return uuid.MustParse(dataMap(r)["id"].(string))
}

// TestAC09_DashboardSearchSQL: the whole point of `q` — a dashboard ranked
// beyond the first page is still findable, plus description matching,
// case-insensitivity, literal LIKE metacharacters and the filter composition.
func TestAC09_DashboardSearchSQL(t *testing.T) {
	h := requireHarness(t)
	tenant, ws := uuid.New(), uuid.New()
	suffix := uuid.NewString()
	for i := 0; i < 60; i++ {
		h.seedSearchDashboard(t, tenant, ws, fmt.Sprintf("Ops board %02d %s", i, suffix), "insights", nil)
	}
	want := h.seedDescribedDashboard(t, tenant, ws, "Denial rate review "+suffix, "insights",
		"Quarterly PAYER mix", []string{"claims"})
	pct := h.seedSearchDashboard(t, tenant, ws, "Denial 100% board "+suffix, "insights", nil)

	t.Run("beyond the first page of 50", func(t *testing.T) {
		page1, r := h.listDashboardIDs(t, tenant, url.Values{
			"workspace_id": {ws.String()}, "limit": {"50"},
		})
		if r.status != http.StatusOK {
			t.Fatalf("list: %d %v", r.status, r.body)
		}
		if len(page1) != 50 {
			t.Fatalf("want a full first page of 50, got %d", len(page1))
		}
		ids, _ := h.listDashboardIDs(t, tenant, url.Values{
			"workspace_id": {ws.String()}, "q": {"denial rate"},
		})
		if len(ids) != 1 || ids[0] != want.String() {
			t.Fatalf(`q="denial rate" want just the 61st dashboard, got %v`, ids)
		}
	})

	t.Run("description match, case-insensitive", func(t *testing.T) {
		ids, _ := h.listDashboardIDs(t, tenant, url.Values{
			"workspace_id": {ws.String()}, "q": {"payer MIX"},
		})
		if len(ids) != 1 || ids[0] != want.String() {
			t.Fatalf("description match: got %v", ids)
		}
	})

	t.Run("% matches literally", func(t *testing.T) {
		ids, _ := h.listDashboardIDs(t, tenant, url.Values{
			"workspace_id": {ws.String()}, "q": {"100%"},
		})
		if len(ids) != 1 || ids[0] != pct.String() {
			t.Fatalf(`q="100%%" must match literally; got %v`, ids)
		}
	})

	t.Run("q composes with tag", func(t *testing.T) {
		ids, _ := h.listDashboardIDs(t, tenant, url.Values{
			"workspace_id": {ws.String()}, "q": {"denial"}, "filter[tag]": {"claims"},
		})
		if len(ids) != 1 || ids[0] != want.String() {
			t.Fatalf("q+tag: got %v", ids)
		}
	})

	t.Run("cursor paging over the q result set", func(t *testing.T) {
		seen := map[string]bool{}
		cursor := ""
		for i := 0; i < 6; i++ {
			q := url.Values{"workspace_id": {ws.String()}, "q": {"denial"}, "limit": {"1"}}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			ids, r := h.listDashboardIDs(t, tenant, q)
			if r.status != http.StatusOK {
				t.Fatalf("page %d: %d %v", i, r.status, r.body)
			}
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

// TestAC09_DashboardSearchRLS: tenant B searching tenant A's workspace gets
// nothing — enforced by Postgres RLS, not by application filtering.
func TestAC09_DashboardSearchRLS(t *testing.T) {
	h := requireHarness(t)
	tenantA, ws := uuid.New(), uuid.New()
	id := h.seedSearchDashboard(t, tenantA, ws, "Denial rate secret "+uuid.NewString(), "insights", nil)

	ids, r := h.listDashboardIDs(t, uuid.New(), url.Values{
		"workspace_id": {ws.String()}, "q": {"denial"},
	})
	if r.status != http.StatusOK {
		t.Fatalf("status %d %v", r.status, r.body)
	}
	if len(ids) != 0 {
		t.Fatalf("RLS leak: %v", ids)
	}
	g := h.do(t, "GET", "/api/v1/dashboards/"+id.String(), h.token(t, uuid.New()), nil, nil)
	if g.status != http.StatusNotFound {
		t.Fatalf("cross-tenant get want 404, got %d", g.status)
	}
}
