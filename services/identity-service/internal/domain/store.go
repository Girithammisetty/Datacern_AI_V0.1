package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Store is the persistence port. Two implementations exist:
//   - store/memory: in-memory fake for the unit test tier
//   - store/postgres: pgx implementation with RLS (integration tier)
//
// Every mutating method accepts trailing outbox events which MUST be
// persisted atomically with the mutation (MASTER-FR-034, BR-12).
type Store interface {
	// --- tenants (platform-scoped, RLS-exempt; BRD §4) ---
	CreateTenant(ctx context.Context, t *Tenant, evs ...OutboxEvent) error
	GetTenant(ctx context.Context, id uuid.UUID) (*Tenant, error)
	GetTenantByName(ctx context.Context, name string) (*Tenant, error)
	ListTenants(ctx context.Context, f TenantFilter, page PageRequest) ([]*Tenant, PageInfo, error)
	UpdateTenant(ctx context.Context, t *Tenant, evs ...OutboxEvent) error
	// TransitionTenant is a compare-and-set status change: fails with
	// CONFLICT if the stored status differs from `from` (guarded state
	// machine at the persistence boundary, IDN-FR-003).
	TransitionTenant(ctx context.Context, id uuid.UUID, from, to TenantStatus, evs ...OutboxEvent) error

	// --- platform admins (platform-scoped, RLS-exempt; first-class cross-tenant
	// operator, distinct from the per-tenant "Admin" role) ---
	IsPlatformAdmin(ctx context.Context, sub, email string) (bool, error)
	ListPlatformAdmins(ctx context.Context) ([]*PlatformAdmin, error)
	CreatePlatformAdmin(ctx context.Context, pa *PlatformAdmin) error
	DeletePlatformAdmin(ctx context.Context, id uuid.UUID) error

	// --- cells ---
	CreateCell(ctx context.Context, c *Cell) error
	ListCells(ctx context.Context) ([]*Cell, error)
	// ReserveCell atomically increments tenant_count if capacity allows.
	ReserveCell(ctx context.Context, cellID uuid.UUID) error
	ReleaseCell(ctx context.Context, cellID uuid.UUID) error

	// --- tenant modules (IDN-FR-005) ---
	SetTenantModules(ctx context.Context, tenantID uuid.UUID, modules []string, version string) error
	DeleteTenantModules(ctx context.Context, tenantID uuid.UUID) error
	GetTenantModules(ctx context.Context, tenantID uuid.UUID) ([]string, error)

	// --- provisioning runs (IDN-FR-006/007) ---
	SaveProvisioningStep(ctx context.Context, s *ProvisioningStep) error
	ListProvisioningSteps(ctx context.Context, tenantID uuid.UUID, workflowID string) ([]*ProvisioningStep, error)

	// --- users (tenant-scoped, RLS) ---
	CreateUser(ctx context.Context, u *User, evs ...OutboxEvent) error
	GetUser(ctx context.Context, tenantID, id uuid.UUID) (*User, error)
	GetUserByEmail(ctx context.Context, tenantID uuid.UUID, email string) (*User, error)
	GetUserBySub(ctx context.Context, tenantID uuid.UUID, sub string) (*User, error)
	ListUsers(ctx context.Context, tenantID uuid.UUID, f UserFilter, page PageRequest) ([]*User, PageInfo, error)
	UpdateUser(ctx context.Context, u *User, evs ...OutboxEvent) error
	// CountUsers counts non-deleted users in the given statuses (BRD 66 slice
	// 2, CPL-FR-031: the invite path's seat_cap check counts invited+active
	// users as "seats in use" -- a pending invite already reserves a seat).
	CountUsers(ctx context.Context, tenantID uuid.UUID, statuses []UserStatus) (int, error)

	// --- invitations (tenant-scoped, RLS) ---
	CreateInvitation(ctx context.Context, inv *Invitation, evs ...OutboxEvent) error
	// GetInvitationByTokenHash is tenant-less: accept links are public
	// (pre-auth). The postgres impl uses a SECURITY-scoped lookup.
	GetInvitationByTokenHash(ctx context.Context, tokenHash string) (*Invitation, error)
	UpdateInvitation(ctx context.Context, inv *Invitation, evs ...OutboxEvent) error
	// InvalidateInvitations invalidates all open invitations for a user
	// (resend invalidates old tokens, AC-5).
	InvalidateInvitations(ctx context.Context, tenantID, userID uuid.UUID, now time.Time) error

	// --- service accounts / api keys (tenant-scoped, RLS) ---
	CreateServiceAccount(ctx context.Context, sa *ServiceAccount, evs ...OutboxEvent) error
	GetServiceAccount(ctx context.Context, tenantID, id uuid.UUID) (*ServiceAccount, error)
	// --- embedded-UI config (IDN-FR-043) ---
	GetTenantEmbedConfig(ctx context.Context, tenantID uuid.UUID) (*TenantEmbedConfig, error)
	UpsertTenantEmbedConfig(ctx context.Context, cfg *TenantEmbedConfig) error

	// --- white-label branding (BRD 59 WS3) ---
	GetTenantBranding(ctx context.Context, tenantID uuid.UUID) (*TenantBranding, error)
	UpsertTenantBranding(ctx context.Context, b *TenantBranding) error
	DeleteTenantBranding(ctx context.Context, tenantID uuid.UUID) error

	// --- self-service external-agent credentials (BRD 60 WS2) ---
	CreateExternalAgentKey(ctx context.Context, k *ExternalAgentKey) error
	// GetExternalAgentKey looks up by the credential id parsed from a presented
	// key — cross-tenant (the id is globally unique); the exchange verifies the
	// secret before trusting the row.
	GetExternalAgentKey(ctx context.Context, id uuid.UUID) (*ExternalAgentKey, error)
	ListExternalAgentKeys(ctx context.Context, tenantID uuid.UUID) ([]*ExternalAgentKey, error)
	// RevokeExternalAgentKey deactivates a key; tenant-scoped so an admin can
	// only revoke their own tenant's credentials.
	RevokeExternalAgentKey(ctx context.Context, tenantID, id uuid.UUID) error
	TouchExternalAgentKey(ctx context.Context, id uuid.UUID, t time.Time) error

	// --- per-tenant OIDC IdP config (BYO-P4) ---
	GetTenantIdpConfig(ctx context.Context, tenantID uuid.UUID) (*TenantIdpConfig, error)
	// GetTenantIdpConfigByIssuer routes an inbound ID token to its tenant by the
	// token's `iss` claim (issuer is globally unique). Read on the login path.
	GetTenantIdpConfigByIssuer(ctx context.Context, issuer string) (*TenantIdpConfig, error)
	UpsertTenantIdpConfig(ctx context.Context, cfg *TenantIdpConfig) error
	DeleteTenantIdpConfig(ctx context.Context, tenantID uuid.UUID) error

	// --- per-tenant display-label overlays (BRD 23 inc3) ---
	ListTenantDisplayLabels(ctx context.Context, tenantID uuid.UUID) ([]DisplayLabel, error)
	UpsertTenantDisplayLabel(ctx context.Context, l *DisplayLabel) error
	DeleteTenantDisplayLabel(ctx context.Context, tenantID uuid.UUID, key string) error

	// ResolveAPIKeyTenant maps a service-account id to its tenant via the
	// platform-scoped api_key_index table (pre-auth edge exchange).
	ResolveAPIKeyTenant(ctx context.Context, saID uuid.UUID) (uuid.UUID, error)
	ListServiceAccounts(ctx context.Context, tenantID uuid.UUID, page PageRequest) ([]*ServiceAccount, PageInfo, error)
	CountServiceAccounts(ctx context.Context, tenantID uuid.UUID) (int, error)
	UpdateServiceAccount(ctx context.Context, sa *ServiceAccount, evs ...OutboxEvent) error

	// --- agent principals (tenant-scoped, RLS; synced from events IDN-FR-040) ---
	UpsertAgentPrincipal(ctx context.Context, a *AgentPrincipal, evs ...OutboxEvent) error
	GetAgentPrincipal(ctx context.Context, tenantID uuid.UUID, agentID, version string) (*AgentPrincipal, error)
	ListAgentPrincipals(ctx context.Context, tenantID uuid.UUID) ([]*AgentPrincipal, error)

	// --- signing keys (platform-scoped registry, IDN-FR-050..052) ---
	SaveSigningKey(ctx context.Context, k *SigningKey, evs ...OutboxEvent) error
	ListSigningKeys(ctx context.Context) ([]*SigningKey, error)
	UpdateSigningKey(ctx context.Context, k *SigningKey) error

	// --- idempotency (MASTER-FR-025) ---
	GetIdempotency(ctx context.Context, tenantID uuid.UUID, key string) (*IdempotencyRecord, error)
	PutIdempotency(ctx context.Context, rec *IdempotencyRecord) error

	// --- outbox ---
	// AppendOutbox writes standalone events (e.g. audit denials) outside a
	// mutation transaction.
	AppendOutbox(ctx context.Context, evs ...OutboxEvent) error
	// ListOutbox returns unpublished events, oldest first (poller + tests).
	ListOutbox(ctx context.Context, limit int) ([]*OutboxEvent, error)
	MarkOutboxPublished(ctx context.Context, eventIDs []uuid.UUID, at time.Time) error

	// --- commercial: plan catalog (platform-scoped, no RLS; CPL-FR-001) ---
	// CreatePlan persists the plan row and its version-1 default entitlements
	// in one transaction.
	CreatePlan(ctx context.Context, p *Plan, entitlements []PlanEntitlement) error
	GetPlan(ctx context.Context, key string) (*Plan, error)
	ListPlans(ctx context.Context) ([]*Plan, error)
	// UpdatePlan persists metadata changes and, when entitlements is non-nil,
	// the new versioned default set (CPL-FR-002: never mutates a prior
	// version's rows, so existing tenant_plan snapshots are unaffected).
	UpdatePlan(ctx context.Context, p *Plan, entitlements []PlanEntitlement) error
	ListPlanEntitlements(ctx context.Context, planKey string, planVersion int) ([]PlanEntitlement, error)

	// --- commercial: tenant plan assignment + overrides (tenant-scoped, RLS;
	// CPL-FR-002/010) ---
	// AssignTenantPlan upserts the tenant's single tenant_plan row (snapshot
	// semantics) and enqueues an entitlements_flat recompute.
	AssignTenantPlan(ctx context.Context, tp *TenantPlan, evs ...OutboxEvent) error
	GetTenantPlan(ctx context.Context, tenantID uuid.UUID) (*TenantPlan, error)
	UpsertEntitlementOverride(ctx context.Context, o *TenantEntitlementOverride, evs ...OutboxEvent) error
	DeleteEntitlementOverride(ctx context.Context, tenantID uuid.UUID, kind EntitlementKind, key string, evs ...OutboxEvent) error
	ListEntitlementOverrides(ctx context.Context, tenantID uuid.UUID) ([]TenantEntitlementOverride, error)

	// --- commercial: tenant commercial-state (columns on tenants; CPL-FR-020) ---
	// TransitionTenantCommercial is a compare-and-set change guarded by
	// CanTransitionCommercial, mirroring TransitionTenant. profile is the
	// tenant's TenantProfile (DSP-FR-003 non-convertibility): callers already
	// hold the tenant record (via GetTenant) so this never requires an extra
	// round-trip to look it up.
	TransitionTenantCommercial(ctx context.Context, id uuid.UUID, profile TenantProfile, from, to CommercialState, evs ...OutboxEvent) error

	// --- commercial: entitlements_flat projection dirty queue (CPL-FR-011),
	// same ClaimDirty/SKIP LOCKED shape as rbac-service's projection_dirty ---
	ClaimCommercialDirty(ctx context.Context, workerID string, batch int, visibility time.Duration) ([]CommercialDirtyClaim, error)
	DeleteCommercialDirty(ctx context.Context, ids []int64) error

	// --- commercial: trial lifecycle (tenant-scoped commercial columns +
	// trial_events, RLS-exempt like tenants itself; BRD 66 slice 2,
	// CPL-FR-020..023) ---

	// StartTrial atomically (one transaction): CAS commercial_state
	// none|suspended_commercial->trial (CanTransitionCommercial-guarded, so an
	// illegal `from` still surfaces as 409 CONFLICT exactly like
	// TransitionTenantCommercial), sets trial_started_at/trial_ends_at,
	// inserts the trial_events row, persists evs, and marks commercial_dirty
	// (CPL-FR-021, US-3).
	StartTrial(ctx context.Context, id uuid.UUID, profile TenantProfile, startedAt, endsAt time.Time, tev TrialEvent, evs ...OutboxEvent) error
	// ExtendTrial atomically: requires commercial_state=trial (CAS no-op guard
	// -- fails CONFLICT if the tenant isn't currently on a trial), updates
	// trial_ends_at, inserts the trial_events row, persists evs (CPL-FR-021,
	// "extends with reason (audited)" -- audited via the trial_events row;
	// per BRD §6's closed topic list there is no bus event for extend).
	ExtendTrial(ctx context.Context, id uuid.UUID, newEndsAt time.Time, tev TrialEvent, evs ...OutboxEvent) error
	// ConvertTrial atomically: CAS commercial_state from->active
	// (CanTransitionCommercial-guarded; `from` is trial or
	// suspended_commercial per AC-2's "conversion after expiry is one API
	// call"), upserts tenant_plan to the target snapshot, clears
	// trial_ends_at, inserts the trial_events row, persists evs (CPL-FR-021).
	ConvertTrial(ctx context.Context, id uuid.UUID, profile TenantProfile, from CommercialState, tp TenantPlan, tev TrialEvent, evs ...OutboxEvent) error
	// SweepExpireTrial atomically: CAS commercial_state trial->
	// suspended_commercial. If the row is no longer `trial` (a prior sweep
	// pass already transitioned it -- e.g. after a leader handoff mid-batch),
	// this is a NO-OP (transitioned=false, err=nil) rather than CONFLICT --
	// CPL-NFR-003's exactly-once semantics rely on this being silent, not an
	// error the caller must special-case. On an actual transition, inserts
	// the trial_events(expired) row and persists evs (design doc "Trial sweep
	// job" step 2/3).
	SweepExpireTrial(ctx context.Context, id uuid.UUID, profile TenantProfile, now time.Time, tev TrialEvent, evs ...OutboxEvent) (transitioned bool, err error)
	// InsertTrialEvent inserts a trial_events row with no commercial_state
	// change, persisting evs in the same transaction (used by the sweep's
	// CPL-FR-023 threshold-event emission).
	InsertTrialEvent(ctx context.Context, tev TrialEvent, evs ...OutboxEvent) error
	// ListExpiredTrials lists commercial_state=trial tenants whose
	// trial_ends_at <= asOf (design doc "Trial sweep job" step 1, indexed on
	// (commercial_state, trial_ends_at)).
	ListExpiredTrials(ctx context.Context, asOf time.Time, limit int) ([]*Tenant, error)
	// ListTrialsForThreshold lists commercial_state=trial tenants whose
	// trial_ends_at falls within (asOf, windowEnd] AND that have no existing
	// trial_events row of eventType yet -- the CPL-FR-023 dedup query (design
	// doc: "no trial_events row of type ending_T14/etc already exists for
	// this tenant").
	ListTrialsForThreshold(ctx context.Context, eventType string, asOf, windowEnd time.Time, limit int) ([]*Tenant, error)
	// ListTrialEvents returns a tenant's trial_events history, newest first
	// (US-4 "no surprises" / operator visibility; also the test-verification
	// seam for sweep idempotency and threshold dedup).
	ListTrialEvents(ctx context.Context, tenantID uuid.UUID) ([]TrialEvent, error)
}

