package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/go-common/httpx"

	"github.com/datacern-ai/fhir-bridge/internal/authz"
	"github.com/datacern-ai/fhir-bridge/internal/fhirclient"
)

// facadeReq is tool-plane's backend-facade contract (BRD 13, TPL-FR-012): the
// mcp-gateway POSTs {tool_id, version, args, tenant, obo_sub, agent_id} to a
// tool's owning-service backend URL after the full enforcement pipeline.
// fhir-bridge hosts the backends for the fhir.* tools here.
type facadeReq struct {
	ToolID  string         `json:"tool_id"`
	Version string         `json:"version"`
	Args    map[string]any `json:"args"`
	Tenant  string         `json:"tenant"`
	OboSub  string         `json:"obo_sub"`
	AgentID string         `json:"agent_id"`
}

// facadeTools maps tool_id → (rbac action, FHIR operation).
var facadeTools = map[string]string{
	"fhir.read_resource":    authz.ActionResourceRead,
	"fhir.search_resources": authz.ActionResourceList,
	"fhir.create_resource":  authz.ActionResourceCreate,
	"fhir.update_resource":  authz.ActionResourceUpdate,
}

// handleToolFacade is the real MCP backend facade the tool-plane federates to.
// The peer identity is the mesh-injected SPIFFE id (X-Spiffe-Id);
// authorization is re-checked against the real OPA sidecar for the effective
// human (obo_sub) — the backend never blindly trusts the gateway. The bridge
// then resolves the tenant's backend row (RLS under the facade tenant),
// attaches upstream auth from Vault and relays the FHIR response. Only
// metadata is logged — never a body.
func (s *Server) handleToolFacade(w http.ResponseWriter, r *http.Request) {
	// Mesh peer identity (MASTER-FR-014). This facade trusts X-Spiffe-Id ONLY
	// because it must sit behind a NetworkPolicy + mTLS (the header is set by
	// the verified in-cluster peer, not an arbitrary client) — so with no
	// allowlist configured there is nothing to verify the header against and
	// we MUST fail closed rather than accept any non-empty value.
	spiffe := r.Header.Get("X-Spiffe-Id")
	allowed := os.Getenv("FHIR_FACADE_ALLOWED_SPIFFE")
	if allowed == "" {
		facadeError(w, http.StatusForbidden, "facade disabled: FHIR_FACADE_ALLOWED_SPIFFE is not configured")
		return
	}
	ok := false
	for _, a := range strings.Split(allowed, ",") {
		if a = strings.TrimSpace(a); a != "" && a == spiffe {
			ok = true
			break
		}
	}
	if !ok {
		facadeError(w, http.StatusForbidden, "facade requires an allowed SPIFFE peer identity")
		return
	}

	var req facadeReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, fhirclient.MaxResponseBytes)).Decode(&req); err != nil {
		facadeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	action, known := facadeTools[req.ToolID]
	if !known {
		facadeError(w, http.StatusNotFound, "unknown tool_id")
		return
	}
	tenant, err := uuid.Parse(req.Tenant)
	if err != nil {
		facadeError(w, http.StatusBadRequest, "invalid tenant")
		return
	}

	// Real governed authorization for the effective human (obo_sub) against
	// the OPA sidecar — fail closed when the authorizer is not wired.
	if s.Authz == nil {
		facadeError(w, http.StatusForbidden, "authorizer not configured")
		return
	}
	if !s.Authz.Allow(r.Context(), authz.Input{
		Subject: authz.Subject{ID: req.OboSub, Typ: "user"},
		Action:  action,
		Tenant:  req.Tenant,
	}) {
		facadeError(w, http.StatusForbidden, "not allowed: "+action)
		return
	}

	backendIDRaw, _ := req.Args["backend_id"].(string)
	backendID, err := uuid.Parse(backendIDRaw)
	if err != nil {
		facadeError(w, http.StatusBadRequest, "args.backend_id must be a uuid")
		return
	}
	resourceType, _ := req.Args["resource_type"].(string)
	if !fhirclient.ValidResourceType(resourceType) {
		facadeError(w, http.StatusBadRequest, "args.resource_type is invalid")
		return
	}

	// Tenant-scoped backend lookup (RLS: the store sets app.tenant_id from the
	// facade tenant). A missing, cross-tenant or disabled backend is the same
	// 404 — its existence is not confirmed.
	b, err := s.Store.Get(r.Context(), tenant, backendID)
	if err != nil || b.Status != "active" {
		facadeError(w, http.StatusNotFound, "backend not found")
		return
	}
	be := toFHIRBackend(b)

	start := time.Now()
	var resp *fhirclient.Response
	var callErr error
	resourceID := ""
	switch req.ToolID {
	case "fhir.read_resource":
		resourceID, _ = req.Args["resource_id"].(string)
		if !fhirclient.ValidResourceID(resourceID) {
			facadeError(w, http.StatusBadRequest, "args.resource_id is invalid")
			return
		}
		resp, callErr = s.FHIR.Read(r.Context(), be, resourceType, resourceID)
	case "fhir.search_resources":
		params := map[string]string{}
		if raw, ok := req.Args["params"].(map[string]any); ok {
			for k, v := range raw {
				sv, ok := v.(string)
				if !ok {
					facadeError(w, http.StatusBadRequest, "args.params values must be strings")
					return
				}
				params[k] = sv
			}
		}
		resp, callErr = s.FHIR.Search(r.Context(), be, resourceType, params)
	case "fhir.create_resource":
		body, ok := marshalResource(req.Args["resource"])
		if !ok {
			facadeError(w, http.StatusBadRequest, "args.resource must be an object")
			return
		}
		resp, callErr = s.FHIR.Create(r.Context(), be, resourceType, body)
	case "fhir.update_resource":
		resourceID, _ = req.Args["resource_id"].(string)
		if !fhirclient.ValidResourceID(resourceID) {
			facadeError(w, http.StatusBadRequest, "args.resource_id is invalid")
			return
		}
		body, ok := marshalResource(req.Args["resource"])
		if !ok {
			facadeError(w, http.StatusBadRequest, "args.resource must be an object")
			return
		}
		resp, callErr = s.FHIR.Update(r.Context(), be, resourceType, resourceID, body)
	}

	// NO-PHI log discipline: resource type/id, status, latency, tenant and
	// backend id only — never a request or response body.
	log := s.log().With("tool_id", req.ToolID, "tenant", req.Tenant,
		"backend_id", b.ID, "resource_type", resourceType, "resource_id", resourceID,
		"latency_ms", time.Since(start).Milliseconds())
	if callErr != nil {
		log.Warn("fhir upstream call failed", "err", callErr)
		facadeError(w, http.StatusBadGateway, "upstream call failed: "+callErr.Error())
		return
	}
	log.Info("fhir upstream call", "status", resp.Status)

	// Relay upstream rejections in the 4xx error shape (tool-plane surfaces
	// them as NOT_FOUND / VALIDATION_FAILED / PERMISSION_DENIED); upstream 5xx
	// becomes a 502 backend error. Bodies are never echoed into errors.
	if resp.Status >= 500 {
		facadeError(w, http.StatusBadGateway, fmt.Sprintf("upstream fhir status %d", resp.Status))
		return
	}
	if resp.Status >= 400 {
		facadeError(w, resp.Status, fmt.Sprintf("upstream fhir status %d", resp.Status))
		return
	}

	key := "resource"
	if req.ToolID == "fhir.search_resources" {
		key = "bundle"
	}
	facadeOutput(w, map[string]any{key: resp.Body, "status": resp.Status})
}

// marshalResource re-encodes the args.resource object for upstream submission.
func marshalResource(v any) ([]byte, bool) {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	raw, err := json.Marshal(obj)
	if err != nil {
		return nil, false
	}
	return raw, true
}

func facadeOutput(w http.ResponseWriter, out map[string]any) {
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"output": out})
}

func facadeError(w http.ResponseWriter, status int, msg string) {
	httpx.WriteJSON(w, status, map[string]any{"output": map[string]any{"error": msg}})
}
