package jobs

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/store"
)

func TestPreviousMonth(t *testing.T) {
	assert.Equal(t, "2026-07", PreviousMonth(time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)))
	assert.Equal(t, "2025-12", PreviousMonth(time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC))) // year rollover
	assert.Equal(t, "2026-02", PreviousMonth(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)))
}

func TestChargebackToRollup_MapsTotalsAndUnits(t *testing.T) {
	lines := []store.ChargebackLine{
		{MeterKey: domain.MeterGovernedDecision, Quantity: 842, USD: 60, AdjustmentsUSD: 7.36, TotalUSD: 67.36},
		{MeterKey: "unknown_meter", Quantity: 5, TotalUSD: 1},
	}
	rows := chargebackToRollup(lines)
	assert.Len(t, rows, 2)

	// governed_decision resolves its unit from the catalog; USD is the line total.
	assert.Equal(t, domain.MeterGovernedDecision, rows[0].MeterKey)
	assert.Equal(t, "count", rows[0].Unit)
	assert.Equal(t, 842.0, rows[0].Quantity)
	assert.NotNil(t, rows[0].USD)
	assert.InDelta(t, 67.36, *rows[0].USD, 1e-9)

	// Unknown meter → empty unit (never panics), total carried.
	assert.Equal(t, "", rows[1].Unit)
	assert.InDelta(t, 1.0, *rows[1].USD, 1e-9)
}

func TestRateCardOf_FirstNonEmpty(t *testing.T) {
	id := uuid.New()
	lines := []store.ChargebackLine{
		{MeterKey: "a", RateCardID: ""},
		{MeterKey: "b", RateCardID: id.String()},
	}
	got, ver := rateCardOf(lines)
	assert.Equal(t, id, got)
	assert.Equal(t, 0, ver) // version not surfaced by Chargeback yet

	// No card anywhere → Nil.
	got, _ = rateCardOf([]store.ChargebackLine{{MeterKey: "a"}})
	assert.Equal(t, uuid.Nil, got)
}

func TestPushOutcome(t *testing.T) {
	// Success → pushed + reference.
	status, ref := pushOutcome(domain.BillingPushResult{Reference: "r1"}, nil)
	assert.Equal(t, domain.PushPushed, status)
	assert.Equal(t, "r1", ref)

	// Not configured → billing_push_not_configured, no reference.
	status, ref = pushOutcome(domain.BillingPushResult{}, &domain.BillingPushNotConfiguredError{Adapter: "stripe"})
	assert.Equal(t, domain.PushNotConfigured, status)
	assert.Empty(t, ref)

	// Any other error → push_failed.
	status, _ = pushOutcome(domain.BillingPushResult{}, errors.New("http 500"))
	assert.Equal(t, domain.PushFailed, status)
}