// CommercialDirtyClaim is one claimed batch of commercial_dirty rows for a
// single tenant (the entitlements_flat projection has no per-user dimension,
// so unlike rbac's DirtyClaim there is no user grouping).
type CommercialDirtyClaim struct {
	TenantID       uuid.UUID
	IDs            []int64
	OldestEnqueued time.Time
}

// UserFilter narrows ListUsers. IDs is the `filter[id]` batch-hydration
// filter (comma-separated ids on the wire): empty means "no id filter";
// non-empty returns only users whose id is in the set (bff-graphql sends up
// to 100 ids per call to hydrate nested User fields, BFF-FR-030/031).
// Status, when set (e.g. "active"), returns only users in that lifecycle
// state — used by the member-safe assignable-users listing so a deactivated
// or not-yet-activated user is never offered as a case assignee.
type UserFilter struct {
	IDs    []uuid.UUID
	Status string
}

// TenantFilter per MASTER-FR-023 (only indexed fields are filterable).
type TenantFilter struct {
	Status  string
	CellID  string
	Cloud   string
	Profile string // DSP-FR-013: the TTL reaper lists profile=demo tenants
}

// PlatformAdmin is a first-class, cross-tenant platform operator. It lives in a
// platform-scoped (RLS-exempt) registry — NOT the per-tenant rbac "Admin" role.
// A user matched here (by sub or email) has the platform scopes + platform_admin
// claim injected at login.
type PlatformAdmin struct {
	ID        uuid.UUID `json:"id"`
	UserSub   string    `json:"user_sub,omitempty"`
	Email     string    `json:"email"`
	GrantedBy string    `json:"granted_by,omitempty"`
	GrantedAt time.Time `json:"granted_at"`
}

