package events

import "testing"

// TestKafkaPublisher_TopicFor covers the commercial.events.v1 topic routing
// (BRD 66 §6, CPL-FR-014): commercial-prefixed event types go to
// CommercialTopic, everything else stays on the publisher's default Topic.
// Exercises topicFor directly (a pure function of the publisher's configured
// default topic) so this doesn't need a live Kafka broker.
func TestKafkaPublisher_TopicFor(t *testing.T) {
	p := &KafkaPublisher{topic: Topic}
	cases := []struct {
		eventType string
		want      string
	}{
		{"commercial.plan_assigned", CommercialTopic},
		{"commercial.entitlement_changed", CommercialTopic},
		{"tenant.created", Topic},
		{"user.invited", Topic},
		{"security.cross_tenant_denied", Topic},
	}
	for _, c := range cases {
		if got := p.topicFor(c.eventType); got != c.want {
			t.Errorf("topicFor(%q) = %q, want %q", c.eventType, got, c.want)
		}
	}
}
