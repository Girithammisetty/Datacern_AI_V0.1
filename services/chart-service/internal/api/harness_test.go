package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/chart-service/internal/authz"
	"github.com/datacern-ai/chart-service/internal/domain"
	"github.com/datacern-ai/chart-service/internal/export"
	"github.com/datacern-ai/chart-service/internal/resolve"
	"github.com/datacern-ai/go-common/authjwt"
	"github.com/datacern-ai/go-common/event"
)

// --- in-memory doubles (unit tier only; never wired from cmd/server) ---

type memStore struct {
	mu    sync.Mutex
	dash  map[uuid.UUID]*domain.Dashboard
	chart map[uuid.UUID]*domain.Chart
	ops   map[uuid.UUID]*domain.Operation
	idem  map[string][]byte
	// chartDocs models the `documentations` rows a chart search reads
	// (documentable_type='chart'). chart-service has no write path for them
	// today — see the D2 note in BRD 74 — so tests set them directly.
	chartDocs map[uuid.UUID]string
}

func newMemStore() *memStore {
	return &memStore{dash: map[uuid.UUID]*domain.Dashboard{}, chart: map[uuid.UUID]*domain.Chart{},
		ops: map[uuid.UUID]*domain.Operation{}, idem: map[string][]byte{},
		chartDocs: map[uuid.UUID]string{}}
}

func (m *memStore) CreateDashboard(_ context.Context, d *domain.Dashboard, _ []event.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d.CreatedAt, d.UpdatedAt = time.Now(), time.Now()
	cp := *d
	m.dash[d.ID] = &cp
	return nil
}
func (m *memStore) GetDashboard(_ context.Context, tenant, id uuid.UUID) (*domain.Dashboard, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.dash[id]
	if !ok || d.TenantID != tenant {
		return nil, domain.ENotFound("dashboard not found")
	}
	cp := *d
	return &cp, nil
}
// ListDashboards models store.PG.ListDashboards (incl. BRD 74 D3's `q`) closely
// enough to exercise the handler contract: workspace + archived + module + tag
// equality, q over name + description, keyset order by id. The authoritative
// test of the SQL itself lives in the integration tier.
func (m *memStore) ListDashboards(_ context.Context, tenant uuid.UUID, f domain.DashboardListFilter) ([]domain.Dashboard, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []domain.Dashboard
	needle := strings.ToLower(f.Q)
	for _, d := range m.dash {
		if d.TenantID != tenant || d.WorkspaceID != f.WorkspaceID || d.Archived != f.Archived {
			continue
		}
		if f.Module != "" && d.Module != f.Module {
			continue
		}
		if f.Tag != "" && !slices.Contains(d.Tags, f.Tag) {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(d.Name), needle) &&
			!strings.Contains(strings.ToLower(d.Description), needle) {
			continue
		}
		if f.After != nil && d.ID.String() <= f.After.String() {
			continue
		}
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID.String() < out[j].ID.String() })
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}
func (m *memStore) UpdateDashboard(_ context.Context, d *domain.Dashboard, _ []event.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.dash[d.ID]; !ok {
		return domain.ENotFound("dashboard not found")
	}
	d.UpdatedAt = time.Now()
	cp := *d
	m.dash[d.ID] = &cp
	return nil
}
func (m *memStore) SetDashboardArchived(_ context.Context, tenant, id uuid.UUID, archived bool, _ []event.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.dash[id]
	if !ok || d.TenantID != tenant {
		return domain.ENotFound("dashboard not found")
	}
	d.Archived = archived
	return nil
}
func (m *memStore) DeleteDashboard(_ context.Context, tenant, id uuid.UUID, _ []event.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.dash[id]; !ok || d.TenantID != tenant {
		return domain.ENotFound("dashboard not found")
	}
	delete(m.dash, id)
	return nil
}
func (m *memStore) DashboardBlockingCharts(_ context.Context, tenant, dashboardID uuid.UUID) ([]uuid.UUID, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []uuid.UUID
	for _, c := range m.chart {
		if c.DashboardID == dashboardID && allowsCases(c) {
			ids = append(ids, c.ID)
		}
	}
	return ids, nil
}
func (m *memStore) CreateChart(_ context.Context, c *domain.Chart, _ []event.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.dash[c.DashboardID]; !ok {
		return domain.ENotFound("dashboard not found")
	}
	c.CreatedAt, c.UpdatedAt = time.Now(), time.Now()
	cp := *c
	m.chart[c.ID] = &cp
	return nil
}
func (m *memStore) GetChart(_ context.Context, tenant, id uuid.UUID) (*domain.Chart, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.chart[id]
	if !ok || c.TenantID != tenant {
		return nil, domain.ENotFound("chart not found")
	}
	cp := *c
	return &cp, nil
}
func (m *memStore) ListCharts(_ context.Context, tenant, dashboardID uuid.UUID) ([]domain.Chart, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []domain.Chart
	for _, c := range m.chart {
		if c.TenantID == tenant && c.DashboardID == dashboardID {
			out = append(out, *c)
		}
	}
	return out, nil
}

