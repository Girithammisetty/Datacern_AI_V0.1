package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/go-common/opaclient"
	"github.com/datacern-ai/usage-service/internal/authz"
	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/events"
)

// TestAC1_AssumptionsSetAndUnset_ValueSummary covers BRD 69 AC-1's "unset"
// half end-to-end over real HTTP/Postgres: with no value_assumptions rows,
// GET /value/summary returns null for every *_est field while decisions/
// ai_cost_usd/adoption still populate from real governed_decision + LLM token
// meter ingestion. REAL: Kafka, Postgres, HTTP.
func TestAC1_AssumptionsSetAndUnset_ValueSummary(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "user", "u-exec", nil)
	period := time.Now().UTC().Format("2006-01")

	// Real governed_decision + LLM-token ingest via Kafka.
	h.publish(t, events.TopicAIProposal, tenant, uuid.New(), time.Now().UTC(),
		governedDecisionPayload("claims-copilot", "user:u-1", "approved", 1000))
	require.Equal(t, 1.0, h.waitRawSum(t, tenant, domain.MeterGovernedDecision, 1, 20*time.Second))
	h.publish(t, events.TopicAITokenUsage, tenant, uuid.New(), time.Now().UTC(),
		h.tokenUsagePayload("ws-7", "u-1", "claims-copilot", "qwen2.5", 1000, 500))
	require.Equal(t, 1000.0, h.waitRawSum(t, tenant, domain.MeterLLMInputTokens, 1000, 20*time.Second))
	require.NoError(t, h.st.RefreshRollups(context.Background(), time.Now().Add(-49*time.Hour)))

	// --- Unset: hours_saved_est/labor_value_est_usd/human_baseline_cost_usd/
	// net_value_est_usd are null; decisions/ai_cost_usd/adoption populate.
	r := h.do(t, "GET", "/api/v1/value/summary?period="+period, tok, nil, nil)
	require.Equal(t, 200, r.status)
	data, _ := r.body["data"].(map[string]any)
	require.NotNil(t, data)
	require.Nil(t, data["hours_saved_est"])
	require.Nil(t, data["labor_value_est_usd"])
	require.Nil(t, data["human_baseline_cost_usd"])
	require.Nil(t, data["net_value_est_usd"])
	decisions, _ := data["decisions"].(map[string]any)
	require.NotNil(t, decisions, "decisions must populate even with assumptions unset")
	require.EqualValues(t, 1, decisions["total"])
	prov, _ := data["provenance"].(map[string]any)
	require.Nil(t, prov["assumption_version"])
	require.NotNil(t, prov["meter_gap"], "current schema gap (by_kind not at rollup grain) always disclosed")

	// --- Set assumptions -> GET /value/assumptions reflects v1.
	putBody := map[string]any{
		"minutes_per_decision":   map[string]float64{"claims_disposition": 20},
		"loaded_hourly_rate_usd": 180,
	}
	pr := h.do(t, "PUT", "/api/v1/value/assumptions", tok, putBody, nil)
	require.Equal(t, 200, pr.status)
	pdata, _ := pr.body["data"].(map[string]any)
	require.EqualValues(t, 1, pdata["version"])

	gr := h.do(t, "GET", "/api/v1/value/assumptions", tok, nil, nil)
	require.Equal(t, 200, gr.status)
	gdata, _ := gr.body["data"].(map[string]any)
	require.EqualValues(t, 1, gdata["version"])
	require.EqualValues(t, 180, gdata["loaded_hourly_rate_usd"])

	// hours_saved_est is STILL null even with assumptions set, because
	// decisions.by_kind is unavailable in the current schema (proposal_kind
	// is raw-detail-only) — the honest degradation valuecalc unit-tests
	// directly; this proves the real handler wiring matches that contract
	// rather than silently fabricating a number.
	r2 := h.do(t, "GET", "/api/v1/value/summary?period="+period, tok, nil, nil)
	require.Equal(t, 200, r2.status)
	data2, _ := r2.body["data"].(map[string]any)
	require.Nil(t, data2["hours_saved_est"])
}

// TestAC2_AssumptionHistory_RecordsVersionsWithActor: editing assumptions
// twice yields two history rows in version order, each carrying created_by
// and the before/after values used (ROI-FR-002 point 4).
func TestAC2_AssumptionHistory_RecordsVersionsWithActor(t *testing.T) {
	h := requireHarness(t)
	tenant := uuid.New()
	tok := h.token(t, tenant, "user", "u-admin", nil)

	r1 := h.do(t, "PUT", "/api/v1/value/assumptions", tok, map[string]any{
		"minutes_per_decision": map[string]float64{"claims_disposition": 20}, "loaded_hourly_rate_usd": 150,
	}, nil)
	require.Equal(t, 200, r1.status)

	r2 := h.do(t, "PUT", "/api/v1/value/assumptions", tok, map[string]any{
		"minutes_per_decision": map[string]float64{"claims_disposition": 25}, "loaded_hourly_rate_usd": 180,
	}, nil)
	require.Equal(t, 200, r2.status)
	d2, _ := r2.body["data"].(map[string]any)
	require.EqualValues(t, 2, d2["version"])

	hr := h.do(t, "GET", "/api/v1/value/assumptions/history", tok, nil, nil)
	require.Equal(t, 200, hr.status)
	items, _ := hr.body["data"].([]any)
	require.Len(t, items, 2)
	v1 := items[0].(map[string]any)
	v2 := items[1].(map[string]any)
	require.EqualValues(t, 1, v1["version"])
	require.Equal(t, "superseded", v1["status"])
	require.EqualValues(t, 2, v2["version"])
	require.Equal(t, "active", v2["status"])
	require.Equal(t, "u-admin", v1["created_by"])

	evs := h.consumeUsageEvents(t, tenant, events.EvAssumptionsUpdated, 2, 15*time.Second)
	require.GreaterOrEqual(t, len(evs), 2, "value_assumptions.updated audited on real Kafka for every edit")
}

