package export

import (
	"context"
	"time"

	"github.com/datacern-ai/go-common/objectstore"
)

// S3Store is the real MinIO/S3-compatible ObjectStore (prod default, safe
// under multiple replicas -- unlike FSStore, whose files are pinned to
// whichever replica wrote them). It wraps go-common/objectstore.Client and
// returns a presigned GET URL signed by the object store itself, rather than
// FSStore's HMAC-signed URL served through this service's own /exports/*
// endpoint.
type S3Store struct {
	Client *objectstore.Client
}

// NewS3Store builds an S3Store over an already-connected client.
func NewS3Store(c *objectstore.Client) *S3Store { return &S3Store{Client: c} }

// Put uploads data at key and returns a presigned download URL valid for ttl.
func (s *S3Store) Put(ctx context.Context, key string, data []byte, ttl time.Duration) (string, time.Time, error) {
	if _, err := s.Client.Put(ctx, key, data, "text/csv; charset=utf-8"); err != nil {
		return "", time.Time{}, err
	}
	url, err := s.Client.PresignGet(ctx, key, ttl)
	if err != nil {
		return "", time.Time{}, err
	}
	return url, time.Now().Add(ttl), nil
}
