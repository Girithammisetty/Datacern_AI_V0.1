// Multi-action agent_obo tokens (BRD 74 AC-10), in BOTH Rego bundles.
//
// tool-plane now forwards a caller's token to the backend facade of a tool whose
// registered version DECLARES its downstream actions, so an agent_obo token may
// carry several actions rather than just the tool id. No policy rule changed to
// permit that — `scopes` was always an action list and `agent_obo` was always
// intersection(scopes, the obo user's grants). These tests pin that the wider
// token is still bounded on both sides, in the canonical bundle
// (datacern.authz, evaluated against the Redis projection) and in the
// input-projection variant (datacern.authz_input, the one every service's
// go-common opaclient actually POSTs).
package policy_test

import (
	"context"
	"os"
	"testing"

	"github.com/open-policy-agent/opa/v1/rego"
	"github.com/open-policy-agent/opa/v1/storage/inmem"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A search-style read tool's token: the tool id, a downstream read the fixture
// user HOLDS, and a write the fixture user does NOT hold.
var delegatedScopes = []string{
	"search.query",
	"dataset.dataset.read",
	"chart.dashboard.delete",
}

func TestPolicy_DelegatedMultiActionScopes(t *testing.T) {
	eval := newEval(t, false)

	allowed, _ := eval(t, in("u-1", "agent_obo", "dataset.dataset.read", ws1, "", delegatedScopes, tenantA))
	assert.True(t, allowed, "a declared read the human holds must be allowed")

	allowed, _ = eval(t, in("u-1", "agent_obo", "chart.dashboard.delete", ws1, "", delegatedScopes, tenantA))
	assert.False(t, allowed, "a declared action the human lacks must stay denied")

	allowed, reason := eval(t, in("u-1", "agent_obo", "case.case.assign", ws1, "", delegatedScopes, tenantA))
	assert.False(t, allowed, "an action the tool did not declare must be denied")
	assert.Equal(t, "scope_excluded", reason)

	// The tool id is not an rbac action and authorizes nothing on its own.
	allowed, reason = eval(t, in("u-1", "agent_obo", "search.query", ws1, "", delegatedScopes, tenantA))
	assert.False(t, allowed)
	assert.Equal(t, "unknown_action", reason)

	// Cross-tenant: the same token against another tenant allows nothing.
	allowed, _ = eval(t, in("u-1", "agent_obo", "dataset.dataset.read", ws1, "", delegatedScopes, tenantB))
	assert.False(t, allowed, "a delegated token must not cross a tenant boundary")
}

// ---- the input-projection variant -------------------------------------------

type inputEval func(t *testing.T, input map[string]any) (bool, string)

func newInputEval(t *testing.T) inputEval {
	t.Helper()
	src, err := os.ReadFile("datacern_authz_input.rego")
	require.NoError(t, err)
	prepared, err := rego.New(
		rego.Query("data.datacern.authz_input.result"),
		rego.Module("datacern_authz_input.rego", string(src)),
		rego.Store(inmem.NewFromObject(map[string]any{})),
	).PrepareForEval(context.Background())
	require.NoError(t, err)
	return func(t *testing.T, input map[string]any) (bool, string) {
		t.Helper()
		rs, err := prepared.Eval(context.Background(), rego.EvalInput(input))
		require.NoError(t, err)
		require.Len(t, rs, 1)
		result, ok := rs[0].Expressions[0].Value.(map[string]any)
		require.True(t, ok, "result must be an object, got %T", rs[0].Expressions[0].Value)
		allowed, _ := result["allow"].(bool)
		reason, _ := result["reason"].(string)
		return allowed, reason
	}
}

// projIn builds the input-projection request an owning service's opaclient
// sends: the caller's subject plus the projection slice it read from Redis.
// `wsActions` is what the obo USER holds in this workspace.
func projIn(action string, scopes []string, wsActions []string) map[string]any {
	s := make([]any, len(scopes))
	for i, v := range scopes {
		s[i] = v
	}
	a := make([]any, len(wsActions))
	for i, v := range wsActions {
		a[i] = v
	}
	return map[string]any{
		"subject":      map[string]any{"id": "agent-7", "typ": "agent_obo", "obo_sub": "u-1", "scopes": s},
		"action":       action,
		"workspace_id": ws1,
		"tenant":       tenantA,
		"projection": map[string]any{
			"action_known":  true,
			"action_scoped": true,
			"flags":         map[string]any{"found": true, "admin": false, "ws_admin": []any{}},
			"tenant_actions": map[string]any{"found": false, "actions": []any{}},
			"workspace": map[string]any{
				"assigned": true, "actions": a, "archived": false,
			},
			"resource":                  map[string]any{"found": false},
			"workspace_archived_tenant": false,
		},
	}
}

func TestPolicyInput_DelegatedMultiActionScopes(t *testing.T) {
	eval := newInputEval(t)
	// The obo user holds the read, not the delete.
	held := []string{"dataset.dataset.read", "case.case.assign"}

	allowed, _ := eval(t, projIn("dataset.dataset.read", delegatedScopes, held))
	assert.True(t, allowed, "a declared read the human holds must be allowed")

	allowed, _ = eval(t, projIn("chart.dashboard.delete", delegatedScopes, held))
	assert.False(t, allowed, "a declared action the human lacks must stay denied")

	allowed, reason := eval(t, projIn("case.case.assign", delegatedScopes, held))
	assert.False(t, allowed, "an action the tool did not declare must be denied")
	assert.Equal(t, "scope_excluded", reason)

	// A token scoped ONLY to the tool id (the write path's shape) authorizes no
	// downstream action at all.
	allowed, reason = eval(t, projIn("dataset.dataset.read", []string{"search.query"}, held))
	assert.False(t, allowed)
	assert.Equal(t, "scope_excluded", reason)
}
