package api_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datacern-ai/case-service/internal/api"
	"github.com/datacern-ai/case-service/internal/authz"
	"github.com/datacern-ai/case-service/internal/store"
)

// The comment routes' HTTP contract (CASE-FR-024 + the BFF list-comments
// contract gap), exercised through the REAL chi router — route registration,
// auth middleware, envelopes — against a REAL Postgres with the service's own
// migrations. Same CASE_TEST_DATABASE_URL gate as the store tier: skips when
// unset so plain `go test ./...` stays hermetic, and the skip message says so
// rather than quietly passing. Authz is the permissive test double; tokens are
// real RS256 JWTs against the static verifier.

type commentHarness struct {
	srv  *httptest.Server
	pool *pgxpool.Pool
	key  *rsa.PrivateKey
}

func newCommentHarness(t *testing.T) *commentHarness {
	t.Helper()
	dsn := os.Getenv("CASE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("CASE_TEST_DATABASE_URL unset — comment HTTP contract NOT verified in this run")
	}
	if err := store.Migrate(dsn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa key: %v", err)
	}
	s := &api.Server{
		Store:    store.NewPG(pool),
		Authz:    authz.AllowAll{},
		Verifier: api.NewVerifierStatic(&key.PublicKey, "datacern-test", "datacern"),
	}
	srv := httptest.NewServer(s.Router())
	t.Cleanup(func() { srv.Close(); pool.Close() })
	return &commentHarness{srv: srv, pool: pool, key: key}
}

func (h *commentHarness) token(t *testing.T, tenant uuid.UUID, sub string) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "tenant_id": tenant.String(), "typ": "user",
		"iss": "datacern-test", "aud": "datacern", "exp": time.Now().Add(5 * time.Minute).Unix(),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