// SearchCharts models store.PG.SearchCharts (BRD 74 D2) closely enough to
// exercise the handler contract: dashboard-scoped module/tag/archived filters,
// q over chart name + description + chart-scoped documentation, keyset order by
// id. The authoritative test of the SQL itself lives in the integration tier.
func (m *memStore) SearchCharts(_ context.Context, tenant uuid.UUID, f domain.ChartSearchFilter) ([]domain.ChartSearchHit, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []domain.ChartSearchHit
	needle := strings.ToLower(f.Q)
	for _, c := range m.chart {
		if c.TenantID != tenant {
			continue
		}
		d, ok := m.dash[c.DashboardID]
		if !ok || d.TenantID != tenant || d.WorkspaceID != f.WorkspaceID {
			continue
		}
		if d.Archived && !f.IncludeArchived {
			continue
		}
		if f.Module != "" && d.Module != f.Module {
			continue
		}
		if f.Tag != "" && !slices.Contains(d.Tags, f.Tag) {
			continue
		}
		if f.DashboardID != nil && c.DashboardID != *f.DashboardID {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(c.Name), needle) &&
			!strings.Contains(strings.ToLower(c.Description), needle) &&
			!strings.Contains(strings.ToLower(m.chartDocs[c.ID]), needle) {
			continue
		}
		if f.After != nil && c.ID.String() <= f.After.String() {
			continue
		}
		out = append(out, domain.ChartSearchHit{Chart: *c, DashboardName: d.Name,
			DashboardModule: d.Module, DashboardTags: d.Tags})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID.String() < out[j].ID.String() })
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}

