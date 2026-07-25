package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// DefaultTTL: entries self-heal via TTL, matching rbac's permissions_flat
// (services/rbac-service/internal/projection/redis.go DefaultTTL).
const DefaultTTL = 24 * time.Hour

// casSet writes ARGV[1] to KEYS[1] with TTL ARGV[3] only when the existing
// value's "v" is older than ARGV[2] — versioned last-writer-wins, identical
// script to rbac's projection.casSet (services/rbac-service/internal/
// projection/redis.go), so two workers racing on the same tenant converge on
// the newest snapshot rather than flapping.
var casSet = redis.NewScript(`
local existing = redis.call('GET', KEYS[1])
if existing then
  local ok, cur = pcall(cjson.decode, existing)
  if ok and cur and cur.v and tonumber(cur.v) >= tonumber(ARGV[2]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
return 1
`)

// flatEntitlement is one entry of the projected entitlement list.
type flatEntitlement struct {
	Kind       string         `json:"kind"`
	Key        string         `json:"key"`
	Value      map[string]any `json:"value,omitempty"`
	Provenance string         `json:"provenance"`
}

// flatValue is the JSON payload stored at ent:{tenant}:flat (design doc
// "entitlements_flat Redis projection").
type flatValue struct {
	V               int64             `json:"v"`
	ComputedAt      string            `json:"computed_at"`
	PlanKey         string            `json:"plan_key,omitempty"`
	PlanVersion     int               `json:"plan_version,omitempty"`
	CommercialState string            `json:"commercial_state"`
	TrialEndsAt     *string           `json:"trial_ends_at,omitempty"`
	Entitlements    []flatEntitlement `json:"entitlements"`
}

func toFlatValue(snap Snapshot) flatValue {
	ents := make([]flatEntitlement, 0, len(snap.Entitlements))
	for _, e := range snap.Entitlements {
		ents = append(ents, flatEntitlement{Kind: string(e.Kind), Key: e.Key, Value: e.Value, Provenance: e.Provenance})
	}
	v := flatValue{
		V: snap.Version, ComputedAt: snap.ComputedAt.UTC().Format(time.RFC3339Nano),
		PlanKey: snap.PlanKey, PlanVersion: snap.PlanVersion,
		CommercialState: string(snap.CommercialState), Entitlements: ents,
	}
	if snap.TrialEndsAt != nil {
		s := snap.TrialEndsAt.UTC().Format(time.RFC3339Nano)
		v.TrialEndsAt = &s
	}
	return v
}

// RedisWriter materializes Snapshots into ent:{tenant}:flat and publishes
// ent.invalidate notifications (CPL-FR-011).
type RedisWriter struct {
	rdb redis.UniversalClient
	ttl time.Duration
}

func NewRedisWriter(rdb redis.UniversalClient, ttl time.Duration) *RedisWriter {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &RedisWriter{rdb: rdb, ttl: ttl}
}

// Write CAS-writes one tenant's flattened entitlement set.
func (w *RedisWriter) Write(ctx context.Context, snap Snapshot) error {
	raw, err := json.Marshal(toFlatValue(snap))
	if err != nil {
		return fmt.Errorf("projection marshal %s: %w", snap.TenantID, err)
	}
	ttlSec := int64(w.ttl / time.Second)
	if err := casSet.Run(ctx, w.rdb, []string{Key(snap.TenantID.String())}, raw, snap.Version, ttlSec).Err(); err != nil {
		return fmt.Errorf("projection write %s: %w", snap.TenantID, err)
	}
	return nil
}

// InvalidateMessage is the ent.invalidate pub/sub payload.
type InvalidateMessage struct {
	Tenant string `json:"tenant"`
}

// PublishInvalidate notifies consumer caches that a tenant's entitlements changed.
func (w *RedisWriter) PublishInvalidate(ctx context.Context, tenant string) error {
	raw, err := json.Marshal(InvalidateMessage{Tenant: tenant})
	if err != nil {
		return err
	}
	return w.rdb.Publish(ctx, InvalidateChannel, raw).Err()
}

// ReadSet is a best-effort direct read of the projection (used by consumers
// that want the fast Redis path without an HTTP round trip to identity-service,
// per CPL-NFR-001; slice 1 does not yet have such a consumer wired, but the
// reader is included now so the projection is testable end-to-end).
func ReadSet(ctx context.Context, rdb redis.UniversalClient, tenantID string) (domain.EffectiveSet, bool, error) {
	raw, err := rdb.Get(ctx, Key(tenantID)).Result()
	if err == redis.Nil {
		return domain.EffectiveSet{}, false, nil
	}
	if err != nil {
		return domain.EffectiveSet{}, false, err
	}
	var v flatValue
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return domain.EffectiveSet{}, false, err
	}
	out := domain.EffectiveSet{
		PlanKey: v.PlanKey, PlanVersion: v.PlanVersion, CommercialState: domain.CommercialState(v.CommercialState),
	}
	if id, perr := uuid.Parse(tenantID); perr == nil {
		out.TenantID = id
	}
	if v.TrialEndsAt != nil {
		if t, err := time.Parse(time.RFC3339Nano, *v.TrialEndsAt); err == nil {
			out.TrialEndsAt = &t
		}
	}
	for _, e := range v.Entitlements {
		out.Entitlements = append(out.Entitlements, domain.EffectiveEntitlement{
			Kind: domain.EntitlementKind(e.Kind), Key: e.Key, Value: e.Value, Provenance: e.Provenance,
		})
	}
	return out, true, nil
}
