package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/go-common/authjwt"
	"github.com/datacern-ai/go-common/httpx"

	"github.com/datacern-ai/fhir-bridge/internal/store"
)

// secretBody is the write-only secret material accepted on create/patch. It is
// written to Vault at secret/data/tenants/<tenant>/fhir-backends/<id> and
// NEVER stored in Postgres (the row keeps only vault_ref).
type secretBody struct {
	Token         string `json:"token,omitempty"`           // bearer
	Username      string `json:"username,omitempty"`        // basic
	Password      string `json:"password,omitempty"`        // basic
	ClientSecret  string `json:"client_secret,omitempty"`   // oauth2_client_credentials
	PrivateKeyPEM string `json:"private_key_pem,omitempty"` // smart_backend_services
	KID           string `json:"kid,omitempty"`             // smart_backend_services
}

func (sb *secretBody) toMap() map[string]string {
	if sb == nil {
		return nil
	}
	out := map[string]string{}
	for k, v := range map[string]string{
		"token": sb.Token, "username": sb.Username, "password": sb.Password,
		"client_secret": sb.ClientSecret, "private_key_pem": sb.PrivateKeyPEM,
		"kid": sb.KID,
	} {
		if v != "" {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

type createBackendReq struct {
	Name        string      `json:"name"`
	BaseURL     string      `json:"base_url"`
	AuthMethod  string      `json:"auth_method"`
	TokenURL    string      `json:"token_url,omitempty"`
	ClientID    string      `json:"client_id,omitempty"`
	Scopes      string      `json:"scopes,omitempty"`
	WorkspaceID *uuid.UUID  `json:"workspace_id,omitempty"`
	Secret      *secretBody `json:"secret,omitempty"`
}

func tenantFrom(r *http.Request) (uuid.UUID, bool) {
	claims, ok := authjwt.FromContext(r.Context())
	if !ok {
		return uuid.Nil, false
	}
	t, err := claims.Tenant()
	if err != nil {
		return uuid.Nil, false
	}
	return t, true
}

func writeData(w http.ResponseWriter, status int, v any) {
	httpx.WriteJSON(w, status, map[string]any{"data": v})
}

func validateBackendConfig(baseURL, authMethod, tokenURL, clientID string) (string, bool) {
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "base_url must be an absolute http(s) URL", false
	}
	if !store.AuthMethods[authMethod] {
		return "auth_method must be one of none|bearer|basic|oauth2_client_credentials|smart_backend_services", false
	}
	if authMethod == "oauth2_client_credentials" || authMethod == "smart_backend_services" {
		if tokenURL == "" || clientID == "" {
			return "token_url and client_id are required for " + authMethod, false
		}
		tu, err := url.Parse(tokenURL)
		if err != nil || (tu.Scheme != "http" && tu.Scheme != "https") || tu.Host == "" {
			return "token_url must be an absolute http(s) URL", false
		}
	}
	return "", true
}

func (s *Server) handleCreateBackend(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantFrom(r)
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthenticated, "bad tenant claim", TraceID(r.Context()), nil, 0)
		return
	}
	var req createBackendReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation, "invalid JSON body", TraceID(r.Context()), nil, 0)
		return
	}
	if req.Name == "" || req.BaseURL == "" || req.AuthMethod == "" {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation, "name, base_url and auth_method are required", TraceID(r.Context()), nil, 0)
		return
	}
	if msg, ok := validateBackendConfig(req.BaseURL, req.AuthMethod, req.TokenURL, req.ClientID); !ok {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation, msg, TraceID(r.Context()), nil, 0)
		return
	}
	secret := req.Secret.toMap()
	if req.AuthMethod != "none" && secret == nil {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation,
			"secret is required for auth_method "+req.AuthMethod, TraceID(r.Context()), nil, 0)
		return
	}

	id := uuid.New()
	b := &store.Backend{
		ID: id, TenantID: tenant, WorkspaceID: req.WorkspaceID,
		Name: req.Name, BaseURL: req.BaseURL, AuthMethod: req.AuthMethod,
		TokenURL: req.TokenURL, ClientID: req.ClientID, Scopes: req.Scopes,
		Status: "active",
	}
	if secret != nil {
		b.VaultRef = vaultRef(tenant, id)
		if err := s.Secrets.Put(r.Context(), b.VaultRef, secret); err != nil {
			s.log().Error("vault write failed", "backend_id", id, "tenant", tenant, "err", err)
			httpx.WriteError(w, http.StatusBadGateway, httpx.CodeInternal, "secret store write failed", TraceID(r.Context()), nil, 0)
			return
		}
	}
	if err := s.Store.Create(r.Context(), b); err != nil {
		if b.VaultRef != "" {
			if derr := s.Secrets.Delete(r.Context(), b.VaultRef); derr != nil {
				s.log().Warn("vault cleanup after failed create", "backend_id", id, "err", derr)
			}
		}
		s.writeStoreErr(w, r, err)
		return
	}
	writeData(w, http.StatusCreated, b)
}

func (s *Server) handleListBackends(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantFrom(r)
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthenticated, "bad tenant claim", TraceID(r.Context()), nil, 0)
		return
	}
	list, err := s.Store.List(r.Context(), tenant)
	if err != nil {
		s.writeStoreErr(w, r, err)
		return
	}
	if list == nil {
		list = []store.Backend{}
	}
	writeData(w, http.StatusOK, list)
}

// backendFromPath resolves the {id} route param to the tenant's backend row.
func (s *Server) backendFromPath(w http.ResponseWriter, r *http.Request) (*store.Backend, bool) {
	tenant, ok := tenantFrom(r)
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthenticated, "bad tenant claim", TraceID(r.Context()), nil, 0)
		return nil, false
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusNotFound, httpx.CodeNotFound, "not found", TraceID(r.Context()), nil, 0)
		return nil, false
	}
	b, err := s.Store.Get(r.Context(), tenant, id)
	if err != nil {
		s.writeStoreErr(w, r, err)
		return nil, false
	}
	return b, true
}

