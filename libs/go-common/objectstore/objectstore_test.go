package objectstore

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// TestPutGetDeleteRoundTrip drives the real client against a live MinIO/S3
// target: Put, Get (byte-identical), presigned GET (URL references the key),
// List (finds the key), then Delete (Get afterwards fails).
//
// Gated behind OBJECTSTORE_MINIO_E2E=1 so the default `go test ./...` stays
// green with no infra -- same convention query-service's
// TestDuckDBMaterializeMinIO uses; run with the env set for the live proof:
//
//	OBJECTSTORE_MINIO_E2E=1 go test ./objectstore/ -run TestPutGetDeleteRoundTrip -v
func TestPutGetDeleteRoundTrip(t *testing.T) {
	if os.Getenv("OBJECTSTORE_MINIO_E2E") != "1" {
		t.Skip("set OBJECTSTORE_MINIO_E2E=1 to run the live MinIO round-trip proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	c, err := New(ctx, Config{
		Endpoint:  env("MINIO_ENDPOINT", "localhost:9000"),
		AccessKey: env("MINIO_ACCESS_KEY", "datacern"),
		SecretKey: env("MINIO_SECRET_KEY", "datacern_dev"),
		UseSSL:    os.Getenv("MINIO_USE_SSL") == "true",
		Bucket:    env("OBJECTSTORE_TEST_BUCKET", "datacern-objectstore-test"),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	key := "roundtrip/" + uuid.NewString() + ".txt"
	want := []byte("hello from go-common/objectstore")

	if _, err := c.Put(ctx, key, want, "text/plain"); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := c.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("Get = %q, want %q", got, want)
	}

	url, err := c.PresignGet(ctx, key, time.Minute)
	if err != nil {
		t.Fatalf("PresignGet: %v", err)
	}
	if !strings.Contains(url, key) {
		t.Errorf("presigned URL %q does not reference key %q", url, key)
	}

	objs, err := c.List(ctx, "roundtrip/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var found bool
	for _, o := range objs {
		if o.Key == key {
			found = true
			if o.Size != int64(len(want)) {
				t.Errorf("listed size = %d, want %d", o.Size, len(want))
			}
		}
	}
	if !found {
		t.Errorf("List did not return key %q", key)
	}

	if err := c.Delete(ctx, key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := c.Get(ctx, key); err == nil {
		t.Error("Get after Delete: expected error, got nil")
	}
}
