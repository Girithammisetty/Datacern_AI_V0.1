package billing

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFSArtifactStore_PutWritesAndCreatesDirs(t *testing.T) {
	root := t.TempDir()
	s := NewFSArtifactStore(root)

	key := "billing/tenant-1/2026-07/1/meters.jsonl"
	data := []byte(`{"meter_key":"governed_decision"}` + "\n")
	require.NoError(t, s.Put(context.Background(), key, data))

	got, err := os.ReadFile(filepath.Join(root, key))
	require.NoError(t, err)
	assert.Equal(t, data, got)
}

func TestFSArtifactStore_VersionsDoNotCollide(t *testing.T) {
	root := t.TempDir()
	s := NewFSArtifactStore(root)
	ctx := context.Background()

	require.NoError(t, s.Put(ctx, "billing/t/2026-07/1/summary.csv", []byte("v1")))
	require.NoError(t, s.Put(ctx, "billing/t/2026-07/2/summary.csv", []byte("v2")))

	v1, err := os.ReadFile(filepath.Join(root, "billing/t/2026-07/1/summary.csv"))
	require.NoError(t, err)
	v2, err := os.ReadFile(filepath.Join(root, "billing/t/2026-07/2/summary.csv"))
	require.NoError(t, err)
	assert.Equal(t, "v1", string(v1)) // v1 untouched by the v2 write
	assert.Equal(t, "v2", string(v2))
}
