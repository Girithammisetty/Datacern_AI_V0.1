// Package valueexport implements the value-report.v1 export mechanics (BRD 69
// ROI-FR-021, design §2.8): RFC 4180 CSV, SHA256 checksums, and a real local
// object store (FSStore, MinIO/S3-compatible in prod). Modeled on
// chart-service's internal/export/export.go ObjectStore/FSStore pattern for
// the object-storage mechanics — reimplemented locally (not imported) because
// services don't share Go packages across DB-per-service boundaries (design
// §2.8 note). This is a periodic business export a tenant admin can
// regenerate, not a compliance record — no WORM/Object-Lock, unlike
// audit-service's exports; immutability is by convention (new version, key
// never overwritten).
package valueexport

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// WriteCSV writes columns + rows in RFC 4180 with a UTF-8 BOM. leadingComments
// become `#`-prefixed header rows so assumptions are disclosed even in a flat
// CSV (AC-4, design §2.8 step 3).
func WriteCSV(leadingComments []string, columns []string, rows [][]any) ([]byte, error) {
	var buf bytes.Buffer
	buf.Write([]byte{0xEF, 0xBB, 0xBF}) // UTF-8 BOM
	for _, c := range leadingComments {
		buf.WriteString("# " + c + "\n")
	}
	w := csv.NewWriter(&buf)
	if len(columns) > 0 {
		if err := w.Write(columns); err != nil {
			return nil, err
		}
	}
	for _, row := range rows {
		rec := make([]string, len(row))
		for i, cell := range row {
			rec[i] = cellString(cell)
		}
		if err := w.Write(rec); err != nil {
			return nil, err
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func cellString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// SHA256Hex returns the lowercase hex SHA256 digest of data (ROI-NFR-002
// "export immutable + checksummed").
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ObjectStore stores an export artifact and returns a time-limited URL.
type ObjectStore interface {
	Put(ctx context.Context, key string, data []byte, ttl time.Duration) (url string, expires time.Time, err error)
}

// FSStore is a real local object store (dev equivalent of MinIO/S3). Keys
// follow value-reports/<tenant>/<period>/<version>/{report.json,report.csv}
// (design §2.8 step 4) and are never overwritten — each export generation
// uses a fresh version directory.
type FSStore struct {
	Root      string
	PublicURL string
	Secret    []byte
}

// NewFSStore builds an FSStore, creating Root if needed.
func NewFSStore(root, publicURL string, secret []byte) *FSStore {
	_ = os.MkdirAll(root, 0o755)
	return &FSStore{Root: root, PublicURL: publicURL, Secret: secret}
}

// Put writes data and returns a signed, expiring download URL served by this
// service's GET /api/v1/value-report-artifacts/{key} endpoint.
func (s *FSStore) Put(_ context.Context, key string, data []byte, ttl time.Duration) (string, time.Time, error) {
	path := filepath.Join(s.Root, key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", time.Time{}, err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(ttl)
	sig := s.Sign(key, expires.Unix())
	url := fmt.Sprintf("%s/api/v1/value-report-artifacts/%s?exp=%d&sig=%s", s.PublicURL, key, expires.Unix(), sig)
	return url, expires, nil
}

// Read returns an artifact if the signature and expiry are valid.
func (s *FSStore) Read(key string, exp int64, sig string) ([]byte, error) {
	if time.Now().Unix() > exp {
		return nil, fmt.Errorf("expired")
	}
	if !hmac.Equal([]byte(sig), []byte(s.Sign(key, exp))) {
		return nil, fmt.Errorf("bad signature")
	}
	return os.ReadFile(filepath.Join(s.Root, filepath.Clean("/"+key)))
}

// Sign computes the HMAC-SHA256 signature for key+exp.
func (s *FSStore) Sign(key string, exp int64) string {
	m := hmac.New(sha256.New, s.Secret)
	_, _ = fmt.Fprintf(m, "%s|%d", key, exp)
	return hex.EncodeToString(m.Sum(nil))
}
