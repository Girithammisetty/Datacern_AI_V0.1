package siemexport

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/audit-service/internal/domain"
)

func testRecord() domain.Record {
	return domain.Record{
		EventID:       uuid.MustParse("018f4a1e-0000-7000-8000-000000000001"),
		EventType:     "case.assigned",
		TenantID:      uuid.MustParse("018f4a1e-0000-7000-8000-000000000002"),
		ActorType:     "user",
		ActorID:       "u-123",
		ResourceURN:   "wr:tenant:case:case/c-1",
		Action:        "case.assign",
		OccurredAt:    time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC),
		TraceID:       "trace-abc",
		PayloadDigest: "deadbeef",
	}
}

func TestFormatEventJSON(t *testing.T) {
	env := Envelope(testRecord())
	out, err := FormatEvent(env, FormatJSON)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if decoded["event_id"] != env.EventID.String() {
		t.Fatalf("event_id mismatch: %v", decoded["event_id"])
	}
}

func TestFormatEventDefaultsToJSON(t *testing.T) {
	env := Envelope(testRecord())
	out, err := FormatEvent(env, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(out), "{") {
		t.Fatalf("empty format must default to JSON, got: %s", out)
	}
}

func TestFormatEventCEF(t *testing.T) {
	rec := testRecord()
	rec.EventType = "case.created" // matches deriveOutcome's "success" heuristic
	env := Envelope(rec)
	out, err := FormatEvent(env, FormatCEF)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(out, "CEF:0|Datacern|AuditService|1.0|case.assign|case.created|") {
		t.Fatalf("unexpected CEF header: %s", out)
	}
	if !strings.Contains(out, "duser="+env.Actor.ID) {
		t.Fatalf("expected duser= extension field, got: %s", out)
	}
	if !strings.Contains(out, "cs1Label=tenant_id cs1="+env.TenantID.String()) {
		t.Fatalf("expected tenant_id custom field, got: %s", out)
	}
	// success outcome -> severity 1.
	if !strings.Contains(out, "|1|") {
		t.Fatalf("expected severity 1 for a success outcome, got: %s", out)
	}
}

func TestFormatEventCEFSeverityByOutcome(t *testing.T) {
	rec := testRecord()
	rec.EventType = "case.access.denied"
	env := Envelope(rec)
	out, err := FormatEvent(env, FormatCEF)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "|7|") {
		t.Fatalf("expected severity 7 for a denied outcome, got: %s", out)
	}
	if !strings.Contains(out, "outcome=denied") {
		t.Fatalf("expected outcome=denied extension, got: %s", out)
	}
}

func TestFormatEventCEFEscapesSpecialCharacters(t *testing.T) {
	rec := testRecord()
	rec.ActorID = `alice|pipe=equals\backslash`
	env := Envelope(rec)
	out, err := FormatEvent(env, FormatCEF)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Extension values escape backslash and equals (not pipe -- only header does).
	if !strings.Contains(out, `duser=alice|pipe\=equals\\backslash`) {
		t.Fatalf("expected escaped duser extension, got: %s", out)
	}
}

func TestFormatEventLEEF(t *testing.T) {
	env := Envelope(testRecord())
	out, err := FormatEvent(env, FormatLEEF)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(out, "LEEF:2.0|Datacern|AuditService|1.0|case.assigned|") {
		t.Fatalf("unexpected LEEF header: %s", out)
	}
	fields := strings.Split(out, "|")
	if len(fields) != 6 {
		t.Fatalf("expected 6 pipe-delimited LEEF fields (header x5 + extension), got %d: %s", len(fields), out)
	}
	ext := fields[5]
	kv := strings.Split(ext, "\t")
	if len(kv) < 5 {
		t.Fatalf("expected tab-separated LEEF extension fields, got: %s", ext)
	}
	if !strings.Contains(ext, "usrName=u-123") {
		t.Fatalf("expected usrName extension field, got: %s", ext)
	}
	if !strings.Contains(ext, "tenantId="+env.TenantID.String()) {
		t.Fatalf("expected tenantId extension field, got: %s", ext)
	}
}

func TestFormatEventUnsupportedFormat(t *testing.T) {
	env := Envelope(testRecord())
	if _, err := FormatEvent(env, "SYSLOG"); err == nil {
		t.Fatal("expected an error for an unsupported format")
	}
}
