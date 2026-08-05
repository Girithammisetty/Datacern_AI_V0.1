package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/chart-service/internal/authz"
	"github.com/datacern-ai/chart-service/internal/domain"
	"github.com/datacern-ai/chart-service/internal/events"
	"github.com/datacern-ai/chart-service/internal/resolve"
	"github.com/datacern-ai/go-common/event"
	"github.com/datacern-ai/go-common/httpx"
)

type chartWrite struct {
	Name        string               `json:"name"`
	ChartType   string               `json:"chart_type"`
	Description string               `json:"description"`
	Config      json.RawMessage      `json:"config"`
	DisplayMeta json.RawMessage      `json:"display_meta"`
	Sources     []domain.ChartSource `json:"sources"`
}

func (s *Server) handleCreateChart(w http.ResponseWriter, r *http.Request) {
	_, tenant, ok := s.claims(w, r)
	if !ok {
		return
	}
	dashID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, domain.ENotFound("dashboard not found"))
		return
	}
	d, err := s.Store.GetDashboard(r.Context(), tenant, dashID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !s.authorize(w, r, authz.ActionChartCreate, events.URN(tenant, "dashboard", dashID.String()), d.WorkspaceID.String()) {
		return
	}
	var in chartWrite
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Name == "" || in.ChartType == "" {
		writeErr(w, r, domain.EValidation("name and chart_type are required"))
		return
	}
	if err := s.validateChartInput(r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	c := &domain.Chart{
		ID: newID(), TenantID: tenant, DashboardID: dashID, Name: in.Name, ChartType: in.ChartType,
		Description: in.Description, Config: rawOr(in.Config, "{}"), DisplayMeta: rawOr(in.DisplayMeta, "{}"),
		ChartVersion: 1, Custom: true, ConfigStatus: "ok", Sources: normalizeSources(in.Sources),
	}
	urn := events.URN(tenant, "chart", c.ID.String())
	ev := events.New(events.ChartCreated, tenant, "user", subject(r), urn, traceID(r.Context()),
		map[string]any{"chart_id": c.ID.String(), "dashboard_id": dashID.String(),
			"chart_type": c.ChartType, "chart_version": 1, "source_urns": sourceURNs(c.Sources)})
	if err := s.replayableCreate(w, r, tenant, http.StatusCreated, chartView(c), func() error {
		return s.Store.CreateChart(r.Context(), c, []event.Envelope{ev})
	}); err != nil {
		writeErr(w, r, err)
	}
}

func (s *Server) handleGetChart(w http.ResponseWriter, r *http.Request) {
	_, tenant, ok := s.claims(w, r)
	if !ok {
		return
	}
	c, err := s.loadChartAuthorized(w, r, tenant, authz.ActionChartRead)
	if err != nil {
		return
	}
	writeData(w, http.StatusOK, chartView(c))
}

func (s *Server) handleUpdateChart(w http.ResponseWriter, r *http.Request) {
	_, tenant, ok := s.claims(w, r)
	if !ok {
		return
	}
	c, err := s.loadChartAuthorized(w, r, tenant, authz.ActionChartUpdate)
	if err != nil {
		return
	}
	var in chartWrite
	if !decodeBody(w, r, &in) {
		return
	}
	versionBump := false
	if in.Name != "" {
		c.Name = in.Name
	}
	if in.Description != "" {
		c.Description = in.Description
	}
	if in.ChartType != "" && in.ChartType != c.ChartType {
		c.ChartType = in.ChartType
		versionBump = true
	}
	if in.Config != nil {
		c.Config = in.Config
		versionBump = true
	}
	if in.DisplayMeta != nil {
		c.DisplayMeta = in.DisplayMeta // display-only change: no version bump
	}
	if in.Sources != nil {
		c.Sources = normalizeSources(in.Sources)
		versionBump = true
	}
	// Re-validate config against (possibly new) type + sources.
	if err := s.validateChartInput(r, &chartWrite{ChartType: c.ChartType, Config: c.Config, DisplayMeta: c.DisplayMeta, Sources: c.Sources}); err != nil {
		writeErr(w, r, err)
		return
	}
	expect := 0
	if m := r.Header.Get("If-Match"); m != "" { // optimistic lock (BR-7)
		if v, err := strconv.Atoi(m); err == nil {
			expect = v
		}
	}
	urn := events.URN(tenant, "chart", c.ID.String())
	ev := events.New(events.ChartUpdated, tenant, "user", subject(r), urn, traceID(r.Context()),
		map[string]any{"chart_id": c.ID.String(), "chart_type": c.ChartType, "source_urns": sourceURNs(c.Sources)})
	if err := s.Store.UpdateChart(r.Context(), c, versionBump, expect, []event.Envelope{ev}); err != nil {
		writeErr(w, r, err)
		return
	}
	// Evict cache for this chart on any change (CHART-FR-031 own update).
	_ = s.Cache.InvalidateChart(r.Context(), tenant.String(), c.ID.String())
	writeData(w, http.StatusOK, chartView(c))
}

// handleSearchCharts serves GET /charts — the cross-dashboard chart search
// (BRD 74 D2), replacing "open every dashboard until you find the denial-rate
// chart".
//
// workspace_id is REQUIRED: `chart.chart.read` is a workspace-scoped grant, so
// one authorization decision can only cover one workspace. `module` and `tag`
// filter on the parent dashboard (charts have no such columns); `q` matches the
// chart's name, description and chart-scoped documentation body. Cursor-paged
// on chart id like every other list here. Archived dashboards are excluded
// unless include_archived=true.
func (s *Server) handleSearchCharts(w http.ResponseWriter, r *http.Request) {
	_, tenant, ok := s.claims(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	wsID, err := uuid.Parse(q.Get("workspace_id"))
	if err != nil {
		writeErr(w, r, domain.EValidation("workspace_id query param is required"))
		return
	}
	if !s.authorize(w, r, authz.ActionChartRead, "", wsID.String()) {
		return
	}
	page, err := httpx.ParsePage(q.Get("limit"), q.Get("cursor"))
	if err != nil {
		writeErr(w, r, domain.EValidation(err.Error()))
		return
	}
	after, err := decodeCursor(q.Get("cursor"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	f := domain.ChartSearchFilter{
		WorkspaceID:     wsID,
		Q:               strings.TrimSpace(q.Get("q")),
		Module:          q.Get("module"),
		Tag:             q.Get("tag"),
		IncludeArchived: q.Get("include_archived") == "true",
		Limit:           page.Limit + 1,
		After:           after,
	}
	switch f.Module {
	case "", domain.ModuleInsights, domain.ModuleCaseManagement, domain.ModuleInspector:
	default:
		writeErr(w, r, domain.EValidation("module must be insights|case_management|inspector"))
		return
	}
	if v := q.Get("dashboard_id"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			writeErr(w, r, domain.EValidation("dashboard_id must be a uuid"))
			return
		}
		f.DashboardID = &id
	}
	hits, err := s.Store.SearchCharts(r.Context(), tenant, f)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var next *string
	hasMore := false
	if len(hits) > page.Limit {
		hasMore = true
		hits = hits[:page.Limit]
		cur := encodeCursor(hits[len(hits)-1].ID)
		next = &cur
	}
	views := make([]any, len(hits))
	for i := range hits {
		views[i] = chartSearchView(&hits[i])
	}
	writePage(w, views, next, hasMore)
}

func (s *Server) handleDeleteChart(w http.ResponseWriter, r *http.Request) {
	_, tenant, ok := s.claims(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, domain.ENotFound("chart not found"))
		return
	}
	c, err := s.Store.GetChart(r.Context(), tenant, id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	d, err := s.Store.GetDashboard(r.Context(), tenant, c.DashboardID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !s.authorize(w, r, authz.ActionChartDelete, events.URN(tenant, "chart", id.String()), d.WorkspaceID.String()) {
		return
	}
	// CHART-FR-016 / AC-8: allow_cases guard → 412.
	allows, err := s.Store.ChartAllowsCases(r.Context(), tenant, id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if allows {
		writeErr(w, r, domain.EChartHasCases(map[string]any{"chart_id": id.String()}))
		return
	}
	urn := events.URN(tenant, "chart", id.String())
	ev := events.New(events.ChartDeleted, tenant, "user", subject(r), urn, traceID(r.Context()),
		map[string]any{"chart_id": id.String()})
	if err := s.Store.DeleteChart(r.Context(), tenant, id, []event.Envelope{ev}); err != nil {
		writeErr(w, r, err)
		return
	}
	_ = s.Cache.InvalidateChart(r.Context(), tenant.String(), id.String())
	w.WriteHeader(http.StatusNoContent)
}

// --- helpers ---

// loadChartAuthorized loads a chart and authorizes action on its dashboard.
func (s *Server) loadChartAuthorized(w http.ResponseWriter, r *http.Request, tenant uuid.UUID, action string) (*domain.Chart, error) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, domain.ENotFound("chart not found"))
		return nil, err
	}
	c, err := s.Store.GetChart(r.Context(), tenant, id)
	if err != nil {
		writeErr(w, r, err)
		return nil, err
	}
	d, err := s.Store.GetDashboard(r.Context(), tenant, c.DashboardID)
	if err != nil {
		writeErr(w, r, err)
		return nil, err
	}
	if !s.authorize(w, r, action, events.URN(tenant, "chart", id.String()), d.WorkspaceID.String()) {
		return nil, errAuthorized
	}
	return c, nil
}

var errAuthorized = domain.EPermission("denied")

func (s *Server) validateChartInput(r *http.Request, in *chartWrite) error {
	if _, ok := domain.LookupType(in.ChartType); !ok {
		return &domain.Error{Status: 422, Code: domain.CodeUnknownChartType, Message: "unknown chart_type " + in.ChartType}
	}
	for i, src := range in.Sources {
		switch src.SourceType {
		case domain.SourceSemanticMeasure, domain.SourceSavedQuery, domain.SourceDataset, domain.SourceMLRun:
		default:
			return domain.EValidation("invalid source_type", []domain.FieldDetail{{Field: "sources[" + strconv.Itoa(i) + "].source_type", Code: "INVALID"}})
		}
		if src.SourceURN == "" {
			return domain.EValidation("source_urn is required", []domain.FieldDetail{{Field: "sources[" + strconv.Itoa(i) + "].source_urn", Code: "REQUIRED"}})
		}
	}
	// A chart whose parsed config yields no metrics can only resolve through a
	// saved query. Without one it is unresolvable BY CONSTRUCTION — every render
	// returns "chart has no measures to resolve" and no config edit fixes it.
	// Checked against the PARSED config, never the family: a grid carrying x + y
	// compiles exactly like an axis chart, and gating on family would refuse 82
	// working pack charts at install time.
	if ct, ok := domain.LookupType(in.ChartType); ok {
		if cfg, perr := domain.ParseConfig(ct.Family, in.Config); perr == nil &&
			domain.NeedsSavedQuery(ct.Family, cfg) {
			hasQuery := false
			for _, src := range in.Sources {
				if src.SourceType == domain.SourceSavedQuery {
					hasQuery = true
					break
				}
			}
			if !hasQuery {
				return domain.EValidation(
					"chart has no measures, so it needs a saved_query source to resolve",
					[]domain.FieldDetail{{
						Field: "sources", Code: "REQUIRED",
						Message: "add a measure to config.y, or a source with " +
							"source_type=" + domain.SourceSavedQuery,
					}})
			}
		}
	}

	known := s.knownFieldSet(r, in.Config, in.DisplayMeta, in.Sources)
	return domain.ValidateConfig(in.ChartType, in.Config, known)
}

// knownFieldSet resolves the real known measure/dimension names for a chart
// spec's semantic model (CHART-FR-013), using the exact model resolution
// resolve.Resolve uses at render time (resolve.ChartModel / DefaultModel), so
// write-time validation and render-time compilation never disagree on which
// model a chart targets. Returns nil (skip the unknown-field check) when no
// validator is wired, the primary source isn't a semantic measure, the model
// can't be resolved, or semantic-service is unreachable.
func (s *Server) knownFieldSet(r *http.Request, config, displayMeta json.RawMessage, sources []domain.ChartSource) map[string]bool {
	if s.Fields == nil {
		return nil
	}
	tmp := &domain.Chart{Config: rawOr(config, "{}"), DisplayMeta: rawOr(displayMeta, "{}"), Sources: sources}
	if src := resolve.PrimarySource(tmp); src.SourceType != domain.SourceSemanticMeasure && src.SourceType != "" {
		return nil
	}
	model := resolve.ChartModel(tmp)
	if model == "" {
		model = s.DefaultModel
	}
	if model == "" {
		return nil
	}
	known, err := s.Fields.KnownFields(r.Context(), bearerToken(r), model, resolve.ChartWorkspace(tmp))
	if err != nil {
		return nil
	}
	return known
}

func normalizeSources(in []domain.ChartSource) []domain.ChartSource {
	out := make([]domain.ChartSource, len(in))
	for i, s := range in {
		s.Position = i
		out[i] = s
	}
	return out
}

func sourceURNs(sources []domain.ChartSource) []string {
	out := make([]string, len(sources))
	for i, s := range sources {
		out[i] = s.SourceURN
	}
	return out
}

// chartSearchView is chartView plus the parent-dashboard context a search hit
// needs to be actionable.
func chartSearchView(h *domain.ChartSearchHit) map[string]any {
	v := chartView(&h.Chart)
	v["dashboard_name"] = h.DashboardName
	v["dashboard_module"] = h.DashboardModule
	v["dashboard_tags"] = orEmpty(h.DashboardTags)
	return v
}

func chartView(c *domain.Chart) map[string]any {
	return map[string]any{
		"id": c.ID, "dashboard_id": c.DashboardID, "name": c.Name, "chart_type": c.ChartType,
		"description": c.Description, "config": rawOr(c.Config, "{}"), "display_meta": rawOr(c.DisplayMeta, "{}"),
		"chart_version": c.ChartVersion, "custom": c.Custom, "config_status": c.ConfigStatus,
		"link_type": c.LinkType, "linked_parent_id": c.LinkedParentID, "sources": c.Sources,
		"created_at": c.CreatedAt, "updated_at": c.UpdatedAt,
	}
}
