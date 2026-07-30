package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/case-service/internal/domain"
	"github.com/datacern-ai/case-service/internal/entitlements"
)

// Event-rule case-trigger CRUD (realtime-decisioning INC-1). Same handler
// conventions as case-schemas: workspace comes from the verified JWT claim,
// tenant from Op, validation errors return the field-keyed details map.

type triggerReq struct {
	Name             *string                    `json:"name"`
	Enabled          *bool                      `json:"enabled"`
	DatasetURN       *string                    `json:"dataset_urn"`
	DatasetName      *string                    `json:"dataset_name"`
	Conditions       *[]domain.TriggerCondition `json:"conditions"`
	RowPKField       *string                    `json:"row_pk_field"`
	Severity         *string                    `json:"severity"`
	DueHours         *int                       `json:"due_hours"`
	ProjectionFields *[]string                  `json:"projection_fields"`
	MaxCasesPerEvent *int                       `json:"max_cases_per_event"`
	AttachEvidence   *bool                      `json:"attach_evidence"`
}

func (req *triggerReq) apply(t *domain.CaseTrigger) {
	if req.Name != nil {
		t.Name = *req.Name
	}
	if req.Enabled != nil {
		t.Enabled = *req.Enabled
	}
	if req.DatasetURN != nil {
		t.DatasetURN = *req.DatasetURN
	}
	if req.DatasetName != nil {
		t.DatasetName = *req.DatasetName
	}
	if req.Conditions != nil {
		t.Conditions = *req.Conditions
	}
	if req.AttachEvidence != nil {
		t.AttachEvidence = *req.AttachEvidence
	}
	if req.RowPKField != nil {
		t.RowPKField = *req.RowPKField
	}
	if req.Severity != nil {
		t.Severity = *req.Severity
	}
	if req.DueHours != nil {
		t.DueHours = *req.DueHours
	}
	if req.ProjectionFields != nil {
		t.ProjectionFields = *req.ProjectionFields
	}
	if req.MaxCasesPerEvent != nil {
		t.MaxCasesPerEvent = *req.MaxCasesPerEvent
	}
}

// attachEvidenceGate maps a realtime-case-streams entitlement check onto the
// error a trigger write gets when it tries to turn intake-snapshot evidence on
// (add-on slice 2). Only the false→true transition is gated: turning the
// feature OFF, or editing a trigger that already has it, never requires a
// round-trip — an entitlement lapse is a commercial-plane concern (pause with
// a surfaced reason, CPL-FR-022 precedent), not a reason to lock a tenant out
// of their own rule's edit screen.
func attachEvidenceGate(st entitlements.Status) *domain.Error {
	switch st {
	case entitlements.Entitled:
		return nil
	case entitlements.Blocked:
		return domain.EPermissionDenied(
			"intake-snapshot evidence requires the realtime-case-streams add-on " +
				"(feature entitlement 'realtime_case_streams'); contact your administrator " +
				"to enable the SKU for this tenant")
	default: // Unavailable — fail closed, and say why honestly (CPL-NFR-004)
		return &domain.Error{Code: "ENTITLEMENT_UNAVAILABLE", HTTP: http.StatusServiceUnavailable,
			Message: "cannot verify the realtime-case-streams entitlement right now; " +
				"refusing to enable intake-snapshot evidence rather than granting it unchecked"}
	}
}

func (s *Server) handleListTriggers(w http.ResponseWriter, r *http.Request) {
	op, ok := opFrom(r)
	if !ok {
		writeErr(w, r, domain.EUnauthenticated("bad claims"))
		return
	}
	ws, ok := workspaceFromClaims(r)
	if !ok {
		writeErr(w, r, domain.EValidation("workspace_id claim required", nil))
		return
	}
	list, err := s.Store.ListTriggers(r.Context(), op.Tenant, ws)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if list == nil {
		list = []*domain.CaseTrigger{}
	}
	writeData(w, http.StatusOK, list)
}

func (s *Server) handleCreateTrigger(w http.ResponseWriter, r *http.Request) {
	op, ok := opFrom(r)
	if !ok {
		writeErr(w, r, domain.EUnauthenticated("bad claims"))
		return
	}
	ws, ok := workspaceFromClaims(r)
	if !ok {
		writeErr(w, r, domain.EValidation("workspace_id claim required", nil))
		return
	}
	var req triggerReq
	if !decodeBody(w, r, &req) {
		return
	}
	t := &domain.CaseTrigger{
		ID: domain.NewID(), TenantID: op.Tenant, WorkspaceID: ws,
		Enabled: true, CreatedByID: op.Actor.ID,
	}
	req.apply(t)
	t.Normalize()
	if errs := t.Validate(); errs != nil {
		writeErr(w, r, domain.EValidation("invalid trigger", errs))
		return
	}
	if t.AttachEvidence {
		if gerr := attachEvidenceGate(s.checkStreamsFeature(r, op.Tenant)); gerr != nil {
			writeErr(w, r, gerr)
			return
		}
	}
	if err := s.Store.CreateTrigger(r.Context(), t); err != nil {
		writeErr(w, r, err)
		return
	}
	writeData(w, http.StatusCreated, t)
}

func (s *Server) handleUpdateTrigger(w http.ResponseWriter, r *http.Request) {
	op, ok := opFrom(r)
	if !ok {
		writeErr(w, r, domain.EUnauthenticated("bad claims"))
		return
	}
	ws, ok := workspaceFromClaims(r)
	if !ok {
		writeErr(w, r, domain.EValidation("workspace_id claim required", nil))
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, domain.EValidation("invalid trigger id", nil))
		return
	}
	var req triggerReq
	if !decodeBody(w, r, &req) {
		return
	}
	t, err := s.Store.GetTrigger(r.Context(), op.Tenant, ws, id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	turningOn := req.AttachEvidence != nil && *req.AttachEvidence && !t.AttachEvidence
	req.apply(t)
	t.Normalize()
	if errs := t.Validate(); errs != nil {
		writeErr(w, r, domain.EValidation("invalid trigger", errs))
		return
	}
	if turningOn {
		if gerr := attachEvidenceGate(s.checkStreamsFeature(r, op.Tenant)); gerr != nil {
			writeErr(w, r, gerr)
			return
		}
	}
	if err := s.Store.UpdateTrigger(r.Context(), t); err != nil {
		writeErr(w, r, err)
		return
	}
	writeData(w, http.StatusOK, t)
}

func (s *Server) handleDeleteTrigger(w http.ResponseWriter, r *http.Request) {
	op, ok := opFrom(r)
	if !ok {
		writeErr(w, r, domain.EUnauthenticated("bad claims"))
		return
	}
	ws, ok := workspaceFromClaims(r)
	if !ok {
		writeErr(w, r, domain.EValidation("workspace_id claim required", nil))
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, domain.EValidation("invalid trigger id", nil))
		return
	}
	if err := s.Store.DeleteTrigger(r.Context(), op.Tenant, ws, id); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
