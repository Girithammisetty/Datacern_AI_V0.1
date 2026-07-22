package events

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
	"github.com/stretchr/testify/require"

	gcevent "github.com/datacern-ai/go-common/event"
)

// TestNewEnvelope_ConformsToMasterContract exercises the real emitting
// shape used by store.Op.emit (internal/store/opctx.go, the path every
// mutating store method routes through) via NewEnvelope and the existing
// toMaster conversion used by GoCommonPublisher.Publish, asserting the
// result satisfies the shared event-envelope conformance validator
// (MASTER-FR-031/041, BRD 58 WS5).
func TestNewEnvelope_ConformsToMasterContract(t *testing.T) {
	tenant := uuid.New()
	env := NewEnvelope(EvGroupCreated, tenant, Actor{Type: "user", ID: "u-1"},
		"wr:t:rbac:group/g-1", "trace-1", map[string]any{"name": "Reviewers"})

	require.NoError(t, gcevent.Validate(toMaster(env)))
}

// TestNewEnvelope_ViaAgentConformsToMasterContract covers the OBO
// (on-behalf-of) attribution path (MASTER-FR-041): actor.type "agent" with
// ViaAgent set, as store.Op.emit assigns after NewEnvelope returns.
func TestNewEnvelope_ViaAgentConformsToMasterContract(t *testing.T) {
	tenant := uuid.New()
	env := NewEnvelope(EvGrantCreated, tenant, Actor{Type: "agent", ID: "ml-engineer"},
		"wr:t:rbac:grant/gr-1", "trace-2", map[string]any{"role": "Editor"})
	env.ViaAgent = &ViaAgent{AgentID: "ml-engineer", Version: "1"}

	require.NoError(t, gcevent.Validate(toMaster(env)))
}

// TestToDLQ_UndecodableMessage_UsesPlatformTenant covers KafkaConsumer.toDLQ's
// decode-failure path (processMessage, consumers.go): the source message
// can't be unmarshalled at all, so no real tenant_id can be recovered from
// it. Regression coverage for the BRD 58 WS5 finding — toDLQ used to build
// this consumer.poison envelope with uuid.Nil, which fails the shared
// conformance validator's non-nil tenant_id requirement.
func TestToDLQ_UndecodableMessage_UsesPlatformTenant(t *testing.T) {
	dlq := NewInMemoryPublisher()
	c := &KafkaConsumer{DLQ: dlq, Group: "rbac-consumer"}

	err := c.toDLQ(context.Background(), kafka.Message{Topic: "identity.events.v1", Value: []byte("not json")},
		uuid.Nil, errors.New("decode: unexpected end of JSON input"))
	require.Error(t, err) // toDLQ returns the original cause, not nil

	published := dlq.Events()
	require.Len(t, published, 1)
	env := published[0].Envelope
	require.Equal(t, PlatformTenant, env.TenantID)
	require.NotEqual(t, uuid.Nil, env.TenantID)
	require.NoError(t, gcevent.Validate(toMaster(env)))
}

// TestToDLQ_HandlerFailure_ThreadsRealTenant covers the retry-exhausted path:
// the source message decoded fine, so its real tenant_id is known and must be
// threaded through to the DLQ envelope rather than dropped in favor of a
// sentinel.
func TestToDLQ_HandlerFailure_ThreadsRealTenant(t *testing.T) {
	dlq := NewInMemoryPublisher()
	c := &KafkaConsumer{DLQ: dlq, Group: "rbac-consumer"}
	tenant := uuid.New()

	err := c.toDLQ(context.Background(), kafka.Message{Topic: "identity.events.v1", Value: []byte(`{"tenant_id":"` + tenant.String() + `"}`)},
		tenant, errors.New("handler: boom"))
	require.Error(t, err)

	published := dlq.Events()
	require.Len(t, published, 1)
	env := published[0].Envelope
	require.Equal(t, tenant, env.TenantID)
	require.NoError(t, gcevent.Validate(toMaster(env)))
}
