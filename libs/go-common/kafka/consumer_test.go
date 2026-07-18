package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	segkafka "github.com/segmentio/kafka-go"

	"github.com/windrose-ai/go-common/event"
)

// fakeDLQ is an in-memory DLQPublisher double. When fail is true every Publish
// errors, simulating a dead-letter topic that cannot be written.
type fakeDLQ struct {
	fail  bool
	calls atomic.Int32
}

func (f *fakeDLQ) Publish(_ context.Context, _ string, _ event.Envelope) error {
	f.calls.Add(1)
	if f.fail {
		return errors.New("dlq unavailable")
	}
	return nil
}

func poisonMsg(t *testing.T) segkafka.Message {
	t.Helper()
	env := event.New("thing.created", uuid.New(), event.Actor{Type: "service", ID: "test"}, "", "", map[string]any{"k": "v"})
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return segkafka.Message{Topic: "x.events.v1", Value: b}
}

func newTestConsumer(handler Handler, dlq DLQPublisher) *ConsumerGroup {
	return &ConsumerGroup{
		handler:    handler,
		dlq:        dlq,
		group:      "test-grp",
		maxRetries: 1, // fail fast: exactly one handler attempt, no backoff
		log:        slog.Default(),
	}
}

// A handler that succeeds must commit (process returns nil) and must never touch
// the DLQ.
func TestProcessSuccessCommits(t *testing.T) {
	dlq := &fakeDLQ{}
	cg := newTestConsumer(func(context.Context, event.Envelope) error { return nil }, dlq)
	if err := cg.process(context.Background(), poisonMsg(t)); err != nil {
		t.Fatalf("success path must return nil (committable), got %v", err)
	}
	if n := dlq.calls.Load(); n != 0 {
		t.Fatalf("DLQ must not be called on success, got %d calls", n)
	}
}

// When the handler exhausts retries and the DLQ publish SUCCEEDS, process must
// return nil so the caller commits (the poison is safely quarantined).
func TestProcessDLQSuccessCommits(t *testing.T) {
	dlq := &fakeDLQ{fail: false}
	cg := newTestConsumer(func(context.Context, event.Envelope) error { return errors.New("boom") }, dlq)
	if err := cg.process(context.Background(), poisonMsg(t)); err != nil {
		t.Fatalf("successful DLQ quarantine must return nil (committable), got %v", err)
	}
	if n := dlq.calls.Load(); n < 1 {
		t.Fatalf("DLQ must be called at least once, got %d", n)
	}
}

// The data-loss fix: when the handler exhausts retries AND the DLQ publish
// ITSELF fails, process must return a non-nil error so the caller does NOT
// commit — the offset is left for redelivery instead of the event being lost.
func TestProcessDLQPublishFailureDoesNotCommit(t *testing.T) {
	dlq := &fakeDLQ{fail: true}
	cg := newTestConsumer(func(context.Context, event.Envelope) error { return errors.New("boom") }, dlq)
	// Bound the blocking DLQ-retry loop with a short ctx deadline; on cancel it
	// must surface a non-nil error (do-not-commit signal).
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	err := cg.process(ctx, poisonMsg(t))
	if err == nil {
		t.Fatal("DLQ publish failure must return a non-nil error so the offset is NOT committed")
	}
	if dlq.calls.Load() < 1 {
		t.Fatalf("DLQ publish should have been attempted, got %d calls", dlq.calls.Load())
	}
}

// recordingDeduper captures every key SetNX is asked about and always reports
// the key as freshly claimed (so the handler runs).
type recordingDeduper struct{ keys []string }

func (d *recordingDeduper) SetNX(_ context.Context, key string, _ time.Duration) (bool, error) {
	d.keys = append(d.keys, key)
	return true, nil
}

// The dedup claim MUST be namespaced by consumer group. case.events.v1 is
// consumed by several groups sharing one Redis; a global "evt:dedup:<id>" key
// let whichever group ran first claim an event and every other group silently
// skip it. Regression guard: the key must embed the group id.
func TestDedupKeyIsGroupNamespaced(t *testing.T) {
	msg := poisonMsg(t)
	var env event.Envelope
	if err := json.Unmarshal(msg.Value, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	dedA := &recordingDeduper{}
	cgA := newTestConsumer(func(context.Context, event.Envelope) error { return nil }, &fakeDLQ{})
	cgA.group, cgA.dedup = "group-a", dedA
	if err := cgA.process(context.Background(), msg); err != nil {
		t.Fatalf("process: %v", err)
	}

	dedB := &recordingDeduper{}
	cgB := newTestConsumer(func(context.Context, event.Envelope) error { return nil }, &fakeDLQ{})
	cgB.group, cgB.dedup = "group-b", dedB
	if err := cgB.process(context.Background(), msg); err != nil {
		t.Fatalf("process: %v", err)
	}

	if len(dedA.keys) != 1 || len(dedB.keys) != 1 {
		t.Fatalf("each group should claim exactly one key, got a=%v b=%v", dedA.keys, dedB.keys)
	}
	// Same event, different groups → DIFFERENT keys (no cross-group cannibalism).
	if dedA.keys[0] == dedB.keys[0] {
		t.Fatalf("dedup key must differ across consumer groups; both were %q", dedA.keys[0])
	}
	wantA := "evt:dedup:group-a:" + env.EventID.String()
	if dedA.keys[0] != wantA {
		t.Fatalf("group-a dedup key = %q, want %q", dedA.keys[0], wantA)
	}
}

// A nil DLQ is a misconfiguration: rather than silently drop a poison event,
// process must block (never returning a committable nil) until ctx is cancelled.
func TestProcessNilDLQPausesRatherThanDrops(t *testing.T) {
	cg := newTestConsumer(func(context.Context, event.Envelope) error { return errors.New("boom") }, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := cg.process(ctx, poisonMsg(t))
	if err == nil {
		t.Fatal("nil DLQ must NOT return a committable nil for a poison event; it must pause")
	}
}
