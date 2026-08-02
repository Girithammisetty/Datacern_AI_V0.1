// Package jobs holds usage-service's periodic workers: rollup refresh, budget
// sweep, daily anomaly scan, provider-bill reconciliation and retention
// enforcement (USG-FR-020/021/022/050/070). They are real background loops
// driven from cmd/server; the scan logic here is unit-testable against the
// store.
package jobs

import (
	"bytes"
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/usage-service/internal/anomaly"
	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/recon"
	"github.com/datacern-ai/usage-service/internal/store"
)

// Runner bundles the store the jobs act on.
type Runner struct {
	Store *store.PG
	Log   *slog.Logger

	// Bills is the provider-bill CSV drop store (USG-FR-070). Nil is a valid,
	// intentional state (no MINIO_ENDPOINT configured, dev/demo only):
	// Reconcile then no-ops rather than erroring, matching cmd/server's loud
	// startup warning that the variance-block gate stays inert until a real
	// bucket is wired.
	Bills recon.BillStore
	// BillPrefix is the object-storage prefix bills are listed under. Empty
	// defaults to "bills/".
	BillPrefix string

	// Pusher forwards a closed BillingPeriod to an external rating system
	// (Stripe, …) — slice 4 of the value-metering-billing-export design
	// (§2.8). It is always non-nil: BuildPusher returns an UnconfiguredPusher
	// (honest typed failure, never a fake "pushed") until STRIPE_API_KEY is
	// set, so the (slice-3) close job can call Push unconditionally and let the
	// file export stay the source of truth (VMB-FR-022/AC-6). Held here as the
	// designated call site; the close job that invokes it is not built yet.
	Pusher domain.BillingPusher
}

func (r *Runner) log() *slog.Logger {
	if r.Log != nil {
		return r.Log
	}
	return slog.Default()
}

// RefreshRollups recomputes rollups for buckets touched in the last 49h
// (covers 48h late events, USG-FR-014/020).
func (r *Runner) RefreshRollups(ctx context.Context) error {
	return r.Store.RefreshRollups(ctx, time.Now().Add(-49*time.Hour))
}

// SweepBudgets re-evaluates every active budget (rollup-driven path + BR-12
// fallback, USG-FR-031).
func (r *Runner) SweepBudgets(ctx context.Context) error {
	tenants, err := r.Store.TenantsWithBudgets(ctx)
	if err != nil {
		return err
	}
	for _, t := range tenants {
		if err := r.Store.EvaluateAll(ctx, t); err != nil {
			r.log().Warn("budget sweep failed", "tenant", t, "err", err)
		}
	}
	return nil
}

// EnforceRetention applies per-tier retention (USG-FR-022).
func (r *Runner) EnforceRetention(ctx context.Context) error {
	return r.Store.EnforceRetention(ctx, time.Now())
}

// AnomalyScan runs z-score detection for `day` (a date) across every tenant and
// meter with a ≥ 28-day trailing baseline (min 7 days) — USG-FR-050. First 7
// days of a new series are suppressed (BR-14).
func (r *Runner) AnomalyScan(ctx context.Context, day time.Time) (int, error) {
	day = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
	tenants, err := r.Store.TenantsWithUsage(ctx)
	if err != nil {
		return 0, err
	}
	detected := 0
	for _, t := range tenants {
		meters, err := r.Store.MetersWithUsage(ctx, t)
		if err != nil {
			r.log().Warn("anomaly meters lookup failed", "tenant", t, "err", err)
			continue
		}
		for _, mk := range meters {
			n, err := r.scanOne(ctx, t, mk, day)
			if err != nil {
				r.log().Warn("anomaly scan failed", "tenant", t, "meter", mk, "err", err)
				continue
			}
			detected += n
		}
	}
	return detected, nil
}

func (r *Runner) scanOne(ctx context.Context, tenant uuid.UUID, meter string, day time.Time) (int, error) {
	from := day.AddDate(0, 0, -28)
	to := day
	totals, err := r.Store.DailyTotals(ctx, tenant, meter, from, to)
	if err != nil {
		return 0, err
	}
	observed := totals[day.Format("2006-01-02")]
	var history []float64
	for i := 1; i <= 28; i++ {
		d := day.AddDate(0, 0, -i).Format("2006-01-02")
		if v, ok := totals[d]; ok {
			history = append(history, v)
		}
	}
	res := anomaly.ZScore(observed, history, 7)
	if !res.Enough {
		return 0, nil // fewer than 7 days of history: skip (BR-14 new-series)
	}
	if math.Abs(res.Z) < 3 {
		return 0, nil
	}
	a := domain.Anomaly{
		TenantID: tenant, MeterKey: meter, Day: day,
		Observed: res.Observed, Mean: res.Mean, Stddev: res.Stddev, Z: res.Z,
	}
	_, created, err := r.Store.RecordAnomaly(ctx, a)
	if err != nil {
		return 0, err
	}
	if created {
		return 1, nil
	}
	return 0, nil
}

// Reconcile scans the provider-bill-drop prefix for CSV exports and, for
// every (provider, month) bill object found, compares metered totals against
// the billed quantities and upserts the reconciliation result (USG-FR-070).
// A variance beyond threshold marks the month blocking (USG-FR-071) — this is
// the job that makes that gate live; before this was wired nothing ever
// called it and the gate's underlying status stayed at its pending zero-value
// forever. Idempotent: re-scanning the same object re-upserts the same
// (month, provider) row (store.UpsertReconciliation's ON CONFLICT), so a slow
// or repeated tick is harmless. Returns the number of bill objects processed.
func (r *Runner) Reconcile(ctx context.Context) (int, error) {
	if r.Bills == nil {
		return 0, nil
	}
	prefix := r.BillPrefix
	if prefix == "" {
		prefix = "bills/"
	}
	objs, err := r.Bills.List(ctx, prefix)
	if err != nil {
		return 0, err
	}
	processed := 0
	for _, o := range objs {
		provider, month, ok := recon.ParseBillKey(prefix, o.Key)
		if !ok {
			r.log().Warn("reconciliation: skipping unrecognized bill key", "key", o.Key)
			continue
		}
		if err := r.reconcileOne(ctx, provider, month, o.Key); err != nil {
			r.log().Warn("reconciliation failed", "provider", provider, "month", month, "key", o.Key, "err", err)
			continue
		}
		processed++
	}
	return processed, nil
}

func (r *Runner) reconcileOne(ctx context.Context, provider, month, key string) error {
	data, err := r.Bills.Get(ctx, key)
	if err != nil {
		return err
	}
	billed, err := recon.ParseBillCSV(bytes.NewReader(data))
	if err != nil {
		return err
	}
	metered, err := r.Store.MeteredMonthly(ctx, month)
	if err != nil {
		return err
	}
	lines, blocking := recon.Compute(metered, billed)
	status := domain.ReconMatched
	var varianceMeters []map[string]any
	if blocking {
		status = domain.ReconVariance
		for _, l := range lines {
			if l.Blocking {
				varianceMeters = append(varianceMeters, map[string]any{
					"meter_key": l.MeterKey, "metered": l.Metered, "billed": l.Billed, "variance_pct": l.VariancePct,
				})
			}
		}
	}
	rec := domain.Reconciliation{Month: month, Provider: provider, Status: status, ReportURI: key}
	_, err = r.Store.UpsertReconciliation(ctx, rec, map[string]any{"lines": lines, "source_key": key}, varianceMeters)
	return err
}
