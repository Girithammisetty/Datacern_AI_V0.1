package store

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// ValueTrendPoints computes one cost_per_decision point per calendar month in
// [from, to] (ROI-FR-011). Reuses ValueSummaryInputs per month — reads
// usage_monthly only (ROI-NFR-001), never usage_raw. distilled_rung_share is
// always nil today: ai-gateway tracks rung per call but usage-service's
// MeterRecord carries no rung dimension yet (design §2.4, a documented
// Should-tier follow-up, not fabricated from ladder config alone).
func (s *PG) ValueTrendPoints(ctx context.Context, tenant uuid.UUID, from, to time.Time, workspaceID string) ([]domain.ValueTrendPoint, error) {
	var out []domain.ValueTrendPoint
	for m := from; !m.After(to); m = m.AddDate(0, 1, 0) {
		decisions, aiCost, _, finalized, err := s.ValueSummaryInputs(ctx, tenant, m, workspaceID)
		if err != nil {
			return nil, err
		}
		period := m.Format("2006-01")
		rollupVersion := "usage_monthly@" + period + "-open"
		if finalized {
			rollupVersion = "usage_monthly@" + period + "-finalized"
		}
		point := domain.ValueTrendPoint{Period: period, RollupVersion: rollupVersion}
		if decisions.Total > 0 {
			v := aiCost / float64(decisions.Total)
			basis := domain.CostBasisBlended
			point.Value = &v
			point.Basis = &basis
		}
		out = append(out, point)
	}
	return out, nil
}
