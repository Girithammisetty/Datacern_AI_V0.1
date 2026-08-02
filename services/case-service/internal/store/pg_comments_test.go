package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datacern-ai/case-service/internal/store"
)

// ListComments (CASE-FR-024), exercised against a REAL Postgres with the
// service's own migrations applied — same tier and gate as the
// queue-intelligence tests (skips when CASE_TEST_DATABASE_URL is unset). The
// claims here are SQL semantics: soft-delete filtering, newest-first ordering,
// keyset pagination via `before`, and the case-visibility 404 pre-check.

// seedComment inserts one comment directly with an explicit created_at (and
// optional soft delete), so ordering/pagination tests state their own clock
// instead of depending on the API's.
func seedComment(t *testing.T, pool *pgxpool.Pool, tenant, caseID uuid.UUID,
	author, body string, createdAgo time.Duration, deleted bool) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	id := uuid.New()
	now := time.Now().UTC()
	var deletedAt *time.Time
	if deleted {
		deletedAt = &now
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO case_comments
		(id, tenant_id, case_id, author_id, body, created_at, deleted_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		id, tenant, caseID, author, body, now.Add(-createdAgo), deletedAt); err != nil {
		t.Fatalf("seed comment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return id
}

func TestListCommentsNewestFirstExcludesDeleted(t *testing.T) {
	pool, done := testPool(t)
	defer done()
	st := store.NewPG(pool)
	ctx := context.Background()
	tenant, ws := uuid.New(), uuid.New()
	hour := time.Hour
	caseID := seedCase(t, pool, tenant, ws, 1, 1, 24*hour, 24*hour, nil, nil)

	oldest := seedComment(t, pool, tenant, caseID, "alice", "first", 3*hour, false)
	middle := seedComment(t, pool, tenant, caseID, "bob", "second", 2*hour, false)
	newest := seedComment(t, pool, tenant, caseID, "alice", "third", 1*hour, false)
	deletedID := seedComment(t, pool, tenant, caseID, "mallory", "gone", 30*time.Minute, true)

	got, err := st.ListComments(ctx, tenant, caseID, 50, nil)
	if err != nil {
		t.Fatalf("ListComments: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d comments, want 3 (soft-deleted excluded)", len(got))
	}
	wantOrder := []uuid.UUID{newest, middle, oldest}
	for i, id := range wantOrder {
		if got[i].ID != id {
			t.Errorf("position %d = %s, want %s — must be newest-first", i, got[i].ID, id)
		}
	}
	for _, c := range got {
		if c.ID == deletedID {
			t.Error("soft-deleted comment leaked into the list")
		}
	}
	// Full fields round-trip: the API returns these structs verbatim, so a
	// missing scan column would surface as a zero value downstream.
	if got[0].Body != "third" || got[0].AuthorID != "alice" || got[0].CaseID != caseID || got[0].CreatedAt.IsZero() {
		t.Errorf("comment fields wrong: %+v", got[0])
	}
}

func TestListCommentsPaginationBefore(t *testing.T) {
	pool, done := testPool(t)
	defer done()
	st := store.NewPG(pool)
	ctx := context.Background()
	tenant, ws := uuid.New(), uuid.New()
	hour := time.Hour
	caseID := seedCase(t, pool, tenant, ws, 2, 1, 24*hour, 24*hour, nil, nil)

	oldest := seedComment(t, pool, tenant, caseID, "alice", "c1", 3*hour, false)
	middle := seedComment(t, pool, tenant, caseID, "alice", "c2", 2*hour, false)
	newest := seedComment(t, pool, tenant, caseID, "alice", "c3", 1*hour, false)

	page1, err := st.ListComments(ctx, tenant, caseID, 2, nil)
	if err != nil {
		t.Fatalf("ListComments page 1: %v", err)
	}
	if len(page1) != 2 || page1[0].ID != newest || page1[1].ID != middle {
		t.Fatalf("page 1 wrong: got %d items, want [newest, middle]", len(page1))
	}
	// A client pages with the last created_at it saw; `before` is strictly
	// exclusive, so the boundary row must not repeat on page 2.
	cursor := page1[1].CreatedAt
	page2, err := st.ListComments(ctx, tenant, caseID, 2, &cursor)
	if err != nil {
		t.Fatalf("ListComments page 2: %v", err)
	}
	if len(page2) != 1 || page2[0].ID != oldest {
		t.Fatalf("page 2 wrong: got %d items, want exactly [oldest]", len(page2))
	}
}

func TestListCommentsUnknownCaseIsNotFound(t *testing.T) {
	pool, done := testPool(t)
	defer done()
	st := store.NewPG(pool)

	_, err := st.ListComments(context.Background(), uuid.New(), uuid.New(), 50, nil)
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown case must be ErrNotFound (→ 404), got %v", err)
	}
}