// TestAC3_ResolveAssumptions_PinsToVersionActiveAtPeriodClose: editing
// assumptions after a period has "closed" (a later effective_from) must not
// change what ResolveAssumptions returns for an `at` timestamp before that
// edit (BRD 69 AC-3). Uses direct store calls with controlled effective_from
// via raw SQL (PutAssumptions always stamps "today" — this test needs
// distinct historical dates to prove the as-of lookup, not the insert path
// already covered by TestAC2 above).
func TestAC3_ResolveAssumptions_PinsToVersionActiveAtPeriodClose(t *testing.T) {
	h := requireHarness(t)
	ctx := context.Background()
	tenant := uuid.New()

	july1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	aug1 := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	julyClose := time.Date(2026, 1, 31, 23, 59, 59, 0, time.UTC)

	h.execTenant(t, tenant, `INSERT INTO value_assumptions
		(id, tenant_id, version, minutes_per_decision, loaded_hourly_rate_usd, effective_from, status, created_by, created_at)
		VALUES ($1,$2,1,'{"claims_disposition":20}',180,$3,'superseded','u-admin', now())`,
		uuid.New(), tenant, july1)
	h.execTenant(t, tenant, `INSERT INTO value_assumptions
		(id, tenant_id, version, minutes_per_decision, loaded_hourly_rate_usd, effective_from, status, created_by, created_at)
		VALUES ($1,$2,2,'{"claims_disposition":25}',200,$3,'active','u-admin', now())`,
		uuid.New(), tenant, aug1)

	// Resolving "as of" July's close must still return v1 even though v2
	// (effective Aug 1) now exists and is the tenant's currently-active row.
	julyResolved, ok, err := h.st.ResolveAssumptions(ctx, tenant, julyClose)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, 1, julyResolved.Version)
	require.Equal(t, 180.0, julyResolved.LoadedHourlyRateUSD)

	// Resolving "now" (well after Aug 1) returns v2.
	current, ok, err := h.st.ResolveAssumptions(ctx, tenant, time.Now().UTC())
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, 2, current.Version)
	require.Equal(t, 200.0, current.LoadedHourlyRateUSD)
}

// TestAC5_ReadOnlyUser_Denied403OnAssumptionWrite proves usage.assumptions.
// update is a DISTINCT grant from usage.report.read via the REAL OPA sidecar
// (design §2.9): a subject granted only report.read is denied the write
// action. REAL: OPA, Redis.
func TestAC5_ReadOnlyUser_Denied403OnAssumptionWrite(t *testing.T) {
	h := requireHarness(t)
	ctx := context.Background()
	tenant := uuid.New().String()
	user := "u-" + uuid.NewString()[:8]

	require.NoError(t, opaclient.SeedCatalogActions(ctx, h.redis, map[string]bool{
		"usage.report.read": false, "usage.assumptions.update": false}))
	require.NoError(t, h.redis.R.Set(ctx, "perm:"+tenant+":"+user+":actions",
		`{"actions":["usage.report.read"]}`, time.Hour).Err())

	az := authz.NewOPAClient(opaURL, redisAddr)
	in := func(action string) authz.Input {
		return authz.Input{Subject: authz.Subject{ID: user, Typ: "user"}, Action: action, Tenant: tenant}
	}
	require.True(t, az.Allow(ctx, in(authz.ActionReportRead)), "granted usage.report.read allows viewing the dashboard")
	require.False(t, az.Allow(ctx, in(authz.ActionAssumptionsUpdate)), "usage.assumptions.update NOT granted -> denied")
}

// TestAC_RLS_ValueAssumptionsCrossTenantEmpty proves tenant isolation on the
// new value_assumptions table under the shipped non-owner role (mirrors
// TestAC_RLSCrossTenantEmptyViaShippedRole for the pre-existing tables).
func TestAC_RLS_ValueAssumptionsCrossTenantEmpty(t *testing.T) {
	h := requireHarness(t)
	ctx := context.Background()
	tenantA := uuid.New()
	tenantB := uuid.New()

	_, err := h.st.PutAssumptions(ctx, domain.Op{Tenant: tenantA, Actor: domain.Actor{Type: "user", ID: "a"}},
		map[string]float64{"claims_disposition": 20}, 180)
	require.NoError(t, err)

	require.Equal(t, 0, h.queryInt(t, tenantB, `SELECT COUNT(*) FROM value_assumptions WHERE tenant_id=$1`, tenantA))
	require.Equal(t, 1, h.queryInt(t, tenantA, `SELECT COUNT(*) FROM value_assumptions WHERE tenant_id=$1`, tenantA))

	// Cross-tenant token cannot read tenant A's assumptions via HTTP either.
	tokB := h.token(t, tenantB, "user", "u-b", nil)
	r := h.do(t, "GET", "/api/v1/value/assumptions", tokB, nil, nil)
	require.Equal(t, 200, r.status)
	require.Nil(t, r.body["data"], "tenant B sees no assumptions (RLS), same as never having set any")
}
