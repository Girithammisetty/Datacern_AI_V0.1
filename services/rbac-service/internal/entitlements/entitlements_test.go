package entitlements

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKey(t *testing.T) {
	assert.Equal(t, "ent:t-1:flat", Key("t-1"))
}

func TestParseFlat_ExtractsWorkspaceCap(t *testing.T) {
	raw := []byte(`{"v":1,"computed_at":"2026-07-25T00:00:00Z","plan_key":"pilot",
		"plan_version":1,"commercial_state":"active",
		"entitlements":[
			{"kind":"seat_cap","key":"seats","value":{"n":15},"provenance":"plan_default"},
			{"kind":"workspace_cap","key":"workspaces","value":{"n":5},"provenance":"plan_default"}
		]}`)
	f, err := ParseFlat(raw)
	require.NoError(t, err)
	assert.Equal(t, "active", f.CommercialState)
	limit, found := f.WorkspaceCap()
	assert.True(t, found)
	assert.Equal(t, 5, limit)
}

func TestParseFlat_NoWorkspaceCapEntitlement_IsUnlimited(t *testing.T) {
	raw := []byte(`{"v":1,"commercial_state":"active","entitlements":[
		{"kind":"seat_cap","key":"seats","value":{"n":15},"provenance":"plan_default"}
	]}`)
	f, err := ParseFlat(raw)
	require.NoError(t, err)
	_, found := f.WorkspaceCap()
	assert.False(t, found, "absent workspace_cap entitlement means unlimited, not blocked")
}

func TestParseFlat_EmptyEntitlements(t *testing.T) {
	f, err := ParseFlat([]byte(`{"v":1,"commercial_state":"trial","entitlements":[]}`))
	require.NoError(t, err)
	_, found := f.WorkspaceCap()
	assert.False(t, found)
}

func TestParseFlat_MalformedJSON(t *testing.T) {
	_, err := ParseFlat([]byte(`not json`))
	assert.Error(t, err)
}

func TestFlat_WorkspaceCap_MalformedValue_TreatedAsZero(t *testing.T) {
	f, err := ParseFlat([]byte(`{"entitlements":[{"kind":"workspace_cap","key":"workspaces","value":{}}]}`))
	require.NoError(t, err)
	limit, found := f.WorkspaceCap()
	assert.True(t, found)
	assert.Equal(t, 0, limit)
}

// ---- Reader (against a real miniredis instance -- no Docker required) -----

func newTestReader(t *testing.T) (*Reader, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return NewReader(rdb), mr
}

func TestReader_WorkspaceCapStatus_Capped(t *testing.T) {
	r, mr := newTestReader(t)
	require.NoError(t, mr.Set(Key("t-1"), `{"commercial_state":"active","entitlements":[
		{"kind":"workspace_cap","key":"workspaces","value":{"n":5}}
	]}`))
	status, limit, err := r.WorkspaceCapStatus(context.Background(), "t-1")
	require.NoError(t, err)
	assert.Equal(t, StatusCapped, status)
	assert.Equal(t, 5, limit)
}

func TestReader_WorkspaceCapStatus_Unlimited(t *testing.T) {
	r, mr := newTestReader(t)
	require.NoError(t, mr.Set(Key("t-1"), `{"commercial_state":"active","entitlements":[]}`))
	status, _, err := r.WorkspaceCapStatus(context.Background(), "t-1")
	require.NoError(t, err)
	assert.Equal(t, StatusUnlimited, status)
}

func TestReader_WorkspaceCapStatus_MissingKey_FailsClosed(t *testing.T) {
	r, _ := newTestReader(t)
	status, _, err := r.WorkspaceCapStatus(context.Background(), "no-such-tenant")
	require.NoError(t, err)
	assert.Equal(t, StatusUnavailable, status)
}

func TestReader_WorkspaceCapStatus_CorruptEntry_FailsClosed(t *testing.T) {
	r, mr := newTestReader(t)
	require.NoError(t, mr.Set(Key("t-1"), `not json`))
	status, _, err := r.WorkspaceCapStatus(context.Background(), "t-1")
	require.NoError(t, err)
	assert.Equal(t, StatusUnavailable, status)
}

func TestReader_WorkspaceCapStatus_RedisDown_FailsClosed(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"}) // nothing listening
	defer func() { _ = rdb.Close() }()
	r := NewReader(rdb)
	status, _, err := r.WorkspaceCapStatus(context.Background(), "t-1")
	assert.Error(t, err)
	assert.Equal(t, StatusUnavailable, status)
}

func TestCapExceeded_UnderAtOverLimit(t *testing.T) {
	assert.False(t, CapExceeded(3, 5), "under limit: not exceeded")
	assert.True(t, CapExceeded(5, 5), "at limit: the NEXT create is blocked")
	assert.True(t, CapExceeded(6, 5), "over limit: exceeded")
	assert.False(t, CapExceeded(0, 5), "zero active, positive cap: not exceeded")
	assert.True(t, CapExceeded(1, 0), "zero cap: any active workspace exceeds it")
}

func TestReader_NilReader_FailsClosed(t *testing.T) {
	var r *Reader
	status, _, err := r.WorkspaceCapStatus(context.Background(), "t-1")
	require.NoError(t, err)
	assert.Equal(t, StatusUnavailable, status)
}
