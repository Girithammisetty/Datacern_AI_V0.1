// Package leaderlease is the real leader-election primitive BRD 70's TTL
// reaper needs (§2.5): a Redis SET-NX-PX lease with periodic renewal, CAS'd
// on release/renew via a Lua script so a pod can never delete or extend a
// lease it no longer holds. This mirrors
// services/realtime-hub/internal/fanout/lease.go's proven pattern
// (RTH-FR-042) byte-for-byte in shape -- it is duplicated rather than
// imported cross-service (each Go service vendors its own copy of small
// cross-cutting helpers per docs/platform/CONVENTIONS.md's wave-1 rule,
// pending a libs/go-common extraction). This is the platform's SECOND real
// leader-election adapter and the design's shared prerequisite (§2.5, "no
// such pattern exists yet in this codebase") a future extraction should
// generalize from these two proven copies rather than from a fresh design.
package leaderlease

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Lease implements domain.LeaseChecker: exactly one process holding the
// named resource's lease is the leader at any moment (barring the lease's
// own TTL expiry window), so only one identity-service replica's DemoReaper
// ticks a given sweep.
type Lease struct {
	rdb    redis.UniversalClient
	key    string
	holder string
	ttl    time.Duration
	held   atomic.Bool
}

// NewLease builds a lease for a named resource, owned by holder (typically
// a pod/process id). ttl defaults to 15s if zero -- longer than realtime-hub's
// 5s fanout lease (RTH-FR-042) since the reaper's own sweep interval
// (§2.5, "minute-or-coarser") is far coarser than fanout's per-event work,
// so the lease only needs to survive between renewals, not sub-second work.
func NewLease(rdb redis.UniversalClient, resource, holder string, ttl time.Duration) *Lease {
	if ttl <= 0 {
		ttl = 15 * time.Second
	}
	return &Lease{rdb: rdb, key: "identity:leader:" + resource, holder: holder, ttl: ttl}
}

// IsLeader reports whether this process currently holds the lease.
func (l *Lease) IsLeader() bool { return l.held.Load() }

// Run campaigns for and renews the lease until ctx is cancelled, at half the
// TTL (so a missed renewal cycle still has margin before the key expires).
func (l *Lease) Run(ctx context.Context) {
	t := time.NewTicker(l.ttl / 2)
	defer t.Stop()
	l.tryAcquire(ctx)
	for {
		select {
		case <-ctx.Done():
			l.release(context.Background())
			return
		case <-t.C:
			l.tryAcquire(ctx)
		}
	}
}

func (l *Lease) tryAcquire(ctx context.Context) {
	if l.held.Load() {
		if renewLease(ctx, l.rdb, l.key, l.holder, l.ttl) {
			return
		}
		l.held.Store(false)
	}
	ok, err := l.rdb.SetNX(ctx, l.key, l.holder, l.ttl).Result()
	if err == nil && ok {
		l.held.Store(true)
	}
}

func (l *Lease) release(ctx context.Context) {
	if !l.held.Load() {
		return
	}
	_ = releaseScript.Run(ctx, l.rdb, []string{l.key}, l.holder).Err()
	l.held.Store(false)
}

var renewScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`)

var releaseScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`)

func renewLease(ctx context.Context, rdb redis.UniversalClient, key, holder string, ttl time.Duration) bool {
	n, err := renewScript.Run(ctx, rdb, []string{key}, holder, ttl.Milliseconds()).Int()
	return err == nil && n == 1
}
