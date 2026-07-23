package ingest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/chain"
	"github.com/datacern-ai/audit-service/internal/domain"
)

// fakeInserter is an in-memory RecordInserter — a UNIT-TEST DOUBLE ONLY; it is
// never reachable from cmd/server (which wires the real *chstore.Store).
type fakeInserter struct{ rows []domain.Record }

func (f *fakeInserter) Insert(_ context.Context, r domain.Record) error {
	f.rows = append(f.rows, r)
	return nil
}

func (f *fakeInserter) InsertBatch(_ context.Context, recs []domain.Record) error {
	f.rows = append(f.rows, recs...)
	return nil
}

// fakeChain is an in-memory ChainAppender/per-tenant AppendBatch computing
// real hashes with a local per-tenant-day seq — mirrors chain.Manager's
// sequencing semantics closely enough to assert HandleBatch's grouping and
// ordering, without needing real Redis/Postgres for these pure-logic tests.
type fakeChain struct {
	seq  map[string]uint64
	prev map[string]string
}

func (f *fakeChain) key(tenant uuid.UUID, date string) string { return tenant.String() + ":" + date }

func (f *fakeChain) Append(_ context.Context, tenant, eventID uuid.UUID, digest string, occ time.Time) (chain.Link, error) {
	links, err := f.appendAll(tenant, []chain.BatchItem{{EventID: eventID, PayloadDigest: digest, OccurredAt: occ}})
	if err != nil {
		return chain.Link{}, err
	}
	return links[0], nil
}

func (f *fakeChain) AppendBatch(_ context.Context, tenant uuid.UUID, items []chain.BatchItem) ([]chain.Link, error) {
	return f.appendAll(tenant, items)
}

func (f *fakeChain) appendAll(tenant uuid.UUID, items []chain.BatchItem) ([]chain.Link, error) {
	if f.prev == nil {
		f.prev = map[string]string{}
		f.seq = map[string]uint64{}
	}
	date := "2026-07-08"
	k := f.key(tenant, date)
	p, ok := f.prev[k]
	if !ok {
		p = domain.GenesisHash(tenant, date)
	}
	links := make([]chain.Link, len(items))
	for i, it := range items {
		f.seq[k]++
		h := domain.ChainHash(p, it.EventID, it.PayloadDigest, it.OccurredAt)
		p = h
		links[i] = chain.Link{ChainDate: date, Seq: f.seq[k], Hash: h}
	}
	f.prev[k] = p
	return links, nil
}

func env(t string, payload map[string]any) domain.Envelope {
	return domain.Envelope{
		EventID: uuid.New(), EventType: t, TenantID: uuid.New(),
		Actor: domain.Actor{Type: "user", ID: "u-1"}, OccurredAt: time.Now().UTC(), Payload: payload,
	}
}

func TestProcessorStoresCleanPayload(t *testing.T) {
	ins := &fakeInserter{}
	p := &Processor{CH: ins, Chain: &fakeChain{}}
	e := env("case.assigned", map[string]any{"assignee": "u-91"})
	if err := p.Handle(context.Background(), Source{Topic: "case.events.v1"}, e); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if len(ins.rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(ins.rows))
	}
	r := ins.rows[0]
	if r.PayloadJSON == "" || r.PayloadDigest == "" || r.ChainHash == "" {
		t.Fatalf("clean payload not stored inline with digest+chain: %+v", r)
	}
}

func TestProcessorDropsPIIBodyKeepsDigest(t *testing.T) {
	ins := &fakeInserter{}
	p := &Processor{CH: ins, Chain: &fakeChain{}}
	e := env("mystery.event", map[string]any{"email": "jane@example.com"})
	if err := p.Handle(context.Background(), Source{Topic: "mystery.events.v1", Partition: 2, Offset: 99}, e); err != nil {
		t.Fatalf("handle: %v", err)
	}
	r := ins.rows[0]
	if r.PayloadJSON != "" {
		t.Fatal("PII body should be withheld")
	}
	if r.PayloadDigest == "" || r.PayloadRef == "" {
		t.Fatalf("digest kept + ref set expected: %+v", r)
	}
}

func TestProcessorTerminalOnInvalidEnvelope(t *testing.T) {
	p := &Processor{CH: &fakeInserter{}, Chain: &fakeChain{}}
	bad := env("x.y", nil)
	bad.TenantID = uuid.Nil
	err := p.Handle(context.Background(), Source{}, bad)
	var term *TerminalError
	if !asTerminal(err, &term) || term.Reason != domain.ReasonEnvelopeInvalid {
		t.Fatalf("expected terminal ENVELOPE_INVALID, got %v", err)
	}
}

