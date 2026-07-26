package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/events"
)

// CreateValueExport inserts the next version for (tenant, period, workspace)
// — re-exporting a period never overwrites a prior version's row (design
// §2.8 step 7).
func (s *PG) CreateValueExport(ctx context.Context, op domain.Op, e domain.ValueExport) (domain.ValueExport, error) {
	wsKey := ""
	if e.WorkspaceID != nil {
		wsKey = *e.WorkspaceID
	}
	e.ID = domain.NewID()
	e.TenantID = op.Tenant
	e.CreatedAt = time.Now().UTC()
	err := s.withTenant(ctx, op.Tenant, func(tx pgx.Tx) error {
		var maxVersion int
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(version),0) FROM value_exports
			WHERE tenant_id=$1 AND period=$2 AND workspace_id=$3`,
			op.Tenant, e.Period, wsKey).Scan(&maxVersion); err != nil {
			return err
		}
		e.Version = maxVersion + 1

		if _, err := tx.Exec(ctx, `
			INSERT INTO value_exports
			  (id, tenant_id, period, workspace_id, version, json_key, json_sha256,
			   csv_key, csv_sha256, assumption_version, generated_by, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			e.ID, e.TenantID, e.Period, wsKey, e.Version, e.JSONKey, e.JSONSHA256,
			e.CSVKey, e.CSVSHA256, e.AssumptionVersion, e.GeneratedBy, e.CreatedAt); err != nil {
			return err
		}
		env := events.NewEnvelope(events.EvValueReportExported, op, domain.ValueExportURN(op.Tenant, e.ID), map[string]any{
			"period": e.Period, "workspace_id": e.WorkspaceID, "version": e.Version,
			"json_sha256": e.JSONSHA256, "csv_sha256": e.CSVSHA256,
		})
		return insertOutbox(ctx, tx, env)
	})
	return e, err
}

// ListValueExports returns exports for a tenant, optionally filtered by
// period, newest first (design §2.8 step 5, "listed in exports").
func (s *PG) ListValueExports(ctx context.Context, tenant uuid.UUID, period string) ([]domain.ValueExport, error) {
	var out []domain.ValueExport
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, tenant_id, period, NULLIF(workspace_id,''), version, json_key, json_sha256,
			       csv_key, csv_sha256, assumption_version, generated_by, created_at
			FROM value_exports
			WHERE tenant_id=$1 AND ($2='' OR period=$2)
			ORDER BY created_at DESC`, tenant, period)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e domain.ValueExport
			if err := rows.Scan(&e.ID, &e.TenantID, &e.Period, &e.WorkspaceID, &e.Version, &e.JSONKey, &e.JSONSHA256,
				&e.CSVKey, &e.CSVSHA256, &e.AssumptionVersion, &e.GeneratedBy, &e.CreatedAt); err != nil {
				return err
			}
			out = append(out, e)
		}
		return rows.Err()
	})
	return out, err
}
