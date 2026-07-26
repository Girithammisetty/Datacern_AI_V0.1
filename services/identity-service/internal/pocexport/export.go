// Package pocexport implements the poc-report.v1 export's object-storage
// mechanics (BRD 70 slice 3, DSP-FR-022, design §2.9). Reimplemented locally
// (not imported) rather than sharing usage-service's internal/valueexport
// package, for the same reason BRD 69's own valueexport package gives:
// services don't share Go packages across DB-per-service boundaries. Mirrors
// valueexport.FSStore's HMAC-signed local object store, minus the CSV half
// (poc-report.v1 is JSON-only per design §2.9's schema).
package pocexport

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// SHA256Hex returns the lowercase hex SHA256 digest of data.
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// FSStore is a real local object store (dev equivalent of MinIO/S3). Keys
// follow poc-reports/<tenant>/<version>/report.json and are never
// overwritten -- each export generation uses a fresh version directory
// (design §2.9 / PocService.ExportReport).
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
// service's GET /api/v1/poc-report-artifacts/{key} endpoint.
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
	url := fmt.Sprintf("%s/api/v1/poc-report-artifacts/%s?exp=%d&sig=%s", s.PublicURL, key, expires.Unix(), sig)
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
