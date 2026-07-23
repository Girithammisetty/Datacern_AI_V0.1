// Package ingest is the consume→store path (AUD-FR-001..004, 050, 070): decode
// the master envelope off any subscribed topic, validate it, apply the PII gate,
// digest the payload, assign the hash-chain position and append to the ClickHouse
// append-only store. Idempotency is the Redis dedup pre-filter (in the consumer)
// plus ReplacingMergeTree convergence.
package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/chain"
	"github.com/datacern-ai/audit-service/internal/domain"
	"github.com/datacern-ai/audit-service/internal/meta"
	"github.com/datacern-ai/audit-service/internal/siemexport"
)

// RecordInserter appends a record to the append-only store (real: *chstore.Store).
type RecordInserter interface {
	Insert(ctx context.Context, r domain.Record) error
	// InsertBatch appends many records in one native batch — used by
	// HandleBatch (B8, scalability audit) instead of one Insert per record.
	InsertBatch(ctx context.Context, recs []domain.Record) error
}

// ChainAppender assigns the next hash-chain position (real: *chain.Manager).
type ChainAppender interface {
	Append(ctx context.Context, tenant, eventID uuid.UUID, payloadDigest string, occurredAt time.Time) (chain.Link, error)
	// AppendBatch assigns positions for many same-tenant events under one
	// lock hold — used by HandleBatch (B8, scalability audit) instead of one
	// Append per event.
	AppendBatch(ctx context.Context, tenant uuid.UUID, items []chain.BatchItem) ([]chain.Link, error)
}

// TerminalError marks an event that will never succeed on retry (envelope
// invalid, digest conflict) and must be quarantined to the DLQ with Reason.
type TerminalError struct {
	Reason string
	Err    error
}

func (e *TerminalError) Error() string { return e.Reason + ": " + e.Err.Error() }
func (e *TerminalError) Unwrap() error { return e.Err }

func terminal(reason string, err error) *TerminalError {
	return &TerminalError{Reason: reason, Err: err}
}

// Processor turns a decoded envelope into a stored, chained audit record.
type Processor struct {
	CH    RecordInserter
	Chain ChainAppender
	Meta  *meta.Emitter
	// CleanAllow is the Schema-Registry-backed set of event types guaranteed
	// PII-free (pii=false). Others are pattern-scanned (BR-5). Nil scans all.
	CleanAllow map[string]bool
	// Export publishes the additive `audit.export.v1` SIEM event (Phase 3,
	// docs/design/siem-export.md) after a record is durably chained + stored.
	// Nil disables the sink entirely (no behavior change, existing tests
	// unaffected) — it is never on the critical path: a publish failure there
	// is logged and swallowed by Exporter.Publish, never returned from Handle.
	Export *siemexport.Exporter
	now    func() time.Time
}

// SetClock overrides the ingest clock (tests).
func (p *Processor) SetClock(f func() time.Time) { p.now = f }

func (p *Processor) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now().UTC()
}

// Source locates the message on its topic (payload_ref when body withheld).
type Source struct {
	Topic     string
	Partition int
	Offset    int64
}

// Handle processes one envelope end-to-end. A *TerminalError means route to DLQ
// with its reason; any other error is transient (ClickHouse/Redis/chain) and the
// caller must pause without committing the offset (BR-6): Kafka is the buffer.
func (p *Processor) Handle(ctx context.Context, src Source, env domain.Envelope) error {
	rec, err := p.buildPending(ctx, src, env)
	if err != nil {
		return err // *TerminalError
	}

	link, err := p.Chain.Append(ctx, rec.TenantID, rec.EventID, rec.PayloadDigest, rec.OccurredAt)
	if err != nil {
		return fmt.Errorf("chain append: %w", err) // transient → pause
	}
	rec.ChainDate, rec.ChainSeq, rec.ChainHash = link.ChainDate, link.Seq, link.Hash

	if err := p.CH.Insert(ctx, rec); err != nil {
		return fmt.Errorf("clickhouse insert: %w", err) // transient → pause
	}

	// Additive SIEM export sink (Phase 3): fires only AFTER the record is
	// durably chained + stored, and never influences the return value — a
	// publish failure here must never trigger a retry/DLQ of an event that has
	// already been correctly ingested (docs/design/siem-export.md).
	if p.Export != nil {
		p.Export.Publish(ctx, rec)
	}
	return nil
}

// Item is one decoded envelope to process within a HandleBatch call.
type Item struct {
	Source Source
	Env    domain.Envelope
}

