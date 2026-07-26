// Package entitlements is rbac-service's own direct reader of the
// entitlements_flat Redis projection (BRD 66 slice 3, CPL-FR-031): the
// workspace-create handler checks the tenant's workspace_cap entitlement
// before creating a workspace.
//
// This mirrors two existing patterns rather than inventing a third:
//   - the KEY SHAPE + JSON schema identity-service's commercial-plane
//     projection worker writes (services/identity-service/internal/
//     projection/{keys,redis}.go): one JSON blob per tenant at
//     ent:{tenant}:flat (docs/initiatives/commercial-plane.md
//     "entitlements_flat Redis projection").
//   - the READ PATTERN rbac-service already uses for permissions_flat
//     (internal/projection/reader.go): a thin, direct Redis client in the
//     request path, no synchronous identity-service HTTP call
//     (CPL-NFR-001, ≤5ms p99).
//
// Per the wave-1 "self-contained services" convention (docs/platform/
// CONVENTIONS.md), this is a small vendored copy of the read-side contract,
// not a cross-service Go import of identity-service's internal package.
package entitlements

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// Key returns the Redis key identity-service's projection worker writes:
// ent:{tenant}:flat.
func Key(tenantID string) string { return fmt.Sprintf("ent:%s:flat", tenantID) }

// Entitlement kinds this reader cares about (CPL-FR-010). Only workspace_cap
// is consumed today; the struct below decodes the full array so future
// callers (e.g. a pack_sku check, if rbac ever needs one) don't need a
// second parser.
const (
	KindWorkspaceCap = "workspace_cap"
	// WorkspaceCapKey is the entitlement_key plan_entitlements seeds for
	// workspace_cap (services/identity-service/migrations/
	// 0010_commercial_plans.up.sql: ('workspace_cap', 'workspaces', '{"n": N}')).
	WorkspaceCapKey = "workspaces"
)

// Entitlement is one row of the flat JSON's "entitlements" array.
type Entitlement struct {
	Kind  string         `json:"kind"`
	Key   string         `json:"key"`
	Value map[string]any `json:"value,omitempty"`
}

// Flat is the ent:{tenant}:flat JSON payload (subset rbac-service reads;
// identity-service's projection.flatValue is the authoritative full shape).
type Flat struct {
	V               int64         `json:"v"`
	CommercialState string        `json:"commercial_state"`
	Entitlements    []Entitlement `json:"entitlements"`
}

// ParseFlat decodes the ent:{tenant}:flat JSON blob.
func ParseFlat(raw []byte) (Flat, error) {
	var f Flat
	if err := json.Unmarshal(raw, &f); err != nil {
		return Flat{}, err
	}
	return f, nil
}

// WorkspaceCap extracts the tenant's workspace_cap limit. found=false means
// the tenant has NO workspace_cap entitlement at all -- that is unlimited,
// not blocked (CPL-NFR-004's fail-closed rule is about a MISSING projection
// key/unreadable Redis, not an absent entitlement within a present,
// well-formed projection).
func (f Flat) WorkspaceCap() (limit int, found bool) {
	for _, e := range f.Entitlements {
		if e.Kind != KindWorkspaceCap || e.Key != WorkspaceCapKey {
			continue
		}
		switch v := e.Value["n"].(type) {
		case float64:
			return int(v), true
		case int:
			return v, true
		default:
			return 0, true // present but malformed value -- treat as a zero cap, not unlimited
		}
	}
	return 0, false
}

// Status is the outcome of consulting the projection for a cap check.
type Status int

const (
	// StatusUnavailable: the projection key is absent or Redis is
	// unreachable/corrupt -- entitlement-gated WRITES fail CLOSED
	// (CPL-NFR-004), surfaced by the caller as 503 ENTITLEMENT_UNAVAILABLE.
	StatusUnavailable Status = iota
	// StatusUnlimited: the projection was read successfully but carries no
	// workspace_cap entitlement -- no cap configured for this tenant, proceed.
	StatusUnlimited
	// StatusCapped: a workspace_cap entitlement is present; Limit holds it.
	StatusCapped
)

// Reader reads entitlements_flat directly from Redis. A nil *Reader (or one
// built over a nil client) is a valid zero value that always reports
// StatusUnavailable -- callers get fail-closed behavior automatically when
// REDIS_ADDR isn't configured, rather than a nil-pointer panic.
type Reader struct {
	rdb redis.UniversalClient
}

// NewReader builds a Reader over an existing Redis client (the same one
// rbac-service already uses for permissions_flat -- entitlements_flat lives
// in the same shared projection Redis per docs/platform/CONVENTIONS.md).
func NewReader(rdb redis.UniversalClient) *Reader { return &Reader{rdb: rdb} }

// CapExceeded reports whether `current` active workspaces already meets or
// exceeds `limit` (CPL-FR-031: AT the cap blocks the NEXT create -- mirrors
// AC-3's seat_cap example, 5 active + cap 5 -> the 6th invite is blocked).
func CapExceeded(current, limit int) bool { return current >= limit }

// WorkspaceCapStatus checks the tenant's workspace_cap entitlement
// (CPL-FR-031).
func (r *Reader) WorkspaceCapStatus(ctx context.Context, tenantID string) (Status, int, error) {
	if r == nil || r.rdb == nil {
		return StatusUnavailable, 0, nil
	}
	raw, err := r.rdb.Get(ctx, Key(tenantID)).Bytes()
	if err == redis.Nil {
		return StatusUnavailable, 0, nil
	}
	if err != nil {
		return StatusUnavailable, 0, err
	}
	flat, perr := ParseFlat(raw)
	if perr != nil {
		// Corrupt entry: treat as unavailable (fail closed), matching
		// rbac's own RedisReader.get() "corrupt entry: treat as miss"
		// comment, but here a miss must fail CLOSED for a gated write.
		return StatusUnavailable, 0, nil
	}
	if n, found := flat.WorkspaceCap(); found {
		return StatusCapped, n, nil
	}
	return StatusUnlimited, 0, nil
}
