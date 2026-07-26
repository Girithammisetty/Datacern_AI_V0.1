// Package entitlements is usage-service's own direct reader of the
// entitlements_flat Redis projection (BRD 66, CPL-FR-032): the value summary
// reports how much of each contracted meter allowance a tenant has left.
//
// This mirrors the read-side contract identity-service's projection worker
// writes (services/identity-service/internal/projection/{keys,redis}.go): one
// JSON blob per tenant at ent:{tenant}:flat. Per the wave-1 "self-contained
// services" convention (docs/platform/CONVENTIONS.md) this is a small vendored
// copy of that contract -- the same shape rbac-service vendors in its own
// internal/entitlements package -- not a cross-service Go import.
//
// Deliberately NOT an enforcement gate. CPL-FR-032 is a *Should* that asks for
// the remaining included quantity to be surfaced, explicitly "no billing math
// here" (that is BRD 67). Nothing in this package blocks a write, and a meter
// running past its allowance is reported, never refused.
package entitlements

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// Key returns the Redis key identity-service's projection worker writes.
func Key(tenantID string) string { return fmt.Sprintf("ent:%s:flat", tenantID) }

// KindMeterAllowance is the only entitlement kind this service reads.
const KindMeterAllowance = "meter_allowance"

// Entitlement is one row of the flat JSON's "entitlements" array. For a
// meter_allowance the entitlement_key IS the meter key (matching how the
// seeded caps use entitlement_key 'seats'/'workspaces'), and value carries
// {included_qty, period}.
type Entitlement struct {
	Kind  string         `json:"kind"`
	Key   string         `json:"key"`
	Value map[string]any `json:"value,omitempty"`
}

// Flat is the ent:{tenant}:flat payload (the subset usage-service reads;
// identity-service's projection.flatValue is the authoritative full shape).
type Flat struct {
	V            int64         `json:"v"`
	Entitlements []Entitlement `json:"entitlements"`
}

// Allowance is one contracted meter allowance.
type Allowance struct {
	MeterKey    string
	IncludedQty float64
	// Period as contracted (CPL-FR-010 v1 defines calendar_month). Reported
	// verbatim rather than normalized: a caller comparing against a window
	// this service did not compute must be able to see the mismatch.
	Period string
}

// ParseFlat decodes the projection blob.
func ParseFlat(raw []byte) (Flat, error) {
	var f Flat
	if err := json.Unmarshal(raw, &f); err != nil {
		return Flat{}, err
	}
	return f, nil
}

// MeterAllowances extracts every meter_allowance entry. An entry whose
// included_qty is absent or non-numeric is SKIPPED rather than defaulted to
// zero: reporting "0 included" for a malformed contract row would read as a
// real contractual fact and understate what the customer bought.
func (f Flat) MeterAllowances() []Allowance {
	var out []Allowance
	for _, e := range f.Entitlements {
		if e.Kind != KindMeterAllowance || e.Key == "" {
			continue
		}
		qty, ok := numeric(e.Value["included_qty"])
		if !ok {
			continue
		}
		period, _ := e.Value["period"].(string)
		out = append(out, Allowance{MeterKey: e.Key, IncludedQty: qty, Period: period})
	}
	return out
}

func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

// Reader reads entitlements_flat directly from Redis. A nil *Reader (or one
// over a nil client) is a valid zero value reporting "no projection", so a
// deployment without REDIS_ADDR degrades to "allowances not shown" instead of
// panicking.
type Reader struct {
	rdb redis.UniversalClient
}

func NewReader(rdb redis.UniversalClient) *Reader { return &Reader{rdb: rdb} }

// Allowances returns the tenant's contracted meter allowances. ok=false means
// the projection could not be consulted (absent key, Redis down, corrupt
// payload). Callers must treat that as "unknown" and omit the figures --
// per CPL-NFR-004 a READ proceeds when the projection is unavailable; only
// entitlement-gated writes fail closed, and nothing here gates a write.
func (r *Reader) Allowances(ctx context.Context, tenantID string) (out []Allowance, ok bool) {
	if r == nil || r.rdb == nil {
		return nil, false
	}
	raw, err := r.rdb.Get(ctx, Key(tenantID)).Bytes()
	if err != nil {
		return nil, false
	}
	flat, perr := ParseFlat(raw)
	if perr != nil {
		return nil, false
	}
	return flat.MeterAllowances(), true
}
