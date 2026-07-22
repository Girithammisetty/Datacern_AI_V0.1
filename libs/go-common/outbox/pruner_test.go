package outbox

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeTx is a minimal pgx.Tx: only Exec/Commit/Rollback are ever invoked by
// pgx.BeginFunc + PruneOnce's closure; everything else panics if reached.
type fakeTx struct {
	pgx.Tx
	calls   *[][2]any // (sql, args) pairs, shared with the owning fakeBeginner
	results []int64   // RowsAffected to return per Exec call, in order
	execN   *int
	err     error // if set, the NEXT Exec call returns this error
}

func (f *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	*f.calls = append(*f.calls, [2]any{sql, args})
	if f.err != nil {
		e := f.err
		f.err = nil // only the call that triggers it fails
		return pgconn.CommandTag{}, e
	}
	n := int64(0)
	if *f.execN < len(f.results) {
		n = f.results[*f.execN]
	}
	*f.execN++
	return pgconn.NewCommandTag("DELETE " + itoa(n)), nil
}
func (f *fakeTx) Commit(context.Context) error   { return nil }
func (f *fakeTx) Rollback(context.Context) error { return nil }

// fakeBeginner hands out a fresh fakeTx per Begin call (mirrors PruneOnce
// opening one transaction per batch), sharing the results/call-log slices.
type fakeBeginner struct {
	results  []int64 // one entry per Exec call across ALL transactions, in order
	execN    int
	calls    [][2]any
	firstErr error // returned by Begin/Exec on the first call only, if set
	begins   int
}

func (b *fakeBeginner) Begin(context.Context) (pgx.Tx, error) {
	b.begins++
	return &fakeTx{calls: &b.calls, results: b.results, execN: &b.execN, err: b.firstErr}, nil
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf []byte
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}

// Every real call site sets a PlatformGUC, so every Exec sequence is
// [set_config, DELETE] per transaction/batch.