// TestHandleBatchMatchesHandleOneAtATime is the correctness anchor for B8: run
// the same events through Handle one at a time vs. through one HandleBatch
// call, and assert byte-identical chain hashes/sequences and stored rows.
// Batching must be purely a throughput change, never a behavior change.
func TestHandleBatchMatchesHandleOneAtATime(t *testing.T) {
	tenant := uuid.New()
	events := make([]domain.Envelope, 5)
	for i := range events {
		e := env("case.assigned", map[string]any{"n": i})
		e.TenantID = tenant
		e.OccurredAt = time.Now().UTC().Add(time.Duration(i) * time.Millisecond)
		events[i] = e
	}

	seqIns, seqChain := &fakeInserter{}, &fakeChain{}
	seqProc := &Processor{CH: seqIns, Chain: seqChain}
	for _, e := range events {
		if err := seqProc.Handle(context.Background(), Source{Topic: "case.events.v1"}, e); err != nil {
			t.Fatalf("sequential handle: %v", err)
		}
	}

	batchIns, batchChain := &fakeInserter{}, &fakeChain{}
	batchProc := &Processor{CH: batchIns, Chain: batchChain}
	items := make([]Item, len(events))
	for i, e := range events {
		items[i] = Item{Source: Source{Topic: "case.events.v1"}, Env: e}
	}
	results, err := batchProc.HandleBatch(context.Background(), items)
	if err != nil {
		t.Fatalf("handle batch: %v", err)
	}
	for i, r := range results {
		if r != nil {
			t.Fatalf("item %d: unexpected error %v", i, r)
		}
	}

	if len(seqIns.rows) != len(batchIns.rows) {
		t.Fatalf("row count mismatch: sequential=%d batch=%d", len(seqIns.rows), len(batchIns.rows))
	}
	for i := range seqIns.rows {
		a, b := seqIns.rows[i], batchIns.rows[i]
		if a.ChainSeq != b.ChainSeq || a.ChainHash != b.ChainHash || a.EventID != b.EventID {
			t.Fatalf("row %d diverges: sequential=%+v batch=%+v", i, a, b)
		}
	}
}

// TestHandleBatchGroupsIndependentlyPerTenant: two tenants in one batch each
// get their own chain starting at seq 1 — batching by micro-batch must never
// leak sequence numbers across tenants.
func TestHandleBatchGroupsIndependentlyPerTenant(t *testing.T) {
	ins, ch := &fakeInserter{}, &fakeChain{}
	p := &Processor{CH: ins, Chain: ch}
	tenantA, tenantB := uuid.New(), uuid.New()

	var items []Item
	for i := 0; i < 3; i++ {
		e := env("case.assigned", map[string]any{"n": i})
		e.TenantID = tenantA
		items = append(items, Item{Source: Source{Topic: "case.events.v1"}, Env: e})
	}
	for i := 0; i < 2; i++ {
		e := env("case.assigned", map[string]any{"n": i})
		e.TenantID = tenantB
		items = append(items, Item{Source: Source{Topic: "case.events.v1"}, Env: e})
	}

	results, err := p.HandleBatch(context.Background(), items)
	if err != nil {
		t.Fatalf("handle batch: %v", err)
	}
	for i, r := range results {
		if r != nil {
			t.Fatalf("item %d: unexpected error %v", i, r)
		}
	}
	if len(ins.rows) != 5 {
		t.Fatalf("expected 5 rows, got %d", len(ins.rows))
	}
	seqByTenant := map[uuid.UUID][]uint64{}
	for _, r := range ins.rows {
		seqByTenant[r.TenantID] = append(seqByTenant[r.TenantID], r.ChainSeq)
	}
	if got := seqByTenant[tenantA]; len(got) != 3 || got[0] != 1 || got[2] != 3 {
		t.Fatalf("tenant A sequence wrong: %v", got)
	}
	if got := seqByTenant[tenantB]; len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("tenant B sequence wrong (leaked from tenant A?): %v", got)
	}
}

// TestHandleBatchTerminalErrorDoesNotBlockOtherItems: one malformed envelope
// in a batch must DLQ individually — it must not fail the transient-error
// path (which would pause the whole micro-batch) or prevent the other valid
// items in the same batch from being chained and stored.
func TestHandleBatchTerminalErrorDoesNotBlockOtherItems(t *testing.T) {
	ins, ch := &fakeInserter{}, &fakeChain{}
	p := &Processor{CH: ins, Chain: ch}

	good1 := env("case.assigned", map[string]any{"n": 1})
	bad := env("x.y", nil)
	bad.TenantID = uuid.Nil
	good2 := env("case.assigned", map[string]any{"n": 2})

	items := []Item{
		{Source: Source{Topic: "case.events.v1"}, Env: good1},
		{Source: Source{Topic: "case.events.v1"}, Env: bad},
		{Source: Source{Topic: "case.events.v1"}, Env: good2},
	}
	results, err := p.HandleBatch(context.Background(), items)
	if err != nil {
		t.Fatalf("handle batch: %v", err) // must NOT fail the whole batch
	}
	if results[0] != nil || results[2] != nil {
		t.Fatalf("valid items should succeed: %v / %v", results[0], results[2])
	}
	var term *TerminalError
	if !asTerminal(results[1], &term) || term.Reason != domain.ReasonEnvelopeInvalid {
		t.Fatalf("expected terminal ENVELOPE_INVALID for item 1, got %v", results[1])
	}
	if len(ins.rows) != 2 {
		t.Fatalf("expected the 2 valid items stored, got %d rows", len(ins.rows))
	}
}
