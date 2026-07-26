//go:build integration

package integration

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/rbac-service/internal/domain"
)

// findSystemRoleID looks up a seeded system role's id by name (mirrors the
// lookup TestIntegration_RoleLifecycle does for RoleDataUser).
func (h *harness) findSystemRoleID(t *testing.T, env *tenantEnv, name string) string {
	t.Helper()
	list := h.do(t, http.MethodGet, "/api/v1/roles?limit=200", env.AdminTok, nil)
	require.Equal(t, http.StatusOK, list.Status)
	var page struct {
		Data []domain.Role `json:"data"`
	}
	list.JSON(t, &page)
	for _, ro := range page.Data {
		if ro.System && ro.Name == name {
			return ro.ID.String()
		}
	}
	require.Failf(t, "system role not found", "name=%s", name)
	return ""
}

func (h *harness) serviceTok(t *testing.T, tenant string) string {
	t.Helper()
	tenantID, err := uuid.Parse(tenant)
	require.NoError(t, err)
	return h.mint(t, tokenSpec{Sub: "svc:notification-service", Tenant: tenantID, Typ: domain.TypService})
}

// TestIntegration_AudienceResolve_TenantAdmins proves notification-service's
// audience resolver, wired to POST /audience/resolve, reaches the real
// tenant-admin membership (env.AdminUser is seeded into the system Admin
// group by newTenant) instead of an empty Redis key nobody writes.
func TestIntegration_AudienceResolve_TenantAdmins(t *testing.T) {
	h := requireHarness(t)
	env := h.newTenant(t)
	tok := h.serviceTok(t, env.Tenant.String())

	r := h.do(t, http.MethodPost, "/api/v1/audience/resolve", tok,
		map[string]any{"tenant": env.Tenant.String(), "role": "tenant_admins"})
	require.Equalf(t, http.StatusOK, r.Status, "body: %s", r.Body)
	var out struct {
		UserIDs []string `json:"user_ids"`
	}
	r.JSON(t, &out)
	assert.Contains(t, out.UserIDs, env.AdminUser)
}

// TestIntegration_AudienceResolve_WorkspaceManagers exercises the
// "Use case Admin" system role scoped to one workspace via a linked content
// group — the real path case.sla.breached's "workspace managers" audience
// must resolve through.
func TestIntegration_AudienceResolve_WorkspaceManagers(t *testing.T) {
	h := requireHarness(t)
	env := h.newTenant(t)
	tok := h.serviceTok(t, env.Tenant.String())

	roleID := h.findSystemRoleID(t, env, domain.RoleUseCaseAdmin)
	pg := h.createGroup(t, env, "WS Managers", domain.GroupTypePermission)
	cg := h.createGroup(t, env, "WS Manager Content", domain.GroupTypeContent)
	ws := h.createWorkspace(t, env, "Managed WS", false)
	manager := "mgr-" + env.AdminUser

	uid, err := uuid.Parse(roleID)
	require.NoError(t, err)
	h.bindRole(t, env, pg.ID, uid)
	h.addMember(t, env, pg.ID, manager)
	h.linkGroup(t, env, ws.ID, cg.ID)
	h.addMember(t, env, cg.ID, manager)

	r := h.do(t, http.MethodPost, "/api/v1/audience/resolve", tok,
		map[string]any{"tenant": env.Tenant.String(), "role": "workspace_managers", "workspace_id": ws.ID.String()})
	require.Equalf(t, http.StatusOK, r.Status, "body: %s", r.Body)
	var out struct {
		UserIDs []string `json:"user_ids"`
	}
	r.JSON(t, &out)
	assert.Contains(t, out.UserIDs, manager)
	assert.NotContains(t, out.UserIDs, env.AdminUser)
}

// TestIntegration_AudienceResolve_Group proves an arbitrary subscription-rule
// group subject resolves to its real members.
func TestIntegration_AudienceResolve_Group(t *testing.T) {
	h := requireHarness(t)
	env := h.newTenant(t)
	tok := h.serviceTok(t, env.Tenant.String())

	g := h.createGroup(t, env, "Subscribers", domain.GroupTypeContent)
	h.addMember(t, env, g.ID, "subscriber-1")
	h.addMember(t, env, g.ID, "subscriber-2")

	r := h.do(t, http.MethodPost, "/api/v1/audience/resolve", tok,
		map[string]any{"tenant": env.Tenant.String(), "role": "group", "group_id": g.ID.String()})
	require.Equalf(t, http.StatusOK, r.Status, "body: %s", r.Body)
	var out struct {
		UserIDs []string `json:"user_ids"`
	}
	r.JSON(t, &out)
	assert.ElementsMatch(t, []string{"subscriber-1", "subscriber-2"}, out.UserIDs)
}

// TestIntegration_AudienceResolve_CrossTenantDenied: a service token minted
// for tenant A cannot resolve tenant B's audience (MASTER-FR-002).
func TestIntegration_AudienceResolve_CrossTenantDenied(t *testing.T) {
	h := requireHarness(t)
	envA := h.newTenant(t)
	envB := h.newTenant(t)
	tokA := h.serviceTok(t, envA.Tenant.String())

	r := h.do(t, http.MethodPost, "/api/v1/audience/resolve", tokA,
		map[string]any{"tenant": envB.Tenant.String(), "role": "tenant_admins"})
	assert.Equal(t, http.StatusForbidden, r.Status)
}

// TestIntegration_AudienceResolve_RequiresServiceIdentity: an ordinary user
// token (not service, not super_admin) is refused.
func TestIntegration_AudienceResolve_RequiresServiceIdentity(t *testing.T) {
	h := requireHarness(t)
	env := h.newTenant(t)

	r := h.do(t, http.MethodPost, "/api/v1/audience/resolve", env.AdminTok,
		map[string]any{"tenant": env.Tenant.String(), "role": "tenant_admins"})
	assert.Equal(t, http.StatusForbidden, r.Status)
}
