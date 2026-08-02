package jobs

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/usage-service/internal/billing"
	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/store"
)

// Billing period-close job (value-metering-billing-export §2.6). Composes the
// pure helpers (billing.DecideClose / NewBillingPeriod / BuildArtifacts) with
// the store and the pusher. Every step is unit-tested in isolation; this loop
// is the integration point that needs live Postgres + object storage, and is
// exercised by test/integration/billing_close_test.go (auto-skips without
// infra). The file export is written before the DB records it and before any
// provider push — "file path is truth" (VMB-FR-022/AC-6).

// CloseBilling closes one tenant's period if the gate allows. Idempotent: a
// period already closed (and not corrected), not finalized, or with an
// unresolved reconciliation variance is a logged no-op, so a repeated tick or a
// per-replica run is harmless (the advisory lock in the store guards the
// concurrent version insert).
func (r *Runner) CloseBilling(ctx context.Context, tenant uuid.UUID, period string) error {
	finalized, err := r.Store.MonthFinalized(ctx, period)
	if err != nil {
		return err
	}
	reconStatus, err := r.Store.ReconciliationStatus(ctx, period)
	if err != nil {
		return err
	}
	priorVer, err := r.Store.BillingPeriodVersion(ctx, tenant, period)
	if err != nil {
		return err
	}

	// Corrected=false: the correction trigger (usage.month_refinalized / a late
	// adjustment re-opening a closed period at v+1) is a follow-on wiring; a
	// first close at v1 is the path exercised here. DecideClose already returns
	// a no-op for an already-closed, uncorrected period.
	decision := billing.DecideClose(billing.CloseInputs{
		MonthFinalized: finalized, ReconStatus: reconStatus, PriorVersion: priorVer, Corrected: false,
	})
	if !decision.ShouldClose {
		r.log().Debug("billing close skipped", "tenant", tenant, "period", period, "reason", decision.Reason)
		return nil
	}

	lines, err := r.Store.Chargeback(ctx, tenant, period)
	if err != nil {
		return err
	}
	rows := chargebackToRollup(lines)
	rcID, rcVer := rateCardOf(lines)

	op := domain.Op{Tenant: tenant, Actor: domain.Actor{Type: "service", ID: "billing-close"}}
	bp := domain.NewBillingPeriod(tenant, period, decision.Version, rcID, rcVer, time.Now().UTC(), rows)

	art, err := billing.BuildArtifacts(bp)
	if err != nil {
		return err
	}
	// Write the artifacts durably FIRST (file path is truth). Without a store
	// configured, close is DB-only — the keys are recorded but no bytes land
	// (dev/demo); a loud startup warning already flags an unconfigured store.
	if r.Artifacts != nil {
		if err := r.Artifacts.Put(ctx, art.JSONLKey, art.JSONL); err != nil {
			return err
		}
		if err := r.Artifacts.Put(ctx, art.CSVKey, art.CSV); err != nil {
			return err
		}
	}

	// Allowance drawdown (§2.6, entitlements snapshot) is a follow-on; until it
	// is wired, net billable equals gross (no included-allowance offset), never
	// a fabricated discount.
	netBillable := bp.GrossUSD

	if _, err := r.Store.InsertBillingPeriod(ctx, op, bp, netBillable, "billing-close",
		store.NewBillingArtifactKeys(art.JSONLKey, art.JSONLSHA256, art.CSVKey, art.CSVSHA256)); err != nil {
		return err
	}

	// Optional provider push — failure only annotates the export row, never
	// blocks the (already-persisted) close.
	if r.Pusher != nil {
		res, perr := r.Pusher.Push(ctx, bp)
		status, ref := pushOutcome(res, perr)
		if err := r.Store.MarkExportPush(ctx, tenant, period, bp.Version, status, ref); err != nil {
			r.log().Warn("billing export push annotation failed", "tenant", tenant, "period", period, "err", err)
		}
		if perr != nil && !errors.Is(perr, domain.ErrBillingPushNotConfigured) {
			r.log().Warn("billing provider push failed", "tenant", tenant, "period", period, "err", perr)
		}
	}
	r.log().Info("billing period closed", "tenant", tenant, "period", period, "version", bp.Version, "gross_usd", bp.GrossUSD)
	return nil
}

// CloseAllBilling attempts to close `period` for every tenant with usage. Per-
// tenant failures are logged and skipped, never aborting the sweep.
func (r *Runner) CloseAllBilling(ctx context.Context, period string) (int, error) {
	tenants, err := r.Store.TenantsWithUsage(ctx)
	if err != nil {
		return 0, err
	}
	closed := 0
	for _, t := range tenants {
		if err := r.CloseBilling(ctx, t, period); err != nil {
			r.log().Warn("billing close failed", "tenant", t, "period", period, "err", err)
			continue
		}
		closed++
	}
	return closed, nil
}

// PreviousMonth returns the YYYY-MM before `now` (the period a close tick
// targets — the just-ended month, once it is finalized).
func PreviousMonth(now time.Time) string {
	firstOfThis := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	return firstOfThis.AddDate(0, 0, -1).Format("2006-01")
}

// chargebackToRollup maps priced chargeback lines to the RollupRow shape
// NewBillingPeriod aggregates. USD carries the line's total (priced +
// adjustments); unit resolves from the meter catalog.
func chargebackToRollup(lines []store.ChargebackLine) []domain.RollupRow {
	units := domain.CatalogKeys()
	out := make([]domain.RollupRow, 0, len(lines))
	for _, l := range lines {
		total := l.TotalUSD
		unit := ""
		if m, ok := units[l.MeterKey]; ok {
			unit = m.Unit
		}
		out = append(out, domain.RollupRow{
			MeterKey: l.MeterKey, Unit: unit, Quantity: l.Quantity, USD: &total,
		})
	}
	return out
}

// rateCardOf picks the rate card id from the first priced line that carries
// one. rate_card_version is not surfaced by Chargeback today, so it is left 0
// (a follow-on threads the active card's version through); the id is what the
// billing_periods row and the JSONL reference for auditability.
func rateCardOf(lines []store.ChargebackLine) (uuid.UUID, int) {
	for _, l := range lines {
		if l.RateCardID == "" {
			continue
		}
		if id, err := uuid.Parse(l.RateCardID); err == nil {
			return id, 0
		}
	}
	return uuid.Nil, 0
}

// pushOutcome maps a pusher result/error to the persisted pushed_status.
func pushOutcome(res domain.BillingPushResult, err error) (status, reference string) {
	switch {
	case err == nil:
		return domain.PushPushed, res.Reference
	case errors.Is(err, domain.ErrBillingPushNotConfigured):
		return domain.PushNotConfigured, ""
	default:
		return domain.PushFailed, ""
	}
}
