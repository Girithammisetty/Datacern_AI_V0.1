package jobs

import (
	"context"

	"github.com/datacern-ai/go-common/objectstore"
	"github.com/datacern-ai/usage-service/internal/recon"
)

// MinioBillStore adapts the shared go-common S3/MinIO client to
// recon.BillStore (USG-FR-070's provider-bill CSV drop prefix). Mirrors how
// valueexport.S3Store wraps the same client for export artifacts.
type MinioBillStore struct {
	c *objectstore.Client
}

// NewMinioBillStore wraps an already-connected real MinIO/S3 client bound to
// the provider-bill bucket.
func NewMinioBillStore(c *objectstore.Client) *MinioBillStore { return &MinioBillStore{c: c} }

func (m *MinioBillStore) List(ctx context.Context, prefix string) ([]recon.BillObject, error) {
	objs, err := m.c.List(ctx, prefix)
	if err != nil {
		return nil, err
	}
	out := make([]recon.BillObject, len(objs))
	for i, o := range objs {
		out[i] = recon.BillObject{Key: o.Key, Size: o.Size}
	}
	return out, nil
}

func (m *MinioBillStore) Get(ctx context.Context, key string) ([]byte, error) {
	return m.c.Get(ctx, key)
}
