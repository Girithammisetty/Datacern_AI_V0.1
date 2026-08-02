package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// Billing-period close persistence (value-metering-billing-export §2.6). Rows
// are never UPDATEd past status/pushed_* — a correction inserts version N+1,
// mirroring value_exports. The close job composes these with the pure
// billing.DecideClose / NewBillingPeriod / BuildArtifacts helpers.

// MonthFinalized reports whether usage_monthly for `month` (YYYY-MM) has been
// finalized (past the 48h late-event window) — the first close-gate condition.
func (s *PG) MonthFinalized(ctx context.Context, month string) (bool, error) {
	first, err := time.Parse("2006-01", month)
	if err != nil {
		return false, domain.ErrValidation
	}
	var finalized bool
	err = s.withPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM usage_monthly WHERE bucket=$1 AND finalized_at IS NOT NULL)`,
			first).Scan(&finalized)
	})
	return finalized, err
}

// BillingPeriodVersion returns the highest existing version for (tenant,
// period), or 0 when the period has never been closed.
func (s *PG) BillingPeriodVersion(ctx context.Context, tenant uuid.UUID, period string) (int, error) {
	var v int
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(version),0) FROM billing_periods
			WHERE tenant_id=$1 AND period=$2`, tenant, period).Scan(&v)
	})
	return v, err
}

// meterTotals is the billing_periods.meter_totals JSONB shape.
type meterTotals map[string]struct {
	Quantity float64 `json:"quantity"`
	GrossUSD float64 `json:"gross_usd"`
}