func (m *memStore) UpdateChart(_ context.Context, c *domain.Chart, versionBump bool, expectVersion int, _ []event.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.chart[c.ID]
	if !ok {
		return domain.ENotFound("chart not found")
	}
	if expectVersion > 0 && expectVersion != cur.ChartVersion {
		return domain.EConflict("stale version")
	}
	if versionBump {
		c.ChartVersion = cur.ChartVersion + 1
	} else {
		c.ChartVersion = cur.ChartVersion
	}
	cp := *c
	m.chart[c.ID] = &cp
	return nil
}
func (m *memStore) DeleteChart(_ context.Context, tenant, id uuid.UUID, _ []event.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.chart[id]; !ok || c.TenantID != tenant {
		return domain.ENotFound("chart not found")
	}
	delete(m.chart, id)
	return nil
}
func (m *memStore) ChartAllowsCases(_ context.Context, tenant, id uuid.UUID) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.chart[id]
	if !ok || c.TenantID != tenant {
		return false, domain.ENotFound("chart not found")
	}
	return allowsCases(c), nil
}
func (m *memStore) CreateLink(_ context.Context, tenant, parentID, childID uuid.UUID, cols []domain.ColumnPair, linkType int, _ []event.Envelope) error {
	if parentID == childID {
		return domain.ECircularLink("self link")
	}
	return nil
}
func (m *memStore) RemoveLink(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, []event.Envelope) error {
	return nil
}
func (m *memStore) CreateOperation(_ context.Context, op *domain.Operation, tenant uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *op
	m.ops[op.ID] = &cp
	return nil
}
func (m *memStore) GetOperation(_ context.Context, tenant, id uuid.UUID) (*domain.Operation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	op, ok := m.ops[id]
	if !ok {
		return nil, domain.ENotFound("operation not found")
	}
	cp := *op
	return &cp, nil
}
func (m *memStore) UpdateOperation(_ context.Context, tenant, id uuid.UUID, status, url, urn, errMsg string, expires *time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if op, ok := m.ops[id]; ok {
		op.Status, op.ArtifactURL, op.ArtifactURN, op.Error, op.ExpiresAt = status, url, urn, errMsg, expires
	}
	return nil
}
func (m *memStore) ConcurrentExports(context.Context, uuid.UUID) (int, error) { return 0, nil }
func (m *memStore) GetIdempotent(_ context.Context, tenant uuid.UUID, key, method, path string) (int, []byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if b, ok := m.idem[key+method+path]; ok {
		return http.StatusCreated, b, true, nil
	}
	return 0, nil, false, nil
}
func (m *memStore) PutIdempotent(_ context.Context, tenant uuid.UUID, key, method, path string, status int, body []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.idem[key+method+path] = body
	return nil
}

func allowsCases(c *domain.Chart) bool {
	var dm struct {
		AllowCases bool `json:"allow_cases"`
	}
	_ = json.Unmarshal(c.DisplayMeta, &dm)
	return dm.AllowCases
}

// memCache is an in-memory result cache double.
type memCache struct {
	mu    sync.Mutex
	data  map[string]*domain.ShapedResult
	locks map[string]bool
}

func newMemCache() *memCache {
	return &memCache{data: map[string]*domain.ShapedResult{}, locks: map[string]bool{}}
}
func (m *memCache) Get(_ context.Context, key string) (*domain.ShapedResult, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.data[key]
	return r, ok, nil
}
func (m *memCache) Set(_ context.Context, key, tenant, chartID string, urns []string, res *domain.ShapedResult) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = res
	return nil
}
func (m *memCache) InvalidateChart(_ context.Context, tenant, chartID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.data {
		delete(m.data, k)
	}
	return nil
}
func (m *memCache) AcquireLock(_ context.Context, key string) (bool, error) { return true, nil }
func (m *memCache) ReleaseLock(_ context.Context, key string) error         { return nil }

// stubResolver returns a canned result and counts calls (proves cache short-
// circuits the resolver, AC-2).
type stubResolver struct {
	mu    sync.Mutex
	calls int
	res   *domain.ShapedResult
	err   error
}

func (s *stubResolver) Resolve(_ context.Context, _ string, chart *domain.Chart, _ domain.ResolveRequest) (*domain.ShapedResult, error) {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	r := *s.res
	r.ChartID = chart.ID.String()
	r.ChartVersion = chart.ChartVersion
	return &r, nil
}
func (s *stubResolver) Drilldown(_ context.Context, _ string, queryURN string, dr resolve.DrilldownRequest) (resolve.ExecResult, error) {
	return resolve.ExecResult{Columns: []domain.ExecColumn{{Name: "region"}}, Rows: [][]any{{"EMEA"}}, NextCursor: "next"}, nil
}
func (s *stubResolver) callCount() int { s.mu.Lock(); defer s.mu.Unlock(); return s.calls }

// --- harness ---

