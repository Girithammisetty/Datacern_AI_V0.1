package domain

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func usd(v float64) *float64 { return &v }

func TestNewBillingPeriod_AggregatesByMeterSortedAndSummed(t *testing.T) {
	tenant := uuid.New()
	rc := uuid.New()
	closed := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

	// Two dimension rows for governed_decision + one for api_calls, out of order.
	rows := []RollupRow{
		{MeterKey: "governed_decision", Unit: "count", Quantity: 500, USD: usd(40)},
		{MeterKey: "api_calls", Unit: "count", Quantity: 1000, USD: usd(2)},
		{MeterKey: "governed_decision", Unit: "count", Quantity: 342, USD: usd(27.36)},
	}

	p := NewBillingPeriod(tenant, "2026-07", 1, rc, 3, closed, rows)

	require.Len(t, p.Lines, 2)
	// sorted by meter_key: api_calls before governed_decision
	assert.Equal(t, "api_calls", p.Lines[0].MeterKey)
	assert.Equal(t, "governed_decision", p.Lines[1].MeterKey)

	gd := p.Lines[1]
	assert.Equal(t, 842.0, gd.Quantity)               // 500 + 342
	assert.InDelta(t, 67.36, gd.GrossUSD, 1e-9)       // 40 + 27.36
	assert.InDelta(t, 0.08, gd.PricePerUnitUSD, 1e-9) // 67.36 / 842

	assert.InDelta(t, 69.36, p.GrossUSD, 1e-9) // 67.36 + 2
	assert.Equal(t, "2026-07", p.Period)
	assert.Equal(t, 1, p.Version)
	assert.Equal(t, rc, p.RateCardID)
	assert.Equal(t, 3, p.RateCardVersion)
	assert.Equal(t, closed, p.ClosedAt)
}

func TestNewBillingPeriod_UnpricedRowContributesQuantityNotGross(t *testing.T) {
	rows := []RollupRow{
		{MeterKey: "governed_decision", Unit: "count", Quantity: 10, USD: nil},
	}
	p := NewBillingPeriod(uuid.New(), "2026-07", 1, uuid.New(), 1, time.Now(), rows)
	require.Len(t, p.Lines, 1)
	assert.Equal(t, 10.0, p.Lines[0].Quantity)
	assert.Equal(t, 0.0, p.Lines[0].GrossUSD)
	assert.Equal(t, 0.0, p.Lines[0].PricePerUnitUSD) // no divide-by on unpriced
	assert.Equal(t, 0.0, p.GrossUSD)
}

func TestNewBillingPeriod_Empty(t *testing.T) {
	p := NewBillingPeriod(uuid.New(), "2026-07", 1, uuid.New(), 1, time.Now(), nil)
	assert.Empty(t, p.Lines)
	assert.Equal(t, 0.0, p.GrossUSD)
}

func TestUnconfiguredPusher_FailsHonestly(t *testing.T) {
	p := &UnconfiguredPusher{Adapter: "stripe", Reason: "set STRIPE_API_KEY"}
	res, err := p.Push(context.Background(), BillingPeriod{})

	require.Error(t, err)
	// The typed error matches the sentinel via errors.Is …
	assert.True(t, errors.Is(err, ErrBillingPushNotConfigured))
	// … and carries the adapter + remediation.
	var notConf *BillingPushNotConfiguredError
	require.True(t, errors.As(err, &notConf))
	assert.Equal(t, "stripe", notConf.Adapter)
	assert.Contains(t, notConf.Error(), "STRIPE_API_KEY")
	// Never a fabricated "pushed": result reports the adapter, zero accepted.
	assert.Equal(t, "stripe", res.Adapter)
	assert.Equal(t, 0, res.Accepted)
}
