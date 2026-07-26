package events

import (
	"context"
	"os"
	"strings"

	gckafka "github.com/datacern-ai/go-common/kafka"
	gcevent "github.com/datacern-ai/go-common/event"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// Topic is identity-service's event topic (MASTER-FR-030).
const Topic = "identity.events.v1"

// CommercialTopic carries commercial-plane events (BRD 66 §6, CPL-FR-014):
// entitlement_changed|plan_assigned (slice 1); trial_started|trial_ending|
// trial_expired|converted (slice 2). Routed by the "commercial." event_type
// prefix in Publish below, kept separate from Topic so commercial-plane
// consumers (billing exports, audit-service) can subscribe without also
// receiving every tenant/user/service-account lifecycle event.
const CommercialTopic = "commercial.events.v1"

// KafkaPublisher is the real Publisher: it maps outbox rows onto the shared
// master event envelope and publishes them to Kafka via libs/go-common
// (Redpanda in dev), keyed by tenant_id (MASTER-FR-031). It replaces the
// dev-only LogPublisher in the runtime path.
type KafkaPublisher struct {
	prod  *gckafka.Producer
	topic string
}

// NewKafkaPublisher builds a KafkaPublisher over the shared producer and
// registers the envelope schema subject for the topic (best-effort — a Schema
// Registry outage must not block issuance).
func NewKafkaPublisher(ctx context.Context, brokers []string, schemaRegistryURL string) *KafkaPublisher {
	cfg := gckafka.Config{
		Brokers: brokers,
		SASL:    gckafka.SASLFromEnv(os.Getenv), TLS: gckafka.TLSFromEnv(os.Getenv),
	}
	if schemaRegistryURL != "" {
		cfg.SchemaRegistry = gckafka.NewSchemaRegistry(schemaRegistryURL)
	}
	prod := gckafka.NewProducer(cfg)
	kp := &KafkaPublisher{prod: prod, topic: Topic}
	if cfg.SchemaRegistry != nil {
		_, _ = prod.RegisterEnvelopeSubject(ctx, Topic)
		_, _ = prod.RegisterEnvelopeSubject(ctx, CommercialTopic)
	}
	return kp
}

// Publish converts outbox rows to envelopes and publishes them, routing each
// via topicFor. The relay marks rows published only after this returns nil
// (at-least-once; consumers dedup on event_id, MASTER-FR-032).
func (p *KafkaPublisher) Publish(ctx context.Context, evs []*domain.OutboxEvent) error {
	for _, ev := range evs {
		if err := p.prod.Publish(ctx, p.topicFor(ev.EventType), toEnvelope(ev)); err != nil {
			return err
		}
	}
	return nil
}

// topicFor routes commercial-plane events (event_type prefixed "commercial.",
// e.g. commercial.plan_assigned) to CommercialTopic and everything else to
// the publisher's default Topic (BRD 66 §6, CPL-FR-014).
func (p *KafkaPublisher) topicFor(eventType string) string {
	if strings.HasPrefix(eventType, "commercial.") {
		return CommercialTopic
	}
	return p.topic
}

// Close flushes and closes the underlying producer.
func (p *KafkaPublisher) Close() error { return p.prod.Close() }

func toEnvelope(ev *domain.OutboxEvent) gcevent.Envelope {
	env := gcevent.Envelope{
		EventID:     ev.EventID,
		EventType:   ev.EventType,
		TenantID:    ev.TenantID,
		Actor:       gcevent.Actor{Type: ev.Actor.Type, ID: ev.Actor.ID},
		ResourceURN: ev.ResourceURN,
		OccurredAt:  ev.OccurredAt,
		TraceID:     ev.TraceID,
		Payload:     ev.Payload,
	}
	if ev.ViaAgent != nil {
		env.ViaAgent = &gcevent.ViaAgent{AgentID: ev.ViaAgent.AgentID, Version: ev.ViaAgent.Version}
	}
	if env.Payload == nil {
		env.Payload = map[string]any{}
	}
	return env
}
