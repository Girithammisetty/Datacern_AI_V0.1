package api

import (
	"net/http"
	"strconv"

	"github.com/datacern-ai/case-service/internal/domain"
)

// maxQueueIntelWindowDays bounds the lookback. The percentile aggregate scans
// every resolved case in the window, so an unbounded `days` would let one
// request table-scan the workspace's whole history.
const maxQueueIntelWindowDays = 90

// handleQueueIntelligence answers the approver's standing questions about the
// queue — how old is the backlog, what breaches next, how much is clearing, how
// long does a decision take — as one read-only aggregate (roadmap item 4).
//
// Composition of data case-service already stores; it adds no new writes and no
// new state. Gated on case.case.read and scoped to the caller's workspace: an
// aggregate is still a disclosure, so it honours the same department boundary
// as the case list rather than counting across it.
func (s *Server) handleQueueIntelligence(w http.ResponseWriter, r *http.Request) {
	c := ClaimsFrom(r.Context())
	if c == nil {
		writeErr(w, r, domain.EUnauthenticated("bad claims"))
		return
	}
	tenant, _ := c.Tenant()
	ws, ok := workspaceFromClaims(r)
	if !ok {
		writeErr(w, r, domain.EValidation("workspace_id claim required", nil))
		return
	}

	days := 7
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxQueueIntelWindowDays {
			writeErr(w, r, domain.EValidation(
				"days must be an integer between 1 and "+strconv.Itoa(maxQueueIntelWindowDays), nil))
			return
		}
		days = n
	}

	intel, err := s.Store.QueueIntelligence(r.Context(), tenant, ws, days)
	if err != nil {
		s.writeLookupErr(w, r, err)
		return
	}
	writeData(w, http.StatusOK, intel)
}