// seedCommentCase inserts one case directly (status=unassigned so the
// no-assignee schema constraint holds) — the comment routes need an existing
// case, not the whole create-cases pipeline.
func (h *commentHarness) seedCommentCase(t *testing.T, tenant uuid.UUID, n int64) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	id := uuid.New()
	now := time.Now().UTC()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cases
		(id, tenant_id, workspace_id, case_number, status, severity, created_by_id,
		 dataset_urn, row_pk, display_projection, source_query_urns, due_date,
		 custom_fields, created_at, updated_at)
		VALUES ($1,$2,$3,$4,3,'high','u-seed','wr:t:dataset:dataset/d',$5,'{}','{}',$6,'{}',$7,$7)`,
		id, tenant, uuid.New(), n, fmt.Sprintf("ROW-%d", n), now.Add(24*time.Hour), now); err != nil {
		t.Fatalf("seed case: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return id
}

func (h *commentHarness) do(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, rdr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return res.StatusCode, out
}

func dataObj(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	d, ok := out["data"].(map[string]any)
	if !ok {
		t.Fatalf("response must use the standard data envelope, got %v", out)
	}
	return d
}

func dataList(t *testing.T, out map[string]any) []any {
	t.Helper()
	d, ok := out["data"].([]any)
	if !ok {
		t.Fatalf("list must use the standard data envelope with an array, got %v", out)
	}
	return d
}

// GET /cases/{id}/comments: non-deleted comments, newest-first, full fields —
// and a DELETEd comment disappears from subsequent lists.
func TestListCommentsRouteNewestFirstAndDeleteExcluded(t *testing.T) {
	h := newCommentHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "alice")
	caseID := h.seedCommentCase(t, tenant, 1)
	base := "/api/v1/cases/" + caseID.String() + "/comments"

	st, _ := h.do(t, "POST", base, tok, map[string]any{"body": "first"})
	if st != http.StatusCreated {
		t.Fatalf("POST comment 1 = %d, want 201", st)
	}
	time.Sleep(2 * time.Millisecond) // distinct created_at for a deterministic order
	st, _ = h.do(t, "POST", base, tok, map[string]any{"body": "second"})
	if st != http.StatusCreated {
		t.Fatalf("POST comment 2 = %d, want 201", st)
	}

	st, out := h.do(t, "GET", base, tok, nil)
	if st != http.StatusOK {
		t.Fatalf("GET comments = %d, want 200 (body %v)", st, out)
	}
	list := dataList(t, out)
	if len(list) != 2 {
		t.Fatalf("got %d comments, want 2", len(list))
	}
	newest := list[0].(map[string]any)
	oldest := list[1].(map[string]any)
	if newest["body"] != "second" || oldest["body"] != "first" {
		t.Errorf("must be newest-first: got [%v, %v]", newest["body"], oldest["body"])
	}
	// Full comment objects, not stubs — this is exactly what the BFF gap was.
	for _, k := range []string{"id", "case_id", "author_id", "created_at"} {
		if v, ok := newest[k].(string); !ok || v == "" {
			t.Errorf("list item missing %q: %v", k, newest)
		}
	}
	if newest["case_id"] != caseID.String() || newest["author_id"] != "alice" {
		t.Errorf("case_id/author_id wrong: %v", newest)
	}

	// Delete the newest (author within the 15m window) → excluded from the list.
	st, _ = h.do(t, "DELETE", "/api/v1/comments/"+newest["id"].(string), tok, nil)
	if st != http.StatusNoContent {
		t.Fatalf("DELETE comment = %d, want 204", st)
	}
	st, out = h.do(t, "GET", base, tok, nil)
	if st != http.StatusOK {
		t.Fatalf("GET after delete = %d, want 200", st)
	}
	list = dataList(t, out)
	if len(list) != 1 || list[0].(map[string]any)["body"] != "first" {
		t.Fatalf("deleted comment must be excluded: got %v", list)
	}
}

// Pagination: ?limit caps the page and ?before (RFC3339, exclusive) resumes
// from the last created_at the client saw.
func TestListCommentsRoutePaginationBefore(t *testing.T) {
	h := newCommentHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "alice")
	caseID := h.seedCommentCase(t, tenant, 2)
	base := "/api/v1/cases/" + caseID.String() + "/comments"

	for _, b := range []string{"c1", "c2", "c3"} {
		st, _ := h.do(t, "POST", base, tok, map[string]any{"body": b})
		if st != http.StatusCreated {
			t.Fatalf("POST %s = %d, want 201", b, st)
		}
		time.Sleep(2 * time.Millisecond)
	}

	st, out := h.do(t, "GET", base+"?limit=2", tok, nil)
	if st != http.StatusOK {
		t.Fatalf("GET page 1 = %d, want 200", st)
	}
	page1 := dataList(t, out)
	if len(page1) != 2 {
		t.Fatalf("limit=2 returned %d items", len(page1))
	}
	if page1[0].(map[string]any)["body"] != "c3" || page1[1].(map[string]any)["body"] != "c2" {
		t.Fatalf("page 1 wrong: %v", page1)
	}

	cursor := page1[1].(map[string]any)["created_at"].(string)
	st, out = h.do(t, "GET", base+"?limit=2&before="+url.QueryEscape(cursor), tok, nil)
	if st != http.StatusOK {
		t.Fatalf("GET page 2 = %d, want 200", st)
	}
	page2 := dataList(t, out)
	if len(page2) != 1 || page2[0].(map[string]any)["body"] != "c1" {
		t.Fatalf("before-cursor page wrong (boundary row must not repeat): %v", page2)
	}
}

func TestListCommentsRouteUnknownCase404(t *testing.T) {
	h := newCommentHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "alice")

	st, out := h.do(t, "GET", "/api/v1/cases/"+uuid.NewString()+"/comments", tok, nil)
	if st != http.StatusNotFound {
		t.Fatalf("unknown case = %d, want 404 (body %v)", st, out)
	}
	if _, ok := out["error"].(map[string]any); !ok {
		t.Fatalf("404 must carry the error envelope, got %v", out)
	}
}

// PATCH /comments/{cid} echoes the FULL updated comment — case_id, author_id
// and created_at were previously dropped ({id, body} only), which nulled those
// fields on the BFF's updateCaseComment response.
func TestEditCommentEchoesFullComment(t *testing.T) {
	h := newCommentHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "alice")
	caseID := h.seedCommentCase(t, tenant, 3)
	base := "/api/v1/cases/" + caseID.String() + "/comments"

	st, created := h.do(t, "POST", base, tok, map[string]any{"body": "orig"})
	if st != http.StatusCreated {
		t.Fatalf("POST comment = %d, want 201", st)
	}
	cid := dataObj(t, created)["id"].(string)

	st, out := h.do(t, "PATCH", "/api/v1/comments/"+cid, tok, map[string]any{"body": "edited"})
	if st != http.StatusOK {
		t.Fatalf("PATCH comment = %d, want 200 (body %v)", st, out)
	}
	d := dataObj(t, out)
	if d["id"] != cid || d["body"] != "edited" {
		t.Errorf("id/body wrong: %v", d)
	}
	if d["case_id"] != caseID.String() {
		t.Errorf("PATCH must echo case_id, got %v", d["case_id"])
	}
	if d["author_id"] != "alice" {
		t.Errorf("PATCH must echo author_id, got %v", d["author_id"])
	}
	if v, ok := d["created_at"].(string); !ok || v == "" {
		t.Errorf("PATCH must echo created_at, got %v", d["created_at"])
	}
	if v, ok := d["edited_at"].(string); !ok || v == "" {
		t.Errorf("edited_at must be set after an edit, got %v", d["edited_at"])
	}
}
