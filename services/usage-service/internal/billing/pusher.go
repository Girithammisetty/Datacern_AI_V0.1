package billing

import (
	"encoding/json"
	"strings"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// PusherConfig selects and configures the billing pusher. It is populated from
// the environment in FromEnv; a zero value (Adapter "") yields an
// UnconfiguredPusher so the close job runs with export-only behaviour by
// default (the file path is truth — a provider push is opt-in).
type PusherConfig struct {
	Adapter       string            // "stripe" | "" (none)
	StripeAPIKey  string            // required to enable stripe
	StripeAPIBase string            // optional override
	MeterEvents   map[string]string // datacern meter_key -> stripe event_name
	Customers     map[string]string // tenant_id -> stripe customer id
}

// BuildPusher returns the configured pusher, or an UnconfiguredPusher that
// fails honestly (never a fake "pushed") when the adapter isn't fully wired.
// This is the Go instance of agent-runtime's build_trainer() selection shape
// (docs/initiatives/value-metering-billing-export.md §2.8).
func BuildPusher(cfg PusherConfig) domain.BillingPusher {
	switch strings.ToLower(strings.TrimSpace(cfg.Adapter)) {
	case "stripe":
		if strings.TrimSpace(cfg.StripeAPIKey) == "" {
			return &domain.UnconfiguredPusher{
				Adapter: "stripe",
				Reason:  "set STRIPE_API_KEY to enable the Stripe billing push",
			}
		}
		return NewStripePusher(StripeConfig{
			APIKey:      cfg.StripeAPIKey,
			APIBase:     cfg.StripeAPIBase,
			MeterEvents: cfg.MeterEvents,
			Customers:   StaticCustomerResolver(cfg.Customers),
		})
	default:
		return &domain.UnconfiguredPusher{
			Adapter: "none",
			Reason:  "no billing pusher configured (set BILLING_PUSHER=stripe + STRIPE_API_KEY to enable)",
		}
	}
}

// FromEnv reads a PusherConfig from the standard env vars. `get` is the
// service's env accessor (e.g. os.Getenv or the server's env() helper), passed
// in so this stays testable without touching the process environment.
//
//	BILLING_PUSHER        stripe | (unset)
//	STRIPE_API_KEY        sk_live_… (required for stripe)
//	STRIPE_API_BASE       optional host override (default https://api.stripe.com)
//	STRIPE_METER_EVENTS   optional JSON {meter_key: event_name} or "k=v,k=v"
//	STRIPE_CUSTOMER_MAP   JSON {tenant_id: cus_…}
func FromEnv(get func(string) string) PusherConfig {
	return PusherConfig{
		Adapter:       get("BILLING_PUSHER"),
		StripeAPIKey:  get("STRIPE_API_KEY"),
		StripeAPIBase: get("STRIPE_API_BASE"),
		MeterEvents:   parseMeterEvents(get("STRIPE_METER_EVENTS")),
		Customers:     parseStringMap(get("STRIPE_CUSTOMER_MAP")),
	}
}

// parseMeterEvents accepts either a JSON object or a compact "k=v,k=v" list.
// An empty/invalid value yields nil so NewStripePusher falls back to
// DefaultMeterEvents (governed_decision only).
func parseMeterEvents(s string) map[string]string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if strings.HasPrefix(s, "{") {
		return parseStringMap(s)
	}
	out := map[string]string{}
	for _, pair := range strings.Split(s, ",") {
		kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
		if len(kv) == 2 && kv[0] != "" && kv[1] != "" {
			out[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseStringMap parses a JSON object of string→string, returning nil on any
// error (a malformed map must not crash startup — the pusher degrades to
// unconfigured/honest-failure for the affected tenants).
func parseStringMap(s string) map[string]string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil
	}
	return m
}
