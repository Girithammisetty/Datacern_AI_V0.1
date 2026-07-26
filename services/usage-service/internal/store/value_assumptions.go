package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/events"
)

// PutAssumptions inserts a new value_assumptions version for a tenant,
// superseding the prior active version (if any) in the same transaction
// (BRD 69 ROI-FR-002, design §2.1 points 1-2). Never an in-place update —
// rows are immutable once written, same discipline as usage_monthly's
// finalized_at rows.
func (s *PG) PutAssumptions(ctx context.Context, op domain.Op, minutesPerDecision map[string]float64, loadedHourlyRateUSD float64) (domain.ValueAssumptions, error) {
	if minutesPerDecision == nil {
		minutesPerDecision = map[string]float64{}
	}
	minutesJSON, err := json.Marshal(minutesPerDecision)
	if err != nil {
		return domain.ValueAssumptions{}, domain.ErrValidation
	}

	var out domain.ValueAssumptions
	var before *domain.ValueAssumptions
	err = s.withTenant(ctx, op.Tenant, func(tx pgx.Tx) error {
		var priorID uuid.UUID
		var priorVersion int
		var priorMinutes []byte
		var priorRate float64
		lookupErr := tx.QueryRow(ctx, `
			SELECT id, version, minutes_per_decision, loaded_hourly_rate_usd
			FROM value_assumptions WHERE tenant_id=$1 AND status='active' FOR UPDATE`,
			op.Tenant).Scan(&priorID, &priorVersion, &priorMinutes, &priorRate)

		newVersion := 1
		switch {
		case lookupErr == nil:
			newVersion = priorVersion + 1
			b := &domain.ValueAssumptions{ID: priorID, Version: priorVersion, LoadedHourlyRateUSD: priorRate}
			_ = json.Unmarshal(priorMinutes, &b.MinutesPerDecision)
			before = b
			if _, err := tx.Exec(ctx, `UPDATE value_assumptions SET status='superseded' WHERE id=$1`, priorID); err != nil {
				return err
			}
		case errors.Is(lookupErr, pgx.ErrNoRows):
			// First assumptions for this tenant (ROI-FR-001 point 1).
		default:
			return lookupErr
		}

		out = domain.ValueAssumptions{
			ID:                  domain.NewID(),
			TenantID:            op.Tenant,
			Version:             newVersion,
			MinutesPerDecision:  minutesPerDecision,
			LoadedHourlyRateUSD: loadedHourlyRateUSD,
			EffectiveFrom:       time.Now().UTC().Truncate(24 * time.Hour),
			Status:              domain.AssumptionsActive,
			CreatedBy:           op.Actor.ID,
			CreatedAt:           time.Now().UTC(),
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO value_assumptions
			  (id, tenant_id, version, minutes_per_decision, loaded_hourly_rate_usd, effective_from, status, created_by, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			out.ID, out.TenantID, out.Version, minutesJSON, out.LoadedHourlyRateUSD,
			out.EffectiveFrom, out.Status, out.CreatedBy, out.CreatedAt); err != nil {
			return err
		}

		payload := map[string]any{"after": assumptionsAuditView(out)}
		if before != nil {
			payload["before"] = assumptionsAuditView(*before)
		} else {
			payload["before"] = nil
		}
		env := events.NewEnvelope(events.EvAssumptionsUpdated, op, domain.ValueAssumptionsURN(op.Tenant, out.ID), payload)
		return insertOutbox(ctx, tx, env)
	})
	return out, err
}

func assumptionsAuditView(a domain.ValueAssumptions) map[string]any {
	return map[string]any{
		"version":                a.Version,
		"minutes_per_decision":   a.MinutesPerDecision,
		"loaded_hourly_rate_usd": a.LoadedHourlyRateUSD,
	}
}

// ResolveAssumptions returns the version active "as of" time `at` — the
// as-of lookup shape mirroring ResolvePrices (MAX(version) WHERE
// effective_from <= at). A closed usage_monthly bucket always resolves
// against the version active at that bucket's close, so recomputing a past
// period after a later assumption edit reproduces the original figures
// exactly (BRD 69 AC-3, design §2.1 point 3). ok=false means the tenant has
// never set assumptions (ROI-FR-001 "ships absent" — no sentinel row).
func (s *PG) ResolveAssumptions(ctx context.Context, tenant uuid.UUID, at time.Time) (*domain.ValueAssumptions, bool, error) {
	var a domain.ValueAssumptions
	var minutes []byte
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT id, tenant_id, version, minutes_per_decision, loaded_hourly_rate_usd,
			       effective_from, status, created_by, created_at
			FROM value_assumptions
			WHERE tenant_id=$1 AND effective_from <= $2
			ORDER BY version DESC LIMIT 1`, tenant, at).
			Scan(&a.ID, &a.TenantID, &a.Version, &minutes, &a.LoadedHourlyRateUSD,
				&a.EffectiveFrom, &a.Status, &a.CreatedBy, &a.CreatedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	_ = json.Unmarshal(minutes, &a.MinutesPerDecision)
	return &a, true, nil
}

// AssumptionHistory returns every version for a tenant ordered by version —
// the version rows themselves ARE the audit history (ROI-FR-002 point 4), no
// separate history table.
func (s *PG) AssumptionHistory(ctx context.Context, tenant uuid.UUID) ([]domain.ValueAssumptions, error) {
	var out []domain.ValueAssumptions
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, tenant_id, version, minutes_per_decision, loaded_hourly_rate_usd,
			       effective_from, status, created_by, created_at
			FROM value_assumptions WHERE tenant_id=$1 ORDER BY version`, tenant)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a domain.ValueAssumptions
			var minutes []byte
			if err := rows.Scan(&a.ID, &a.TenantID, &a.Version, &minutes, &a.LoadedHourlyRateUSD,
				&a.EffectiveFrom, &a.Status, &a.CreatedBy, &a.CreatedAt); err != nil {
				return err
			}
			_ = json.Unmarshal(minutes, &a.MinutesPerDecision)
			out = append(out, a)
		}
		return rows.Err()
	})
	return out, err
}
