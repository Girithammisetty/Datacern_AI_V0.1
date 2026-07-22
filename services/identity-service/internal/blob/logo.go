// Package blob is identity-service's object-storage adapter for tenant
// branding logo bytes (BRD 59 WS3). It speaks the real S3 API against MinIO
// (deploy: localhost:9000) via minio-go -- the same adapter case-service uses
// for case evidence and audit-service uses for WORM export. The pointer/
// metadata row (object key + content type) lives in Postgres (tenant_branding);
// the bytes live here.
package blob

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Config configures the logo object store.
type Config struct {
	Endpoint  string // host:port, e.g. localhost:9000
	AccessKey string
	SecretKey string
	UseSSL    bool
	Bucket    string // e.g. datacern-tenant-branding
}

// MinioLogoStore is a MinIO/S3-backed logo store bound to one bucket.
type MinioLogoStore struct {
	mc     *minio.Client
	bucket string
}

// NewMinioLogoStore builds the client and ensures the bucket exists.
func NewMinioLogoStore(ctx context.Context, cfg Config) (*MinioLogoStore, error) {
	mc, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	})
	if err != nil {
		return nil, err
	}
	c := &MinioLogoStore{mc: mc, bucket: cfg.Bucket}
	if err := c.ensureBucket(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *MinioLogoStore) ensureBucket(ctx context.Context) error {
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

// Put writes a logo object at key with its declared content type, overwriting
// any prior logo at the same key (one logo per tenant -- no versioning).
func (c *MinioLogoStore) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := c.mc.PutObject(ctx, c.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

// Get reads a logo object fully (streamed to the caller by the handler).
func (c *MinioLogoStore) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := c.mc.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = obj.Close() }()
	return io.ReadAll(obj)
}

// Delete removes a logo object (called when branding is reset/cleared).
func (c *MinioLogoStore) Delete(ctx context.Context, key string) error {
	if key == "" {
		return nil
	}
	return c.mc.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
}
