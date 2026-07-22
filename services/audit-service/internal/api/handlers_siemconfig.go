package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/domain"
	"github.com/datacern-ai/audit-service/internal/pgstore"
)

// BRD 59 WS2: per-tenant SIEM export destination, four-eyes gated (mirrors
// ingestion-service's writebacks propose/approve/reject flow). Every route is
// tenant-scoped to the caller's own tenant (resolveTenant) — there is no
// cross-tenant path here, unlike audit search's breakglass escape, since a
// SIEM destination is purely a tenant-owned config, not platform data.

type siemConfigDTO struct {
	ID           string `json:"id"`
	Endpoint     string `json:"endpoint"`
	Format       string `json:"format"`
	AuthRef      string `json:"auth_ref,omitempty"`
	Active       bool   `json:"active"`
	Status       string `json:"status"`
	RequestedBy  string `json:"requested_by"`
	ApprovedBy   string `json:"approved_by,omitempty"`
	RejectedBy   string `json:"rejected_by,omitempty"`
	RejectReason string `json:"reject_reason,omitempty"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

func siemConfigDTOFrom(c pgstore.SiemConfig) siemConfigDTO {
	return siemConfigDTO{
		ID: c.ID.String(), Endpoint: c.Endpoint, Format: c.Format, AuthRef: c.AuthRef,
		Active: c.Active, Status: c.Status, RequestedBy: c.RequestedBy,
		ApprovedBy: c.ApprovedBy, RejectedBy: c.RejectedBy, RejectReason: c.RejectReason,
		CreatedAt: c.CreatedAt.Format(timeFmt), UpdatedAt: c.UpdatedAt.Format(timeFmt),
	}
}

const timeFmt = "2006-01-02T15:04:05.000Z07:00"

// handleGetSiemConfig returns the tenant's current active destination (if
// any), any pending proposal awaiting a second approver, and the full
// decision history — everything the self-service /admin/audit/export screen
// needs in one call.
func (s *Server) handleGetSiemConfig(w http.ResponseWriter, r *http.Request) {
	tenant, _, derr := s.resolveTenant(r)
	if derr != nil {
		writeErr(w, r, derr)
		return
	}
	history, err := s.PG.ListSiemConfigs(r.Context(), tenant)
	if err != nil {
		writeErr(w, r, domain.EInternal("list siem configs: "+err.Error()))
		return
	}
	var active, pending *siemConfigDTO
	dtos := make([]siemConfigDTO, 0, len(history))
	for _, c := range history {
		d := siemConfigDTOFrom(c)
		dtos = append(dtos, d)
		if c.Active {
			cp := d
			active = &cp
		}
		if c.Status == "pending_approval" && pending == nil {
			cp := d
			pending = &cp
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"active": active, "pending": pending, "history": dtos})
}

type proposeSiemConfigReq struct {
	Endpoint string `json:"endpoint"`
	Format   string `json:"format"`
	AuthRef  string `json:"auth_ref"`
}

// handleProposeSiemConfig creates a pending_approval row (four-eyes propose
// step) — the currently-active destination, if any, keeps delivering
// unaffected until this proposal is approved.
func (s *Server) handleProposeSiemConfig(w http.ResponseWriter, r *http.Request) {
	tenant, _, derr := s.resolveTenant(r)
	if derr != nil {
		writeErr(w, r, derr)
		return
	}
	var req proposeSiemConfigReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, r, domain.EValidation("invalid request body", nil))
		return
	}
	req.Endpoint = strings.TrimSpace(req.Endpoint)
	if req.Endpoint == "" {
		writeErr(w, r, domain.EValidation("endpoint is required", nil))
		return
	}
	if !strings.HasPrefix(req.Endpoint, "https://") {
		writeErr(w, r, domain.EValidation("endpoint must be https://", nil))
		return
	}
	switch req.Format {
	case "CEF", "LEEF", "JSON":
	case "":
		req.Format = "JSON"
	default:
		writeErr(w, r, domain.EValidation("format must be CEF, LEEF, or JSON", nil))
		return
	}
	claims := ClaimsFrom(r.Context())
	cfg, err := s.PG.ProposeSiemConfig(r.Context(), tenant, req.Endpoint, req.Format, req.AuthRef, claims.Sub)
	if err != nil {
		writeErr(w, r, domain.EInternal("propose siem config: "+err.Error()))
		return
	}
	writeJSON(w, http.StatusCreated, siemConfigDTOFrom(*cfg))
}

func (s *Server) parseSiemConfigID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, domain.EValidation("invalid id", nil))
		return uuid.Nil, false
	}
	return id, true
}

// handleApproveSiemConfig approves a pending proposal. Four-eyes: the
// approver must be a DISTINCT subject from whoever proposed it.
func (s *Server) handleApproveSiemConfig(w http.ResponseWriter, r *http.Request) {
	tenant, _, derr := s.resolveTenant(r)
	if derr != nil {
		writeErr(w, r, derr)
		return
	}
	id, ok := s.parseSiemConfigID(w, r)
	if !ok {
		return
	}
	claims := ClaimsFrom(r.Context())
	cfg, err := s.PG.ApproveSiemConfig(r.Context(), tenant, id, claims.Sub)
	switch {
	case errors.Is(err, pgstore.ErrFourEyesSameActor):
		writeErr(w, r, domain.EConflict("four-eyes: the approver must differ from the requester"))
		return
	case errors.Is(err, pgstore.ErrSiemConfigNotPending):
		writeErr(w, r, domain.EConflict("this proposal has already been decided"))
		return
	case err != nil:
		writeErr(w, r, domain.EInternal("approve siem config: "+err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, siemConfigDTOFrom(*cfg))
}

type rejectSiemConfigReq struct {
	Reason string `json:"reason"`
}

// handleRejectSiemConfig declines a pending proposal (the requester may
// reject their own proposal to withdraw it -- unlike approve, there is no
// self-dealing risk in rejection).
func (s *Server) handleRejectSiemConfig(w http.ResponseWriter, r *http.Request) {
	tenant, _, derr := s.resolveTenant(r)
	if derr != nil {
		writeErr(w, r, derr)
		return
	}
	id, ok := s.parseSiemConfigID(w, r)
	if !ok {
		return
	}
	var req rejectSiemConfigReq
	_ = json.NewDecoder(r.Body).Decode(&req) // reason is optional
	claims := ClaimsFrom(r.Context())
	cfg, err := s.PG.RejectSiemConfig(r.Context(), tenant, id, claims.Sub, req.Reason)
	if errors.Is(err, pgstore.ErrSiemConfigNotPending) {
		writeErr(w, r, domain.EConflict("this proposal has already been decided"))
		return
	}
	if err != nil {
		writeErr(w, r, domain.EInternal("reject siem config: "+err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, siemConfigDTOFrom(*cfg))
}

// handleDeleteSiemConfig removes a decided (approved/rejected) row. Deleting
// the active config stops delivery to it immediately.
func (s *Server) handleDeleteSiemConfig(w http.ResponseWriter, r *http.Request) {
	tenant, _, derr := s.resolveTenant(r)
	if derr != nil {
		writeErr(w, r, derr)
		return
	}
	id, ok := s.parseSiemConfigID(w, r)
	if !ok {
		return
	}
	if err := s.PG.DeleteSiemConfig(r.Context(), tenant, id); err != nil {
		writeErr(w, r, domain.EInternal("delete siem config: "+err.Error()))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