// SigningKey is the platform key registry row (IDN-FR-050..052).
// Private material never lands here: LocalSigner keeps it in memory (dev),
// Vault keeps it in transit (prod, vault_ref).
type SigningKey struct {
	KID          string     `json:"kid"`
	Alg          string     `json:"alg"`
	VaultRef     string     `json:"vault_ref,omitempty"`
	PublicKeyPEM string     `json:"public_key_pem"`
	NotBefore    time.Time  `json:"not_before"` // published >=10 min before use (IDN-FR-052)
	RetiredAt    *time.Time `json:"retired_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// IdempotencyRecord stores a completed POST response for 24h replay
// (MASTER-FR-025).
type IdempotencyRecord struct {
	TenantID    uuid.UUID
	Key         string
	RequestHash string
	Status      int
	Body        []byte
	CreatedAt   time.Time
}

// IdempotencyTTL per MASTER-FR-025.
const IdempotencyTTL = 24 * time.Hour

// ProvisioningStep is one persisted step record of a provisioning /
// deprovisioning workflow (provisioning_runs table, IDN-FR-006/007).
type ProvisioningStep struct {
	ID               uuid.UUID  `json:"id"`
	TenantID         uuid.UUID  `json:"tenant_id"`
	WorkflowID       string     `json:"workflow_id"`
	StepIndex        int        `json:"step_index"`
	StepName         string     `json:"step_name"`
	Status           StepStatus `json:"status"`
	Attempt          int        `json:"attempt"`
	Error            string     `json:"error,omitempty"`
	CompensationName string     `json:"compensation,omitempty"` // recorded comp path (AC-2)
	StartedAt        *time.Time `json:"started_at,omitempty"`
	FinishedAt       *time.Time `json:"finished_at,omitempty"`
}

type StepStatus string

const (
	StepPending     StepStatus = "pending"
	StepRunning     StepStatus = "running"
	StepSucceeded   StepStatus = "succeeded"
	StepFailed      StepStatus = "failed"
	StepCompensated StepStatus = "compensated"
)
