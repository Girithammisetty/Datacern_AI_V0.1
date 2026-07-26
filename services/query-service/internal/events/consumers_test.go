package events

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	gcevent "github.com/datacern-ai/go-common/event"
)

// fakeBroker records what the consumer dispatched, standing in for
// exec.Broker (CONVENTIONS: fakes from contracts, never live services).
type fakeBroker struct {
	suspended []uuid.UUID
	resumed   []uuid.UUID
	deleted   []string
}

func (f *fakeBroker) HandleDatasetDeleted(_ context.Context, _ uuid.UUID, urn string) {
	f.deleted = append(f.deleted, urn)
}
func (f *fakeBroker) SuspendTenant(_ context.Context, tenant uuid.UUID) {
	f.suspended = append(f.suspended, tenant)
}
func (f *fakeBroker) ResumeTenant(tenant uuid.UUID) {
	f.resumed = append(f.resumed, tenant)
}

// TestConsumerKafkaHandler_TenantSuspendedReactivated proves the wire path a
// real Kafka delivery takes: a gcevent.Envelope carrying identity-service's
// actual event names (tenant.suspended, tenant.reactivated — NOT the
// previously-wrong "tenant.resumed") reaches the broker via KafkaHandler's
// fromMaster translation.
func TestConsumerKafkaHandler_TenantSuspendedReactivated(t *testing.T) {
	fb := &fakeBroker{}
	c := &Consumer{Broker: fb}
	tenant := uuid.New()

	suspend := gcevent.New("tenant.suspended", tenant, gcevent.Actor{Type: "service", ID: "identity-service"},
		"wr:"+tenant.String()+":identity:tenant/"+tenant.String(), "trace-1", nil)
	err := c.KafkaHandler()(context.Background(), suspend)
	require.NoError(t, err)
	require.Equal(t, []uuid.UUID{tenant}, fb.suspended)

	reactivate := gcevent.New("tenant.reactivated", tenant, gcevent.Actor{Type: "service", ID: "identity-service"},
		"wr:"+tenant.String()+":identity:tenant/"+tenant.String(), "trace-2", nil)
	err = c.KafkaHandler()(context.Background(), reactivate)
	require.NoError(t, err)
	require.Equal(t, []uuid.UUID{tenant}, fb.resumed)

	// A stale/mistaken "tenant.resumed" (identity-service never emits this)
	// must not be silently treated as a resume.
	wrong := gcevent.New("tenant.resumed", tenant, gcevent.Actor{Type: "service", ID: "identity-service"}, "", "trace-3", nil)
	err = c.KafkaHandler()(context.Background(), wrong)
	require.NoError(t, err)
	assert.Len(t, fb.resumed, 1, "tenant.resumed is not identity-service's real event name; must not double-resume")
}

// TestConsumerKafkaHandler_Dedup proves duplicate deliveries (same event_id,
// e.g. an at-least-once redelivery) are no-ops, mirroring Handle's own dedup
// test coverage but through the Kafka-facing entry point.
func TestConsumerKafkaHandler_Dedup(t *testing.T) {
	fb := &fakeBroker{}
	c := &Consumer{Broker: fb}
	tenant := uuid.New()
	env := gcevent.New("tenant.suspended", tenant, gcevent.Actor{Type: "service", ID: "identity-service"}, "", "trace-1", nil)

	require.NoError(t, c.KafkaHandler()(context.Background(), env))
	require.NoError(t, c.KafkaHandler()(context.Background(), env))
	assert.Len(t, fb.suspended, 1, "replayed event_id must not re-dispatch")
}
