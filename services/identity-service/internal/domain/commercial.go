// Commercial plane data model (BRD 66 slice 1): the plan catalog, per-tenant
// plan assignment, entitlement overrides, and the effective-entitlement
// resolution CPL-FR-010 describes ("plan defaults, overrides win by
// kind+key"). See docs/initiatives/commercial-plane.md §2 for the full design.
package domain

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// EntitlementKind enumerates the v1 entitlement kinds (CPL-FR-010).
type EntitlementKind string

const (
	KindPackSKU        EntitlementKind = "pack_sku"
	KindMeterAllowance EntitlementKind = "meter_allowance"
	KindSeatCap        EntitlementKind = "seat_cap"
	KindWorkspaceCap   EntitlementKind = "workspace_cap"
	KindFeature        EntitlementKind = "feature"
)

// ValidEntitlementKinds gates every kind field on write paths (plan defaults
// and tenant overrides alike).
var ValidEntitlementKinds = map[EntitlementKind]bool{
	KindPackSKU: true, KindMeterAllowance: true, KindSeatCap: true, KindWorkspaceCap: true, KindFeature: true,
}

// Provenance values for the effective-entitlements response (CPL-FR-011).
const (
	ProvenancePlanDefault = "plan_default"
	ProvenanceOverride    = "override"
)

// ValidPlanStatuses gates Plan.Status.
var ValidPlanStatuses = map[string]bool{"active": true, "deprecated": true}

// planKeyRe: lowercase, digits, hyphens, matching the seeded keys
// (internal-demo, design-partner, pilot, enterprise) but extensible
// (CPL-FR-001 "no tenant-defined plans" -- keys are still platform-chosen,
// just not restricted to exactly the seeded four).
var planKeyRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,63}$`)

// ValidatePlanKey rejects anything that isn't a clean, URL/SQL-safe key.
func ValidatePlanKey(key string) error {
	if !planKeyRe.MatchString(key) {
		return EValidation("invalid plan key",
			FieldError{Field: "key", Message: "must match ^[a-z][a-z0-9-]{1,63}$"})
	}
	return nil
}

// Plan is a platform-defined commercial plan (CPL-FR-001). Platform-scoped,
// RLS-exempt; CRUD gated to requireSuperAdmin (platform.plan.manage scope
// label, enforced by the existing middleware -- see server.go wiring).
type Plan struct {
	Key              string    `json:"key"`
	Name             string    `json:"name"`
	Description      string    `json:"description"`
	TrialDaysDefault *int      `json:"trial_days_default,omitempty"`
	Status           string    `json:"status"` // active|deprecated
	Version          int       `json:"version"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// PlanEntitlement is one default entitlement row pinned to a plan version
