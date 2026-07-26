package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/rbac-service/internal/entitlements"
)

// fakeCapReader is the CapReader test seam (CPL-FR-031) -- lets
// checkWorkspaceCap be unit-tested without a live Redis/Postgres, mirroring
// the fake-writer/fake-store seams used elsewhere in this repo's unit tiers.
type fakeCapReader struct {
	status entitlements.Status
	limit  int
	err    error
}

func (f fakeCapReader) WorkspaceCapStatus(context.Context, string) (entitlements.Status, int, error) {
	return f.status, f.limit, f.err
}

func decodeErr(t *testing.T, rec *httptest.ResponseRecorder) ErrorBody {
	t.Helper()
	var body ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body
}

// A missing/unreachable projection must fail CLOSED (CPL-NFR-004): the
// handler never reaches the store, and the caller sees 503
// ENTITLEMENT_UNAVAILABLE, not a silent pass-through.
func TestCheckWorkspaceCap_Unavailable_FailsClosed(t *testing.T) {
	s := &Server{Entitlements: fakeCapReader{status: entitlements.StatusUnavailable}}
	req := httptest.NewRequest("POST", "/api/v1/workspaces", nil)
	rec := httptest.NewRecorder()

	ok := s.checkWorkspaceCap(rec, req, uuid.New())

	assert.False(t, ok)
	assert.Equal(t, 503, rec.Code)
	body := decodeErr(t, rec)
	assert.Equal(t, CodeEntitlementUnavailable, body.Error.Code)
}

// A Redis error surfacing from the reader is treated identically to an
// absent key -- fail closed, never silently entitled.
func TestCheckWorkspaceCap_ReaderError_FailsClosed(t *testing.T) {
	s := &Server{Entitlements: fakeCapReader{err: errors.New("redis down")}}
	req := httptest.NewRequest("POST", "/api/v1/workspaces", nil)
	rec := httptest.NewRecorder()

	ok := s.checkWorkspaceCap(rec, req, uuid.New())

	assert.False(t, ok)
	assert.Equal(t, 503, rec.Code)
	assert.Equal(t, CodeEntitlementUnavailable, decodeErr(t, rec).Error.Code)
}

// No Entitlements reader wired at all (e.g. REDIS_ADDR unset) is the same
// fail-closed 503, not a nil-pointer panic.
func TestCheckWorkspaceCap_NilEntitlements_FailsClosed(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest("POST", "/api/v1/workspaces", nil)
	rec := httptest.NewRecorder()

	ok := s.checkWorkspaceCap(rec, req, uuid.New())

	assert.False(t, ok)
	assert.Equal(t, 503, rec.Code)
}

// A tenant with no workspace_cap entitlement configured is unlimited: the
// gate passes without ever touching the store's workspace count.
func TestCheckWorkspaceCap_Unlimited_Passes(t *testing.T) {
	s := &Server{Entitlements: fakeCapReader{status: entitlements.StatusUnlimited}}
	req := httptest.NewRequest("POST", "/api/v1/workspaces", nil)
	rec := httptest.NewRecorder()

	ok := s.checkWorkspaceCap(rec, req, uuid.New())

	assert.True(t, ok)
	assert.Equal(t, 200, rec.Code) // nothing written on the pass path
}

// The under/at/over-limit boundary itself (CPL-FR-031, mirrors AC-3's
// seat_cap example) is covered directly against entitlements.CapExceeded in
// internal/entitlements -- the store-backed "current active workspace count"
// half of this path needs live Postgres (CountActiveWorkspaces), so it is
// exercised in the Docker-gated integration tier, not here.