// InsertBillingPeriod atomically closes a period at bp.Version and records its
// export, under a per-(tenant,period) advisory lock so two replicas racing the
// same close can't both insert the same version (design §2.6). The advisory
// lock is transaction-scoped (pg_advisory_xact_lock) so it releases with the
// tx; a loser blocks briefly then sees the version already present and the
// UNIQUE (tenant_id, period, version) constraint is the final backstop.
// The artifact bytes must already be written to the object store before this
// (file path is truth). Returns the new billing_periods.id.
func (s *PG) InsertBillingPeriod(
	ctx context.Context, op domain.Op, bp domain.BillingPeriod,
	netBillableUSD float64, closedBy string, art billingArtifactKeys,
) (uuid.UUID, error) {
	totals := meterTotals{}
	for _, ln := range bp.Lines {
		totals[ln.MeterKey] = struct {
			Quantity float64 `json:"quantity"`
			GrossUSD float64 `json:"gross_usd"`
		}{Quantity: ln.Quantity, GrossUSD: ln.GrossUSD}
	}
	totalsJSON, err := json.Marshal(totals)
	if err != nil {
		return uuid.Nil, err
	}

	periodID := domain.NewID()
	exportID := domain.NewID()
	now := time.Now().UTC()

	err = s.withTenant(ctx, op.Tenant, func(tx pgx.Tx) error {
		// Serialize concurrent closes of the same (tenant, period).
		lockKey := int64(hashKey(op.Tenant.String() + ":" + bp.Period))
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKey); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO billing_periods
			  (id, tenant_id, period, version, rate_card_id, rate_card_version,
			   meter_totals, allowance_drawdown, gross_usd, net_billable_usd,
			   status, closed_at, closed_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8,$9,$10,$11,$12)`,
			periodID, op.Tenant, bp.Period, bp.Version, bp.RateCardID, bp.RateCardVersion,
			totalsJSON, bp.GrossUSD, netBillableUSD, domain.BillingExported, now, closedBy); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO billing_exports
			  (id, billing_period_id, tenant_id, period, version,
			   jsonl_key, jsonl_sha256, csv_key, csv_sha256, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			exportID, periodID, op.Tenant, bp.Period, bp.Version,
			art.JSONLKey, art.JSONLSHA256, art.CSVKey, art.CSVSHA256, now); err != nil {
			return err
		}
		return nil
	})
	return periodID, err
}

// billingArtifactKeys carries the object keys + checksums the close job already
// computed via billing.BuildArtifacts (kept here to avoid a store→billing
// import cycle — the job passes the four strings).
type billingArtifactKeys struct {
	JSONLKey, JSONLSHA256, CSVKey, CSVSHA256 string
}

// NewBillingArtifactKeys constructs the keys record from the four values the
// close job holds.
func NewBillingArtifactKeys(jsonlKey, jsonlSHA, csvKey, csvSHA string) billingArtifactKeys {
	return billingArtifactKeys{JSONLKey: jsonlKey, JSONLSHA256: jsonlSHA, CSVKey: csvKey, CSVSHA256: csvSHA}
}

// MarkExportPush records the outcome of a provider push on the export row
// (never blocks the period being exported — the file path is truth). status is
// one of domain.PushPushed / PushNotConfigured / PushFailed.
func (s *PG) MarkExportPush(ctx context.Context, tenant uuid.UUID, period string, version int, status, reference string) error {
	return s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		var ref *string
		if reference != "" {
			ref = &reference
		}
		_, err := tx.Exec(ctx, `
			UPDATE billing_exports SET pushed_status=$1, pushed_reference=$2, pushed_at=now()
			WHERE tenant_id=$3 AND period=$4 AND version=$5`,
			status, ref, tenant, period, version)
		return err
	})
}

// ListBillingPeriods returns a tenant's closed periods (optionally one period),
// newest first, each joined with its export record (VMB-FR-023).
func (s *PG) ListBillingPeriods(ctx context.Context, tenant uuid.UUID, period string, limit int) ([]domain.BillingPeriodRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var out []domain.BillingPeriodRecord
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT p.id, p.tenant_id, p.period, p.version, p.rate_card_id, p.rate_card_version,
			       p.gross_usd, p.net_billable_usd, p.status, p.closed_at, p.closed_by,
			       e.jsonl_key, e.jsonl_sha256, e.csv_key, e.csv_sha256,
			       e.pushed_status, e.pushed_reference, e.pushed_at, e.created_at
			FROM billing_periods p
			LEFT JOIN billing_exports e
			  ON e.tenant_id=p.tenant_id AND e.period=p.period AND e.version=p.version
			WHERE p.tenant_id=$1 AND ($2='' OR p.period=$2)
			ORDER BY p.period DESC, p.version DESC
			LIMIT $3`, tenant, period, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r domain.BillingPeriodRecord
			var jsonlKey, jsonlSHA, csvKey, csvSHA *string
			var pushedStatus, pushedRef *string
			var pushedAt *time.Time
			var exportCreated *time.Time
			if err := rows.Scan(
				&r.ID, &r.TenantID, &r.Period, &r.Version, &r.RateCardID, &r.RateCardVer,
				&r.GrossUSD, &r.NetBillableUSD, &r.Status, &r.ClosedAt, &r.ClosedBy,
				&jsonlKey, &jsonlSHA, &csvKey, &csvSHA,
				&pushedStatus, &pushedRef, &pushedAt, &exportCreated,
			); err != nil {
				return err
			}
			if jsonlKey != nil {
				exp := &domain.BillingExport{
					JSONLKey: *jsonlKey, CSVKey: derefStr(csvKey),
					PushedStatus: pushedStatus, PushedReference: pushedRef, PushedAt: pushedAt,
				}
				if jsonlSHA != nil {
					exp.JSONLSHA256 = *jsonlSHA
				}
				if csvSHA != nil {
					exp.CSVSHA256 = *csvSHA
				}
				if exportCreated != nil {
					exp.CreatedAt = *exportCreated
				}
				r.Export = exp
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	return out, err
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// hashKey is a stable 63-bit hash for a Postgres advisory-lock key (FNV-1a,
// masked to fit a signed bigint). Matches the design's
// pg_try_advisory_lock(hashtext(...)) intent with an in-process hash so the key
// is deterministic and Go-side, not dependent on Postgres's hashtext.
func hashKey(s string) uint64 {
	const (
		offset = 1469598103934665603
		prime  = 1099511628211
	)
	h := uint64(offset)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= prime
	}
	return h & 0x7fffffffffffffff
}
