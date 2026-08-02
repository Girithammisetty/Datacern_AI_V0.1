package billing

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// fakeDoer records requests and returns a scripted response.
type fakeDoer struct {
	reqs   []*http.Request
	bodies []string
	status int
	body   string
	err    error
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(req.Body)
	f.reqs = append(f.reqs, req)
	f.bodies = append(f.bodies, string(b))
	if f.err != nil {
		return nil, f.err
	}
	status := f.status
	if status == 0 {
		status = 200
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Header:     make(http.Header),
	}, nil
}

func usd(v float64) *float64 { return &v }

func periodWith(tenant uuid.UUID, lines ...domain.BillingLine) domain.BillingPeriod {
	return domain.BillingPeriod{
		TenantID: tenant, Period: "2026-07", Version: 2,
		RateCardID: uuid.New(), RateCardVersion: 1,
		Lines: lines, ClosedAt: time.Now(),
	}
}

func newPusher(doer HTTPDoer, customers map[string]string, meters map[string]string) *StripePusher {
	return NewStripePusher(StripeConfig{
		APIKey:      "sk_test_x",
		APIBase:     "https://stripe.test",
		MeterEvents: meters,
		Customers:   StaticCustomerResolver(customers),
		HTTP:        doer,
	})
}

func TestStripePush_SendsOneMeterEventPerBillableLine(t *testing.T) {
	tenant := uuid.New()
	doer := &fakeDoer{status: 200, body: `{"identifier":"x"}`}
	p := newPusher(doer, map[string]string{tenant.String(): "cus_123"}, nil) // default: governed_decision only

	period := periodWith(tenant,
		domain.BillingLine{MeterKey: "governed_decision", Unit: "count", Quantity: 842},
		domain.BillingLine{MeterKey: "api_calls", Unit: "count", Quantity: 9999}, // not billable → skipped
	)

	res, err := p.Push(context.Background(), period)
	require.NoError(t, err)
	assert.Equal(t, 1, res.Accepted)
	assert.Equal(t, "stripe", res.Adapter)
	assert.Contains(t, res.Reference, tenant.String())

	require.Len(t, doer.reqs, 1)
	req := doer.reqs[0]
	assert.Equal(t, http.MethodPost, req.Method)
	assert.Equal(t, "https://stripe.test/v1/billing/meter_events", req.URL.String())
	assert.Equal(t, "Bearer sk_test_x", req.Header.Get("Authorization"))
	assert.Equal(t, "application/x-www-form-urlencoded", req.Header.Get("Content-Type"))

	// Body carries the quantity as value + the customer, and the stable identifier.
	form, err := url.ParseQuery(doer.bodies[0])
	require.NoError(t, err)
	assert.Equal(t, "governed_decision", form.Get("event_name"))
	assert.Equal(t, "cus_123", form.Get("payload[stripe_customer_id]"))
	assert.Equal(t, "842", form.Get("payload[value]"))
	assert.Equal(t, tenant.String()+":2026-07:v2:governed_decision", form.Get("identifier"))
	// Never sends an amount — Stripe prices the quantity.
	assert.Empty(t, form.Get("payload[amount]"))

	// Request-level idempotency key mirrors the event identifier.
	assert.Equal(t, "meter_event:"+tenant.String()+":2026-07:v2:governed_decision", req.Header.Get("Idempotency-Key"))
}

func TestStripePush_IdentifierIsStableAcrossRuns(t *testing.T) {
	tenant := uuid.New()
	p := periodWith(tenant, domain.BillingLine{MeterKey: "governed_decision", Quantity: 5})

	d1 := &fakeDoer{}
	d2 := &fakeDoer{}
	_, err := newPusher(d1, map[string]string{tenant.String(): "cus_1"}, nil).Push(context.Background(), p)
	require.NoError(t, err)
	_, err = newPusher(d2, map[string]string{tenant.String(): "cus_1"}, nil).Push(context.Background(), p)
	require.NoError(t, err)

	f1, _ := url.ParseQuery(d1.bodies[0])
	f2, _ := url.ParseQuery(d2.bodies[0])
	assert.Equal(t, f1.Get("identifier"), f2.Get("identifier")) // replay-safe in Stripe
}

