package api

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/datacern-ai/rbac-service/internal/domain"
)

type audienceRequest struct {
	Tenant      string `json:"tenant"`
	Role        string `json:"role"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	GroupID     string `json:"group_id,omitempty"`
}

type audienceResponse struct {
	UserIDs []string `json:"user_ids"`
}

// handleAudienceResolve is the real source of truth notification-service's
// role/group-addressed audiences resolve against (NOTIF-FR-013): tenant
// admins, workspace managers and workspace subscribers read the live
// members/group_roles/roles/workspace_groups tables, and arbitrary
// subscription-rule group subjects read the same membership rows
// GET /groups/{id}/members serves. Gated like /authz/check: service callers
// or a super-admin only, tenant bound to the caller's own verified token
// (MASTER-FR-002).
func (s *Server) handleAudienceResolve(w http.ResponseWriter, r *http.Request) {
	var req audienceRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Tenant == "" || req.Role == "" {
		writeError(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "tenant and role are required", nil)
		return
	}
	claims := ClaimsFrom(r.Context())
	if req.Tenant != claims.TenantID && !claims.HasScope(ScopeSuperAdmin) {
		writeError(w, r, http.StatusForbidden, "PERMISSION_DENIED", "tenant does not match caller identity", nil)
		return
	}
	tenant, err := uuid.Parse(req.Tenant)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "invalid tenant", nil)
		return
	}
	var wsID uuid.UUID
	if req.WorkspaceID != "" {
		if wsID, err = uuid.Parse(req.WorkspaceID); err != nil {
			writeError(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "invalid workspace_id", nil)
			return
		}
	}

	var ids []string
	switch req.Role {
	case "tenant_admins":
		ids, err = s.Store.RoleAudience(r.Context(), tenant, domain.RoleAdmin, uuid.Nil)
	case "workspace_managers":
		if wsID == uuid.Nil {
			writeError(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "workspace_id is required for workspace_managers", nil)
			return
		}
		ids, err = s.Store.RoleAudience(r.Context(), tenant, domain.RoleUseCaseAdmin, wsID)
	case "workspace_subscribers":
		if wsID == uuid.Nil {
			writeError(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "workspace_id is required for workspace_subscribers", nil)
			return
		}
		ids, err = s.Store.WorkspaceSubscribers(r.Context(), tenant, wsID)
	case "group":
		var gid uuid.UUID
		if gid, err = uuid.Parse(req.GroupID); err != nil {
			writeError(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "invalid group_id", nil)
			return
		}
		ids, err = s.groupMemberIDs(r.Context(), tenant, gid)
	default:
		writeError(w, r, http.StatusBadRequest, "VALIDATION_FAILED", "unknown role", nil)
		return
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, http.StatusOK, audienceResponse{UserIDs: ids})
}

// groupMemberIDs pages through ListMembers (the same store method backing
// GET /groups/{id}/members) up to audienceCap so the "group" audience role
// shares its one real source of membership with the admin-facing endpoint.
func (s *Server) groupMemberIDs(ctx context.Context, tenant, groupID uuid.UUID) ([]string, error) {
	var ids []string
	cursor := ""
	for {
		page, err := s.Store.ListMembers(ctx, tenant, groupID, cursor, 200)
		if err != nil {
			return nil, err
		}
		for _, m := range page.Data {
			ids = append(ids, m.UserID)
			if len(ids) >= 500 {
				return ids, nil
			}
		}
		if !page.HasMore {
			return ids, nil
		}
		cursor = page.NextCursor
	}
}
