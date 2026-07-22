package chstore

import (
	"strings"
	"testing"
)

// TestBuildMigrateDDLSingleNode confirms the default (dev/Hetzner) path is
// byte-for-byte unaffected by the B9 HA change: no "Replicated" engine leaks
// in when Config.Replicated is left false.
func TestBuildMigrateDDLSingleNode(t *testing.T) {
	ddl := buildMigrateDDL("audit_events", false)
	if !strings.Contains(ddl, "ENGINE = ReplacingMergeTree(ingested_at)") {
		t.Fatalf("expected single-node ReplacingMergeTree engine, got:\n%s", ddl)
	}
	if strings.Contains(ddl, "Replicated") {
		t.Fatalf("single-node DDL must not mention Replicated:\n%s", ddl)
	}
	if !strings.Contains(ddl, "TTL toDateTime(occurred_at) + INTERVAL 7 YEAR") {
		t.Fatalf("expected the 7-year WORM retention TTL to be preserved:\n%s", ddl)
	}
}

// TestBuildMigrateDDLReplicated proves the B9 HA path renders a real
// Keeper-coordinated engine with the table name correctly interpolated into
// the ZK-style path, while every other column/partition/TTL clause is
// unchanged from the single-node DDL.
func TestBuildMigrateDDLReplicated(t *testing.T) {
	ddl := buildMigrateDDL("audit_events", true)
	want := "ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/audit_events', '{replica}', ingested_at)"
	if !strings.Contains(ddl, want) {
		t.Fatalf("expected replicated engine clause %q, got:\n%s", want, ddl)
	}
	if !strings.Contains(ddl, "PARTITION BY toYYYYMM(occurred_at)") ||
		!strings.Contains(ddl, "ORDER BY (tenant_id, occurred_at, event_id)") ||
		!strings.Contains(ddl, "TTL toDateTime(occurred_at) + INTERVAL 7 YEAR") {
		t.Fatalf("replicated DDL must keep the same partitioning/ordering/TTL as single-node:\n%s", ddl)
	}
}
