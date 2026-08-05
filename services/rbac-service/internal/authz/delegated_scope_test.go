package authz

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/rbac-service/internal/domain"
)

// Multi-action agent_obo tokens (BRD 74 AC-10).
//
// tool-plane can now forward a caller's token to the backend facade of a tool
// whose registered version DECLARES the downstream actions it will exercise, so
// an agent_obo token may legitimately carry several actions — e.g.
// scopes=["search.query", "dataset.dataset.read", "case.case.assign"] — instead
// of just the tool id.
//
// Nothing about the DECISION changed to allow that: `scopes` was always an
// action list, and `agent_obo` was always intersection(scopes, the obo user's
// grants). These tests pin that the wider token is still bounded on both sides,
// because that is the whole security argument for forwarding it: the tool's
// declaration caps the token, and the human's own grants cap the tool.
func TestDecide_DelegatedMultiActionScopes(t *testing.T) {
	r := fixtureReader(t)
	ctx := context.Background()

	// The shape a search-style read tool's token has: the tool id plus the
	// downstream reads it declared. Deliberately ALSO carries an action the
	// fixture user does NOT hold (chart.dashboard.delete) and one the tool did
	// not declare is simply absent.
	declared := []string{
		"search.query",
		"dataset.dataset.read",
		"chart.dashboard.delete",
	}
	obo := func(action, ws string) Input {
		return Input{
			Subject:     Subject{ID: "agent-7", Typ: domain.TypAgentOBO, OboSub: "u-1", Scopes: declared},
			Action:      action,
			WorkspaceID: ws,
			Tenant:      tenantA.String(),
		}
	}

	// In scopes AND held by the human -> allowed. This is the leg that makes
	// the MCP search tool return the same rows the human's own GraphQL query
	// returns.
	d, err := Decide(ctx, obo("dataset.dataset.read", ws1.String()), r)
	require.NoError(t, err)
	assert.True(t, d.Allowed, "a declared read the human holds must be allowed")

	// In scopes but NOT held by the human -> denied. Carrying an extra scope
	// buys the agent nothing: the human is still the ceiling.
	d, err = Decide(ctx, obo("chart.dashboard.delete", ws1.String()), r)
	require.NoError(t, err)
	assert.False(t, d.Allowed, "a declared action the human lacks must stay denied")

	// Held by the human but NOT in scopes -> denied, scope_excluded. This is
	// the property that keeps tool A's token useless for tool B's actions.
	d, err = Decide(ctx, obo("case.case.assign", ws1.String()), r)
	require.NoError(t, err)
	assert.False(t, d.Allowed)
	assert.Equal(t, ReasonScopeExcluded, d.Reason)

	// The tool id itself is not an rbac action, so it authorizes nothing.
	d, err = Decide(ctx, obo("search.query", ws1.String()), r)
	require.NoError(t, err)
	assert.False(t, d.Allowed)
	assert.Equal(t, ReasonUnknownAction, d.Reason)

	// Cross-tenant is unaffected: the same token against another tenant's
	// projection allows nothing.
	in := obo("dataset.dataset.read", ws1.String())
	in.Tenant = tenantB.String()
	d, err = Decide(ctx, in, r)
	require.NoError(t, err)
	assert.False(t, d.Allowed, "a delegated token must not cross a tenant boundary")
}

// A delegated token must never let an agent do MORE than the human, whatever
// verbs it names. The fixture user holds an editor grant on dashURN; editor
// permits update/share, never delete/admin — and the token cannot change that.
func TestDecide_DelegatedScopesNeverExceedTheResourceGrant(t *testing.T) {
	r := fixtureReader(t)
	ctx := context.Background()

	scoped := func(action string) Input {
		return Input{
			Subject: Subject{ID: "agent-7", Typ: domain.TypAgentOBO, OboSub: "u-1",
				Scopes: []string{"search.query", "chart.dashboard.update",
					"chart.dashboard.delete", "chart.dashboard.admin"}},
			Action:      action,
			WorkspaceID: ws1.String(),
			ResourceURN: dashURN,
			Tenant:      tenantA.String(),
		}
	}

	d, err := Decide(ctx, scoped("chart.dashboard.update"), r)
	require.NoError(t, err)
	assert.True(t, d.Allowed, "editor grant permits update")

	for _, action := range []string{"chart.dashboard.delete", "chart.dashboard.admin"} {
		d, err = Decide(ctx, scoped(action), r)
		require.NoError(t, err)
		assert.Falsef(t, d.Allowed, "%s must stay denied: editor is the human's ceiling", action)
	}
}
