// Package objectstore is the shared real S3/MinIO-compatible object-storage
// client (Put/Get/Delete/PresignGet/List) backing the export and snapshot
// storage of usage-service, identity-service, chart-service, query-service,
// and case-service. It wraps minio-go the same way identity-service's and
// case-service's internal/blob packages and audit-service's internal/worm
// package already do for logo/evidence/WORM bytes -- this package exists so
// that real fix doesn't get duplicated a sixth, seventh, and eighth time.
// Each service still owns its domain-level export/snapshot logic (key
// layout, checksums, HMAC-signed local fallback URLs); only the raw MinIO/S3
// wire client -- infrastructure, not domain logic -- is shared, matching how
// kafka/redisx/otelx are already shared via this module.
package objectstore

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Config configures the client.
type Config struct {
	Endpoint  string // host:port, e.g. localhost:9000 (no scheme)
	AccessKey string
	SecretKey string
	UseSSL    bool
	Bucket    string
}

// Client wraps a MinIO/S3 client bound to one bucket.
type Client struct {
	mc     *minio.Client
	bucket string
}

// Object describes one listed key (used by callers that need to enumerate or
// garbage-collect their own objects, e.g. query-service's result retention).
type Object struct {
	Key  string
	Size int64
}

// New builds a Client and ensures the bucket exists.
func New(ctx context.Context, cfg Config) (*Client, error) {
	mc, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	})
	if err != nil {
		return nil, err
	}
	c := &Client{mc: mc, bucket: cfg.Bucket}
	if err := c.ensureBucket(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Client) ensureBucket(ctx context.Context) error {
	exists, err := c.mc.BucketExists(ctx, c.bucket)
	if err != nil {
		return fmt.Errorf("bucket exists: %w", err)
	}
	if exists {
		return nil
	}
	if err := c.mc.MakeBucket(ctx, c.bucket, minio.MakeBucketOptions{}); err != nil {
		return fmt.Errorf("make bucket: %w", err)
	}
	return nil
}

// Bucket returns the bucket name.
func (c *Client) Bucket() string { return c.bucket }

// Put writes data at key, overwriting any prior object at the same key.
func (c *Client) Put(ctx context.Context, key string, data []byte, contentType string) (etag string, err error) {
	info, err := c.mc.PutObject(ctx, c.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return "", fmt.Errorf("put %s: %w", key, err)
	}
	return info.ETag, nil
}

// Get reads an object fully.
func (c *Client) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := c.mc.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = obj.Close() }()
	return io.ReadAll(obj)
}

// Delete removes an object; a missing key is not an error.
func (c *Client) Delete(ctx context.Context, key string) error {
	return c.mc.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
}

// PresignGet returns a time-limited download URL for key, signed directly by
// the object store rather than routed through the calling service's own HTTP
// surface -- the real-adapter equivalent of the FSStore fallback's app-served
// HMAC-signed URL.
func (c *Client) PresignGet(ctx context.Context, key string, expiry time.Duration) (string, error) {
	u, err := c.mc.PresignedGetObject(ctx, c.bucket, key, expiry, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// List returns every object under prefix (recursive), with size, for callers
// that need to enumerate or garbage-collect their own objects.
func (c *Client) List(ctx context.Context, prefix string) ([]Object, error) {
	var out []Object
	for obj := range c.mc.ListObjects(ctx, c.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		out = append(out, Object{Key: obj.Key, Size: obj.Size})
	}
	return out, nil
}
