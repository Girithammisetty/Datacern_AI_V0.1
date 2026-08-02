package api

import (
	"net/http"
	"strconv"
)

// handleListBillingPeriods serves a tenant's closed billing periods, newest
// first, each joined with its export record (BRD 67 slice 3, VMB-FR-023).
// Optional ?period=YYYY-MM filter and ?limit (default 50, max 200). RLS scopes
// rows to the caller's tenant; the read is guarded by ActionReportRead.
func (s *Server) handleListBillingPeriods(w http.ResponseWriter, r *http.Request) {
	op, _ := opFrom(r)
	q := r.URL.Query()
	period := q.Get("period")
	limit := 50
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l > 0 && l <= 200 {
		limit = l
	}
	recs, err := s.Store.ListBillingPeriods(r.Context(), op.Tenant, period, limit)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	views := make([]any, len(recs))
	for i, rec := range recs {
		views[i] = rec
	}
	writePage(w, views, "", false)
}
