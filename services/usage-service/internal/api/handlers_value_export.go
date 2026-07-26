package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/valueexport"
)

const valueExportSchema = "value-report.v1"

type exportValueReportBody struct {
	Period      string  `json:"period"`
	WorkspaceID *string `json:"workspace_id,omitempty"`
}

// handleExportValueReport generates a value-report.v1 JSON + CSV export
// (BRD 69 ROI-FR-021, design §2.8). Recomputes /value/summary and
// /value/trend server-side (never trusts client-supplied figures) so the
// export matches what the API would return right now for that period.
// Re-running export for an already-exported period inserts version N+1;
// prior versions' object keys and rows are never overwritten.
func (s *Server) handleExportValueReport(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	if s.Exports == nil {
		writeErrCode(w, r, http.StatusServiceUnavailable, "NOT_READY", "export object store not configured", nil)
		return
	}

	key := r.Header.Get("Idempotency-Key")
	if key != "" {
		if rec, err := s.Store.GetIdempotent(r.Context(), op.Tenant, key); err == nil && rec != nil {
			w.Header().Set("Idempotency-Replayed", "true")
			writeJSON(w, rec.Status, json.RawMessage(rec.Response))
			return
		}
	}

	var body exportValueReportBody
	if !decodeBody(w, r, &body) {
		return
	}
	monthStart, err := time.Parse("2006-01", body.Period)
	if err != nil {
		writeErrCode(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "period must be YYYY-MM", nil)
		return
	}
	wsID := ""
	if body.WorkspaceID != nil {
		wsID = *body.WorkspaceID
	}

	summary, assumptions, err := s.buildValueSummary(r.Context(), op.Tenant, body.Period, monthStart, wsID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	trendFrom := monthStart.AddDate(0, -11, 0)
	trendPoints, err := s.Store.ValueTrendPoints(r.Context(), op.Tenant, trendFrom, monthStart, wsID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	trend := map[string]any{"metric": "cost_per_decision", "granularity": "month", "points": trendPoints}

	assumptionsView := map[string]any{}
	var assumptionVersion *int
	if assumptions != nil {
		v := assumptions.Version
		assumptionVersion = &v
		assumptionsView = map[string]any{
			"version": assumptions.Version, "effective_from": assumptions.EffectiveFrom.Format("2006-01-02"),
			"loaded_hourly_rate_usd": assumptions.LoadedHourlyRateUSD, "minutes_per_decision": assumptions.MinutesPerDecision,
		}
	}

	report := map[string]any{
		"schema":          valueExportSchema,
		"tenant_id":       op.Tenant.String(),
		"period":          body.Period,
		"workspace_id":    body.WorkspaceID,
		"generated_at":    time.Now().UTC().Format(time.RFC3339),
		"generated_by":    map[string]any{"type": op.Actor.Type, "id": op.Actor.ID},
		"assumptions":     assumptionsView,
		"summary":         summary,
		"trend":           trend,
		"rollup_versions": []string{summary.Provenance.RollupVersion},
	}
	jsonBytes, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		writeErr(w, r, err)
		return
	}
	jsonSHA := valueexport.SHA256Hex(jsonBytes)

	csvComments := []string{
		"value-report.v1 for tenant " + op.Tenant.String() + " period " + body.Period,
	}
	if assumptions != nil {
		csvComments = append(csvComments,
			"assumptions version "+strconv.Itoa(assumptions.Version)+" loaded_hourly_rate_usd="+
				strconv.FormatFloat(assumptions.LoadedHourlyRateUSD, 'f', -1, 64))
		for kind, mins := range assumptions.MinutesPerDecision {
			csvComments = append(csvComments, "minutes_per_decision."+kind+"="+strconv.FormatFloat(mins, 'f', -1, 64))
		}
	} else {
		csvComments = append(csvComments, "assumptions: not set")
	}
	csvRows := [][]any{
		{"decisions_total", decisionsTotalOrEmpty(summary.Decisions)},
		{"ai_cost_usd", summary.AICostUSD},
		{"hours_saved_est", estValueOrEmpty(summary.HoursSavedEst)},
		{"labor_value_est_usd", estValueOrEmpty(summary.LaborValueEstUSD)},
		{"human_baseline_cost_usd", estValueOrEmpty(summary.HumanBaselineCostUSD)},
		{"net_value_est_usd", estValueOrEmpty(summary.NetValueEstUSD)},
		{"active_users", summary.Adoption.ActiveUsers},
	}
	csvBytes, err := valueexport.WriteCSV(csvComments, []string{"metric", "value"}, csvRows)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	csvSHA := valueexport.SHA256Hex(csvBytes)

	// Next version number (mirrors store.CreateValueExport's own lookup, but
	// needed here first to build the object-store key).
	existing, err := s.Store.ListValueExports(r.Context(), op.Tenant, body.Period)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	nextVersion := 1
	for _, e := range existing {
		wsMatch := (e.WorkspaceID == nil && body.WorkspaceID == nil) ||
			(e.WorkspaceID != nil && body.WorkspaceID != nil && *e.WorkspaceID == *body.WorkspaceID)
		if wsMatch && e.Version >= nextVersion {
			nextVersion = e.Version + 1
		}
	}
	base := "value-reports/" + op.Tenant.String() + "/" + body.Period + "/" + strconv.Itoa(nextVersion) + "/"
	jsonKey := base + "report.json"
	csvKey := base + "report.csv"
	if _, _, err := s.Exports.Put(r.Context(), jsonKey, jsonBytes, 24*time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}
	if _, _, err := s.Exports.Put(r.Context(), csvKey, csvBytes, 24*time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}

	created, err := s.Store.CreateValueExport(r.Context(), op, domain.ValueExport{
		Period: body.Period, WorkspaceID: body.WorkspaceID,
		JSONKey: jsonKey, JSONSHA256: jsonSHA, CSVKey: csvKey, CSVSHA256: csvSHA,
		AssumptionVersion: assumptionVersion, GeneratedBy: op.Actor.Type + ":" + op.Actor.ID,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}

	view := valueExportView(s, created)
	if key != "" {
		var buf strings.Builder
		_ = json.NewEncoder(&buf).Encode(DataBody{Data: view})
		_ = s.Store.PutIdempotent(r.Context(), op.Tenant, key, r.Method, r.URL.Path, http.StatusCreated, []byte(buf.String()))
	}
	writeData(w, http.StatusCreated, view)
}

// handleListValueReports serves GET /api/v1/value-reports?period= (design
// §2.8 step 5, "listed in exports").
func (s *Server) handleListValueReports(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	period := r.URL.Query().Get("period")
	exports, err := s.Store.ListValueExports(r.Context(), op.Tenant, period)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	views := make([]map[string]any, len(exports))
	for i, e := range exports {
		views[i] = valueExportView(s, e)
	}
	writePage(w, views, "", false)
}

// handleDownloadValueExport serves a signed artifact (HMAC-validated, not
// JWT — mirrors chart-service's GET /exports/* pattern, design §2.8).
func (s *Server) handleDownloadValueExport(w http.ResponseWriter, r *http.Request) {
	if s.Exports == nil {
		writeErrCode(w, r, http.StatusServiceUnavailable, "NOT_READY", "export object store not configured", nil)
		return
	}
	fs, ok := s.Exports.(*valueexport.FSStore)
	if !ok {
		writeErrCode(w, r, http.StatusServiceUnavailable, "NOT_READY", "download unsupported by this object store", nil)
		return
	}
	key := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	q := r.URL.Query()
	exp, _ := strconv.ParseInt(q.Get("exp"), 10, 64)
	data, err := fs.Read(key, exp, q.Get("sig"))
	if err != nil {
		writeErrCode(w, r, http.StatusNotFound, "NOT_FOUND", "artifact not found or link expired", nil)
		return
	}
	ct := "application/octet-stream"
	if strings.HasSuffix(key, ".json") {
		ct = "application/json"
	} else if strings.HasSuffix(key, ".csv") {
		ct = "text/csv; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", "attachment")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func valueExportView(s *Server, e domain.ValueExport) map[string]any {
	v := map[string]any{
		"id": e.ID.String(), "period": e.Period, "version": e.Version,
		"json_sha256": e.JSONSHA256, "csv_sha256": e.CSVSHA256, "created_at": e.CreatedAt.Format(time.RFC3339),
	}
	if e.WorkspaceID != nil {
		v["workspace_id"] = *e.WorkspaceID
	}
	if e.AssumptionVersion != nil {
		v["assumption_version"] = *e.AssumptionVersion
	}
	// Presigned URLs are re-signed on every list read (not stored) — the
	// object bytes are immutable once written (design §2.8), only the
	// download link's signature/expiry needs to stay fresh.
	if fs, ok := s.Exports.(*valueexport.FSStore); ok {
		expAt := time.Now().Add(24 * time.Hour).Unix()
		v["json_url"] = presignedURL(fs, e.JSONKey, expAt)
		v["csv_url"] = presignedURL(fs, e.CSVKey, expAt)
	}
	return v
}

func presignedURL(fs *valueexport.FSStore, key string, exp int64) string {
	sig := fs.Sign(key, exp)
	return fs.PublicURL + "/api/v1/value-report-artifacts/" + key + "?exp=" + strconv.FormatInt(exp, 10) + "&sig=" + sig
}

func decisionsTotalOrEmpty(d *domain.ValueDecisionsView) any {
	if d == nil {
		return ""
	}
	return d.Total
}

func estValueOrEmpty(e *domain.EstimatedValue) any {
	if e == nil {
		return ""
	}
	return e.Value()
}
