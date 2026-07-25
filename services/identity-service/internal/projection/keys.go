// Package projection is the entitlements_flat Redis projection (CPL-FR-011):
// one JSON key per tenant, outbox/dirty-queue-driven recompute + pub/sub
// invalidate, mirroring rbac-service's permissions_flat discipline
// (services/rbac-service/internal/projection) but simplified to a single key
// per tenant since entitlements have no per-user dimension to shard on (see
// docs/initiatives/commercial-plane.md "entitlements_flat Redis projection").
package projection

import "fmt"

// InvalidateChannel is the Redis pub/sub channel consumers (pack-service,
// BFF, identity's own seat/workspace-cap checks) subscribe to for
// cache-invalidation notifications, mirroring rbac's perm.invalidate.
const InvalidateChannel = "ent.invalidate"

// Key returns the Redis key for a tenant's flattened entitlement set:
// ent:{tenant}:flat (BRD 66 §6, design doc "entitlements_flat Redis projection").
func Key(tenantID string) string { return fmt.Sprintf("ent:%s:flat", tenantID) }