type harness struct {
	srv      *Server
	http     *httptest.Server
	key      *rsa.PrivateKey
	store    *memStore
	cache    *memCache
	resolver *stubResolver
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	st := newMemStore()
	c := newMemCache()
	res := &stubResolver{res: &domain.ShapedResult{ChartType: "vertical_bar_chart", Aggregated: true,
		Columns: []string{"region", "sum_revenue"}, Rows: [][]any{{"EMEA", 1250000.5}}, RowCount: 1}}
	srv := &Server{
		Store: st, Cache: c, Authz: authz.AllowAll{}, Resolver: res,
		Verifier:   authjwt.NewStatic(&key.PublicKey, "datacern-test", "datacern"),
		Exports:    export.NewFSStore(t.TempDir(), "http://test", []byte("secret")),
		PreviewSem: make(chan struct{}, 5),
	}
	ts := httptest.NewServer(srv.Router())
	t.Cleanup(ts.Close)
	return &harness{srv: srv, http: ts, key: key, store: st, cache: c, resolver: res}
}

func (h *harness) token(t *testing.T, tenant uuid.UUID) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": "user-1", "tenant_id": tenant.String(), "typ": "user",
		"iss": "datacern-test", "aud": "datacern", "exp": time.Now().Add(5 * time.Minute).Unix(),
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type resp struct {
	status  int
	body    map[string]any
	headers http.Header
}

func (h *harness) do(t *testing.T, method, path, token string, body any, hdrs map[string]string) resp {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, h.http.URL+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdrs {
		req.Header.Set(k, v)
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Body.Close() }()
	raw, _ := io.ReadAll(r.Body)
	out := resp{status: r.StatusCode, headers: r.Header}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out.body)
	}
	return out
}

func dataMap(r resp) map[string]any {
	d, _ := r.body["data"].(map[string]any)
	return d
}
func errCode(r resp) string {
	if e, ok := r.body["error"].(map[string]any); ok {
		c, _ := e["code"].(string)
		return c
	}
	return ""
}

// seedDashboard creates a dashboard in an explicit workspace/module with tags
// (chart search filters on all three).
func (h *harness) seedDashboard(t *testing.T, tenant, ws uuid.UUID, name, module string, tags []string) uuid.UUID {
	t.Helper()
	r := h.do(t, "POST", "/api/v1/dashboards", h.token(t, tenant), map[string]any{
		"name": name, "module": module, "workspace_id": ws.String(), "tags": tags,
	}, nil)
	if r.status != http.StatusCreated {
		t.Fatalf("create dashboard: %d %v", r.status, r.body)
	}
	return uuid.MustParse(dataMap(r)["id"].(string))
}

// seedNamedChart creates a chart with an explicit name + description.
func (h *harness) seedNamedChart(t *testing.T, tenant, dashID uuid.UUID, name, description string) uuid.UUID {
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

// seed creates a dashboard + chart and returns their ids.
func (h *harness) seedChart(t *testing.T, tenant uuid.UUID, displayMeta string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	tok := h.token(t, tenant)
	ws := uuid.New()
	cr := h.do(t, "POST", "/api/v1/dashboards", tok, map[string]any{
		"name": "D" + uuid.NewString(), "module": "insights", "workspace_id": ws.String(),
	}, nil)
	if cr.status != http.StatusCreated {
		t.Fatalf("create dashboard: %d %v", cr.status, cr.body)
	}
	dashID := uuid.MustParse(dataMap(cr)["id"].(string))
	body := map[string]any{
		"name": "C" + uuid.NewString(), "chart_type": "vertical_bar_chart",
		"sources": []map[string]any{{"source_type": "semantic_measure", "source_urn": "wr:t:semantic:measure/revenue"}},
		"config":  map[string]any{"x": map[string]any{"dimension": "region"}, "y": []map[string]any{{"measure": "revenue", "agg_fn": "sum"}}},
	}
	if displayMeta != "" {
		var dm map[string]any
		_ = json.Unmarshal([]byte(displayMeta), &dm)
		body["display_meta"] = dm
	}
	ccr := h.do(t, "POST", "/api/v1/dashboards/"+dashID.String()+"/charts", tok, body, nil)
	if ccr.status != http.StatusCreated {
		t.Fatalf("create chart: %d %v", ccr.status, ccr.body)
	}
	chartID := uuid.MustParse(dataMap(ccr)["id"].(string))
	return dashID, chartID
}
