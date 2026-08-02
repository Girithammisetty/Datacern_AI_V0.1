package domain

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
)

// A closed billing period and the seam that hands it to an external rating/
// billing system (Stripe, Lago, …). This is the in-memory shape slice 3's
// close job produces and slice 4's pusher consumes (see
// docs/initiatives/value-metering-billing-export.md §2.6/§2.8). The file/CSV
// export is the source of truth (VMB-FR-022/AC-6): pushing to a provider is an
// OPTIONAL, honestly-failing secondary path — a period is fully closed and
// exported whether or not a pusher is configured, and a pusher that isn't
// wired returns a typed error, never a fabricated "pushed" status.

// BillingLine is one invoice-line summary for a period: a meter's total
// quantity and its rate-card-priced gross. Stripe's own meter/price config
// does the money in the provider (usage-service "never touches money" — it
// sends quantities); GrossUSD is carried for the CSV/JSONL export and for
// operator reconciliation, not for the provider push.
type BillingLine struct {
	MeterKey        string  `json:"meter_key"`
	Unit            string  `json:"unit"`
	Quantity        float64 `json:"quantity"`
	PricePerUnitUSD float64 `json:"price_per_unit_usd"`
	GrossUSD        float64 `json:"gross_usd"`
}

// BillingPeriod is a tenant's closed month. Corrections mint a new version;
// a period is never mutated in place (mirrors billing_periods' UNIQUE
// (tenant_id, period, version), design §2.6).
type BillingPeriod struct {
	TenantID        uuid.UUID     `json:"tenant_id"`
	Period          string        `json:"period"` // YYYY-MM
	Version         int           `json:"version"`
	RateCardID      uuid.UUID     `json:"rate_card_id"`
	RateCardVersion int           `json:"rate_card_version"`
	Lines           []BillingLine `json:"lines"`
	GrossUSD        float64       `json:"gross_usd"`
	ClosedAt        time.Time     `json:"closed_at"`
}

// NewBillingPeriod aggregates priced rollup rows (the output of
// store.Chargeback — meter totals × rate card, design §2.6) into one line per
// meter_key, summing quantity and gross across the dimension breakdown. Pure
// and deterministic: lines come out sorted by meter_key so the artifact and
// any provider push are byte-stable across runs (VMB-FR-021 replay safety).
// Rows with a nil USD (unpriced meter) contribute quantity but zero gross.
func NewBillingPeriod(
	tenant uuid.UUID, period string, version int,
	rateCardID uuid.UUID, rateCardVersion int, closedAt time.Time,
	rows []RollupRow,
) BillingPeriod {
	type agg struct {
		unit     string
		qty      float64
		gross    float64
		grossSet bool
	}
	byMeter := map[string]*agg{}
	for _, r := range rows {
		a := byMeter[r.MeterKey]
		if a == nil {
			a = &agg{unit: r.Unit}
			byMeter[r.MeterKey] = a
		}
		if a.unit == "" {
			a.unit = r.Unit
		}
		a.qty += r.Quantity
		if r.USD != nil {
			a.gross += *r.USD
			a.grossSet = true
		}
	}

	keys := make([]string, 0, len(byMeter))
	for k := range byMeter {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	lines := make([]BillingLine, 0, len(keys))
	var total float64
	for _, k := range keys {
		a := byMeter[k]
		var price float64
		if a.grossSet && a.qty != 0 {
			price = a.gross / a.qty
		}
		lines = append(lines, BillingLine{
			MeterKey:        k,
			Unit:            a.unit,
			Quantity:        a.qty,
			PricePerUnitUSD: price,
			GrossUSD:        a.gross,
		})
		total += a.gross
	}

	return BillingPeriod{
		TenantID:        tenant,
		Period:          period,
		Version:         version,
		RateCardID:      rateCardID,
		RateCardVersion: rateCardVersion,
		Lines:           lines,
		GrossUSD:        total,
		ClosedAt:        closedAt,
	}
}

// BillingPushResult reports what a pusher accepted. Reference is the
// provider-side batch/reference id when the provider returns one; Accepted is
// the number of lines/events the provider took. Idempotent is true when the
// provider reported it already had these events (a safe replay), so the close
// job can distinguish "pushed now" from "already pushed".
type BillingPushResult struct {
	Adapter    string `json:"adapter"`
	Reference  string `json:"reference,omitempty"`
	Accepted   int    `json:"accepted"`
	Idempotent bool   `json:"idempotent"`
}

// BillingPusher forwards a closed period to an external billing system. The
// export (file path) is always written first and independently; a Push failure
// only annotates billing_exports.pushed_status and never blocks the period from
// being `exported` (VMB-FR-022/AC-6 — "file path is truth").
type BillingPusher interface {
	Push(ctx context.Context, period BillingPeriod) (BillingPushResult, error)
}

// ErrBillingPushNotConfigured is the sentinel every unwired pusher returns.
// Mirrors agent-runtime's GpuTrainerNotConfigured and ai-gateway's
// ProviderNotConfigured (docs/initiatives/value-metering-billing-export.md
// §2.8): accepted at the control plane, fails honestly at execution, never a
// fabricated success. This is the first Go instance of that triad in the repo.
var ErrBillingPushNotConfigured = errors.New("billing_push_not_configured")

// BillingPushNotConfiguredError is the typed, non-retryable error a stub pusher
// returns, carrying the adapter and the exact remediation an operator needs.
type BillingPushNotConfiguredError struct {
	Adapter string
	Reason  string
}

func (e *BillingPushNotConfiguredError) Error() string {
	return "billing_push_not_configured: " + e.Adapter + ": " + e.Reason
}

// Is lets errors.Is(err, ErrBillingPushNotConfigured) match.
func (e *BillingPushNotConfiguredError) Is(target error) bool {
	return target == ErrBillingPushNotConfigured
}

// UnconfiguredPusher is the default until a real adapter is wired: a real
// object that fails honestly, never a fake "pushed" status. Reason must state
// what to set to enable the adapter.
type UnconfiguredPusher struct {
	Adapter string
	Reason  string
}

// Push always returns a BillingPushNotConfiguredError.
func (p *UnconfiguredPusher) Push(_ context.Context, _ BillingPeriod) (BillingPushResult, error) {
	return BillingPushResult{Adapter: p.Adapter}, &BillingPushNotConfiguredError{Adapter: p.Adapter, Reason: p.Reason}
}
