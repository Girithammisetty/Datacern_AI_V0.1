package api

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/windrose-ai/identity-service/internal/domain"
)

func parseID(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return uuid.Nil, domain.ENotFound("resource")
	}
	return id, nil
}

// POST /tenants — 202 + operation_id when publish=true (MASTER-FR-027).
func (s *Server) handleCreateTenant(w http.ResponseWriter, r *http.Request) {
	var req domain.CreateTenantRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	t, opID, err := s.Tenants.Create(r.Context(), req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if req.Publish {
		writeJSON(w, http.StatusAccepted, map[string]any{"operation_id": opID, "tenant": t})
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

// GET /tenants/{id} — super-admin sees any tenant; a tenant admin sees only
// its own. Cross-tenant reads return 404 + security.cross_tenant_denied
// (MASTER-FR-003, AC-12).
func (s *Server) handleGetTenant(w http.ResponseWriter, r *http.Request) {
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
				"endpoint": "GET /tenants/{id}", "target_tenant": id.String(),
			})
		ev.TraceID = TraceIDFrom(r.Context())
		_ = s.Store.AppendOutbox(r.Context(), ev)
		writeErr(w, r, domain.ENotFound("tenant"))
		return
	}
	t, err := s.Store.GetTenant(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// GET /tenants/self — the SAFE, member-visible subset of the caller's own
// tenant (name/display name/status). Any authenticated member of a tenant may
// see what their organization is called — the admin gate on GET /tenants/{id}
// protects registry internals (owner_email, quotas, namespace, cell), none of
// which are returned here.
func (s *Server) handleGetTenantSelf(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	t, err := s.Store.GetTenant(r.Context(), claims.TenantID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": t.ID, "name": t.Name, "display_name": t.DisplayName, "status": t.Status,
	})
}

// PUT /tenants/{id}/embed-config (IDN-FR-043): set the tenant's allowed
// embedding origins and (re)generate the embed secret. Returns the plaintext
// secret ONCE (like an API key). Tenant-admin scoped; a tenant admin may only
// configure its own tenant.
func (s *Server) handleSetEmbedConfig(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !claims.IsSuperAdmin() && claims.TenantID != id {
		writeErr(w, r, domain.ENotFound("tenant"))
		return
	}
	var body struct {
		AllowedOrigins []string `json:"allowed_origins"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, r, err)
		return
	}
	// Validate origins before minting a secret: they become the CSP
	// frame-ancestors of every embed of this tenant. Reject '*'/wildcards
	// (clickjacking) and header-injection characters.
	if err := domain.ValidateEmbedOrigins(body.AllowedOrigins); err != nil {
		writeErr(w, r, err)
		return
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		writeErr(w, r, domain.EInternal("secret generation failed"))
		return
	}
	secret := "wes_" + base64.RawURLEncoding.EncodeToString(buf)
	cfg := &domain.TenantEmbedConfig{
		TenantID:       id,
		SecretHash:     domain.HashEmbedSecret(secret),
		AllowedOrigins: body.AllowedOrigins,
	}
	if err := s.Store.UpsertTenantEmbedConfig(r.Context(), cfg); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"embed_secret":    secret, // shown once
		"allowed_origins": body.AllowedOrigins,
	})
}

// GET /tenants/{id}/embed-config (IDN-FR-043): read back the tenant's current
// embed configuration for the admin screen — never the secret itself (only
// SecretHash is stored), just whether one has been generated, the allowed
// origins, and when it was last changed. A 404 means "never configured",
// distinct from "configured with zero origins".
func (s *Server) handleGetEmbedConfig(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	cfg, err := s.Store.GetTenantEmbedConfig(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured":      cfg.SecretHash != "",
		"allowed_origins": cfg.AllowedOrigins,
		"updated_at":      cfg.UpdatedAt,
	})
}

// --- per-tenant OIDC IdP config (BYO-P4) — self-service for tenant admins ---

// GET /tenants/self/idp: the caller's tenant's OIDC IdP config for the admin
// SSO screen. 404 = "no IdP configured" (SSO login for this tenant is off).
func (s *Server) handleGetTenantIdp(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	cfg, err := s.Store.GetTenantIdpConfig(r.Context(), claims.TenantID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, idpConfigView(cfg))
}

// PUT /tenants/self/idp: register/update the caller's tenant's OIDC IdP. The
// issuer must be globally unique (it routes inbound ID tokens to this tenant);
// a collision surfaces as a clean 409-class conflict rather than a raw DB error.
func (s *Server) handleSetTenantIdp(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	var body struct {
		Issuer       string `json:"issuer"`
		ClientID     string `json:"client_id"`
		DiscoveryURL string `json:"discovery_url"`
		Enabled      *bool  `json:"enabled"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, r, err)
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	cfg := &domain.TenantIdpConfig{
		TenantID:     claims.TenantID,
		Issuer:       strings.TrimSpace(body.Issuer),
		ClientID:     strings.TrimSpace(body.ClientID),
		DiscoveryURL: strings.TrimSpace(body.DiscoveryURL),
		Enabled:      enabled,
	}
	if err := cfg.Validate(); err != nil {
		writeErr(w, r, err)
		return
	}
	// Guard the unique-issuer invariant with a clear message (another tenant
	// can't be shadowed by re-registering their issuer).
	if other, err := s.Store.GetTenantIdpConfigByIssuer(r.Context(), cfg.Issuer); err == nil &&
		other != nil && other.TenantID != claims.TenantID {
		writeErr(w, r, domain.EConflict("that issuer is already registered to another tenant"))
		return
	}
	if err := s.Store.UpsertTenantIdpConfig(r.Context(), cfg); err != nil {
		writeErr(w, r, err)
		return
	}
	stored, err := s.Store.GetTenantIdpConfig(r.Context(), claims.TenantID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, idpConfigView(stored))
}

// DELETE /tenants/self/idp: turn off SSO for the caller's tenant.
func (s *Server) handleDeleteTenantIdp(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	if err := s.Store.DeleteTenantIdpConfig(r.Context(), claims.TenantID); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func idpConfigView(c *domain.TenantIdpConfig) map[string]any {
	return map[string]any{
		"issuer":        c.Issuer,
		"client_id":     c.ClientID,
		"discovery_url": c.DiscoveryURL,
		"enabled":       c.Enabled,
		"updated_at":    c.UpdatedAt,
	}
}

// --- per-tenant display-label overlays (BRD 23 inc3) ---

// GET /tenants/self/labels: the caller's tenant's UI label overrides as a flat
// {key: value} map. MEMBER-SAFE (no admin scope) — every tenant member's UI
// loads these at bootstrap to overlay its base i18n catalog, so a capability
// pack's "Cases -> AP Exceptions" rename renders for the whole tenant.
func (s *Server) handleGetTenantLabels(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	labels, err := s.Store.ListTenantDisplayLabels(r.Context(), claims.TenantID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"labels": labelMap(labels)})
}

// PUT /tenants/self/labels: bulk-merge upsert of the caller's tenant's label
// overrides (tenant-admin scoped — labels are tenant-wide presentation). Body:
// {"labels": {"cases.title": "AP Exceptions", ...}}. Each entry is validated;
// unknown-but-well-formed keys are allowed (the UI overlays only keys it knows).
// Returns the full merged map.
func (s *Server) handleSetTenantLabels(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	var body struct {
		Labels map[string]string `json:"labels"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, r, err)
		return
	}
	if len(body.Labels) == 0 {
		writeErr(w, r, domain.EValidation("labels is required",
			domain.FieldError{Field: "labels", Message: "at least one label required"}))
		return
	}
	for k, v := range body.Labels {
		if err := domain.ValidateDisplayLabel(k, v); err != nil {
			writeErr(w, r, err)
			return
		}
	}
	for k, v := range body.Labels {
		l := &domain.DisplayLabel{
			TenantID: claims.TenantID, Key: strings.TrimSpace(k),
			Value: v, UpdatedBy: claims.Subject,
		}
		if err := s.Store.UpsertTenantDisplayLabel(r.Context(), l); err != nil {
			writeErr(w, r, err)
			return
		}
	}
	merged, err := s.Store.ListTenantDisplayLabels(r.Context(), claims.TenantID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"labels": labelMap(merged)})
}

// DELETE /tenants/self/labels/{key}: remove one label override (tenant-admin
// scoped). Reverts that key to the app's base i18n string. 204 whether or not
// the key existed (idempotent — the reversal path a pack uninstall drives).
func (s *Server) handleDeleteTenantLabel(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		writeErr(w, r, domain.EValidation("label key is required",
			domain.FieldError{Field: "key", Message: "required"}))
		return
	}
	if err := s.Store.DeleteTenantDisplayLabel(r.Context(), claims.TenantID, key); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func labelMap(labels []domain.DisplayLabel) map[string]string {
	m := map[string]string{}
	for _, l := range labels {
		m[l.Key] = l.Value
	}
	return m
}

// GET /tenants — filters: status, cell, cloud (MASTER-FR-023).
func (s *Server) handleListTenants(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, err := domain.ParsePage(q.Get("limit"), q.Get("cursor"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	f := domain.TenantFilter{
		Status: q.Get("filter[status]"),
		CellID: q.Get("filter[cell]"),
		Cloud:  q.Get("filter[cloud]"),
	}
	items, info, err := s.Store.ListTenants(r.Context(), f, page)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writePage(w, items, info)
}

func (s *Server) handlePatchTenant(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req domain.PatchTenantRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	t, err := s.Tenants.Patch(r.Context(), id, req, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t) // mutations return the full resource (MASTER-FR-026)
}

func (s *Server) handlePublishTenant(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	opID, err := s.Tenants.Publish(r.Context(), id, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"operation_id": opID})
}

func (s *Server) handleSuspendTenant(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	t, err := s.Tenants.Suspend(r.Context(), id, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleReactivateTenant(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	t, drift, err := s.Tenants.Reactivate(r.Context(), id, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenant": t, "drift": drift})
}

func (s *Server) handleRetryProvisioning(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	opID, err := s.Tenants.RetryProvisioning(r.Context(), id, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"operation_id": opID})
}

func (s *Server) handleProvisioningStatus(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	steps, err := s.Tenants.ProvisioningStatus(r.Context(), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if steps == nil {
		steps = []*domain.ProvisioningStep{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"steps": steps})
}

// DELETE /tenants/{id}?mode=archive|destroy&force=true (IDN-FR-008).
func (s *Server) handleDeleteTenant(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	mode := r.URL.Query().Get("mode")
	force := r.URL.Query().Get("force") == "true"
	t, err := s.Tenants.Delete(r.Context(), id, mode, force, actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// POST /keys/rotate — on-demand signing key rotation (IDN-FR-052).
func (s *Server) handleRotateKeys(w http.ResponseWriter, r *http.Request) {
	kid, err := s.KM.Rotate(r.Context(), actorFrom(ClaimsFrom(r.Context())))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"kid": kid})
}
