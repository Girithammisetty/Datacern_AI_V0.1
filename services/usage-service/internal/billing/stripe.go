// Package billing holds usage-service's billing-push adapters: the seam that
// forwards a closed BillingPeriod to an external rating system. Per
// docs/initiatives/value-metering-billing-export.md §2.8, the file/CSV export
// is the source of truth; a push is an optional, honestly-failing secondary
// path. This package deliberately holds NO secrets and makes NO network call
// under test — the live call is behind an injectable HTTP doer and only fires
// when STRIPE_API_KEY is set (README "No credential-gated exceptions": the
// payload-shaping is fully unit-tested; the live call is operator-activated).
package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// stripeAPIBase is Stripe's real API host; overridable for tests/staging.
const stripeAPIBase = "https://api.stripe.com"

// meterEventsPath is Stripe's usage-based-billing meter-events endpoint.
// We POST one event per billable meter carrying the period's total quantity;
// Stripe's own meter aggregation (sum) + price config turns that into money,
// so usage-service never sends an amount. Idempotency is Stripe-native via the
// event `identifier` (deduped within Stripe's window) plus an Idempotency-Key
// header on the request itself.
const meterEventsPath = "/v1/billing/meter_events"

// HTTPDoer is the injection seam for the live call — *http.Client in prod, a
// fake in tests. Nothing in this package constructs a real client itself.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// CustomerResolver maps a Datacern tenant to its Stripe customer id (cus_…).
// A tenant with no mapping is a per-tenant not-configured condition — the
// pusher fails honestly for that tenant rather than inventing a customer.
type CustomerResolver interface {
	StripeCustomerID(tenant string) (string, bool)
}

// StaticCustomerResolver is a fixed tenant→customer map (e.g. seeded from
// STRIPE_CUSTOMER_MAP JSON). Real deployments back this with a projection.
type StaticCustomerResolver map[string]string

// StripeCustomerID looks up a tenant's Stripe customer id.
func (m StaticCustomerResolver) StripeCustomerID(tenant string) (string, bool) {
	id, ok := m[tenant]
	return id, ok && id != ""
}

// StripeConfig configures the Stripe pusher. APIKey is required to enable the
// live path (empty → BuildPusher returns an UnconfiguredPusher). MeterEvents
// maps a Datacern meter_key to the Stripe meter `event_name`; only meters in
// this map are pushed (default: governed_decision → "governed_decision"). The
// rate-card price is NOT sent — Stripe prices the quantity per its own meter.
type StripeConfig struct {
	APIKey      string
	APIBase     string            // default stripeAPIBase
	MeterEvents map[string]string // datacern meter_key -> stripe event_name
	Customers   CustomerResolver
	HTTP        HTTPDoer
}

// DefaultMeterEvents is the billable-meter allowlist when none is configured:
// governed_decision is the pricing unit (design §1a). Infra meters are never
// pushed to Stripe — sending them would double-bill against infra plans.
func DefaultMeterEvents() map[string]string {
	return map[string]string{domain.MeterGovernedDecision: domain.MeterGovernedDecision}
}

// StripePusher forwards billable meter quantities to Stripe Billing.
type StripePusher struct {
	apiKey      string
	base        string
	meterEvents map[string]string
	customers   CustomerResolver
	http        HTTPDoer
}

// NewStripePusher builds a configured pusher. Caller guarantees APIKey != ""
// (BuildPusher enforces this and returns an UnconfiguredPusher otherwise).
func NewStripePusher(cfg StripeConfig) *StripePusher {
	base := cfg.APIBase
	if base == "" {
		base = stripeAPIBase
	}
	me := cfg.MeterEvents
	if len(me) == 0 {
		me = DefaultMeterEvents()
	}
	h := cfg.HTTP
	if h == nil {
		h = http.DefaultClient
	}
	return &StripePusher{
		apiKey:      cfg.APIKey,
		base:        strings.TrimRight(base, "/"),
		meterEvents: me,
		customers:   cfg.Customers,
		http:        h,
	}
}

// meterEvent is the form-encoded payload for one Stripe meter event.
type meterEvent struct {
	eventName  string
	identifier string
	customerID string
	value      float64
}