func (s *Server) handleGetBackend(w http.ResponseWriter, r *http.Request) {
	b, ok := s.backendFromPath(w, r)
	if !ok {
		return
	}
	writeData(w, http.StatusOK, b)
}

type patchBackendReq struct {
	Name       *string     `json:"name,omitempty"`
	BaseURL    *string     `json:"base_url,omitempty"`
	AuthMethod *string     `json:"auth_method,omitempty"`
	TokenURL   *string     `json:"token_url,omitempty"`
	ClientID   *string     `json:"client_id,omitempty"`
	Scopes     *string     `json:"scopes,omitempty"`
	Status     *string     `json:"status,omitempty"`
	Secret     *secretBody `json:"secret,omitempty"`
}

func (s *Server) handlePatchBackend(w http.ResponseWriter, r *http.Request) {
	b, ok := s.backendFromPath(w, r)
	if !ok {
		return
	}
	var req patchBackendReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation, "invalid JSON body", TraceID(r.Context()), nil, 0)
		return
	}
	if req.Name != nil {
		b.Name = *req.Name
	}
	if req.BaseURL != nil {
		b.BaseURL = *req.BaseURL
	}
	if req.AuthMethod != nil {
		b.AuthMethod = *req.AuthMethod
	}
	if req.TokenURL != nil {
		b.TokenURL = *req.TokenURL
	}
	if req.ClientID != nil {
		b.ClientID = *req.ClientID
	}
	if req.Scopes != nil {
		b.Scopes = *req.Scopes
	}
	if req.Status != nil {
		if *req.Status != "active" && *req.Status != "disabled" {
			httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation, "status must be active or disabled", TraceID(r.Context()), nil, 0)
			return
		}
		b.Status = *req.Status
	}
	if b.Name == "" || b.BaseURL == "" {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation, "name and base_url must not be empty", TraceID(r.Context()), nil, 0)
		return
	}
	if msg, ok := validateBackendConfig(b.BaseURL, b.AuthMethod, b.TokenURL, b.ClientID); !ok {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeValidation, msg, TraceID(r.Context()), nil, 0)
		return
	}
	// Optional secret rotation: a new secret object replaces the Vault entry.
	if secret := req.Secret.toMap(); secret != nil {
		if b.VaultRef == "" {
			b.VaultRef = vaultRef(b.TenantID, b.ID)
		}
		if err := s.Secrets.Put(r.Context(), b.VaultRef, secret); err != nil {
			s.log().Error("vault rotate failed", "backend_id", b.ID, "tenant", b.TenantID, "err", err)
			httpx.WriteError(w, http.StatusBadGateway, httpx.CodeInternal, "secret store write failed", TraceID(r.Context()), nil, 0)
			return
		}
	}
	if err := s.Store.Update(r.Context(), b); err != nil {
		s.writeStoreErr(w, r, err)
		return
	}
	writeData(w, http.StatusOK, b)
}

func (s *Server) handleDeleteBackend(w http.ResponseWriter, r *http.Request) {
	b, ok := s.backendFromPath(w, r)
	if !ok {
		return
	}
	if err := s.Store.Delete(r.Context(), b.TenantID, b.ID); err != nil {
		s.writeStoreErr(w, r, err)
		return
	}
	// Best-effort Vault cleanup: a dangling secret is logged, never fatal.
	if b.VaultRef != "" {
		if err := s.Secrets.Delete(r.Context(), b.VaultRef); err != nil {
			s.log().Warn("vault delete failed (secret may dangle)",
				"backend_id", b.ID, "tenant", b.TenantID, "vault_ref", b.VaultRef, "err", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleTestBackend probes GET {base_url}/metadata with the backend's auth
// attached and reports {ok, status, fhir_version} — the CapabilityStatement
// body itself is never relayed (no PHI, but also no body passthrough on the
// admin plane).
func (s *Server) handleTestBackend(w http.ResponseWriter, r *http.Request) {
	b, ok := s.backendFromPath(w, r)
	if !ok {
		return
	}
	start := time.Now()
	resp, err := s.FHIR.Metadata(r.Context(), toFHIRBackend(b))
	if err != nil {
		s.log().Warn("backend probe failed", "backend_id", b.ID, "tenant", b.TenantID, "err", err)
		writeData(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	out := map[string]any{
		"ok":         resp.Status >= 200 && resp.Status < 300,
		"status":     resp.Status,
		"latency_ms": time.Since(start).Milliseconds(),
	}
	var caps struct {
		FHIRVersion string `json:"fhirVersion"`
	}
	if json.Unmarshal(resp.Body, &caps) == nil && caps.FHIRVersion != "" {
		out["fhir_version"] = caps.FHIRVersion
	}
	writeData(w, http.StatusOK, out)
}

func vaultRef(tenant, id uuid.UUID) string {
	return fmt.Sprintf("secret/data/tenants/%s/fhir-backends/%s", tenant, id)
}

func (s *Server) writeStoreErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, httpx.CodeNotFound, "not found", TraceID(r.Context()), nil, 0)
	case errors.Is(err, store.ErrNameConflict):
		httpx.WriteError(w, http.StatusConflict, httpx.CodeConflict, "backend name already exists", TraceID(r.Context()), nil, 0)
	default:
		s.log().Error("store error", "err", err, "path", r.URL.Path)
		httpx.WriteError(w, http.StatusInternalServerError, httpx.CodeInternal, "internal error", TraceID(r.Context()), nil, 0)
	}
}
