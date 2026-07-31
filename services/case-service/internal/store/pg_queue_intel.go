package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// QueueIntel is the approver's view of the queue: how old the backlog is, what
// is about to breach, how much is actually clearing, and how long a case sits
// before someone decides it.
//
// Composition, not new plumbing — every number here comes from columns `cases`
// already carries (created_at, due_date, assigned_to_at, resolved_at, status).
// Nothing is sampled or estimated; each field is a real aggregate over the
// caller's own workspace.
type QueueIntel struct {
	GeneratedAt time.Time `json:"generated_at"`
	WindowDays  int       `json:"window_days"`

	Open OpenCounts `json:"open"`
	// Aging buckets over OPEN cases only. A closed case has no age to worry
	// about, and mixing them in makes a cleared backlog look like a stuck one.
	Aging       []AgingBucket `json:"aging"`
	SLA         SLACounts     `json:"sla"`
	Throughput  Throughput    `json:"throughput"`
	Latency     Latency       `json:"latency"`
}

type OpenCounts struct {
	Total      int `json:"total"`
	Unassigned int `json:"unassigned"`
	InProgress int `json:"in_progress"`
}

type AgingBucket struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

type SLACounts struct {
	// Breached: past due and still open. Already a miss.
	Breached int `json:"breached"`
	// DueWithin24h: open, not yet breached, due inside a day. The actionable one —
	// this is the set an approver can still save.
	DueWithin24h int `json:"due_within_24h"`
}

type Throughput struct {
	Opened   int `json:"opened"`
	Resolved int `json:"resolved"`
	Closed   int `json:"closed"`
}

// Latency is time-to-decision over cases RESOLVED in the window, in seconds.
//
// Measured created_at → resolved_at, deliberately: the approver's question is
// "how long does a case wait before someone decides it", and assignment is part
// of that wait. Sample is the number of resolved cases the percentiles were
// computed from — reported so a p90 over three cases is visibly not a trend.
// Percentiles are null when nothing resolved in the window, never zero: "no
// data" and "instant" are different facts and zero would read as the latter.
type Latency struct {
	P50Seconds *int64 `json:"p50_seconds"`
	P90Seconds *int64 `json:"p90_seconds"`
	Sample     int    `json:"sample"`
}

// QueueIntelligence aggregates the queue for one workspace.
//
// Workspace-scoped by construction, matching the case surface's department
// isolation: an aggregate is still a disclosure, and counting another
// department's backlog would leak exactly what the /cases isolation rules
// exist to prevent. RLS pins the tenant underneath (withTenant).
func (s *PG) QueueIntelligence(ctx context.Context, tenant, workspace uuid.UUID, windowDays int) (QueueIntel, error) {
	if windowDays <= 0 {
		windowDays = 7
	}
	now := time.Now().UTC()
	since := now.AddDate(0, 0, -windowDays)
	out := QueueIntel{GeneratedAt: now, WindowDays: windowDays}

	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		// status: 0 draft, 1 in_progress, 2 resolved, 3 unassigned, 4 closed.
		// "Open" = not resolved and not closed, i.e. still someone's problem.
		const openPred = `workspace_id=$1 AND deleted_at IS NULL AND status NOT IN (2,4)`

		if err := tx.QueryRow(ctx, `SELECT
			count(*),
			count(*) FILTER (WHERE status=3),
			count(*) FILTER (WHERE status=1)
			FROM cases WHERE `+openPred, workspace).Scan(
			&out.Open.Total, &out.Open.Unassigned, &out.Open.InProgress); err != nil {
			return err
		}

		var b24, b72, b168, bOlder int
		if err := tx.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE created_at >  $2::timestamptz - interval '24 hours'),
			count(*) FILTER (WHERE created_at <= $2::timestamptz - interval '24 hours'
			                   AND created_at >  $2::timestamptz - interval '72 hours'),
			count(*) FILTER (WHERE created_at <= $2::timestamptz - interval '72 hours'
			                   AND created_at >  $2::timestamptz - interval '168 hours'),
			count(*) FILTER (WHERE created_at <= $2::timestamptz - interval '168 hours')
			FROM cases WHERE `+openPred, workspace, now).Scan(&b24, &b72, &b168, &bOlder); err != nil {
			return err
		}
		out.Aging = []AgingBucket{
			{Label: "under_24h", Count: b24},
			{Label: "1_to_3d", Count: b72},
			{Label: "3_to_7d", Count: b168},
			{Label: "over_7d", Count: bOlder},
		}

		if err := tx.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE due_date <= $2::timestamptz),
			count(*) FILTER (WHERE due_date >  $2::timestamptz AND due_date <= $2::timestamptz + interval '24 hours')
			FROM cases WHERE `+openPred, workspace, now).Scan(
			&out.SLA.Breached, &out.SLA.DueWithin24h); err != nil {
			return err
		}

		// Throughput counts EVENTS in the window, not current state: a case
		// opened and resolved inside the window is counted in both, because both
		// happened. Deleted cases are excluded everywhere.
		if err := tx.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE created_at  >= $2::timestamptz),
			count(*) FILTER (WHERE resolved_at >= $2::timestamptz),
			count(*) FILTER (WHERE closed_at   >= $2::timestamptz)
			FROM cases WHERE workspace_id=$1 AND deleted_at IS NULL`,
			workspace, since).Scan(
			&out.Throughput.Opened, &out.Throughput.Resolved, &out.Throughput.Closed); err != nil {
			return err
		}

		var p50, p90 *float64
		if err := tx.QueryRow(ctx, `SELECT
			count(*),
			percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at))),
			percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)))
			FROM cases
			WHERE workspace_id=$1 AND deleted_at IS NULL
			  AND resolved_at IS NOT NULL AND resolved_at >= $2::timestamptz
			  -- Guard against clock skew / backdated imports producing a negative
			  -- duration, which would drag a percentile below zero and read as a
			  -- case resolved before it existed.
			  AND resolved_at >= created_at`,
			workspace, since).Scan(&out.Latency.Sample, &p50, &p90); err != nil {
			return err
		}
		out.Latency.P50Seconds = secs(p50)
		out.Latency.P90Seconds = secs(p90)
		return nil
	})
	return out, err
}

// secs rounds a percentile to whole seconds, preserving NULL as nil so an empty
// window stays distinguishable from a zero-latency one.
func secs(v *float64) *int64 {
	if v == nil {
		return nil
	}
	n := int64(*v + 0.5)
	return &n
}
