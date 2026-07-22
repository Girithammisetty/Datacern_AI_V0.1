package pgstore

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrFourEyesSameActor is returned when the approver is the same subject who
// proposed the change (BRD 59 WS2, mirrors ingestion-service writebacks.approve()).
var ErrFourEyesSameActor = errors.New("four-eyes: the approver must differ from the requester")

// ErrSiemConfigNotPending is returned approving/rejecting a row that has
// already left pending_approval (already decided, or raced by another approver).
var ErrSiemConfigNotPending = errors.New("siem config is not pending_approval")

// SiemConfig is one proposed/decided state of a tenant's SIEM export
// destination (BRD 59 WS2). See migrations/000004_siem_configs for the
// four-eyes design note: every propose/approve/reject creates or transitions
// one row rather than mutating a single config in place, so the full history
// (who proposed, who approved) stays queryable.
type SiemConfig struct {
	ID           uuid.UUID
	TenantID     uuid.UUID
	Endpoint     string
	Format       string // CEF | LEEF | JSON
	AuthRef      string
	Active       bool
	Status       string // pending_approval | approved | rejected
	RequestedBy  string
	ApprovedBy   string
	RejectedBy   string
	RejectReason string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const siemConfigCols = `id, tenant_id, endpoint, format, auth_ref, active, status,
	requested_by, coalesce(approved_by,''), coalesce(rejected_by,''), reject_reason, created_at, updated_at`

func scanSiemConfig(row pgx.Row) (*SiemConfig, error) {
	var c SiemConfig
	err := row.Scan(&c.ID, &c.TenantID, &c.Endpoint, &c.Format, &c.AuthRef, &c.Active, &c.Status,
		&c.RequestedBy, &c.ApprovedBy, &c.RejectedBy, &c.RejectReason, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// ProposeSiemConfig creates a new pending_approval row (the four-eyes propose
// step) — the current active config, if any, is untouched until this one is
// approved, so export delivery never has a gap.
func (s *Store) ProposeSiemConfig(ctx context.Context, tenant uuid.UUID, endpoint, format, authRef, requestedBy string) (*SiemConfig, error) {
	id := uuid.New()
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO tenant_siem_configs (id, tenant_id, endpoint, format, auth_ref, requested_by)
			 VALUES ($1,$2,$3,$4,$5,$6)`,
			id, tenant, endpoint, format, authRef, requestedBy)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.GetSiemConfig(ctx, tenant, id)
}

// ApproveSiemConfig approves a pending row by a DISTINCT approver (four-eyes)
// and, in the same transaction, deactivates any previously-active config for
// the tenant so at most one row is ever active.
func (s *Store) ApproveSiemConfig(ctx context.Context, tenant, id uuid.UUID, approvedBy string) (*SiemConfig, error) {
	var out *SiemConfig
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		var requestedBy, status string
		if err := tx.QueryRow(ctx,
			`SELECT requested_by, status FROM tenant_siem_configs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
			tenant, id).Scan(&requestedBy, &status); err != nil {
			return err
		}
		if status != "pending_approval" {
			return ErrSiemConfigNotPending
		}
		if requestedBy == approvedBy {
			return ErrFourEyesSameActor
		}
		if _, err := tx.Exec(ctx,
			`UPDATE tenant_siem_configs SET active=false, updated_at=now() WHERE tenant_id=$1 AND active`,
			tenant); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE tenant_siem_configs SET status='approved', approved_by=$3, active=true, updated_at=now()
			   WHERE tenant_id=$1 AND id=$2`,
			tenant, id, approvedBy); err != nil {
			return err
		}
		c, err := scanSiemConfig(tx.QueryRow(ctx,
			`SELECT `+siemConfigCols+` FROM tenant_siem_configs WHERE tenant_id=$1 AND id=$2`, tenant, id))
		out = c
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RejectSiemConfig rejects a pending row. Any actor may reject (unlike
// approve, rejection has no self-dealing risk to guard against) except the
// original requester withdrawing their own proposal is just as valid as
// someone else declining it.
func (s *Store) RejectSiemConfig(ctx context.Context, tenant, id uuid.UUID, rejectedBy, reason string) (*SiemConfig, error) {
	var out *SiemConfig
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(ctx,
			`SELECT status FROM tenant_siem_configs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenant, id).
			Scan(&status); err != nil {
			return err
		}
		if status != "pending_approval" {
			return ErrSiemConfigNotPending
		}
		if _, err := tx.Exec(ctx,
			`UPDATE tenant_siem_configs SET status='rejected', rejected_by=$3, reject_reason=$4, updated_at=now()
			   WHERE tenant_id=$1 AND id=$2`,
			tenant, id, rejectedBy, reason); err != nil {
			return err
		}
		c, err := scanSiemConfig(tx.QueryRow(ctx,
			`SELECT `+siemConfigCols+` FROM tenant_siem_configs WHERE tenant_id=$1 AND id=$2`, tenant, id))
		out = c
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteSiemConfig removes a decided (approved/rejected, never pending — use
// RejectSiemConfig to withdraw a live proposal) row. Deleting the active
// config stops export delivery to it immediately.
func (s *Store) DeleteSiemConfig(ctx context.Context, tenant, id uuid.UUID) error {
	return s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`DELETE FROM tenant_siem_configs WHERE tenant_id=$1 AND id=$2 AND status <> 'pending_approval'`,
			tenant, id)
		return err
	})
}

// GetSiemConfig reads one row by id; nil when absent (or cross-tenant, via RLS).
func (s *Store) GetSiemConfig(ctx context.Context, tenant, id uuid.UUID) (*SiemConfig, error) {
	var out *SiemConfig
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		c, err := scanSiemConfig(tx.QueryRow(ctx,
			`SELECT `+siemConfigCols+` FROM tenant_siem_configs WHERE tenant_id=$1 AND id=$2`, tenant, id))
		out = c
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ActiveSiemConfig returns the tenant's current live destination, nil if none
// is configured/approved yet.
func (s *Store) ActiveSiemConfig(ctx context.Context, tenant uuid.UUID) (*SiemConfig, error) {
	var out *SiemConfig
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		c, err := scanSiemConfig(tx.QueryRow(ctx,
			`SELECT `+siemConfigCols+` FROM tenant_siem_configs WHERE tenant_id=$1 AND active LIMIT 1`, tenant))
		out = c
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ListSiemConfigs returns every proposal for a tenant (history + any pending
// row), newest first, for the self-service admin screen.
func (s *Store) ListSiemConfigs(ctx context.Context, tenant uuid.UUID) ([]SiemConfig, error) {
	var out []SiemConfig
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT `+siemConfigCols+` FROM tenant_siem_configs WHERE tenant_id=$1 ORDER BY created_at DESC`, tenant)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			c, err := scanSiemConfig(rows)
			if err != nil {
				return err
			}
			out = append(out, *c)
		}
		return rows.Err()
	})
	return out, err
}

// ActiveSiemConfigForDelivery is the platform-scoped read the export path
// uses: it processes one shared ingest stream spanning every tenant, so it
// looks up each event's tenant's destination under app.role=platform rather
// than a single tenant's own request context (mirrors ListUnsealedDays).
func (s *Store) ActiveSiemConfigForDelivery(ctx context.Context, tenant uuid.UUID) (*SiemConfig, error) {
	var out *SiemConfig
	err := s.withPlatform(ctx, func(tx pgx.Tx) error {
		c, err := scanSiemConfig(tx.QueryRow(ctx,
			`SELECT `+siemConfigCols+` FROM tenant_siem_configs WHERE tenant_id=$1 AND active LIMIT 1`, tenant))
		out = c
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
