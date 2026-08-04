// Package authz is fhir-bridge's authorization port (MASTER-FR-012): decisions
// come from the local OPA sidecar reading the Redis permissions_flat
// projection. rbac-service is never called synchronously in the request path.
// The real runtime implementation is OPAClient (opa_client.go); Static below is
// a unit-test double only.
package authz

import "context"

// Actions (MASTER-FR-016 naming: <service>.<resource>.<verb>). Every action
// here MUST use a catalog-valid verb from the RBC-FR-022 closed set
// (read/list/create/update/delete/execute/assign/approve/admin/export/share/
// merge) so that rbac's action catalog (which OPA consumes for `action_known`)
// recognises it. These are registered with rbac's idempotent registration API
// at startup (Manifest, internal/register).
//
// fhir.backend.* is the tenant-admin connection plane (configure the tenant's
// external FHIR servers). fhir.resource.* is the governed proxy data plane the
// tool-plane facade re-checks per invocation for the effective human.
const (
	ActionBackendCreate = "fhir.backend.create"
	ActionBackendRead   = "fhir.backend.read"
	ActionBackendList   = "fhir.backend.list"
	ActionBackendUpdate = "fhir.backend.update"
	ActionBackendDelete = "fhir.backend.delete"

	ActionResourceRead   = "fhir.resource.read"
	ActionResourceList   = "fhir.resource.list"
	ActionResourceCreate = "fhir.resource.create"
	ActionResourceUpdate = "fhir.resource.update"
)

// Manifest is fhir-bridge's action catalog slice (RBC-FR-022): the exact set of
// actions this service authorizes against, registered with rbac at startup so
// the catalog OPA consumes knows each action (`action_known`). All fhir
// actions are tenant-scoped, NOT workspace-scoped: the bridge's OPA input
// carries the tenant only (the facade call has no workspace context).
func Manifest() []ActionManifestEntry {
	return []ActionManifestEntry{
		{Action: ActionBackendCreate, WorkspaceScoped: false},
		{Action: ActionBackendRead, WorkspaceScoped: false},
		{Action: ActionBackendList, WorkspaceScoped: false},
		{Action: ActionBackendUpdate, WorkspaceScoped: false},
		{Action: ActionBackendDelete, WorkspaceScoped: false},
		{Action: ActionResourceRead, WorkspaceScoped: false},
		{Action: ActionResourceList, WorkspaceScoped: false},
		{Action: ActionResourceCreate, WorkspaceScoped: false},
		{Action: ActionResourceUpdate, WorkspaceScoped: false},
	}
}

// ActionManifestEntry is one catalog registration record.
type ActionManifestEntry struct {
	Action          string `json:"action"`
	WorkspaceScoped bool   `json:"workspace_scoped"`
}

// Input is one authorization question (MASTER-FR-012/016).
type Input struct {
	Subject     Subject `json:"subject"`
	Action      string  `json:"action"`
	ResourceURN string  `json:"resource_urn"`
	WorkspaceID string  `json:"workspace_id"`
	Tenant      string  `json:"tenant"`
}

// Subject describes the caller.
type Subject struct {
	ID     string   `json:"id"`
	Typ    string   `json:"typ"`
	OboSub string   `json:"obo_sub,omitempty"`
	Scopes []string `json:"scopes,omitempty"`
}

// Authorizer answers allow/deny. The real runtime implementation is OPAClient
// (opa_client.go). Static is a unit-test double only.
type Authorizer interface {
	Allow(ctx context.Context, in Input) bool
}

// Static allows/denies per action (unit-tier authz matrix fake).
type Static struct {
	Denied map[string]bool
}

// Allow denies the listed actions and allows the rest.
func (s Static) Allow(_ context.Context, in Input) bool { return !s.Denied[in.Action] }
