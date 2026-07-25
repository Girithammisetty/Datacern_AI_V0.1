package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// Commercial-plane endpoints (BRD 66 slice 1): plan catalog CRUD + tenant
// plan assignment + entitlement overrides are platform-operator scope
// (requireSuperAdmin, mounted under /platform/... in server.go, matching the
// existing /platform/admins precedent). GET /tenants/{id}/entitlements is the
// one read a tenant admin may perform for its own tenant (US-4) --
// cross-tenant is 404, same pattern as handleGetTenant (F-3/AC-12).

// planWithEntitlements is the plan detail response shape (GET .../plans,
// POST .../plans, PATCH .../plans/{key}): the plan row plus its
// current-version default entitlements.
type planWithEntitlements struct {
	*domain.Plan
	Entitlements []domain.PlanEntitlement `json:"entitlements"`
}

// GET /platform/plans
func (s *Server) handleListPlans(w http.ResponseWriter, r *http.Request) {
	plans, err := s.Plans.List(r.Context())
	if err != nil {
		writeErr(w, r, err)
		return
	}
	out := make([]planWithEntitlements, 0, len(plans))
	for _, p := range plans {
		ents, err := s.Store.ListPlanEntitlements(r.Context(), p.Key, p.Version)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		out = append(out, planWithEntitlements{Plan: p, Entitlements: ents})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// GET /platform/plans/{key}
func (s *Server) handleGetPlan(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	p, ents, err := s.Plans.Get(r.Context(), key)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, planWithEntitlements{Plan: p, Entitlements: ents})
}

// POST /platform/plans (CPL-FR-001)
func (s *Server) handleCreatePlan(w http.ResponseWriter, r *http.Request) {
	var req domain.CreatePlanRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	p, err := s.Plans.Create(r.Context(), req)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	ents, err := s.Store.ListPlanEntitlements(r.Context(), p.Key, p.Version)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, planWithEntitlements{Plan: p, Entitlements: ents})
}

// patchPlanReq mirrors domain.PatchPlanRequest but keeps a raw json.RawMessage
// for "entitlements" so we can tell "field absent" from "field explicitly
// []" -- domain.PatchPlanRequest.EntitlementsSet carries that distinction
// into the service layer (CPL-FR-002: only a PRESENT entitlements field
// bumps the plan version).
type patchPlanReq struct {
	Name             *string                        `json:"name,omitempty"`
	Description      *string                        `json:"description,omitempty"`
	TrialDaysDefault *int                            `json:"trial_days_default,omitempty"`
	Status           *string                         `json:"status,omitempty"`
	Entitlements     *[]domain.PlanEntitlementInput  `json:"entitlements,omitempty"`
}

// PATCH /platform/plans/{key} (CPL-FR-002)
func (s *Server) handlePatchPlan(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	var req patchPlanReq
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	svcReq := domain.PatchPlanRequest{
		Name: req.Name, Description: req.Description, TrialDaysDefault: req.TrialDaysDefault, Status: req.Status,
	}
	if req.Entitlements != nil {
		svcReq.EntitlementsSet = true
		svcReq.Entitlements = *req.Entitlements
	}
	p, err := s.Plans.Patch(r.Context(), key, svcReq)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	ents, err := s.Store.ListPlanEntitlements(r.Context(), p.Key, p.Version)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, planWithEntitlements{Plan: p, Entitlements: ents})
}

type assignPlanReq struct {
	PlanKey string `json:"plan_key"`
}

// POST /platform/tenants/{id}/plan (CPL-FR-002, US-2)
func (s *Server) handleAssignTenantPlan(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req assignPlanReq
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	tp, err := s.Commercial.AssignPlan(r.Context(), id, req.PlanKey, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tp)
}

// POST /platform/tenants/{id}/plan/resync
func (s *Server) handleResyncTenantPlan(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	tp, err := s.Commercial.Resync(r.Context(), id, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tp)
}

type upsertOverrideReq struct {
	Kind   domain.EntitlementKind `json:"kind"`
	Key    string                 `json:"key"`
	Value  map[string]any         `json:"value,omitempty"`
	Reason string                 `json:"reason,omitempty"`
}

// POST /platform/tenants/{id}/entitlements/overrides (US-2)
func (s *Server) handleUpsertOverride(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req upsertOverrideReq
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	o, err := s.Commercial.UpsertOverride(r.Context(), id, req.Kind, req.Key, req.Value, req.Reason, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, o)
}

// DELETE /platform/tenants/{id}/entitlements/overrides/{kind}/{key}
func (s *Server) handleDeleteOverride(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	kind := domain.EntitlementKind(chi.URLParam(r, "kind"))
	key := chi.URLParam(r, "key")
	if err := s.Commercial.RemoveOverride(r.Context(), id, kind, key, actorFrom(ClaimsFrom(r.Context()))); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /tenants/{id}/entitlements (CPL-FR-011, US-4/US-7): super-admin sees
// any tenant; a tenant admin sees only its own. Cross-tenant reads return 404
// + security.cross_tenant_denied (MASTER-FR-003, AC-5), the identical pattern
// handleGetTenant uses (AC-12).
func (s *Server) handleGetTenantEntitlements(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !claims.IsSuperAdmin() && claims.TenantID != id {
		now := s.Clock().UTC()
		ev := domain.NewEvent(domain.EvCrossTenantDenied, claims.TenantID, actorFrom(claims),
			domain.PlatformURN("tenant", id.String()), now, map[string]any{
				"endpoint": "GET /tenants/{id}/entitlements", "target_tenant": id.String(),
			})
		ev.TraceID = TraceIDFrom(r.Context())
		_ = s.Store.AppendOutbox(r.Context(), ev)
		writeErr(w, r, domain.ENotFound("tenant"))
		return
	}
	eff, err := s.Commercial.EffectiveEntitlements(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data":             eff.Entitlements,
		"plan":             map[string]any{"key": eff.PlanKey, "version": eff.PlanVersion},
		"commercial_state": eff.CommercialState,
		"trial_ends_at":    eff.TrialEndsAt,
	})
}

// Trial lifecycle endpoints (BRD 66 slice 2, CPL-FR-021, US-3): start/extend/
// convert. requireSuperAdmin, mounted in server.go alongside the slice-1
// commercial routes (same middleware group, so Idempotency-Key handling per
// MASTER-FR-025 applies automatically via the existing idempotencyMiddleware).

// POST /tenants/{id}/trial (CPL-FR-021)
func (s *Server) handleStartTrial(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req domain.StartTrialRequest
	if r.ContentLength > 0 {
		if err := decodeBody(r, &req); err != nil {
			writeErr(w, r, err)
			return
		}
	}
	t, err := s.Trials.Start(r.Context(), id, req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// POST /tenants/{id}/trial/extend (CPL-FR-021: reason required + audited)
func (s *Server) handleExtendTrial(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req domain.ExtendTrialRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	t, err := s.Trials.Extend(r.Context(), id, req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// POST /tenants/{id}/convert (CPL-FR-021: trial->active with target plan)
func (s *Server) handleConvertTrial(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req domain.ConvertTrialRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	t, err := s.Trials.Convert(r.Context(), id, req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}
