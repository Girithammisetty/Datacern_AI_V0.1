// POC-mode handlers (BRD 70 slice 3, DSP-FR-020..022). Creation is
// operator/partner-scoped (requireSuperAdmin, mirroring /demo-tenants --
// BRD 70 §In-scope: "demo/POC tenants are operator/partner-created in
// v1"). Reads and the sponsor-facing manual-value update reuse ActUserAdmin
// + the cross-tenant-404 pattern GET /tenants/{id}/entitlements already
// established (handlers_commercial.go) -- this codebase has no distinct
// "sponsor" RBAC role, so a POC's tenant-admin-scoped caller stands in for
// DSP-FR-021's "sponsor role + SE" access, same as every other
// tenant-self-service surface in this service.
package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/pocexport"
)

// POST /poc-tenants {pack?, window_days, sponsor, success_criteria[]} —
// DSP-FR-020. 202 + operation_id, mirroring handleCreateDemoTenant's shape.
func (s *Server) handleCreatePocTenant(w http.ResponseWriter, r *http.Request) {
	var req domain.CreatePocTenantRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	t, opID, err := s.Poc.Create(r.Context(), req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"operation_id": opID, "tenant": t})
}

// crossTenantGuard is the GET /tenants/{id}/entitlements pattern
// (handlers_commercial.go) generalized: a non-platform caller may only
// touch their own tenant; a mismatch is audited and returns 404 (never 403,
// per MASTER-FR-002/003 -- cross-tenant existence is not disclosed).
func (s *Server) crossTenantGuard(w http.ResponseWriter, r *http.Request, tid uuid.UUID, endpoint string) bool {
	claims := ClaimsFrom(r.Context())
	if !claims.IsSuperAdmin() && claims.TenantID != tid {
		now := s.Clock().UTC()
		ev := domain.NewEvent(domain.EvCrossTenantDenied, claims.TenantID, actorFrom(claims),
			domain.PlatformURN("tenant", tid.String()), now, map[string]any{
				"endpoint": endpoint, "target_tenant": tid.String(),
			})
		ev.TraceID = TraceIDFrom(r.Context())
		_ = s.Store.AppendOutbox(r.Context(), ev)
		writeErr(w, r, domain.ENotFound("tenant"))
		return false
	}
	return true
}

// GET /tenants/{id}/poc/criteria — DSP-FR-020.
func (s *Server) handleGetPocCriteria(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !s.crossTenantGuard(w, r, id, "GET /tenants/{id}/poc/criteria") {
		return
	}
	criteria, err := s.Poc.GetCriteria(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": criteria})
}

// PUT /tenants/{id}/poc/criteria — operator edit of an already-created POC's
// declared criteria set (requireSuperAdmin, same scope as creation itself).
func (s *Server) handleSetPocCriteria(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var body struct {
		SuccessCriteria []domain.SuccessCriterion `json:"success_criteria"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.Poc.SetCriteria(r.Context(), id, body.SuccessCriteria, actorFrom(ClaimsFrom(r.Context()))); err != nil {
		writeErr(w, r, err)
		return
	}
	criteria, err := s.Poc.GetCriteria(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": criteria})
}

// PATCH /tenants/{id}/poc/criteria/{key}/manual-value — DSP-FR-021: sponsor
// updates a manual criterion's reported value (audited).
func (s *Server) handleUpdatePocManualValue(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !s.crossTenantGuard(w, r, id, "PATCH /tenants/{id}/poc/criteria/{key}/manual-value") {
		return
	}
	key := strings.TrimSpace(chi.URLParam(r, "key"))
	var body struct {
		Value float64 `json:"value"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.Poc.UpdateManualValue(r.Context(), id, key, body.Value, actorFrom(ClaimsFrom(r.Context()))); err != nil {
		writeErr(w, r, err)
		return
	}
	criteria, err := s.Poc.GetCriteria(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": criteria})
}

// GET /tenants/{id}/poc/progress — DSP-FR-021's live success dashboard:
// actual-vs-target per criterion, computed from real BRD 69 value data
// (or "inconclusive" when that data is genuinely absent -- never fabricated).
func (s *Server) handleGetPocProgress(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !s.crossTenantGuard(w, r, id, "GET /tenants/{id}/poc/progress") {
		return
	}
	progress, err := s.Poc.Progress(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, progress)
}

// POST /tenants/{id}/poc-reports — DSP-FR-022: generate + store a
// checksummed poc-report.v1 export.
func (s *Server) handleExportPocReport(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !s.crossTenantGuard(w, r, id, "POST /tenants/{id}/poc-reports") {
		return
	}
	export, err := s.Poc.ExportReport(r.Context(), id, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, pocExportView(r.Context(), s, export))
}

// GET /tenants/{id}/poc-reports — list a POC tenant's poc-report.v1 exports.
func (s *Server) handleListPocReports(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !s.crossTenantGuard(w, r, id, "GET /tenants/{id}/poc-reports") {
		return
	}
	exports, err := s.Poc.ListExports(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	views := make([]map[string]any, len(exports))
	for i, e := range exports {
		views[i] = pocExportView(r.Context(), s, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": views})
}

// GET /poc-report-artifacts/* — signed artifact download (HMAC-validated,
// not JWT, mirroring usage-service's GET /value-report-artifacts/*).
func (s *Server) handleDownloadPocReport(w http.ResponseWriter, r *http.Request) {
	if s.PocExports == nil {
		writeErr(w, r, domain.EInternal("poc report export object store not configured"))
		return
	}
	fs, ok := s.PocExports.(*pocexport.FSStore)
	if !ok {
		writeErr(w, r, domain.EInternal("download unsupported by this object store"))
		return
	}
	key := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	q := r.URL.Query()
	exp, _ := strconv.ParseInt(q.Get("exp"), 10, 64)
	data, err := fs.Read(key, exp, q.Get("sig"))
	if err != nil {
		writeErr(w, r, domain.ENotFound("artifact"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", "attachment")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func pocExportView(ctx context.Context, s *Server, e domain.PocExport) map[string]any {
	v := map[string]any{
		"id": e.ID.String(), "version": e.Version,
		"json_sha256": e.JSONSHA256, "generated_by": e.GeneratedBy,
		"created_at": e.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	switch store := s.PocExports.(type) {
	case *pocexport.FSStore:
		exp := s.Clock().Add(24 * time.Hour).Unix()
		v["json_url"] = store.PublicURL + "/api/v1/poc-report-artifacts/" + e.JSONKey +
			"?exp=" + strconv.FormatInt(exp, 10) + "&sig=" + store.Sign(e.JSONKey, exp)
	case *pocexport.S3Store:
		if u, err := store.PresignedURL(ctx, e.JSONKey, 24*time.Hour); err == nil {
			v["json_url"] = u
		}
	}
	return v
}
