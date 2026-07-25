// Demo-sandbox lifecycle handlers (BRD 70 slice 1/2, DSP-FR-010/012). All
// three routes are operator/partner-scoped (requireSuperAdmin, wired in
// server.go) -- BRD 70 §In-scope: "demo/POC tenants are operator/
// partner-created in v1; self-serve is a later initiative."
package api

import (
	"net/http"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// POST /demo-tenants {pack, template?} — DSP-FR-010. 202 + operation_id,
// mirroring handleCreateTenant's publish=true shape (the demo saga always
// publishes; there is no draft-only demo tenant).
func (s *Server) handleCreateDemoTenant(w http.ResponseWriter, r *http.Request) {
	var req domain.CreateDemoTenantRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	t, opID, err := s.Demo.Create(r.Context(), req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"operation_id": opID, "tenant": t})
}

// POST /demo-tenants/{id}/reset — DSP-FR-012 (idempotent re-seed, §2.4).
func (s *Server) handleResetDemoTenant(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	t, err := s.Demo.Reset(r.Context(), id, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// POST /demo-tenants/{id}/clone — DSP-FR-012 (fresh sibling, §2.4).
func (s *Server) handleCloneDemoTenant(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req domain.CloneDemoTenantRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	t, opID, err := s.Demo.Clone(r.Context(), id, req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"operation_id": opID, "tenant": t})
}
