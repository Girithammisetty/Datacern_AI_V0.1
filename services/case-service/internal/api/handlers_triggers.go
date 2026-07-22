package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/case-service/internal/domain"
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
	req.apply(t)
	t.Normalize()
	if errs := t.Validate(); errs != nil {
		writeErr(w, r, domain.EValidation("invalid trigger", errs))
		return
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