// (CPL-FR-002): changing a plan's defaults bumps Plan.Version and inserts a
// new set of rows, never mutating rows at a prior version.
type PlanEntitlement struct {
	ID          uuid.UUID       `json:"id"`
	PlanKey     string          `json:"plan_key"`
	PlanVersion int             `json:"plan_version"`
	Kind        EntitlementKind `json:"kind"`
	Key         string          `json:"key"`
	Value       map[string]any  `json:"value,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
}

// TenantPlan is the tenant->plan assignment (CPL-FR-002): one row per tenant,
// snapshotting the plan version at attach time. Tenant-scoped, RLS.
type TenantPlan struct {
	TenantID            uuid.UUID `json:"tenant_id"`
	PlanKey             string    `json:"plan_key"`
	PlanVersionSnapshot int       `json:"plan_version_snapshot"`
	AssignedAt          time.Time `json:"assigned_at"`
	AssignedBy          string    `json:"assigned_by"`
}

// TenantEntitlementOverride shadows (or adds to) a tenant's plan defaults
// (CPL-FR-010). Tenant-scoped, RLS.
type TenantEntitlementOverride struct {
	ID        uuid.UUID       `json:"id"`
	TenantID  uuid.UUID       `json:"tenant_id"`
	Kind      EntitlementKind `json:"kind"`
	Key       string          `json:"key"`
	Value     map[string]any  `json:"value,omitempty"`
	GrantedBy string          `json:"granted_by"`
	GrantedAt time.Time       `json:"granted_at"`
	Reason    string          `json:"reason,omitempty"`
}

// EffectiveEntitlement is one row of the effective set returned by
// GET /tenants/{id}/entitlements (CPL-FR-011) and materialized into the
// entitlements_flat projection.
type EffectiveEntitlement struct {
	Kind       EntitlementKind `json:"kind"`
	Key        string          `json:"key"`
	Value      map[string]any  `json:"value,omitempty"`
	Provenance string          `json:"provenance"` // plan_default|override
}

// EffectiveSet is the full response shape for CPL-FR-011: the effective
// entitlements plus the plan/commercial-state context they were resolved
// against. Shared by the HTTP handler and the entitlements_flat projection
// worker so both compute from the identical code path.
type EffectiveSet struct {
	TenantID        uuid.UUID               `json:"tenant_id"`
	PlanKey         string                  `json:"plan_key,omitempty"`
	PlanVersion     int                     `json:"plan_version,omitempty"`
	CommercialState CommercialState         `json:"commercial_state"`
	TrialEndsAt     *time.Time              `json:"trial_ends_at,omitempty"`
	Entitlements    []EffectiveEntitlement  `json:"entitlements"`
}

// EntitlementReader abstracts a read of the tenant's entitlements_flat
// projection (CPL-NFR-001: no synchronous identity-service call in the
// request path) so entitlement-gated write paths (CPL-FR-031's seat_cap
// invite gate) are testable without a live Redis, and so this package
// doesn't need to import internal/projection (which itself imports domain --
// an EntitlementReader implementation is instead adapted from
// projection.ReadSet in main.go via EntitlementReaderFunc below).
//
// Contract (CPL-NFR-004's fail-open/fail-closed split): ok=false, err=nil
// means "no projection row for this tenant" (never assigned a plan, or
// overrides only with no matching kind) -- NOT unavailability; it resolves
// to "no cap configured". err!=nil means the projection could not be read AT
// ALL (e.g. Redis unreachable) -- entitlement-gated writes MUST fail closed
// (503 ENTITLEMENT_UNAVAILABLE, EEntitlementUnavailable()) on this case.
type EntitlementReader interface {
	ReadEntitlements(ctx context.Context, tenantID uuid.UUID) (set EffectiveSet, ok bool, err error)
}

// EntitlementReaderFunc adapts a plain func to EntitlementReader (mirrors
// http.HandlerFunc), so main.go can wire projection.ReadSet directly without
// a named adapter type living in internal/projection (which already imports
// domain, so domain importing it back would cycle).
type EntitlementReaderFunc func(ctx context.Context, tenantID uuid.UUID) (EffectiveSet, bool, error)

func (f EntitlementReaderFunc) ReadEntitlements(ctx context.Context, tenantID uuid.UUID) (EffectiveSet, bool, error) {
	return f(ctx, tenantID)
}

type entKey struct {
	Kind EntitlementKind
	Key  string
}

// ResolveEffectiveEntitlements computes the effective entitlement set
// (CPL-FR-010): plan defaults, with overrides winning by (kind, key). An
// override that shadows no plan default is additive (a tenant can be granted
// an entitlement its plan doesn't include at all -- e.g. a negotiated
// contract term). Order is deterministic (plan-default order, then
// override-only keys) for stable API responses and projection diffs.
func ResolveEffectiveEntitlements(defaults []PlanEntitlement, overrides []TenantEntitlementOverride) []EffectiveEntitlement {
	overrideByKey := make(map[entKey]TenantEntitlementOverride, len(overrides))
	for _, o := range overrides {
		overrideByKey[entKey{o.Kind, o.Key}] = o
	}
	seen := make(map[entKey]bool, len(defaults))
	out := make([]EffectiveEntitlement, 0, len(defaults)+len(overrides))
	for _, d := range defaults {
		k := entKey{d.Kind, d.Key}
		seen[k] = true
		if o, ok := overrideByKey[k]; ok {
			out = append(out, EffectiveEntitlement{Kind: o.Kind, Key: o.Key, Value: o.Value, Provenance: ProvenanceOverride})
			continue
		}
		out = append(out, EffectiveEntitlement{Kind: d.Kind, Key: d.Key, Value: d.Value, Provenance: ProvenancePlanDefault})
	}
	for _, o := range overrides {
		k := entKey{o.Kind, o.Key}
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, EffectiveEntitlement{Kind: o.Kind, Key: o.Key, Value: o.Value, Provenance: ProvenanceOverride})
	}
	return out
}

// ValidateEntitlementRef checks a (kind, key) pair as used on both plan
// defaults and tenant overrides.
func ValidateEntitlementRef(kind EntitlementKind, key string) error {
	if !ValidEntitlementKinds[kind] {
		return EValidation("invalid entitlement kind",
			FieldError{Field: "kind", Message: "must be one of pack_sku|meter_allowance|seat_cap|workspace_cap|feature"})
	}
	if strings.TrimSpace(key) == "" {
		return EValidation("entitlement key required", FieldError{Field: "key", Message: "required"})
	}
	return nil
}
