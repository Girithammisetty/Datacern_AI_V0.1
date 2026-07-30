// Package entitlements is case-service's direct reader of the
// entitlements_flat Redis projection (BRD 66) — the same vendored read-side
// contract pack-service (app/domain/entitlements.py, CPL-FR-030), usage-service
// and rbac-service each carry, per the wave-1 "self-contained services"
// convention (docs/platform/CONVENTIONS.md). identity-service's commercial-
// plane projection worker writes one JSON blob per tenant at ent:{tenant}:flat
// (services/identity-service/internal/projection/{keys,redis}.go is the
// authoritative shape); nothing here calls identity-service synchronously.
//
// Unlike usage-service's reader this one IS an enforcement gate: the
// realtime-case-streams add-on (docs/initiatives/realtime-case-streams-addon.md,
// slice 2) is a priced feature, and turning its surfaces on without the
// entitlement must refuse — fail-closed like pack install (CPL-NFR-004), never
// silently entitled.
package entitlements

import (
	"context"
	"encoding/json"
	"fmt"
)

// FeatureRealtimeCaseStreams is the feature-kind entitlement key the
// realtime-case-streams add-on SKU grants.
const FeatureRealtimeCaseStreams = "realtime_case_streams"

// Key returns the Redis key identity-service's projection worker writes.
func Key(tenantID string) string { return fmt.Sprintf("ent:%s:flat", tenantID) }

// Status is the outcome of a feature entitlement check.
type Status int

const (
	// Entitled: the projection is present and grants the feature.
	Entitled Status = iota
	// Blocked: the projection is present and does NOT grant the feature —
	// the legitimate "not entitled" outcome, distinct from Unavailable.
	Blocked
	// Unavailable: the projection is missing/unreadable/corrupt. Fail CLOSED:
	// an entitlement-gated write must not proceed when the projection cannot
	// be consulted, and must not report the tenant as merely "not entitled"
	// when the truth is "could not check".
	Unavailable
)

// Getter is the minimal Redis surface the checker needs
// (satisfied by go-common/redisx.Client).
type Getter interface {
	Get(ctx context.Context, key string) (value string, found bool, err error)
}

type flat struct {
	Entitlements []struct {
		Kind string `json:"kind"`
		Key  string `json:"key"`
	} `json:"entitlements"`
}

// CheckFeature reports whether the tenant holds the feature-kind entitlement
// featureKey. Any read error, missing key, or corrupt payload is Unavailable.
func CheckFeature(ctx context.Context, g Getter, tenantID, featureKey string) Status {
	if g == nil {
		return Unavailable
	}
	raw, found, err := g.Get(ctx, Key(tenantID))
	if err != nil || !found || raw == "" {
		return Unavailable
	}
	var doc flat
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return Unavailable
	}
	for _, e := range doc.Entitlements {
		if e.Kind == "feature" && e.Key == featureKey {
			return Entitled
		}
	}
	return Blocked
}
