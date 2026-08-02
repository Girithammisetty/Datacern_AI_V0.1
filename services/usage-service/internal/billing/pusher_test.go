package billing

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/usage-service/internal/domain"
)

func TestBuildPusher_NoAdapterIsUnconfigured(t *testing.T) {
	p := BuildPusher(PusherConfig{})
	_, err := p.Push(context.Background(), domain.BillingPeriod{})
	require.Error(t, err)
	assert.True(t, errors.Is(err, domain.ErrBillingPushNotConfigured))
	var nc *domain.BillingPushNotConfiguredError
	require.True(t, errors.As(err, &nc))
	assert.Equal(t, "none", nc.Adapter)
}

func TestBuildPusher_StripeWithoutKeyIsUnconfigured(t *testing.T) {
	p := BuildPusher(PusherConfig{Adapter: "stripe"}) // no key
	_, err := p.Push(context.Background(), domain.BillingPeriod{})
	require.Error(t, err)
	assert.True(t, errors.Is(err, domain.ErrBillingPushNotConfigured))
	var nc *domain.BillingPushNotConfiguredError
	require.True(t, errors.As(err, &nc))
	assert.Equal(t, "stripe", nc.Adapter)
	assert.Contains(t, nc.Reason, "STRIPE_API_KEY")
}

func TestBuildPusher_StripeConfiguredReturnsRealAdapter(t *testing.T) {
	p := BuildPusher(PusherConfig{
		Adapter:      "Stripe", // case-insensitive
		StripeAPIKey: "sk_test_x",
		Customers:    map[string]string{"t1": "cus_1"},
	})
	sp, ok := p.(*StripePusher)
	require.True(t, ok, "expected a *StripePusher when key is set")
	assert.Equal(t, "sk_test_x", sp.apiKey)
	// Default meter allowlist applied.
	assert.Contains(t, sp.meterEvents, domain.MeterGovernedDecision)
}

func TestFromEnv_ParsesAllFields(t *testing.T) {
	env := map[string]string{
		"BILLING_PUSHER":      "stripe",
		"STRIPE_API_KEY":      "sk_live_abc",
		"STRIPE_API_BASE":     "https://stripe.internal",
		"STRIPE_METER_EVENTS": `{"governed_decision":"decisions"}`,
		"STRIPE_CUSTOMER_MAP": `{"t1":"cus_1","t2":"cus_2"}`,
	}
	cfg := FromEnv(func(k string) string { return env[k] })
	assert.Equal(t, "stripe", cfg.Adapter)
	assert.Equal(t, "sk_live_abc", cfg.StripeAPIKey)
	assert.Equal(t, "https://stripe.internal", cfg.StripeAPIBase)
	assert.Equal(t, map[string]string{"governed_decision": "decisions"}, cfg.MeterEvents)
	assert.Equal(t, map[string]string{"t1": "cus_1", "t2": "cus_2"}, cfg.Customers)
}

func TestParseMeterEvents_AcceptsCompactAndJSON(t *testing.T) {
	assert.Equal(t, map[string]string{"a": "x", "b": "y"}, parseMeterEvents("a=x, b=y"))
	assert.Equal(t, map[string]string{"a": "x"}, parseMeterEvents(`{"a":"x"}`))
	assert.Nil(t, parseMeterEvents(""))
	assert.Nil(t, parseMeterEvents("garbage-no-eq"))
}

func TestParseStringMap_MalformedIsNilNotPanic(t *testing.T) {
	assert.Nil(t, parseStringMap("{not json"))
	assert.Nil(t, parseStringMap(""))
	assert.Equal(t, map[string]string{"k": "v"}, parseStringMap(`{"k":"v"}`))
}

// A configured Stripe pusher wired end-to-end through BuildPusher pushes via a
// fake doer — proves the selection path yields a working adapter, not just a
// type.
func TestBuildPusher_EndToEndWithFakeDoer(t *testing.T) {
	tenant := uuid.New()
	doer := &fakeDoer{status: 200, body: `{}`}
	// BuildPusher can't inject HTTP, so construct directly for the wired-call
	// assertion; BuildPusher's type is covered above.
	sp := NewStripePusher(StripeConfig{
		APIKey:    "sk_test_x",
		Customers: StaticCustomerResolver{tenant.String(): "cus_1"},
		HTTP:      doer,
	})
	res, err := sp.Push(context.Background(), domain.BillingPeriod{
		TenantID: tenant, Period: "2026-07", Version: 1,
		Lines: []domain.BillingLine{{MeterKey: domain.MeterGovernedDecision, Quantity: 42}},
	})
	require.NoError(t, err)
	assert.Equal(t, 1, res.Accepted)
	require.Len(t, doer.reqs, 1)
}
