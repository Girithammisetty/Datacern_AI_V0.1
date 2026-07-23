// Package chain maintains the per-tenant-per-day tamper-evidence hash chain
// (AUD-FR-050): chain_hash = SHA-256(prev || event_id || payload_digest ||
// occurred_at), sequenced by a per-(tenant,day) monotonic counter. Correctness
// rests on three guarantees:
//
//   - Idempotent assignment (HIGH-1): the chain position for an event_id is
//     recorded durably BEFORE the ClickHouse insert, so a retry after a transient
//     ClickHouse failure (BR-6) reuses the SAME seq and re-attempts an idempotent
//     insert — never a phantom gap (AC-11).
//   - Distributed single-writer (HIGH-2): a Redis lock per (tenant, ingest-day)
//     serializes advances across replicas, so a tenant's events arriving on
//     different topic partitions/instances of the multi-topic ingest group can
//     never race the counter/head (BR-10).
//   - ClickHouse-anchored recovery: a cold counter reseeds from the durable
//     ClickHouse tip (max chain_seq), so Redis eviction/restart cannot regress or
//     duplicate the sequence.
//
// Ordering is the ingest sequence, not occurred_at (BR-2): the chain day is the
// UTC ingest day.
package chain

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/datacern-ai/audit-service/internal/domain"
	"github.com/datacern-ai/audit-service/internal/metrics"
	"github.com/datacern-ai/audit-service/internal/pgstore"
	"github.com/datacern-ai/go-common/redisx"
)

// ChainTipper returns the durable chain tip (max seq + its hash) for a day.
// Satisfied by *chstore.Store.
type ChainTipper interface {
	ChainTip(ctx context.Context, tenant uuid.UUID, chainDate string) (uint64, string, bool, error)
}

// Manager appends events to the chain.
type Manager struct {
	redis   *redisx.Client
	pg      *pgstore.Store
	tip     ChainTipper
	now     func() time.Time
	metrics *metrics.Metrics

	lockTTL time.Duration
	keyTTL  time.Duration
}

// New builds a Manager over real Redis + Postgres + the ClickHouse tip anchor.
func New(r *redisx.Client, pg *pgstore.Store, tip ChainTipper) *Manager {
	return &Manager{
		redis: r, pg: pg, tip: tip,
		now:     func() time.Time { return time.Now().UTC() },
		lockTTL: 15 * time.Second,
		keyTTL:  8 * 24 * time.Hour,
	}
}

// WithMetrics attaches the shared metrics bundle (BRD 58 SEC-2) so a failed
// chain_heads checkpoint write -- otherwise silently swallowed -- is at least
// counted. Optional: a nil metrics bundle (the zero-value Manager) leaves the
// counter untouched, matching prior behavior exactly.
func (m *Manager) WithMetrics(mx *metrics.Metrics) *Manager {
	m.metrics = mx
	return m
}

// Link is the chain position assigned to an event.
type Link struct {
	ChainDate string `json:"date"`
	Seq       uint64 `json:"seq"`
	Hash      string `json:"hash"`
}

var releaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`)

// Append assigns (idempotently) the next chain position for an event.
func (m *Manager) Append(ctx context.Context, tenant, eventID uuid.UUID, payloadDigest string, occurredAt time.Time) (Link, error) {
	date := m.now().Format("2006-01-02")
	assignKey := fmt.Sprintf("audit:chain:assign:%s:%s", tenant, eventID)

	// Fast path: this event already has an assigned position → reuse it (HIGH-1).
	if link, ok, err := m.getAssignment(ctx, assignKey); err != nil {
		return Link{}, err
	} else if ok {
		return link, nil
	}

	// Distributed single-writer lock per (tenant, ingest-day) (HIGH-2).
	lockKey := fmt.Sprintf("audit:chain:lock:%s:%s", tenant, date)
	token := uuid.NewString()
	if err := m.acquire(ctx, lockKey, token); err != nil {
		return Link{}, err
	}
	defer func() { _ = releaseScript.Run(ctx, m.redis.R, []string{lockKey}, token).Err() }()

	// Re-check under the lock (another writer may have assigned it meanwhile).
	if link, ok, err := m.getAssignment(ctx, assignKey); err != nil {
		return Link{}, err
	} else if ok {
		return link, nil
	}

	seqKey := fmt.Sprintf("audit:chain:seq:%s:%s", tenant, date)
	headKey := fmt.Sprintf("audit:chain:head:%s:%s", tenant, date)

	// Seed cold counters from the DURABLE ClickHouse tip (authoritative), so a
	// phantom Redis seq from a prior failed insert cannot outrun the store.
	exists, err := m.redis.Exists(ctx, seqKey)
	if err != nil {
		return Link{}, fmt.Errorf("chain seq check: %w", err)
	}
	if !exists {
		seedSeq, seedHead, err := m.seed(ctx, tenant, date)
		if err != nil {
			return Link{}, err
		}
		if err := m.redis.Set(ctx, seqKey, seedSeq, m.keyTTL); err != nil {
			return Link{}, err
		}
		if err := m.redis.Set(ctx, headKey, seedHead, m.keyTTL); err != nil {
			return Link{}, err
		}
	}

	seq, err := m.redis.R.Incr(ctx, seqKey).Result()
	if err != nil {
		return Link{}, fmt.Errorf("chain seq incr: %w", err)
	}
	_ = m.redis.R.Expire(ctx, seqKey, m.keyTTL)

	prev, _, err := m.redis.Get(ctx, headKey)
	if err != nil {
		return Link{}, fmt.Errorf("chain head read: %w", err)
	}
	if prev == "" {
		prev = domain.GenesisHash(tenant, date)
	}
	hash := domain.ChainHash(prev, eventID, payloadDigest, occurredAt)
	link := Link{ChainDate: date, Seq: uint64(seq), Hash: hash}

	// Commit the position durably BEFORE the head advances and before the caller
	// inserts to ClickHouse: a retry of this exact event now reuses this link.
	if err := m.putAssignment(ctx, assignKey, link); err != nil {
		return Link{}, fmt.Errorf("chain assignment persist: %w", err)
	}
	if err := m.redis.Set(ctx, headKey, hash, m.keyTTL); err != nil {
		return Link{}, err
	}
	// Postgres checkpoint is best-effort (sealed tracking + unsealed listing);
	// it is NOT authoritative for the sequence, so a transient PG error must not
	// fail ingest or advance the seq on retry.
	if err := m.pg.UpsertChainHead(ctx, tenant, date, hash, uint64(seq)); err != nil {
		// Not fatal: the live chain sequence reseeds from the ClickHouse tip,
		// not from this checkpoint. But this exact failure is what makes a day
		// invisible to the seal scheduler's ListUnsealedDays (BRD 58 SEC-2) --
		// counted so it's observable, and self-healed later by the export
		// scheduler's ClickHouse reconcile pass rather than lost forever.
		if m.metrics != nil {
			m.metrics.ChainHeadUpsertFailures.Inc()
		}
	}
	return link, nil
}

// BatchItem is one event's chain-append request within AppendBatch. All items
// in a call must belong to the same tenant (grouping is the caller's job —
// the chain is per-(tenant,day), so cross-tenant batching would gain nothing
// and only complicate the single lock hold below).
type BatchItem struct {
	EventID       uuid.UUID
	PayloadDigest string
	OccurredAt    time.Time
}

// AppendBatch assigns chain positions for many same-tenant events in one lock
// hold, one pipelined Redis round trip, and one Postgres checkpoint — instead
// of Append's per-event lock acquire/release + ~4 Redis round trips + 1
// Postgres upsert (B8, scalability audit: audit-service is the
// highest-volume consumer and this per-event cost was its throughput
// ceiling). Returns links in the same order as items. Result is identical to
// calling Append once per item under one continuously-held lock — this is
// purely a throughput optimization, not a behavior change.
func (m *Manager) AppendBatch(ctx context.Context, tenant uuid.UUID, items []BatchItem) ([]Link, error) {
	if len(items) == 0 {
		return nil, nil
	}
	if len(items) == 1 {
		link, err := m.Append(ctx, tenant, items[0].EventID, items[0].PayloadDigest, items[0].OccurredAt)
		if err != nil {
			return nil, err
		}
		return []Link{link}, nil
	}

	date := m.now().Format("2006-01-02")
	links := make([]Link, len(items))
	assignKeys := make([]string, len(items))
	for i, it := range items {
		assignKeys[i] = fmt.Sprintf("audit:chain:assign:%s:%s", tenant, it.EventID)
	}

	// Fast path (mirrors Append's single-event fast path): a batch redelivered
	// after a crash between "Redis committed" and "Kafka offset committed" may
	// find some or all of its events already assigned. No lock needed to read.
	pending, err := m.batchMissingAssignments(ctx, assignKeys, links)
	if err != nil {
		return nil, err
	}
	if len(pending) == 0 {
		return links, nil
	}

	lockKey := fmt.Sprintf("audit:chain:lock:%s:%s", tenant, date)
	token := uuid.NewString()
	if err := m.acquire(ctx, lockKey, token); err != nil {
		return nil, err
	}
	defer func() { _ = releaseScript.Run(ctx, m.redis.R, []string{lockKey}, token).Err() }()

	// Re-check under the lock: another replica may have assigned some of the
	// still-pending items between our first check and acquiring the lock.
	pending, err = m.batchMissingAssignments(ctx, subsetOf(assignKeys, pending), links, pending...)
	if err != nil {
		return nil, err
	}
	if len(pending) == 0 {
		return links, nil
	}

	seqKey := fmt.Sprintf("audit:chain:seq:%s:%s", tenant, date)
	headKey := fmt.Sprintf("audit:chain:head:%s:%s", tenant, date)

	exists, err := m.redis.Exists(ctx, seqKey)
	if err != nil {
		return nil, fmt.Errorf("chain seq check: %w", err)
	}
	var seq uint64
	var prev string
	if !exists {
		seq, prev, err = m.seed(ctx, tenant, date)
		if err != nil {
			return nil, err
		}
	} else {
		seqStr, _, err := m.redis.Get(ctx, seqKey)
		if err != nil {
			return nil, fmt.Errorf("chain seq read: %w", err)
		}
		seq, _ = strconv.ParseUint(seqStr, 10, 64)
		headStr, ok, err := m.redis.Get(ctx, headKey)
		if err != nil {
			return nil, fmt.Errorf("chain head read: %w", err)
		}
		if ok {
			prev = headStr
		} else {
			prev = domain.GenesisHash(tenant, date)
		}
	}

	// Assign every still-pending item IN ORDER off one local running counter
	// and running prev-hash, then write everything back in one atomic
	// pipeline (MULTI/EXEC) — stronger than Append's original sequence of
	// separate SET calls, since a mid-write crash here can no longer land
	// between "assignment written" and "head advanced" for different events.
	pipe := m.redis.R.TxPipeline()
	for _, idx := range pending {
		it := items[idx]
		seq++
		hash := domain.ChainHash(prev, it.EventID, it.PayloadDigest, it.OccurredAt)
		link := Link{ChainDate: date, Seq: seq, Hash: hash}
		links[idx] = link
		prev = hash
		b, _ := json.Marshal(link)
		pipe.Set(ctx, assignKeys[idx], string(b), m.keyTTL)
	}
	pipe.Set(ctx, seqKey, seq, m.keyTTL)
	pipe.Set(ctx, headKey, prev, m.keyTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, fmt.Errorf("chain batch persist: %w", err)
	}

	// Postgres checkpoint: one upsert for the whole group's final state,
	// same best-effort tolerance as Append (see its comment) — the live
	// sequence always reseeds from the durable ClickHouse tip, never from
	// this checkpoint.
	if err := m.pg.UpsertChainHead(ctx, tenant, date, prev, seq); err != nil {
		if m.metrics != nil {
			m.metrics.ChainHeadUpsertFailures.Inc()
		}
	}
	return links, nil
}

// batchMissingAssignments pipelines a GET per key in keys and fills links at
// the corresponding original index (from origIdx, or 0..len(keys)-1 when
// origIdx is empty) for every hit. Returns the original indices that missed.
func (m *Manager) batchMissingAssignments(ctx context.Context, keys []string, links []Link, origIdx ...int) ([]int, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	pipe := m.redis.R.Pipeline()
	cmds := make([]*redis.StringCmd, len(keys))
	for i, k := range keys {
		cmds[i] = pipe.Get(ctx, k)
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("chain batch assignment check: %w", err)
	}
	var missing []int
	for i, cmd := range cmds {
		idx := i
		if len(origIdx) > 0 {
			idx = origIdx[i]
		}
		raw, err := cmd.Result()
		if err != nil {
			missing = append(missing, idx)
			continue
		}
		var link Link
		if json.Unmarshal([]byte(raw), &link) != nil {
			missing = append(missing, idx)
			continue
		}
		links[idx] = link
	}
	return missing, nil
}

// subsetOf returns the elements of full at each index in idx.
func subsetOf(full []string, idx []int) []string {
	out := make([]string, len(idx))
	for i, j := range idx {
		out[i] = full[j]
	}
	return out
}

// seed computes the cold-start (seq, head) for a day from the durable store.
func (m *Manager) seed(ctx context.Context, tenant uuid.UUID, date string) (uint64, string, error) {
	if m.tip != nil {
		seq, hash, ok, err := m.tip.ChainTip(ctx, tenant, date)
		if err != nil {
			return 0, "", fmt.Errorf("chain tip: %w", err)
		}
		if ok {
			return seq, hash, nil
		}
	}
	return 0, domain.GenesisHash(tenant, date), nil
}

func (m *Manager) getAssignment(ctx context.Context, key string) (Link, bool, error) {
	raw, ok, err := m.redis.Get(ctx, key)
	if err != nil {
		return Link{}, false, err
	}
	if !ok {
		return Link{}, false, nil
	}
	var link Link
	if json.Unmarshal([]byte(raw), &link) != nil {
		return Link{}, false, nil
	}
	return link, true, nil
}

func (m *Manager) putAssignment(ctx context.Context, key string, link Link) error {
	b, _ := json.Marshal(link)
	return m.redis.Set(ctx, key, string(b), m.keyTTL)
}

// acquire spins on a Redis SETNX lock until held or ctx is cancelled.
func (m *Manager) acquire(ctx context.Context, key, token string) error {
	backoff := 5 * time.Millisecond
	for {
		ok, err := m.redis.R.SetNX(ctx, key, token, m.lockTTL).Result()
		if err != nil {
			return fmt.Errorf("chain lock: %w", err)
		}
		if ok {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 200*time.Millisecond {
			backoff *= 2
		}
	}
}

// VerifyResult is the outcome of a chain replay (AUD-FR-051).
type VerifyResult struct {
	Valid         bool    `json:"valid"`
	EventsChecked uint64  `json:"events_checked"`
	ChainHead     string  `json:"chain_head"`
	ManifestMatch bool    `json:"manifest_match"`
	FirstMismatch *uint64 `json:"first_mismatch_seq,omitempty"`
	Sealed        bool    `json:"sealed"`
}

// Verify recomputes the chain for (tenant, date) from the stored rows and
// compares to each row's stored chain_hash and the sealed head (AUD-FR-051). It
// also detects a broken sequence (gap/duplicate). Any mutation of
// payload_digest/occurred_at/ordering surfaces as a mismatch.
func Verify(rows []domain.Record, tenant uuid.UUID, date, sealedHead string) VerifyResult {
	res := VerifyResult{Valid: true}
	prev := domain.GenesisHash(tenant, date)
	var expectedSeq uint64 = 1
	for _, r := range rows {
		res.EventsChecked++
		if r.ChainSeq != expectedSeq {
			// Gap or duplicate in the sequence — the chain is not contiguous.
			seq := r.ChainSeq
			res.Valid = false
			res.FirstMismatch = &seq
			res.ChainHead = prev
			return res
		}
		want := domain.ChainHash(prev, r.EventID, r.PayloadDigest, r.OccurredAt)
		if want != r.ChainHash {
			seq := r.ChainSeq
			res.Valid = false
			res.FirstMismatch = &seq
			res.ChainHead = prev
			return res
		}
		prev = r.ChainHash
		expectedSeq++
	}
	res.ChainHead = prev
	if sealedHead != "" {
		res.ManifestMatch = prev == sealedHead
		if !res.ManifestMatch {
			res.Valid = false
		}
	}
	return res
}
