package api

import (
	"net/http"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// POST /token/obo (IDN-FR-041). The subject_token in the body carries the
// authentication; no separate bearer required.
func (s *Server) handleOBO(w http.ResponseWriter, r *http.Request) {
	var req domain.OBORequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	resp, err := s.Tokens.OBOExchange(r.Context(), req, TraceIDFrom(r.Context()))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /token/embed (IDN-FR-043): edge exchange of a tenant embed secret +
// user context for a short-lived, workspace-scoped embed token. The secret is
// presented by the tenant's backend (never the browser); no bearer required.
func (s *Server) handleEmbedToken(w http.ResponseWriter, r *http.Request) {
	var req domain.EmbedRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	resp, err := s.Tokens.EmbedExchange(r.Context(), req, TraceIDFrom(r.Context()))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleEmbedOIDC implements POST /token/embed/oidc (task #84, embed-federated
// SSO): the tenant posts the END USER's OIDC ID token (from the tenant's IdP)
// instead of a shared embed secret; identity-service verifies it, binds it to a
// real user in the tenant, and mints a per-user workspace-scoped embed token.
func (s *Server) handleEmbedOIDC(w http.ResponseWriter, r *http.Request) {
	var req domain.EmbedOIDCRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	resp, err := s.Tokens.EmbedOIDCExchange(r.Context(), req, TraceIDFrom(r.Context()))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleOIDCLogin implements POST /token/oidc (BYO-P4): the web tier posts the
// ID token it obtained from the tenant's OIDC IdP (after the code+PKCE
// exchange), identity-service verifies it against the IdP's JWKS, resolves the
// Datacern user, and returns a platform session JWT. Unauthenticated by design
// — the ID token IS the credential (like /token/embed is gated by the embed
// secret, not a bearer).
func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	var req domain.OIDCLoginRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	resp, err := s.Tokens.OIDCLogin(r.Context(), req, TraceIDFrom(r.Context()))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /token/agent (IDN-FR-042): only agent-runtime, SPIFFE-verified.
func (s *Server) handleAgentToken(w http.ResponseWriter, r *http.Request) {
	spiffe, _ := r.Context().Value(ctxSpiffeID).(string)
	if spiffe == "" || !s.TrustedSpiffeIDs[spiffe] {
		writeErr(w, r, domain.EPermissionDenied("caller is not an authorized workload (SPIFFE identity required)"))
		return
	}
	var req domain.AutonomousTokenRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	resp, err := s.Tokens.AutonomousToken(r.Context(), req)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /token/apikey (IDN-FR-032): edge exchange of an API key for a
// short-lived typ=service JWT.
func (s *Server) handleAPIKeyExchange(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIKey string `json:"api_key"`
	}
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	resp, err := s.Tokens.ExchangeAPIKey(r.Context(), req.APIKey, TraceIDFrom(r.Context()))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- service accounts ---

func (s *Server) handleCreateSA(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	var req domain.CreateServiceAccountRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}
	created, err := s.SAs.Create(r.Context(), claims.TenantID, req, actorFrom(claims))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created) // api_key shown once (BR-11)
}

func (s *Server) handleListSAs(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	page, err := domain.ParsePage(r.URL.Query().Get("limit"), r.URL.Query().Get("cursor"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	items, info, err := s.Store.ListServiceAccounts(r.Context(), claims.TenantID, page)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writePage(w, items, info)
}

func (s *Server) handleRotateSA(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	rotated, err := s.SAs.Rotate(r.Context(), claims.TenantID, id, actorFrom(claims))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rotated)
}

func (s *Server) handleRevokeSA(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	id, err := parseID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.SAs.Revoke(r.Context(), claims.TenantID, id, actorFrom(claims)); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /credentials (US-8): active credentials inventory per tenant.
func (s *Server) handleCredentials(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	entries, err := s.SAs.CredentialInventory(r.Context(), claims.TenantID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": entries})
}
