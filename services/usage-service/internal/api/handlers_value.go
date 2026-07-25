package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/valuecalc"
)

const maxAssumptionsJSONBytes = 64 * 1024 // MASTER-FR-061 carve-out, mirrors migration comment

type putAssumptionsBody struct {
	MinutesPerDecision  map[string]float64 `json:"minutes_per_decision"`
	LoadedHourlyRateUSD float64            `json:"loaded_hourly_rate_usd"`
}

// handlePutAssumptions edits value-reporting assumptions (BRD 69 ROI-FR-001/
// 002). Gated by usage.assumptions.update (design §2.9, see authz.go comment
// on the "manage" -> "update" verb deviation).
func (s *Server) handlePutAssumptions(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	var body putAssumptionsBody
	if !decodeBody(w, r, &body) {
		return
	}
	ve := &domain.ValidationError{}
	if body.LoadedHourlyRateUSD <= 0 {
		ve.Fields = append(ve.Fields, domain.FieldError{Field: "loaded_hourly_rate_usd", Message: "must be > 0"})
	}
	size := 2 // "{}"
	for k, v := range body.MinutesPerDecision {
		size += len(k) + 16
		if v <= 0 {
			ve.Fields = append(ve.Fields, domain.FieldError{Field: "minutes_per_decision." + k, Message: "must be > 0"})
		}
	}
	if size > maxAssumptionsJSONBytes {
		ve.Fields = append(ve.Fields, domain.FieldError{Field: "minutes_per_decision", Message: "exceeds 64KB (MASTER-FR-061)"})
	}
	if len(ve.Fields) > 0 {
		writeErr(w, r, ve)
		return
	}

	created, err := s.Store.PutAssumptions(r.Context(), op, body.MinutesPerDecision, body.LoadedHourlyRateUSD)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeData(w, http.StatusOK, assumptionsView(created))
}

// handleGetAssumptions returns the active assumptions or null (ROI-FR-001
// "ships absent" — never a 404, absence is a legitimate, expected state).
func (s *Server) handleGetAssumptions(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	a, ok, err := s.Store.ResolveAssumptions(r.Context(), op.Tenant, time.Now().UTC())
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !ok {
		writeData(w, http.StatusOK, nil)
		return
	}
	writeData(w, http.StatusOK, assumptionsView(*a))
}

// handleGetAssumptionHistory returns every version ordered ascending — the
// version rows ARE the audit history (ROI-FR-002 point 4).
func (s *Server) handleGetAssumptionHistory(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	hist, err := s.Store.AssumptionHistory(r.Context(), op.Tenant)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	views := make([]map[string]any, len(hist))
	for i, a := range hist {
		views[i] = assumptionsView(a)
	}
	writePage(w, views, "", false)
}

func assumptionsView(a domain.ValueAssumptions) map[string]any {
	return map[string]any{
		"id":                     a.ID.String(),
		"version":                a.Version,
		"minutes_per_decision":   a.MinutesPerDecision,
		"loaded_hourly_rate_usd": a.LoadedHourlyRateUSD,
		"effective_from":         a.EffectiveFrom.Format("2006-01-02"),
		"status":                 a.Status,
		"created_by":             a.CreatedBy,
		"created_at":             a.CreatedAt.Format(time.RFC3339),
	}
}

// handleValueSummary serves GET /api/v1/value/summary (ROI-FR-010). Reads
// usage_monthly only (ROI-NFR-001); resolves assumptions as-of the period's
// close so a later assumption edit never changes an already-served period's
// figures (AC-3).
func (s *Server) handleValueSummary(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	q := r.URL.Query()
	period := q.Get("period")
	monthStart, err := time.Parse("2006-01", period)
	if err != nil {
		writeErrCode(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "period must be YYYY-MM", nil)
		return
	}
	wsID := q.Get("workspace_id")

	summary, _, err := s.buildValueSummary(r.Context(), op.Tenant, period, monthStart, wsID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeData(w, http.StatusOK, summary)
}

// buildValueSummary is the shared implementation behind GET /value/summary
// and the export flow (design §2.8 step 2: the export handler recomputes the
// summary server-side rather than trusting client-supplied figures). Returns
// the resolved assumptions too so the export can disclose them.
func (s *Server) buildValueSummary(ctx context.Context, tenant uuid.UUID, period string, monthStart time.Time, wsID string) (domain.ValueSummary, *domain.ValueAssumptions, error) {
	var wsPtr *string
	if wsID != "" {
		wsPtr = &wsID
	}
	periodEnd := monthStart.AddDate(0, 1, 0).Add(-time.Second)

	decisions, aiCost, adoption, finalized, err := s.Store.ValueSummaryInputs(ctx, tenant, monthStart, wsID)
	if err != nil {
		return domain.ValueSummary{}, nil, err
	}
	assumptions, ok, err := s.Store.ResolveAssumptions(ctx, tenant, periodEnd)
	if err != nil {
		return domain.ValueSummary{}, nil, err
	}
	var assumptionsPtr *domain.ValueAssumptions
	if ok {
		assumptionsPtr = assumptions
	}

	rollupVersion := fmt.Sprintf("usage_monthly@%s-open", period)
	if finalized {
		rollupVersion = fmt.Sprintf("usage_monthly@%s-finalized", period)
	}

	summary := valuecalc.BuildSummary(valuecalc.Input{
		Period:        period,
		WorkspaceID:   wsPtr,
		Decisions:     &decisions, // CURRENT repo state always has the meter (Tier >=1); see valuecalc doc comment for the Tier-0 code path
		Assumptions:   assumptionsPtr,
		AICostUSD:     aiCost,
		Adoption:      adoption,
		RollupVersion: rollupVersion,
	})
	return summary, assumptionsPtr, nil
}

// handleValueTrend serves GET /api/v1/value/trend (ROI-FR-011). Only
// metric=cost_per_decision is meaningful today; granularity=month is the
// only supported granularity.
func (s *Server) handleValueTrend(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	q := r.URL.Query()
	metric := q.Get("metric")
	if metric == "" {
		metric = "cost_per_decision"
	}
	granularity := q.Get("granularity")
	if granularity == "" {
		granularity = "month"
	}
	if granularity != "month" {
		writeErrCode(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "granularity must be month", nil)
		return
	}
	wsID := q.Get("workspace_id")

	to := time.Now().UTC()
	from := to.AddDate(0, -5, 0) // default: trailing 6 months
	if v := q.Get("from"); v != "" {
		t, err := time.Parse("2006-01", v)
		if err != nil {
			writeErrCode(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "from must be YYYY-MM", nil)
			return
		}
		from = t
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse("2006-01", v)
		if err != nil {
			writeErrCode(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "to must be YYYY-MM", nil)
			return
		}
		to = t
	}
	from = time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, time.UTC)
	to = time.Date(to.Year(), to.Month(), 1, 0, 0, 0, 0, time.UTC)
	if to.Before(from) {
		writeErrCode(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "to must be >= from", nil)
		return
	}

	points, err := s.Store.ValueTrendPoints(r.Context(), op.Tenant, from, to, wsID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeData(w, http.StatusOK, map[string]any{
		"metric": metric, "granularity": granularity, "points": points,
	})
}
