package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// ValueSummaryInputs reads the ROI-FR-010 summary's raw ingredients from
// usage_monthly ONLY (ROI-NFR-001 "no raw scans at request time" — the same
// precedent QueryUsage follows over usage_daily). Returns the
// governed_decision breakdown (including by_kind — see below), ai_cost_usd
// (existing LLM token meters priced via the active rate card), adoption
// (distinct user_id across all meters), and whether the bucket is finalized
// (for the provenance.rollup_version tag).
//
// ByKind is populated from usage_monthly's proposal_kind column (BRD 69's
// migration 000007_governed_decision_kind, docs/initiatives/
// value-roi-reporting.md §3 "Repo-state finding" / "Known limits" — this
// closes the gap that migration left open: proposal_kind is now a physical
// rollup dimension, not raw-detail-only in usage_raw.meta). A decision row
// with an empty/unset proposal_kind (pre-migration data, or an event that
// genuinely carried none) does NOT contribute to ByKind — it still counts
// toward Total/ByDecision/ByAgent/ByPack, but valuecalc.BuildSummary only
// derives hours_saved_est/etc. from kinds it can see, so decisions with no
// kind honestly contribute nothing to those estimates rather than being
// silently dropped or fabricated into an "unknown" bucket.
func (s *PG) ValueSummaryInputs(ctx context.Context, tenant uuid.UUID, monthStart time.Time, workspaceID string) (domain.DecisionsBreakdown, float64, domain.Adoption, bool, error) {
	decisions := domain.DecisionsBreakdown{
		ByDecision: map[string]int64{},
		ByKind:     map[string]int64{},
		ByAgent:    map[string]int64{},
		ByPack:     map[string]int64{},
	}
	adoption := domain.Adoption{ByWorkspace: map[string]int64{}}
	var aiCostUSD float64
	var finalized bool

	prices, _, err := s.ResolvePrices(ctx, tenant, monthStart)
	if err != nil {
		return decisions, 0, adoption, false, err
	}

	err = s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		// governed_decision breakdown.
		rows, err := tx.Query(ctx, `
			SELECT NULLIF(decision,''), NULLIF(agent_id,''), NULLIF(pack_name,''), NULLIF(proposal_kind,''),
			       quantity_sum::float8, finalized_at
			FROM usage_monthly
			WHERE tenant_id=$1 AND meter_key=$2 AND bucket=$3
			  AND ($4='' OR workspace_id=$4)`,
			tenant, domain.MeterGovernedDecision, monthStart, workspaceID)
		if err != nil {
			return err
		}
		first := true
		for rows.Next() {
			var decision, agent, pack, kind *string
			var qty float64
			var finAt *time.Time
			if err := rows.Scan(&decision, &agent, &pack, &kind, &qty, &finAt); err != nil {
				rows.Close()
				return err
			}
			n := int64(qty)
			decisions.Total += n
			if decision != nil {
				decisions.ByDecision[*decision] += n
			}
			if agent != nil {
				decisions.ByAgent[*agent] += n
			}
			if pack != nil {
				decisions.ByPack[*pack] += n
			}
			if kind != nil {
				decisions.ByKind[*kind] += n
			}
			if first {
				finalized = finAt != nil
				first = false
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		rows.Close()

		// ai_cost_usd: LLM token meters only (design §2.0 "computable today").
		aiRows, err := tx.Query(ctx, `
			SELECT meter_key, SUM(quantity_sum)::float8
			FROM usage_monthly
			WHERE tenant_id=$1 AND bucket=$2 AND meter_key IN ($3,$4)
			  AND ($5='' OR workspace_id=$5)
			GROUP BY meter_key`,
			tenant, monthStart, domain.MeterLLMInputTokens, domain.MeterLLMOutputTokens, workspaceID)
		if err != nil {
			return err
		}
		for aiRows.Next() {
			var mk string
			var qty float64
			if err := aiRows.Scan(&mk, &qty); err != nil {
				aiRows.Close()
				return err
			}
			aiCostUSD += qty * prices[mk]
		}
		if err := aiRows.Err(); err != nil {
			return err
		}
		aiRows.Close()

		// adoption: distinct active users across all meters this period.
		userRows, err := tx.Query(ctx, `
			SELECT DISTINCT NULLIF(workspace_id,''), user_id
			FROM usage_monthly
			WHERE tenant_id=$1 AND bucket=$2 AND user_id<>''
			  AND ($3='' OR workspace_id=$3)`,
			tenant, monthStart, workspaceID)
		if err != nil {
			return err
		}
		seenOverall := map[string]bool{}
		seenByWS := map[string]map[string]bool{}
		for userRows.Next() {
			var ws *string
			var user string
			if err := userRows.Scan(&ws, &user); err != nil {
				userRows.Close()
				return err
			}
			seenOverall[user] = true
			if ws != nil {
				if seenByWS[*ws] == nil {
					seenByWS[*ws] = map[string]bool{}
				}
				seenByWS[*ws][user] = true
			}
		}
		if err := userRows.Err(); err != nil {
			return err
		}
		userRows.Close()
		adoption.ActiveUsers = int64(len(seenOverall))
		for ws, users := range seenByWS {
			adoption.ByWorkspace[ws] = int64(len(users))
		}
		return nil
	})
	return decisions, aiCostUSD, adoption, finalized, err
}
