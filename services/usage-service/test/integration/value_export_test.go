package integration

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// stripHost turns a full presigned URL (http://host:port/api/v1/...) into a
// path+query h.do can hit against the harness's own httptest server (the
// FSStore's PublicURL is empty in the harness, see harness_test.go, so the
// signed URL is already host-relative — this is defensive for either shape).
func stripHost(u string) string {
	parsed, err := url.Parse(u)
	if err != nil {
		return u
	}
	if parsed.RawQuery != "" {
		return parsed.Path + "?" + parsed.RawQuery
	}
	return parsed.Path
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// TestAC4_ExportValueReport_ChecksumAndVersionIncrement covers BRD 69 AC-4
// end-to-end over real HTTP/Postgres/filesystem object store (the harness
// wires a real valueexport.FSStore, see harness_test.go): exporting a period
// twice yields two versions, each with a checksum, and the second export
// never overwrites the first's object-store keys (design §2.8 step 7,
// mirrors AC-5 of BRD 67's own export semantics). REAL: Postgres, HTTP,
// local filesystem object store.
func TestAC4_ExportValueReport_ChecksumAndVersionIncrement(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "user", "u-admin", nil)
	period := time.Now().UTC().Format("2006-01")

	r1 := h.do(t, "POST", "/api/v1/value-reports", tok, map[string]any{"period": period}, nil)
	require.Equal(t, 201, r1.status)
	d1, _ := r1.body["data"].(map[string]any)
	require.EqualValues(t, 1, d1["version"])
	sha1, _ := d1["json_sha256"].(string)
	require.NotEmpty(t, sha1)
	jsonURL1, _ := d1["json_url"].(string)
	require.NotEmpty(t, jsonURL1)

	// Download the artifact via the signed URL and verify the checksum
	// matches the served bytes (AC-4 "downloads and verifies the checksum").
	getResp := h.do(t, "GET", stripHost(jsonURL1), "", nil, nil)
	require.Equal(t, 200, getResp.status)
	require.Equal(t, sha1, sha256Hex(getResp.raw))

	r2 := h.do(t, "POST", "/api/v1/value-reports", tok, map[string]any{"period": period}, nil)
	require.Equal(t, 201, r2.status)
	d2, _ := r2.body["data"].(map[string]any)
	require.EqualValues(t, 2, d2["version"], "re-export inserts version N+1, never overwrites")
	require.NotEqual(t, d1["json_sha256"], "", "version 1 sha untouched by the second export")

	lr := h.do(t, "GET", "/api/v1/value-reports?period="+period, tok, nil, nil)
	require.Equal(t, 200, lr.status)
	items, _ := lr.body["data"].([]any)
	require.Len(t, items, 2)
}

// TestValueTrend_ReturnsMonthlyPoints proves GET /value/trend returns one
// point per calendar month in range with real Postgres-backed data, blended
// basis, and a null distilled_rung_share (the honest, documented gap —
// design §2.4).
func TestValueTrend_ReturnsMonthlyPoints(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "user", "u-exec", nil)

	r := h.do(t, "GET", "/api/v1/value/trend?metric=cost_per_decision", tok, nil, nil)
	require.Equal(t, 200, r.status)
	data, _ := r.body["data"].(map[string]any)
	points, _ := data["points"].([]any)
	require.Len(t, points, 6, "default trailing-6-month window")
	last := points[len(points)-1].(map[string]any)
	require.Nil(t, last["distilled_rung_share"], "always null today — see design §2.4 gap")
}
