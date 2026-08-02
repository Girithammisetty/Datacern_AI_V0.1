package billing

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/valueexport"
)

func samplePeriod(t *testing.T) domain.BillingPeriod {
	t.Helper()
	tenant := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	rc := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	rows := []domain.RollupRow{
		{MeterKey: "governed_decision", Unit: "count", Quantity: 842, USD: usd(67.36)},
		{MeterKey: "api_calls", Unit: "count", Quantity: 1000, USD: usd(2)},
	}
	return domain.NewBillingPeriod(tenant, "2026-07", 1, rc, 3, time.Unix(0, 0).UTC(), rows)
}

func TestBuildArtifacts_KeysAndChecksums(t *testing.T) {
	p := samplePeriod(t)
	a, err := BuildArtifacts(p)
	require.NoError(t, err)

	assert.Equal(t, "billing/11111111-1111-1111-1111-111111111111/2026-07/1", a.Prefix)
	assert.Equal(t, a.Prefix+"/meters.jsonl", a.JSONLKey)
	assert.Equal(t, a.Prefix+"/summary.csv", a.CSVKey)
	assert.Len(t, a.JSONLSHA256, 64) // hex sha-256
	assert.Len(t, a.CSVSHA256, 64)
	assert.Equal(t, valueSHA(a.JSONL), a.JSONLSHA256)
	assert.Equal(t, valueSHA(a.CSV), a.CSVSHA256)
}

func TestBuildArtifacts_JSONLOneLinePerMeterSorted(t *testing.T) {
	p := samplePeriod(t)
	a, err := BuildArtifacts(p)
	require.NoError(t, err)

	lines := strings.Split(strings.TrimRight(string(a.JSONL), "\n"), "\n")
	require.Len(t, lines, 2)
	// NewBillingPeriod sorts by meter_key: api_calls first.
	assert.Contains(t, lines[0], `"meter_key":"api_calls"`)
	assert.Contains(t, lines[1], `"meter_key":"governed_decision"`)
	assert.Contains(t, lines[1], `"quantity":842`)
	assert.Contains(t, lines[1], `"gross_usd":67.36`)
	assert.Contains(t, lines[1], `"rate_card_version":3`)
	assert.Contains(t, lines[1], `"period":"2026-07"`)
}

func TestBuildArtifacts_CSVSummaryShape(t *testing.T) {
	p := samplePeriod(t)
	a, err := BuildArtifacts(p)
	require.NoError(t, err)

	text := string(a.CSV)
	// Disclosure comments present.
	assert.Contains(t, text, "# Datacern billing summary")
	assert.Contains(t, text, "meters.jsonl")
	// Header + one row per meter.
	assert.Contains(t, text, "meter_key,unit,quantity,price_per_unit_usd,gross_usd")
	assert.Contains(t, text, "governed_decision,count,842,0.08,67.36")
}

func TestBuildArtifacts_DeterministicAcrossRuns(t *testing.T) {
	p := samplePeriod(t)
	a1, err := BuildArtifacts(p)
	require.NoError(t, err)
	a2, err := BuildArtifacts(p)
	require.NoError(t, err)
	// Byte-identical artifacts => identical checksums (VMB-FR-021 replay safety).
	assert.Equal(t, a1.JSONL, a2.JSONL)
	assert.Equal(t, a1.CSV, a2.CSV)
	assert.Equal(t, a1.JSONLSHA256, a2.JSONLSHA256)
	assert.Equal(t, a1.CSVSHA256, a2.CSVSHA256)
}

func TestBuildArtifacts_VersionBumpChangesPrefixNotV1(t *testing.T) {
	p := samplePeriod(t)
	a1, err := BuildArtifacts(p)
	require.NoError(t, err)

	p2 := p
	p2.Version = 2
	a2, err := BuildArtifacts(p2)
	require.NoError(t, err)

	assert.NotEqual(t, a1.Prefix, a2.Prefix)
	assert.True(t, strings.HasSuffix(a1.Prefix, "/1"))
	assert.True(t, strings.HasSuffix(a2.Prefix, "/2"))
}

func TestBuildArtifacts_EmptyPeriod(t *testing.T) {
	p := domain.NewBillingPeriod(uuid.New(), "2026-07", 1, uuid.New(), 1, time.Now(), nil)
	a, err := BuildArtifacts(p)
	require.NoError(t, err)
	assert.Empty(t, a.JSONL)         // no lines
	assert.NotEmpty(t, a.CSV)        // header + comments still written
	assert.Len(t, a.JSONLSHA256, 64) // checksum of empty is still a valid digest
}

// valueSHA is valueexport.SHA256Hex, used for the test's independent check.
func valueSHA(b []byte) string { return valueexport.SHA256Hex(b) }
