package billing

import (
	"context"
	"os"
	"path/filepath"
)

// ArtifactStore persists billing artifacts durably (design §2.7). Kept to a
// bare Put(key, data) — the list API surfaces keys + checksums, and a signed
// download endpoint is a later addition; the close job only needs the bytes
// written durably before the DB records their keys ("file path is truth",
// VMB-FR-022/AC-6). The prod adapter wraps go-common/objectstore (S3/MinIO),
// mirroring jobs.MinioBillStore; FSArtifactStore is the local/dev equivalent.
type ArtifactStore interface {
	Put(ctx context.Context, key string, data []byte) error
}

// FSArtifactStore writes artifacts under a filesystem root (dev/self-host).
// Keys are relative object paths (billing/<tenant>/<period>/<version>/…); the
// store creates intermediate directories and never overwrites across versions
// because the version segment differs.
type FSArtifactStore struct {
	Root string
}

// NewFSArtifactStore builds an FSArtifactStore, creating Root if needed.
func NewFSArtifactStore(root string) *FSArtifactStore {
	_ = os.MkdirAll(root, 0o755)
	return &FSArtifactStore{Root: root}
}

// Put writes data at key under Root.
func (s *FSArtifactStore) Put(_ context.Context, key string, data []byte) error {
	path := filepath.Join(s.Root, filepath.Clean("/"+key))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