func TestStripePush_ZeroQuantityAndNoBillableLinesAreNoOps(t *testing.T) {
	tenant := uuid.New()
	doer := &fakeDoer{}
	p := newPusher(doer, map[string]string{tenant.String(): "cus_1"}, nil)

	// governed_decision with 0 quantity + a non-billable meter → nothing sent.
	res, err := p.Push(context.Background(), periodWith(tenant,
		domain.BillingLine{MeterKey: "governed_decision", Quantity: 0},
		domain.BillingLine{MeterKey: "storage_gb_month", Quantity: 12},
	))
	require.NoError(t, err)
	assert.Equal(t, 0, res.Accepted)
	assert.Empty(t, doer.reqs)
}

func TestStripePush_MissingCustomerMappingFailsHonestly(t *testing.T) {
	tenant := uuid.New()
	doer := &fakeDoer{}
	p := newPusher(doer, map[string]string{}, nil) // no mapping for this tenant

	res, err := p.Push(context.Background(), periodWith(tenant,
		domain.BillingLine{MeterKey: "governed_decision", Quantity: 5}))

	require.Error(t, err)
	assert.True(t, errors.Is(err, domain.ErrBillingPushNotConfigured))
	assert.Contains(t, err.Error(), tenant.String())
	assert.Equal(t, 0, res.Accepted)
	assert.Empty(t, doer.reqs) // no call attempted without a customer
}

func TestStripePush_ApiErrorSurfacesStripeMessage(t *testing.T) {
	tenant := uuid.New()
	doer := &fakeDoer{
		status: 402,
		body:   `{"error":{"code":"card_declined","message":"Your card was declined."}}`,
	}
	p := newPusher(doer, map[string]string{tenant.String(): "cus_1"}, nil)

	res, err := p.Push(context.Background(), periodWith(tenant,
		domain.BillingLine{MeterKey: "governed_decision", Quantity: 5}))

	require.Error(t, err)
	assert.Contains(t, err.Error(), "http 402")
	assert.Contains(t, err.Error(), "card_declined")
	assert.Contains(t, err.Error(), "Your card was declined.")
	assert.Equal(t, 0, res.Accepted) // failure not counted as accepted
}

func TestStripePush_TransportErrorPropagates(t *testing.T) {
	tenant := uuid.New()
	doer := &fakeDoer{err: errors.New("dial tcp: connection refused")}
	p := newPusher(doer, map[string]string{tenant.String(): "cus_1"}, nil)

	_, err := p.Push(context.Background(), periodWith(tenant,
		domain.BillingLine{MeterKey: "governed_decision", Quantity: 5}))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "connection refused")
}

func TestStripePush_CustomMeterAllowlist(t *testing.T) {
	tenant := uuid.New()
	doer := &fakeDoer{}
	// Map two datacern meters to stripe event names.
	p := newPusher(doer, map[string]string{tenant.String(): "cus_1"},
		map[string]string{"governed_decision": "decisions", "case_resolved": "cases"})

	res, err := p.Push(context.Background(), periodWith(tenant,
		domain.BillingLine{MeterKey: "governed_decision", Quantity: 3},
		domain.BillingLine{MeterKey: "case_resolved", Quantity: 7},
		domain.BillingLine{MeterKey: "api_calls", Quantity: 100},
	))
	require.NoError(t, err)
	assert.Equal(t, 2, res.Accepted)
	require.Len(t, doer.bodies, 2)
	// Sorted by event_name: "cases" before "decisions".
	f0, _ := url.ParseQuery(doer.bodies[0])
	f1, _ := url.ParseQuery(doer.bodies[1])
	assert.Equal(t, "cases", f0.Get("event_name"))
	assert.Equal(t, "7", f0.Get("payload[value]"))
	assert.Equal(t, "decisions", f1.Get("event_name"))
	assert.Equal(t, "3", f1.Get("payload[value]"))
}

func TestStaticCustomerResolver_EmptyIsUnmapped(t *testing.T) {
	r := StaticCustomerResolver{"t1": "cus_1", "t2": ""}
	id, ok := r.StripeCustomerID("t1")
	assert.True(t, ok)
	assert.Equal(t, "cus_1", id)

	_, ok = r.StripeCustomerID("t2") // present but empty → unmapped
	assert.False(t, ok)
	_, ok = r.StripeCustomerID("t3")
	assert.False(t, ok)
}
