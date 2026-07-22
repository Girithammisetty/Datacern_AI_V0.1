package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/datacern-ai/case-service/internal/domain"
)

// Case-trigger CRUD (realtime-decisioning INC-1). Same RLS-pinned access
// pattern as every other case-service table (withTenant → app.tenant_id).

const triggerCols = `id, workspace_id, name, enabled, dataset_urn, dataset_name,
	conditions, row_pk_field, severity, due_hours, projection_fields, max_cases_per_event,
	created_by, created_at, updated_at`

func scanTrigger(row pgx.Row, tenant uuid.UUID) (*domain.CaseTrigger, error) {
	t := &domain.CaseTrigger{TenantID: tenant}
	var conds, projFields []byte
	if err := row.Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Enabled, &t.DatasetURN, &t.DatasetName,
		&conds, &t.RowPKField, &t.Severity, &t.DueHours, &projFields, &t.MaxCasesPerEvent,
		&t.CreatedByID, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	if len(conds) > 0 {
		_ = json.Unmarshal(conds, &t.Conditions)
	}
	if t.Conditions == nil {
		t.Conditions = []domain.TriggerCondition{}
	}
	if len(projFields) > 0 {
		_ = json.Unmarshal(projFields, &t.ProjectionFields)
	}
	if t.ProjectionFields == nil {
		t.ProjectionFields = []string{}
	}
	return t, nil
}

// CreateTrigger inserts a trigger; (tenant, workspace, name) unique.
func (s *PG) CreateTrigger(ctx context.Context, t *domain.CaseTrigger) error {
	err := s.withTenant(ctx, t.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO case_triggers (id, tenant_id, workspace_id, name, enabled,
				dataset_urn, dataset_name, conditions, row_pk_field, severity, due_hours,
				projection_fields, max_cases_per_event, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			t.ID, t.TenantID, t.WorkspaceID, t.Name, t.Enabled,
			t.DatasetURN, t.DatasetName, mustJSON(t.Conditions), t.RowPKField, t.Severity, t.DueHours,
			mustJSON(t.ProjectionFields), t.MaxCasesPerEvent, t.CreatedByID)
		return err
	})
	if isUniqueViolation(err) {
		return ErrCodeConflict
	}
	return err
}

// ListTriggers returns the workspace's triggers, newest first.
func (s *PG) ListTriggers(ctx context.Context, tenant, workspace uuid.UUID) ([]*domain.CaseTrigger, error) {
	var out []*domain.CaseTrigger
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+triggerCols+` FROM case_triggers
			WHERE workspace_id = $1 ORDER BY created_at DESC`, workspace)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			t, err := scanTrigger(rows, tenant)
			if err != nil {
				return err
			}
			out = append(out, t)
		}
		return rows.Err()
	})
	return out, err
}

// ListEnabledTriggers returns every enabled trigger for the tenant (all
// workspaces) — the consumer match set for one ingestion.completed event.
func (s *PG) ListEnabledTriggers(ctx context.Context, tenant uuid.UUID) ([]*domain.CaseTrigger, error) {
	var out []*domain.CaseTrigger
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+triggerCols+` FROM case_triggers
			WHERE enabled ORDER BY created_at`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			t, err := scanTrigger(rows, tenant)
			if err != nil {
				return err
			}
			out = append(out, t)
		}
		return rows.Err()
	})
	return out, err
}

// UpdateTrigger persists the full (already-validated) rule; the API layer
// loads + merges the patch before calling.
func (s *PG) UpdateTrigger(ctx context.Context, t *domain.CaseTrigger) error {
	return s.withTenant(ctx, t.TenantID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE case_triggers SET name=$3, enabled=$4, dataset_urn=$5, dataset_name=$6,
				conditions=$7, row_pk_field=$8, severity=$9, due_hours=$10, projection_fields=$11,
				max_cases_per_event=$12, updated_at=now()
			WHERE id=$1 AND workspace_id=$2`,
			t.ID, t.WorkspaceID, t.Name, t.Enabled, t.DatasetURN, t.DatasetName,
			mustJSON(t.Conditions), t.RowPKField, t.Severity, t.DueHours, mustJSON(t.ProjectionFields),
			t.MaxCasesPerEvent)
		if err != nil {
			if isUniqueViolation(err) {
				return ErrCodeConflict
			}
			return err
		}
		if tag.RowsAffected() == 0 {
			return domain.ENotFound()
		}
		return nil
	})
}

// GetTrigger loads one trigger by id within the caller's workspace.
func (s *PG) GetTrigger(ctx context.Context, tenant, workspace, id uuid.UUID) (*domain.CaseTrigger, error) {
	var out *domain.CaseTrigger
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		t, err := scanTrigger(tx.QueryRow(ctx, `SELECT `+triggerCols+` FROM case_triggers
			WHERE id=$1 AND workspace_id=$2`, id, workspace), tenant)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.ENotFound()
			}
			return err
		}
		out = t
		return nil
	})
	return out, err
}

// DeleteTrigger removes a trigger.
func (s *PG) DeleteTrigger(ctx context.Context, tenant, workspace, id uuid.UUID) error {
	return s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM case_triggers WHERE id=$1 AND workspace_id=$2`, id, workspace)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return domain.ENotFound()
		}
		return nil
	})
}

// TouchTriggerFired is a lightweight updated_at bump used by the consumer so
// operators can see a trigger recently acted (no dedicated last_fired column
// yet — deferred until the UI needs richer run history).
func (s *PG) TouchTriggerFired(ctx context.Context, tenant, id uuid.UUID, at time.Time) error {
	return s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE case_triggers SET updated_at=$2 WHERE id=$1`, id, at)
		return err
	})
}