func TestPruneOnce_SingleBatch(t *testing.T) {
	fb := &fakeBeginner{results: []int64{0 /* set_config */, 42 /* delete */}}
	p := &Pruner{Pool: fb, Table: "outbox", PlatformGUC: "app.role", PlatformVal: "platform", Batch: 1000}
	n, err := p.PruneOnce(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 42 {
		t.Fatalf("want 42 deleted, got %d", n)
	}
	if fb.begins != 1 {
		t.Fatalf("want 1 transaction, got %d", fb.begins)
	}
}

func TestPruneOnce_MultipleBatches(t *testing.T) {
	// Two full batches (5,5) then a partial (2) -> 3 transactions.
	fb := &fakeBeginner{results: []int64{0, 5, 0, 5, 0, 2}}
	p := &Pruner{Pool: fb, Table: "outbox", PlatformGUC: "app.role", PlatformVal: "platform", Batch: 5}
	n, err := p.PruneOnce(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 12 {
		t.Fatalf("want 12 total deleted, got %d", n)
	}
	if fb.begins != 3 {
		t.Fatalf("want 3 transactions, got %d", fb.begins)
	}
}

func TestPruneOnce_NothingToPrune(t *testing.T) {
	fb := &fakeBeginner{results: []int64{0, 0}}
	p := &Pruner{Pool: fb, Table: "outbox", PlatformGUC: "app.role", PlatformVal: "platform", Batch: 1000}
	n, err := p.PruneOnce(context.Background())
	if err != nil || n != 0 {
		t.Fatalf("want (0, nil), got (%d, %v)", n, err)
	}
}

func TestPruneOnce_ExecError(t *testing.T) {
	fb := &fakeBeginner{firstErr: errors.New("db exploded")}
	p := &Pruner{Pool: fb, Table: "outbox", PlatformGUC: "app.role", PlatformVal: "platform", Batch: 1000}
	_, err := p.PruneOnce(context.Background())
	if err == nil {
		t.Fatal("expected error to propagate")
	}
}

func TestPruneOnce_RejectsUnsafeTableName(t *testing.T) {
	fb := &fakeBeginner{results: []int64{0, 0}}
	for _, bad := range []string{"outbox; DROP TABLE users", "out box", "1outbox", "", "outbox--"} {
		p := &Pruner{Pool: fb, Table: bad, PlatformGUC: "app.role", PlatformVal: "platform", Batch: 1000}
		if _, err := p.PruneOnce(context.Background()); err == nil {
			t.Fatalf("table %q should have been rejected", bad)
		}
	}
	if fb.begins != 0 {
		t.Fatalf("no transaction should open for an unsafe identifier, got %d", fb.begins)
	}
}

func TestPruneOnce_RejectsUnsafeColumnName(t *testing.T) {
	fb := &fakeBeginner{results: []int64{0, 0}}
	p := &Pruner{Pool: fb, Table: "outbox", Column: "ts; DROP TABLE x", PlatformGUC: "app.role", PlatformVal: "platform", Batch: 1000}
	if _, err := p.PruneOnce(context.Background()); err == nil {
		t.Fatal("unsafe column name should be rejected")
	}
}

func TestPruneOnce_SetsThePlatformGUCBeforeDeleting(t *testing.T) {
	fb := &fakeBeginner{results: []int64{0, 7}}
	p := &Pruner{Pool: fb, Table: "outbox", PlatformGUC: "app.worker", PlatformVal: "on", Batch: 1000}
	if _, err := p.PruneOnce(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fb.calls) != 2 {
		t.Fatalf("want 2 Exec calls (set_config + delete), got %d", len(fb.calls))
	}
	setSQL, setArgs := fb.calls[0][0].(string), fb.calls[0][1].([]any)
	if setSQL != `SELECT set_config($1, $2, true)` {
		t.Fatalf("first call should set the GUC, got: %s", setSQL)
	}
	if setArgs[0] != "app.worker" || setArgs[1] != "on" {
		t.Fatalf("GUC name/value wrong: %v", setArgs)
	}
	delSQL, _ := fb.calls[1][0].(string), fb.calls[1][1]
	if delSQL == setSQL {
		t.Fatal("second call should be the DELETE, not another set_config")
	}
}

func TestPruneOnce_NoGUCSkipsSetConfig(t *testing.T) {
	// A table with no cross-tenant RLS gate (PlatformGUC empty) issues only the
	// DELETE — never silently blocked by RLS with no explanation, and never
	// wastes a round-trip on an unnecessary set_config.
	fb := &fakeBeginner{results: []int64{3}}
	p := &Pruner{Pool: fb, Table: "outbox", Batch: 1000} // no PlatformGUC set
	n, err := p.PruneOnce(context.Background())
	if err != nil || n != 3 {
		t.Fatalf("want (3, nil), got (%d, %v)", n, err)
	}
	if len(fb.calls) != 1 {
		t.Fatalf("want exactly 1 Exec call (delete only), got %d", len(fb.calls))
	}
}

func TestPruneOnce_DefaultsApplied(t *testing.T) {
	fb := &fakeBeginner{results: []int64{0}}
	p := &Pruner{Pool: fb, Table: "outbox"} // no Column/Batch set
	if _, err := p.PruneOnce(context.Background()); err != nil {
		t.Fatalf("unexpected error with zero-value Column/Batch: %v", err)
	}
	_, args := fb.calls[0][0].(string), fb.calls[0][1].([]any)
	if args[1] != 1000 {
		t.Fatalf("want default batch 1000, got %v", args[1])
	}
}

func TestNewPruner_Defaults(t *testing.T) {
	p := NewPruner(&fakeBeginner{}, "outbox", "app.role", "platform")
	if p.Table != "outbox" || p.Column != "published_at" || p.Batch != 1000 {
		t.Fatalf("unexpected defaults: %+v", p)
	}
	if p.PlatformGUC != "app.role" || p.PlatformVal != "platform" {
		t.Fatalf("platform GUC not threaded through: %+v", p)
	}
}
