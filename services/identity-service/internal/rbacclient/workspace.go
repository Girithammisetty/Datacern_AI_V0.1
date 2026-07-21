// Package rbacclient — default-workspace resolution for interactive OIDC
// logins (domain.WorkspaceResolver). "workspace" is a first-class entity
// owned entirely by rbac-service (services/rbac-service/internal/domain
// Workspace), not identity — every tenant gets a well-known, literally-named
// public workspace at provisioning time (rbac's domain.DefaultWorkspaceName,
// "Default use case"; see rbac-service/internal/store/seed.go SeedTenant).
package rbacclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// defaultWorkspaceName mirrors rbac-service's domain.DefaultWorkspaceName —
// duplicated rather than imported since identity-service doesn't (and
// shouldn't) depend on rbac-service's Go module.
const defaultWorkspaceName = "Default use case"

// WorkspaceResolver implements domain.WorkspaceResolver against the real
// rbac-service API, the same way Checker implements domain.LastAdminChecker.
type WorkspaceResolver struct {
	BaseURL string             // rbac-service base URL
	Issuer  domain.TokenIssuer // mints the service token (platform signing key)
	HTTP    *http.Client
	Log     *slog.Logger
}

var _ domain.WorkspaceResolver = (*WorkspaceResolver)(nil)

func (r *WorkspaceResolver) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 5 * time.Second}
}

type workspaceDTO struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type workspacePage struct {
	Data []workspaceDTO `json:"data"`
	Page struct {
		NextCursor *string `json:"next_cursor"`
		HasMore    bool    `json:"has_more"`
	} `json:"page"`
}

// DefaultWorkspaceID finds the tenant's well-known "Default use case"
// workspace (public, so it's visible to any authenticated caller — no
// membership needed). Errors (rbac unreachable, no default found) propagate;
// the caller (OIDCLogin) treats that as "leave workspace_id unset" rather
// than failing sign-in.
func (r *WorkspaceResolver) DefaultWorkspaceID(ctx context.Context, tenantID uuid.UUID) (string, error) {
	token, _, err := r.Issuer.Issue(domain.Claims{
		Subject: "svc:identity-service", TenantID: tenantID, Typ: domain.TypService, Scopes: []string{},
	})
	if err != nil {
		return "", fmt.Errorf("mint rbac service token: %w", err)
	}

	cursor := ""
	for {
		q := url.Values{"limit": {"200"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			r.BaseURL+"/api/v1/workspaces?"+q.Encode(), nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := r.client().Do(req)
		if err != nil {
			return "", fmt.Errorf("rbac list workspaces: %w", err)
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("rbac list workspaces: status %d: %s", resp.StatusCode, string(raw))
		}
		var page workspacePage
		if err := json.Unmarshal(raw, &page); err != nil {
			return "", fmt.Errorf("rbac list workspaces: decode: %w", err)
		}
		for _, ws := range page.Data {
			if ws.Name == defaultWorkspaceName {
				return ws.ID.String(), nil
			}
		}
		if !page.Page.HasMore || page.Page.NextCursor == nil {
			break
		}
		cursor = *page.Page.NextCursor
	}

	if r.Log != nil {
		r.Log.Warn("no default workspace found for tenant", "tenant", tenantID)
	}
	return "", fmt.Errorf("no %q workspace found for tenant %s", defaultWorkspaceName, tenantID)
}