// eventIdentifier is the Stripe-native dedup key for one (tenant, period,
// version, meter) push. Stable across replays so re-running a period's push is
// a no-op in Stripe (VMB-FR-021 replay safety carried to the provider).
func eventIdentifier(p domain.BillingPeriod, meterKey string) string {
	return fmt.Sprintf("%s:%s:v%d:%s", p.TenantID.String(), p.Period, p.Version, meterKey)
}

// buildEvents projects a period into the Stripe meter events to send: one per
// line whose meter is in the allowlist and has a non-zero quantity. Pure and
// deterministic (sorted by event_name) so a push is byte-stable and unit-
// testable without any network. Returns an error when the tenant has no Stripe
// customer mapping — an honest per-tenant not-configured signal, not a guess.
func (s *StripePusher) buildEvents(p domain.BillingPeriod) ([]meterEvent, error) {
	custID, ok := s.customers.StripeCustomerID(p.TenantID.String())
	if !ok {
		return nil, &domain.BillingPushNotConfiguredError{
			Adapter: "stripe",
			Reason:  "no Stripe customer mapping for tenant " + p.TenantID.String() + " (set STRIPE_CUSTOMER_MAP)",
		}
	}
	var events []meterEvent
	for _, ln := range p.Lines {
		eventName, billable := s.meterEvents[ln.MeterKey]
		if !billable || ln.Quantity == 0 {
			continue
		}
		events = append(events, meterEvent{
			eventName:  eventName,
			identifier: eventIdentifier(p, ln.MeterKey),
			customerID: custID,
			value:      ln.Quantity,
		})
	}
	sort.Slice(events, func(i, j int) bool { return events[i].eventName < events[j].eventName })
	return events, nil
}

// encodeMeterEvent form-encodes one meter event to Stripe's schema:
//
//	event_name=<name>
//	identifier=<stable dedup key>
//	payload[stripe_customer_id]=cus_…
//	payload[value]=<quantity>
func encodeMeterEvent(ev meterEvent) string {
	v := url.Values{}
	v.Set("event_name", ev.eventName)
	v.Set("identifier", ev.identifier)
	v.Set("payload[stripe_customer_id]", ev.customerID)
	// Stripe meter `value` is a stringified number; format without trailing
	// zeros so integer counts stay integers.
	v.Set("payload[value]", strconv.FormatFloat(ev.value, 'f', -1, 64))
	return v.Encode()
}

// Push sends the period's billable meter quantities to Stripe. Every event is
// posted; the first hard failure aborts and is returned (the close job records
// push_failed and can retry — Stripe dedups on identifier, so a retry after a
// partial push re-sends already-accepted events harmlessly). A period with no
// billable, non-zero lines is a successful no-op (Accepted 0).
func (s *StripePusher) Push(ctx context.Context, p domain.BillingPeriod) (domain.BillingPushResult, error) {
	res := domain.BillingPushResult{Adapter: "stripe"}
	events, err := s.buildEvents(p)
	if err != nil {
		return res, err
	}
	for _, ev := range events {
		if err := s.postOne(ctx, ev); err != nil {
			return res, err
		}
		res.Accepted++
	}
	res.Reference = fmt.Sprintf("%s:%s:v%d", p.TenantID.String(), p.Period, p.Version)
	return res, nil
}

func (s *StripePusher) postOne(ctx context.Context, ev meterEvent) error {
	body := encodeMeterEvent(ev)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+meterEventsPath, strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// Request-level idempotency in addition to the event identifier: a retried
	// POST with the same key is a no-op even before Stripe's meter dedup.
	req.Header.Set("Idempotency-Key", "meter_event:"+ev.identifier)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("stripe meter_event %q: %w", ev.identifier, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	// Surface Stripe's error message when present, capped so a huge body can't
	// blow up a log line.
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	msg := stripeErrorMessage(raw)
	return fmt.Errorf("stripe meter_event %q: http %d: %s", ev.identifier, resp.StatusCode, msg)
}

// stripeErrorMessage pulls {"error":{"message":"…"}} out of a Stripe error
// body, falling back to the raw text when it isn't the expected shape.
func stripeErrorMessage(raw []byte) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && env.Error.Message != "" {
		if env.Error.Code != "" {
			return env.Error.Code + ": " + env.Error.Message
		}
		return env.Error.Message
	}
	s := strings.TrimSpace(string(raw))
	if s == "" {
		return "(no body)"
	}
	return s
}
