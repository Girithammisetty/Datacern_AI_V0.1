package outbox

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// B6 (BRD 58): the transactional outbox is drained (MarkPublished) but never
// pruned — 20+ outbox tables across the platform grow unboundedly forever, even
// though every published row is already durably delivered. Pruner deletes
// published rows past a retention window, in small batches so it never holds a
// long-running lock on a hot table.
//
// IMPORTANT: every outbox table has RLS (FORCE ROW LEVEL SECURITY) with a
// tenant-scoped policy, so a plain DELETE with no session context matches ZERO
// rows across tenants — not an error, just silently useless (the exact class of
// bug SEC-1 guards against for reads; this is its write-path twin). Each
// service's relay already opens this cross-tenant door by setting a GUC before
// querying (e.g. case-service/query-service/etc: `app.role='platform'`;
// rbac-service: `app.worker='on'`) inside the SAME transaction as the query —
// PruneOnce does the same, so the caller MUST pass the exact GUC name/value
// their service's relay uses (see NewPruner).

// identOK guards against ever interpolating an unsafe table name into SQL —
// Table is always a compile-time constant at call sites, never user input, but
// this is a cheap belt against a future refactor mistake.
var identOK = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Beginner is the pool method this package needs — satisfied by *pgxpool.Pool.
type Beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Pruner periodically deletes rows from a table's timestamp column once
// they're older than Retention. PlatformGUC/PlatformVal are set via
// `set_config` inside the same transaction as the delete, matching whatever
// cross-tenant RLS escape hatch the table's own relay already uses.
type Pruner struct {
	Pool        Beginner
	Table       string
	Column      string // timestamp column to age against; default "published_at"
	PlatformGUC string // e.g. "app.role" (case/chart/query/...) or "app.worker" (rbac)
	PlatformVal string // e.g. "platform" or "on" — whatever that GUC expects
	Retention   time.Duration
	Interval    time.Duration
	Batch       int
	Log         *slog.Logger
}

// NewPruner builds a Pruner for an outbox-shaped table. platformGUC/platformVal
// MUST match the GUC the service's own outbox relay sets for cross-tenant reads
// (grep the service's `withPlatform`/equivalent) — an empty/wrong GUC means RLS
// silently blocks every delete rather than erroring.
func NewPruner(pool Beginner, table, platformGUC, platformVal string) *Pruner {
	return &Pruner{
		Pool:        pool,
		Table:       table,
		Column:      "published_at",
		PlatformGUC: platformGUC,
		PlatformVal: platformVal,
		Retention:   30 * 24 * time.Hour,
		Interval:    time.Hour,
		Batch:       1000,
		Log:         slog.Default(),
	}
}

// Run sweeps on Interval until ctx is cancelled.
func (p *Pruner) Run(ctx context.Context) {
	t := time.NewTicker(p.Interval)
	defer t.Stop()
	for {
		if n, err := p.PruneOnce(ctx); err != nil {
			p.Log.Error("outbox prune failed", "table", p.Table, "err", err)
		} else if n > 0 {
			p.Log.Info("outbox pruned", "table", p.Table, "deleted", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// PruneOnce deletes rows older than Retention in Batch-sized passes (each its
// own transaction, re-asserting the platform GUC) until a pass deletes fewer
// than Batch rows, and returns the total deleted.
func (p *Pruner) PruneOnce(ctx context.Context) (int64, error) {
	col := p.Column
	if col == "" {
		col = "published_at"
	}
	batch := p.Batch
	if batch <= 0 {
		batch = 1000
	}
	if !identOK.MatchString(p.Table) || !identOK.MatchString(col) {
		return 0, fmt.Errorf("outbox: unsafe identifier table=%q column=%q", p.Table, col)
	}
	seconds := int64(p.Retention.Seconds())

	deleteSQL := fmt.Sprintf(
		`DELETE FROM %s WHERE ctid IN (
		   SELECT ctid FROM %s
		   WHERE %s IS NOT NULL AND %s < now() - ($1::text || ' seconds')::interval
		   LIMIT $2
		 )`, p.Table, p.Table, col, col)

	var total int64
	for {
		var n int64
		err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
			if p.PlatformGUC != "" {
				if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, p.PlatformGUC, p.PlatformVal); err != nil {
					return fmt.Errorf("set platform context: %w", err)
				}
			}
			tag, err := tx.Exec(ctx, deleteSQL, seconds, batch)
			if err != nil {
				return err
			}
			n = tag.RowsAffected()
			return nil
		})
		if err != nil {
			return total, err
		}
		total += n
		if n < int64(batch) {
			return total, nil
		}
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		default:
		}
	}
}
