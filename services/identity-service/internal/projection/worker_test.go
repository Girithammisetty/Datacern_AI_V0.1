package projection_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/projection"
)

// fakeLoader is a store-free Loader (mirrors rbac-service's projection unit
// tests, which stub SnapshotLoader rather than standing up Postgres) so
// Worker's claim/recompute/delete/publish orchestration is testable without
// Docker.
type fakeLoader struct {
	mu        sync.Mutex
	dirty     []projection.DirtyClaim
	snapshots map[uuid.UUID]projection.Snapshot
	snapErr   map[uuid.UUID]error
	deleted   [][]int64
}

func newFakeLoader() *fakeLoader {
	return &fakeLoader{snapshots: map[uuid.UUID]projection.Snapshot{}, snapErr: map[uuid.UUID]error{}}
}

func (l *fakeLoader) ClaimDirty(_ context.Context, _ string, batch int, _ time.Duration) ([]projection.DirtyClaim, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.dirty) == 0 {
		return nil, nil
	}
	n := batch
	if n > len(l.dirty) {
		n = len(l.dirty)
	}
	out := l.dirty[:n]
	l.dirty = l.dirty[n:]
	return out, nil
}

func (l *fakeLoader) DeleteDirty(_ context.Context, ids []int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.deleted = append(l.deleted, ids)
	return nil
}

func (l *fakeLoader) Snapshot(_ context.Context, tenantID uuid.UUID) (projection.Snapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.snapErr[tenantID]; err != nil {
		return projection.Snapshot{}, err
	}
	return l.snapshots[tenantID], nil
}

// fakeWriter is an in-memory projection.Writer (the CAS Lua script itself is
// identical to rbac-service's battle-tested projection.casSet and needs a
// live Redis to run — that's the integration tier's job, not this unit test;
// this fake exercises WORKER orchestration, not the Redis write mechanics).
type fakeWriter struct {
	mu        sync.Mutex
	written   []projection.Snapshot
	published []string
	writeErr  error
}

func (w *fakeWriter) Write(_ context.Context, s projection.Snapshot) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.writeErr != nil {
		return w.writeErr
	}
	w.written = append(w.written, s)
	return nil
}

func (w *fakeWriter) PublishInvalidate(_ context.Context, tenant string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.published = append(w.published, tenant)
	return nil
}

func newTestWorker(loader projection.Loader, writer projection.Writer) *projection.Worker {
	w := projection.NewWorker("test-worker", loader, writer)
	w.Interval = time.Millisecond // irrelevant to ProcessOnce, but keep Run() fast if ever used
	return w
}

func TestWorker_ProcessOnce_ClaimsRecomputesAndPublishes(t *testing.T) {
	loader := newFakeLoader()
	tenantA, _ := uuid.NewV7()
	loader.dirty = []projection.DirtyClaim{
		{TenantID: tenantA, IDs: []int64{1, 2}, OldestEnqueued: time.Now().Add(-time.Second)},
	}
	loader.snapshots[tenantA] = projection.Snapshot{
		TenantID: tenantA, Version: 1, CommercialState: domain.CommercialActive,
		Entitlements: []domain.EffectiveEntitlement{{Kind: domain.KindSeatCap, Key: "seats", Provenance: domain.ProvenancePlanDefault}},
	}
	writer := &fakeWriter{}
	w := newTestWorker(loader, writer)

	n, err := w.ProcessOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	if len(writer.written) != 1 || writer.written[0].TenantID != tenantA {
		t.Fatalf("expected 1 write for %s, got %+v", tenantA, writer.written)
	}
	if len(loader.deleted) != 1 || len(loader.deleted[0]) != 2 {
		t.Fatalf("expected the 2 claimed dirty ids deleted, got %+v", loader.deleted)
	}
	if len(writer.published) != 1 || writer.published[0] != tenantA.String() {
		t.Fatalf("expected ent.invalidate published for %s, got %+v", tenantA, writer.published)
	}
}

// TestWorker_ProcessOnce_SnapshotErrorLeavesRowsClaimed: a recompute failure
// must not delete the dirty rows (visibility-timeout re-queue, at-least-once
// -- mirrors rbac's Worker.recomputeUser error handling).
func TestWorker_ProcessOnce_SnapshotErrorLeavesRowsClaimed(t *testing.T) {
	loader := newFakeLoader()
	tenantA, _ := uuid.NewV7()
	loader.dirty = []projection.DirtyClaim{{TenantID: tenantA, IDs: []int64{9}, OldestEnqueued: time.Now()}}
	loader.snapErr[tenantA] = context.DeadlineExceeded
	writer := &fakeWriter{}
	w := newTestWorker(loader, writer)

	n, err := w.ProcessOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("processed = %d, want 0 on snapshot error", n)
	}
	if len(loader.deleted) != 0 {
		t.Fatalf("dirty rows deleted despite snapshot failure: %+v", loader.deleted)
	}
}

// TestWorker_ProcessOnce_WriteErrorLeavesRowsClaimed mirrors the snapshot-
// error case for a Redis write failure.
func TestWorker_ProcessOnce_WriteErrorLeavesRowsClaimed(t *testing.T) {
	loader := newFakeLoader()
	tenantA, _ := uuid.NewV7()
	loader.dirty = []projection.DirtyClaim{{TenantID: tenantA, IDs: []int64{3}, OldestEnqueued: time.Now()}}
	loader.snapshots[tenantA] = projection.Snapshot{TenantID: tenantA}
	writer := &fakeWriter{writeErr: context.DeadlineExceeded}
	w := newTestWorker(loader, writer)

	n, err := w.ProcessOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("processed = %d, want 0 on write error", n)
	}
	if len(loader.deleted) != 0 {
		t.Fatalf("dirty rows deleted despite write failure: %+v", loader.deleted)
	}
}

func TestWorker_ProcessOnce_EmptyQueueIsANoop(t *testing.T) {
	w := newTestWorker(newFakeLoader(), &fakeWriter{})
	n, err := w.ProcessOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("processed = %d, want 0 on an empty queue", n)
	}
}
