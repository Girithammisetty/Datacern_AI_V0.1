package valueexport

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestWriteCSV_LeadingCommentsAndBOM(t *testing.T) {
	out, err := WriteCSV(
		[]string{"assumptions version 1 loaded_hourly_rate_usd=180"},
		[]string{"metric", "value"},
		[][]any{{"decisions_total", int64(12340)}, {"ai_cost_usd", 812.44}},
	)
	require.NoError(t, err)
	s := string(out)
	require.Equal(t, byte(0xEF), out[0], "UTF-8 BOM")
	require.Contains(t, s, "# assumptions version 1 loaded_hourly_rate_usd=180")
	require.Contains(t, s, "metric,value")
	require.Contains(t, s, "decisions_total,12340")
	require.Contains(t, s, "ai_cost_usd,812.44")
}

func TestSHA256Hex_Deterministic(t *testing.T) {
	a := SHA256Hex([]byte("hello"))
	b := SHA256Hex([]byte("hello"))
	c := SHA256Hex([]byte("hello2"))
	require.Equal(t, a, b)
	require.NotEqual(t, a, c)
	require.Len(t, a, 64)
}

// TestFSStore_PutSignAndRead proves the round trip AC-4 relies on: Put writes
// bytes + a signed URL; Read validates the signature/expiry and returns the
// identical bytes; a tampered signature or an expired link is rejected
// (never silently served).
func TestFSStore_PutSignAndRead(t *testing.T) {
	root := t.TempDir()
	fs := NewFSStore(root, "http://localhost:8080", []byte("test-secret"))
	ctx := context.Background()

	data := []byte(`{"schema":"value-report.v1"}`)
	url, expires, err := fs.Put(ctx, "value-reports/t-1/2026-07/1/report.json", data, time.Hour)
	require.NoError(t, err)
	require.Contains(t, url, "/api/v1/value-report-artifacts/value-reports/t-1/2026-07/1/report.json")
	require.True(t, expires.After(time.Now()))

	// File actually landed on disk at the expected path.
	onDisk, err := os.ReadFile(filepath.Join(root, "value-reports/t-1/2026-07/1/report.json"))
	require.NoError(t, err)
	require.Equal(t, data, onDisk)

	sig := fs.Sign("value-reports/t-1/2026-07/1/report.json", expires.Unix())
	got, err := fs.Read("value-reports/t-1/2026-07/1/report.json", expires.Unix(), sig)
	require.NoError(t, err)
	require.Equal(t, data, got)

	// Tampered signature -> rejected.
	_, err = fs.Read("value-reports/t-1/2026-07/1/report.json", expires.Unix(), "bad-sig")
	require.Error(t, err)

	// Expired link -> rejected even with a correct signature.
	pastExp := time.Now().Add(-time.Minute).Unix()
	pastSig := fs.Sign("value-reports/t-1/2026-07/1/report.json", pastExp)
	_, err = fs.Read("value-reports/t-1/2026-07/1/report.json", pastExp, pastSig)
	require.Error(t, err)
}

// TestFSStore_ReExport_NeverOverwritesPriorVersion proves the "immutable,
// never overwritten" convention (design §2.8 step 7) at the object-store
// layer: writing report.json under two different version directories for
// the same period leaves both readable and distinct.
func TestFSStore_ReExport_NeverOverwritesPriorVersion(t *testing.T) {
	root := t.TempDir()
	fs := NewFSStore(root, "http://localhost:8080", []byte("s"))
	ctx := context.Background()

	_, _, err := fs.Put(ctx, "value-reports/t-1/2026-07/1/report.json", []byte("v1"), time.Hour)
	require.NoError(t, err)
	_, _, err = fs.Put(ctx, "value-reports/t-1/2026-07/2/report.json", []byte("v2"), time.Hour)
	require.NoError(t, err)

	v1, err := os.ReadFile(filepath.Join(root, "value-reports/t-1/2026-07/1/report.json"))
	require.NoError(t, err)
	v2, err := os.ReadFile(filepath.Join(root, "value-reports/t-1/2026-07/2/report.json"))
	require.NoError(t, err)
	require.Equal(t, "v1", string(v1))
	require.Equal(t, "v2", string(v2))
}
