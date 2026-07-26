package results

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/datacern-ai/go-common/objectstore"
)

// backend is where result bytes durably live: the local filesystem in dev
// (the default, single-replica only -- files are pinned to whichever replica
// wrote them) or S3/MinIO in prod-like environments (see cmd/server/main.go's
// REQUIRE_REAL_ADAPTERS gate). Keys use forward slashes and mirror the layout
// the filesystem backend always used (results/<tenant>/<exec>/part-N.jsonl,
// .../manifest.json), so switching backends changes only where the bytes
// live, not the logical layout. Store's own methods already take no caller
// context for their I/O (matches every other real-adapter fallback store in
// this codebase, e.g. valueexport.FSStore), so backend methods use
// context.Background() internally.
type backend interface {
	write(key string, data []byte) error
	read(key string) ([]byte, error)
	// list returns every object under prefix (recursive), with size.
	list(prefix string) ([]objectstore.Object, error)
	// removePrefix deletes every object under prefix.
	removePrefix(prefix string) error
}

// localBackend is the default, single-replica filesystem backend.
type localBackend struct {
	root string
}

func (b *localBackend) path(key string) string { return filepath.Join(b.root, filepath.FromSlash(key)) }

func (b *localBackend) write(key string, data []byte) error {
	p := b.path(key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

func (b *localBackend) read(key string) ([]byte, error) {
	return os.ReadFile(b.path(key))
}

func (b *localBackend) list(prefix string) ([]objectstore.Object, error) {
	root := b.path(prefix)
	var out []objectstore.Object
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(b.root, p)
		if err != nil {
			return err
		}
		out = append(out, objectstore.Object{Key: filepath.ToSlash(rel), Size: info.Size()})
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return out, nil
}

func (b *localBackend) removePrefix(prefix string) error {
	return os.RemoveAll(b.path(prefix))
}

// s3Backend is the real MinIO/S3-compatible backend (prod default, safe
// under multiple replicas).
type s3Backend struct {
	client *objectstore.Client
}

func (b *s3Backend) contentType(key string) string {
	switch {
	case strings.HasSuffix(key, ".json"):
		return "application/json"
	case strings.HasSuffix(key, ".jsonl"):
		return "application/x-ndjson"
	case strings.HasSuffix(key, ".csv"):
		return "text/csv; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

func (b *s3Backend) write(key string, data []byte) error {
	_, err := b.client.Put(context.Background(), key, data, b.contentType(key))
	return err
}

func (b *s3Backend) read(key string) ([]byte, error) {
	return b.client.Get(context.Background(), key)
}

func (b *s3Backend) list(prefix string) ([]objectstore.Object, error) {
	return b.client.List(context.Background(), prefix)
}

func (b *s3Backend) removePrefix(prefix string) error {
	objs, err := b.client.List(context.Background(), prefix)
	if err != nil {
		return err
	}
	for _, o := range objs {
		if err := b.client.Delete(context.Background(), o.Key); err != nil {
			return err
		}
	}
	return nil
}