// HandleBatch processes many envelopes in one micro-batch: one chain-lock
// hold per distinct tenant plus one ClickHouse InsertBatch call, instead of
// Handle's per-event lock + insert round trips (B8, scalability audit —
// audit-service is the highest-volume consumer and per-event round trips were
// its throughput ceiling). Returns one result per item in the same order as
// items: nil means the event was chained and stored; a *TerminalError means
// that one item must be DLQ'd (it does not block the rest of the batch). A
// non-nil `err` return means the whole batch failed on a transient
// store/chain error — same BR-6 contract as Handle: the caller must pause
// without committing any message in the batch (Kafka redelivers all of it;
// idempotent chain assignment + ReplacingMergeTree make that safe).
func (p *Processor) HandleBatch(ctx context.Context, items []Item) ([]error, error) {
	results := make([]error, len(items))
	recs := make([]domain.Record, len(items))
	byTenant := map[uuid.UUID][]int{}

	for i, it := range items {
		rec, err := p.buildPending(ctx, it.Source, it.Env)
		if err != nil {
			results[i] = err // *TerminalError -> caller DLQs just this item
			continue
		}
		recs[i] = rec
		byTenant[rec.TenantID] = append(byTenant[rec.TenantID], i)
	}

	var toInsert []domain.Record
	for tenant, idxs := range byTenant {
		chainItems := make([]chain.BatchItem, len(idxs))
		for j, idx := range idxs {
			chainItems[j] = chain.BatchItem{
				EventID:       recs[idx].EventID,
				PayloadDigest: recs[idx].PayloadDigest,
				OccurredAt:    recs[idx].OccurredAt,
			}
		}
		links, err := p.Chain.AppendBatch(ctx, tenant, chainItems)
		if err != nil {
			return nil, fmt.Errorf("chain append batch: %w", err) // transient → pause whole batch
		}
		for j, idx := range idxs {
			recs[idx].ChainDate, recs[idx].ChainSeq, recs[idx].ChainHash = links[j].ChainDate, links[j].Seq, links[j].Hash
			toInsert = append(toInsert, recs[idx])
		}
	}

	if len(toInsert) > 0 {
		if err := p.CH.InsertBatch(ctx, toInsert); err != nil {
			return nil, fmt.Errorf("clickhouse insert batch: %w", err) // transient → pause whole batch
		}
	}

	if p.Export != nil {
		for _, rec := range toInsert {
			p.Export.Publish(ctx, rec)
		}
	}
	return results, nil
}

// buildPending validates and shapes one envelope into a domain.Record with
// everything filled EXCEPT the chain fields (ChainDate/Seq/Hash) — those are
// assigned by the caller via Append or AppendBatch. Shared by Handle and
// HandleBatch so the PII gate / digest / record-shaping logic exists once.
func (p *Processor) buildPending(ctx context.Context, src Source, env domain.Envelope) (domain.Record, error) {
	if err := domain.ValidateEnvelope(env); err != nil {
		return domain.Record{}, terminal(domain.ReasonEnvelopeInvalid, err)
	}

	// Normalize occurred_at to millisecond precision up front: the ClickHouse
	// column is DateTime64(3), so the value read back for chain verification is
	// ms-truncated. Hashing the same truncated value keeps ingest and verify
	// byte-identical (otherwise every chain would falsely fail verification).
	env.OccurredAt = env.OccurredAt.UTC().Truncate(time.Millisecond)

	canonical := domain.CanonicalJSON(env.Payload)
	digest := domain.SHA256Hex(canonical)

	// PII gate (AUD-FR-070/071): decide whether the body may be stored inline.
	gate := domain.PIIGate(env.EventType, canonical, p.CleanAllow)
	payloadJSON := ""
	payloadRef := ""
	switch {
	case gate.Clean:
		payloadJSON = string(canonical)
	case gate.TooLarge:
		payloadRef = domain.PayloadRef(src.Topic, src.Partition, src.Offset)
	default: // PII hit: drop body, keep digest, emit meta event naming producer.
		payloadRef = domain.PayloadRef(src.Topic, src.Partition, src.Offset)
		if p.Meta != nil {
			producer := domain.ParseURN(env.ResourceURN).Service
			if producer == "" {
				producer = env.Actor.ID
			}
			p.Meta.PIIRejected(ctx, env.TenantID, producer, env.EventType, gate.Reason)
		}
	}

	urn := domain.ParseURN(env.ResourceURN)
	rec := domain.Record{
		EventID:         env.EventID,
		EventType:       env.EventType,
		SourceTopic:     src.Topic,
		TenantID:        env.TenantID,
		ActorType:       actorTypeEnum(env.Actor.Type),
		ActorID:         env.Actor.ID,
		OboUserID:       oboUser(env),
		ResourceURN:     env.ResourceURN,
		ResourceService: urn.Service,
		ResourceType:    urn.Type,
		Action:          domain.ActionFromEventType(urn.Service, env.EventType),
		OccurredAt:      env.OccurredAt,
		IngestedAt:      p.clock(),
		TraceID:         env.TraceID,
		PayloadDigest:   digest,
		PayloadJSON:     payloadJSON,
		PayloadRef:      payloadRef,
	}
	if env.ViaAgent != nil {
		rec.ViaAgentID = env.ViaAgent.AgentID
		rec.ViaAgentVersion = env.ViaAgent.Version
	}
	return rec, nil
}

// actorTypeEnum maps envelope actor types onto the ClickHouse Enum (platform →
// service for storage; the enum has user/service/agent).
func actorTypeEnum(t string) string {
	switch t {
	case "user", "service", "agent":
		return t
	case "platform":
		return "service"
	default:
		return "service"
	}
}

// oboUser denormalizes the on-behalf-of user for OBO rows (dual attribution,
// AUD-FR-031): actor is the user, via_agent is the agent.
func oboUser(env domain.Envelope) string {
	if env.ViaAgent != nil && env.Actor.Type == "user" {
		return env.Actor.ID
	}
	return ""
}
