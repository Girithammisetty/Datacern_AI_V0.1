package domain

import (
	"context"
	"time"
)

// LeaseChecker abstracts leader election (§2.5) so DemoReaper's business
// logic is testable without Redis. The production adapter
// (internal/adapters/leaderlease) mirrors services/realtime-hub/internal/
// fanout/lease.go's SET-NX-PX + Lua-CAS pattern -- the one real
// leader-election precedent already proven in this codebase (RTH-FR-042,
// 5s TTL). nil means "always leader": correct for single-replica dev/tests,
// and an honest default rather than a silent no-op (the same pattern a nil
// HealthProber/Prober already uses elsewhere in this package).
type LeaseChecker interface {
	IsLeader() bool
}

// DemoReaper implements DSP-FR-013 (§2.5): a leader-elected, idempotent
// sweep that deprovisions profile=demo tenants past created_at+ttl_days
// through the REAL deprovision saga -- TenantService.Delete's force-destroy
// path (first pass) / Engine.Deprovision retried directly (a tenant already
// `deleting` from a prior partial sweep) -- never cleanup_pack_tenants.py's
// raw-SQL purge. This is the one place the design deliberately does NOT
// generalize existing demo tooling (see docs/initiatives/
// demo-sandbox-poc-mode.md §2.5): a hosted reaper tearing down real
// per-tenant infra must go through the same Terraform-destroy-gated path a
// human operator's `DELETE /tenants/{id}?mode=destroy&force=true` would.
type DemoReaper struct {
	Store   Store
	Tenants *TenantService
	Engine  ProvisioningEngine
	Clock   func() time.Time
	Lease   LeaseChecker
}

func (r *DemoReaper) now() time.Time {
	if r.Clock != nil {
		return r.Clock().UTC()
	}
	return time.Now().UTC()
}

// Sweep lists demo tenants past TTL and reaps each. Returns the number
// actually reaped THIS call (0 when it is not this replica's turn, or when
// nothing is expired yet) and the first hard error encountered LISTING
// tenants; a per-tenant reap failure is swallowed and retried next tick,
// mirroring RunScheduledDeletions' BR-6 "stays deleting, retried next
// sweep" contract exactly. Idempotent (AC-4): once a tenant reaches
// `deleted` it is excluded from every future sweep's candidate list, so
// re-running the reaper against an already-reaped tenant is a true no-op.
func (r *DemoReaper) Sweep(ctx context.Context) (int, error) {
	if r.Lease != nil && !r.Lease.IsLeader() {
		return 0, nil
	}
	tenants, _, err := r.Store.ListTenants(ctx, TenantFilter{Profile: string(ProfileDemo)}, PageRequest{Limit: MaxPageLimit})
	if err != nil {
		return 0, err
	}
	now := r.now()
	actor := Actor{Type: "service", ID: "identity-service-demo-reaper"}
	reaped := 0
	for _, t := range tenants {
		if t.Status == TenantDeleted || t.TTLDays == nil {
			continue
		}
		deadline := t.CreatedAt.Add(time.Duration(*t.TTLDays) * 24 * time.Hour)
		if now.Before(deadline) {
			continue
		}
		if r.reapOne(ctx, t, actor) {
			reaped++
		}
	}
	return reaped, nil
}

// reapOne drives one expired tenant through the real destroy path and
// reports whether it reached `deleted` THIS call. A tenant already
// `deleting` (a prior sweep started the destroy workflow but it hasn't
// finished -- e.g. Async server mode, or a transient Terraform failure)
// retries Engine.Deprovision directly rather than re-transitioning (which
// would 409: TenantDeleting has no self-edge in tenantTransitions).
func (r *DemoReaper) reapOne(ctx context.Context, t *Tenant, actor Actor) bool {
	if t.Status == TenantDeleting {
		_ = r.Engine.Deprovision(ctx, t.ID) // idempotent retry of the destroy steps
	} else if _, err := r.Tenants.Delete(ctx, t.ID, "destroy", true, actor); err != nil {
		return false
	}
	updated, err := r.Store.GetTenant(ctx, t.ID)
	if err != nil || updated.Status != TenantDeleted {
		return false // still deleting (possibly async) -- retried next sweep
	}
	ttl := 0
	if t.TTLDays != nil {
		ttl = *t.TTLDays
	}
	_ = r.Store.AppendOutbox(ctx, NewEvent(EvDemoTenantReaped, t.ID, actor, t.URN(), r.now(), map[string]any{
		"ttl_days": ttl, "created_at": t.CreatedAt,
	}))
	return true
}
