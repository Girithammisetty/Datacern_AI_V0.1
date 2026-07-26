package events

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	gcevent "github.com/datacern-ai/go-common/event"
)

// BrokerReactions is the surface the consumers drive (implemented by
// exec.Broker) — BRD 05 §6 consumed events.
type BrokerReactions interface {
	HandleDatasetDeleted(ctx context.Context, tenant uuid.UUID, urn string)
	SuspendTenant(ctx context.Context, tenant uuid.UUID)
	ResumeTenant(tenant uuid.UUID)
}

// ResolverInvalidation lets the dataset consumer drop cached plans.
type ResolverInvalidation interface {
	Delete(tenant uuid.UUID, name string)
}

// Consumer dispatches inbound envelopes. In production it sits behind the
// shared go-common Kafka consumer group (cmd/server/main.go's "query-inbound"
// group on identity.events.v1) with Redis event_id dedup and a DLQ
// (MASTER-FR-032/033), reached via KafkaHandler; tests dispatch directly
// through Handle (CONVENTIONS: fakes from contracts, never live services).
type Consumer struct {
	Broker   BrokerReactions
	Resolver ResolverInvalidation

	// Dedup implements MASTER-FR-032 consumer-side idempotency; the default
	// in-memory set stands in for Redis SETNX.
	seen map[uuid.UUID]bool
}

// Handle processes one envelope; safe to replay (MASTER-FR-032).
func (c *Consumer) Handle(ctx context.Context, env Envelope) {
	if c.seen == nil {
		c.seen = map[uuid.UUID]bool{}
	}
	if c.seen[env.EventID] {
		return // duplicate delivery
	}
	c.seen[env.EventID] = true

	switch env.EventType {
	case "dataset.deleted":
		// Invalidate cached plans/results for the URN and fail queued
		// executions referencing it (§6).
		if name, ok := env.Payload["name"].(string); ok && c.Resolver != nil {
			c.Resolver.Delete(env.TenantID, name)
		}
		c.Broker.HandleDatasetDeleted(ctx, env.TenantID, env.ResourceURN)
	case "dataset.version_created":
		// Result-cache entries keyed to older versions naturally miss (the
		// cache key pins versions, QRY-FR-046); latest-plan caches refresh
		// on the resolver's short TTL. No action required.
	case "tenant.suspended":
		c.Broker.SuspendTenant(ctx, env.TenantID)
	case "tenant.reactivated":
		c.Broker.ResumeTenant(env.TenantID)
	default:
		slog.Debug("ignoring event", "type", env.EventType)
	}
}

// KafkaHandler adapts Handle to the shared go-common Kafka consumer's Handler
// signature (gckafka.Handler), translating the wire envelope onto
// query-service's local Envelope type (mirrors toMaster's inverse in
// gocommon.go). Handle itself never errors, so retries/DLQ never trigger on
// tenant-suspension delivery.
func (c *Consumer) KafkaHandler() func(ctx context.Context, env gcevent.Envelope) error {
	return func(ctx context.Context, env gcevent.Envelope) error {
		c.Handle(ctx, fromMaster(env))
		return nil
	}
}
