package triggers

// Intake-snapshot evidence (real-time case-streams add-on, slice: evidence
// auto-capture). These cover the pure snapshot builder — the full
// blob+InsertEvidence path runs in the integration tier against real MinIO+PG,
// like every other evidence test.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/datacern-ai/case-service/internal/domain"
	"github.com/google/uuid"
)

func snapTrigger() *domain.CaseTrigger {
	return &domain.CaseTrigger{
		ID: uuid.New(), Name: "high-value-disputes",
		WorkspaceID: uuid.New(), AttachEvidence: true,
	}
}

func TestBuildIntakeSnapshotFreezesTheFullRowNotTheProjection(t *testing.T) {
	// The display projection is truncated for worklist rendering; the snapshot
	// exists precisely to keep what the projection may have dropped.
	tr := snapTrigger()
	cols := []string{"id", "amount", "memo"}
	row := []any{"row-9", 125000, strings.Repeat("x", 5000)} // beyond projection caps

	data, err := BuildIntakeSnapshot(tr, "wr:t:dataset:dataset/claims", cols, row,
		time.Date(2026, 7, 30, 3, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("BuildIntakeSnapshot: %v", err)
	}
	var got struct {
		Kind        string         `json:"kind"`
		TriggerName string         `json:"trigger_name"`
		DatasetURN  string         `json:"dataset_urn"`
		Row         map[string]any `json:"row"`
		CapturedAt  string         `json:"captured_at"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("snapshot is not valid JSON: %v", err)
	}
	if got.Kind != "intake_snapshot/v1" {
		t.Fatalf("kind = %q", got.Kind)
	}
	if got.TriggerName != "high-value-disputes" || got.DatasetURN != "wr:t:dataset:dataset/claims" {
		t.Fatalf("provenance missing: %+v", got)
	}
	if len(got.Row["memo"].(string)) != 5000 {
		t.Fatalf("full row value was truncated: len=%d", len(got.Row["memo"].(string)))
	}
	if got.CapturedAt != "2026-07-30T03:00:00Z" {
		t.Fatalf("captured_at = %q", got.CapturedAt)
	}
}

func TestBuildIntakeSnapshotIsByteStableForTheSameInput(t *testing.T) {
	// Same intake → same bytes: two writes of one snapshot must not look like
	// two different pieces of evidence to an examiner (or a hash check).
	tr := snapTrigger()
	at := time.Date(2026, 7, 30, 3, 0, 0, 0, time.UTC)
	a, _ := BuildIntakeSnapshot(tr, "urn", []string{"a", "b"}, []any{1, "x"}, at)
	b, _ := BuildIntakeSnapshot(tr, "urn", []string{"a", "b"}, []any{1, "x"}, at)
	if string(a) != string(b) {
		t.Fatal("snapshot bytes differ for identical input")
	}
}

func TestBuildIntakeSnapshotToleratesRaggedRows(t *testing.T) {
	// A row shorter than the column list (source schema drift mid-page) must
	// not panic and must keep the columns it does have.
	tr := snapTrigger()
	data, err := BuildIntakeSnapshot(tr, "urn", []string{"a", "b", "c"}, []any{"only-a"}, time.Now())
	if err != nil {
		t.Fatalf("ragged row: %v", err)
	}
	var got struct {
		Row map[string]any `json:"row"`
	}
	_ = json.Unmarshal(data, &got)
	if got.Row["a"] != "only-a" || len(got.Row) != 1 {
		t.Fatalf("ragged row handled wrong: %+v", got.Row)
	}
}
