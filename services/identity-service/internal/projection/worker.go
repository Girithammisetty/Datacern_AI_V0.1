package projection

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// Snapshot is one tenant's computed entitlements_flat payload.
type Snapshot struct {
	TenantID        uuid.UUID
	Version         int64
	ComputedAt      time.Time
	PlanKey         string
	PlanVersion     int
	CommercialState domain.CommercialState
	TrialEndsAt     *time.Time
	Entitlements    []domain.EffectiveEntitlement
}

// DirtyClaim mirrors domain.CommercialDirtyClaim without importing the store
// package, so the worker stays store-agnostic and unit-testable (mirrors
// rbac-service's projection.DirtyBatch).
type DirtyClaim struct {
	TenantID       uuid.UUID
	IDs            []int64
	OldestEnqueued time.Time
}

// Loader is the store-facing port the worker depends on (kept small and
// store-agnostic, mirroring rbac-service's projection.SnapshotLoader).
type Loader interface {
	ClaimDirty(ctx context.Context, workerID string, batch int, visibility time.Duration) ([]DirtyClaim, error)
	DeleteDirty(ctx context.Context, ids []int64) error
	Snapshot(ctx context.Context, tenantID uuid.UUID) (Snapshot, error)
}

// StoreLoader adapts domain.Store + domain.CommercialService into a Loader.
// The projection version is a wall-clock nanosecond timestamp rather than a
// DB sequence (unlike rbac's projection_version_seq): entitlements have no
// per-user fan-out to keep monotonic across, and a single writer per tenant
// at a time (through the dirty-queue claim) makes wall-clock ordering
// sufficient for the CAS write to converge correctly.
type StoreLoader struct {
	Store      domain.Store
	Commercial *domain.CommercialService
	Now        func() time.Time
}

func (l StoreLoader) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

func (l StoreLoader) ClaimDirty(ctx context.Context, workerID string, batch int, visibility time.Duration) ([]DirtyClaim, error) {
	rows, err := l.Store.ClaimCommercialDirty(ctx, workerID, batch, visibility)
	if err != nil {
		return nil, err
	}
	out := make([]DirtyClaim, 0, len(rows))
	for _, r := range rows {
		out = append(out, DirtyClaim{TenantID: r.TenantID, IDs: r.IDs, OldestEnqueued: r.OldestEnqueued})
	}
	return out, nil
}

func (l StoreLoader) DeleteDirty(ctx context.Context, ids []int64) error {
	return l.Store.DeleteCommercialDirty(ctx, ids)
}

func (l StoreLoader) Snapshot(ctx context.Context, tenantID uuid.UUID) (Snapshot, error) {
	eff, err := l.Commercial.EffectiveEntitlements(ctx, tenantID)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		TenantID: tenantID, Version: l.now().UTC().UnixNano(), ComputedAt: l.now().UTC(),
		PlanKey: eff.PlanKey, PlanVersion: eff.PlanVersion, CommercialState: eff.CommercialState,
		TrialEndsAt: eff.TrialEndsAt, Entitlements: eff.Entitlements,
	}, nil
}

// Writer is the projection-write port the worker depends on (satisfied by
// *RedisWriter in production); kept as a small interface so the worker's
// claim/recompute/write/delete/publish orchestration is unit-testable
// against a fake without a live Redis.
type Writer interface {
	Write(ctx context.Context, snap Snapshot) error
	PublishInvalidate(ctx context.Context, tenant string) error
}

// Worker recomputes entitlements_flat off the commercial_dirty queue
// (CPL-FR-011): claims dirty rows with SKIP LOCKED + a visibility timeout
// (crashed workers' claims are reclaimed, at-least-once), recomputes per
// tenant, writes Redis, then publishes ent.invalidate and deletes the claimed
// rows. Structurally identical to rbac-service's projection.Worker.
type Worker struct {
	ID         string
	Loader     Loader
	Writer     Writer
	Interval   time.Duration // poll interval when the queue is empty
	Batch      int
	Visibility time.Duration
	Log        *slog.Logger
}

func NewWorker(id string, loader Loader, writer Writer) *Worker {
	return &Worker{
		ID: id, Loader: loader, Writer: writer,
		Interval: 500 * time.Millisecond, Batch: 128, Visibility: 30 * time.Second,
		Log: slog.Default(),
	}
}

// Run polls until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	for {
		n, err := w.ProcessOnce(ctx)
		if err != nil && ctx.Err() == nil {
			w.Log.Error("commercial projection worker pass failed", "err", err)
		}
		if ctx.Err() != nil {
			return
		}
		if n == 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(w.Interval):
			}
		}
	}
}

// ProcessOnce claims and processes one batch; returns tenants recomputed.
func (w *Worker) ProcessOnce(ctx context.Context) (int, error) {
	claims, err := w.Loader.ClaimDirty(ctx, w.ID, w.Batch, w.Visibility)
	if err != nil {
		return 0, err
	}
	processed := 0
	for _, c := range claims {
		snap, err := w.Loader.Snapshot(ctx, c.TenantID)
		if err != nil {
			// Leave rows claimed; the visibility timeout re-queues them.
			w.Log.Error("commercial projection snapshot failed", "tenant", c.TenantID, "err", err)
			continue
		}
		if err := w.Writer.Write(ctx, snap); err != nil {
			w.Log.Error("commercial projection write failed", "tenant", c.TenantID, "err", err)
			continue
		}
		if err := w.Loader.DeleteDirty(ctx, c.IDs); err != nil {
			w.Log.Error("commercial projection dirty-delete failed", "tenant", c.TenantID, "err", err)
			continue
		}
		if err := w.Writer.PublishInvalidate(ctx, c.TenantID.String()); err != nil {
			w.Log.Warn("ent.invalidate publish failed", "tenant", c.TenantID, "err", err)
		}
		processed++
	}
	return processed, nil
}
