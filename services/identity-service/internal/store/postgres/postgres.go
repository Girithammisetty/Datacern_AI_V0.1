// Package postgres is the pgx implementation of domain.Store. Tenant-scoped
// operations run inside a transaction that sets app.tenant_id (RLS,
// MASTER-FR-001); platform operations (registry tables, outbox poller,
// pre-auth invitation lookup) set app.role=platform instead.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datacern-ai/identity-service/internal/domain"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// --- transaction helpers ---

func (s *Store) inTx(ctx context.Context, setup string, arg string, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if setup != "" {
		if _, err := tx.Exec(ctx, "SELECT set_config($1, $2, true)", setup, arg); err != nil {
			return err
		}
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// tenantTx sets app.tenant_id for RLS-scoped work.
func (s *Store) tenantTx(ctx context.Context, tenantID uuid.UUID, fn func(pgx.Tx) error) error {
	return s.inTx(ctx, "app.tenant_id", tenantID.String(), fn)
}

// platformTx sets app.role=platform (outbox poller, pre-auth lookups,
// provisioning seed work executed by identity-service itself).
func (s *Store) platformTx(ctx context.Context, fn func(pgx.Tx) error) error {
	return s.inTx(ctx, "app.role", "platform", fn)
}

// plainTx touches only RLS-exempt platform tables.
func (s *Store) plainTx(ctx context.Context, fn func(pgx.Tx) error) error {
	return s.inTx(ctx, "", "", fn)
}

func insertOutbox(ctx context.Context, tx pgx.Tx, evs []domain.OutboxEvent) error {
	for _, ev := range evs {
		actor, _ := json.Marshal(ev.Actor)
		payload, _ := json.Marshal(ev.Payload)
		var via any
		if ev.ViaAgent != nil {
			via, _ = json.Marshal(ev.ViaAgent)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO outbox (event_id, event_type, tenant_id, actor, via_agent, resource_urn, occurred_at, trace_id, payload)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			ev.EventID, ev.EventType, ev.TenantID, actor, via, ev.ResourceURN, ev.OccurredAt, ev.TraceID, payload); err != nil {
			return err
		}
	}
	return nil
}

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// --- tenants ---

const tenantCols = `id, name, display_name, owner_email, tier, cell_id, cloud, status, quotas,
	platform_version, subdomain, k8s_namespace, schema_prefix, auto_upgrade, modules, created_by,
	created_at, updated_at, deleted_at, deletion_scheduled_at, commercial_state, trial_started_at, trial_ends_at,
	profile, demo_pack, ttl_days`

func scanTenant(row pgx.Row) (*domain.Tenant, error) {
	var t domain.Tenant
	var quotas []byte
	var status, commercialState, profile string
	err := row.Scan(&t.ID, &t.Name, &t.DisplayName, &t.OwnerEmail, &t.Tier, &t.CellID, &t.Cloud,
		&status, &quotas, &t.PlatformVersion, &t.Subdomain, &t.K8sNamespace, &t.SchemaPrefix,
		&t.AutoUpgrade, &t.Modules, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &t.DeletedAt, &t.DeletionScheduledAt,
		&commercialState, &t.TrialStartedAt, &t.TrialEndsAt, &profile, &t.DemoPack, &t.TTLDays)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ENotFound("tenant")
	}
	if err != nil {
		return nil, err
	}
	t.Status = domain.TenantStatus(status)
	t.CommercialState = domain.CommercialState(commercialState)
	t.Profile = domain.TenantProfile(profile)
	if err := json.Unmarshal(quotas, &t.Quotas); err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Store) CreateTenant(ctx context.Context, t *domain.Tenant, evs ...domain.OutboxEvent) error {
	quotas, _ := json.Marshal(t.Quotas)
	commercialState := string(t.CommercialState)
	if commercialState == "" {
		commercialState = string(domain.CommercialNone) // defensive default (column also has a DB default)
	}
	profile := string(t.Profile)
	if profile == "" {
		profile = string(domain.ProfileStandard) // defensive default (column also has a DB default)
	}
	err := s.plainTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenants (`+tenantCols+`)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
			t.ID, t.Name, t.DisplayName, t.OwnerEmail, t.Tier, t.CellID, t.Cloud, string(t.Status), quotas,
			t.PlatformVersion, t.Subdomain, t.K8sNamespace, t.SchemaPrefix, t.AutoUpgrade, t.Modules,
			t.CreatedBy, t.CreatedAt, t.UpdatedAt, t.DeletedAt, t.DeletionScheduledAt,
			commercialState, t.TrialStartedAt, t.TrialEndsAt,
			profile, t.DemoPack, t.TTLDays); err != nil {
			return err
		}
		return insertOutbox(ctx, tx, evs)
	})
	if isUnique(err) {
		// AC-4 / BR-1: single transaction — nothing was created.
		return domain.EValidation("tenant name (or a derived identifier) already exists",
			domain.FieldError{Field: "name", Message: "already in use"})
	}
	return err
}

func (s *Store) GetTenant(ctx context.Context, id uuid.UUID) (*domain.Tenant, error) {
	return scanTenant(s.pool.QueryRow(ctx, `SELECT `+tenantCols+` FROM tenants WHERE id = $1`, id))
}

func (s *Store) GetTenantByName(ctx context.Context, name string) (*domain.Tenant, error) {
	return scanTenant(s.pool.QueryRow(ctx, `SELECT `+tenantCols+` FROM tenants WHERE name = $1`, name))
}

func (s *Store) GetTenantEmbedConfig(ctx context.Context, tenantID uuid.UUID) (*domain.TenantEmbedConfig, error) {
	var c domain.TenantEmbedConfig
	err := s.pool.QueryRow(ctx,
		`SELECT tenant_id, secret_hash, allowed_origins, updated_at FROM tenant_embed_configs WHERE tenant_id = $1`,
		tenantID).Scan(&c.TenantID, &c.SecretHash, &c.AllowedOrigins, &c.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, domain.ENotFound("embed config")
		}
		return nil, err
	}
	return &c, nil
}

func (s *Store) UpsertTenantEmbedConfig(ctx context.Context, cfg *domain.TenantEmbedConfig) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO tenant_embed_configs (tenant_id, secret_hash, allowed_origins, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (tenant_id) DO UPDATE SET
		   secret_hash = EXCLUDED.secret_hash,
		   allowed_origins = EXCLUDED.allowed_origins,
		   updated_at = now()`,
		cfg.TenantID, cfg.SecretHash, cfg.AllowedOrigins)
	return err
}

// --- white-label branding (BRD 59 WS3) ---

const brandingCols = `tenant_id, logo_object_key, logo_content_type, primary_color, accent_color, updated_at, updated_by`

func (s *Store) GetTenantBranding(ctx context.Context, tenantID uuid.UUID) (*domain.TenantBranding, error) {
	var b domain.TenantBranding
	err := s.pool.QueryRow(ctx,
		`SELECT `+brandingCols+` FROM tenant_branding WHERE tenant_id = $1`, tenantID).
		Scan(&b.TenantID, &b.LogoObjectKey, &b.LogoContentType, &b.PrimaryColor, &b.AccentColor, &b.UpdatedAt, &b.UpdatedBy)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, domain.ENotFound("tenant branding")
		}
		return nil, err
	}
	return &b, nil
}

func (s *Store) UpsertTenantBranding(ctx context.Context, b *domain.TenantBranding) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO tenant_branding (tenant_id, logo_object_key, logo_content_type, primary_color, accent_color, updated_at, updated_by)
		 VALUES ($1, $2, $3, $4, $5, now(), $6)
		 ON CONFLICT (tenant_id) DO UPDATE SET
		   logo_object_key = EXCLUDED.logo_object_key,
		   logo_content_type = EXCLUDED.logo_content_type,
		   primary_color = EXCLUDED.primary_color,
		   accent_color = EXCLUDED.accent_color,
		   updated_at = now(),
		   updated_by = EXCLUDED.updated_by`,
		b.TenantID, b.LogoObjectKey, b.LogoContentType, b.PrimaryColor, b.AccentColor, b.UpdatedBy)
	return err
}

func (s *Store) DeleteTenantBranding(ctx context.Context, tenantID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tenant_branding WHERE tenant_id = $1`, tenantID)
	return err
}

// --- self-service external-agent credentials (BRD 60 WS2) ---

const extAgentKeyCols = `id, tenant_id, agent_id, agent_version, scopes, secret_hash, label, active, created_by, created_at, last_used_at`

func scanExtAgentKey(row pgx.Row) (*domain.ExternalAgentKey, error) {
	var k domain.ExternalAgentKey
	if err := row.Scan(&k.ID, &k.TenantID, &k.AgentID, &k.AgentVersion, &k.Scopes,
		&k.SecretHash, &k.Label, &k.Active, &k.CreatedBy, &k.CreatedAt, &k.LastUsedAt); err != nil {
		return nil, err
	}
	return &k, nil
}

func (s *Store) CreateExternalAgentKey(ctx context.Context, k *domain.ExternalAgentKey) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO external_agent_keys (id, tenant_id, agent_id, agent_version, scopes, secret_hash, label, active, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		k.ID, k.TenantID, k.AgentID, k.AgentVersion, k.Scopes, k.SecretHash, k.Label, k.Active, k.CreatedBy)
	return err
}

func (s *Store) GetExternalAgentKey(ctx context.Context, id uuid.UUID) (*domain.ExternalAgentKey, error) {
	k, err := scanExtAgentKey(s.pool.QueryRow(ctx,
		`SELECT `+extAgentKeyCols+` FROM external_agent_keys WHERE id = $1`, id))
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, domain.ENotFound("external agent key")
		}
		return nil, err
	}
	return k, nil
}

func (s *Store) ListExternalAgentKeys(ctx context.Context, tenantID uuid.UUID) ([]*domain.ExternalAgentKey, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+extAgentKeyCols+` FROM external_agent_keys WHERE tenant_id = $1 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.ExternalAgentKey
	for rows.Next() {
		k, err := scanExtAgentKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) RevokeExternalAgentKey(ctx context.Context, tenantID, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE external_agent_keys SET active = false WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ENotFound("external agent key")
	}
	return nil
}

func (s *Store) TouchExternalAgentKey(ctx context.Context, id uuid.UUID, t time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE external_agent_keys SET last_used_at = $2 WHERE id = $1`, id, t)
	return err
}

// --- per-tenant OIDC IdP config (BYO-P4) ---

const idpCols = `tenant_id, issuer, client_id, discovery_url, enabled, created_at, updated_at`

func scanIdp(row interface{ Scan(...any) error }) (*domain.TenantIdpConfig, error) {
	var c domain.TenantIdpConfig
	if err := row.Scan(&c.TenantID, &c.Issuer, &c.ClientID, &c.DiscoveryURL,
		&c.Enabled, &c.CreatedAt, &c.UpdatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, domain.ENotFound("idp config")
		}
		return nil, err
	}
	return &c, nil
}

func (s *Store) GetTenantIdpConfig(ctx context.Context, tenantID uuid.UUID) (*domain.TenantIdpConfig, error) {
	return scanIdp(s.pool.QueryRow(ctx,
		`SELECT `+idpCols+` FROM tenant_idp_configs WHERE tenant_id = $1`, tenantID))
}

func (s *Store) GetTenantIdpConfigByIssuer(ctx context.Context, issuer string) (*domain.TenantIdpConfig, error) {
	return scanIdp(s.pool.QueryRow(ctx,
		`SELECT `+idpCols+` FROM tenant_idp_configs WHERE issuer = $1`, issuer))
}

func (s *Store) UpsertTenantIdpConfig(ctx context.Context, cfg *domain.TenantIdpConfig) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO tenant_idp_configs (tenant_id, issuer, client_id, discovery_url, enabled, updated_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (tenant_id) DO UPDATE SET
		   issuer = EXCLUDED.issuer,
		   client_id = EXCLUDED.client_id,
		   discovery_url = EXCLUDED.discovery_url,
		   enabled = EXCLUDED.enabled,
		   updated_at = now()`,
		cfg.TenantID, cfg.Issuer, cfg.ClientID, cfg.DiscoveryURL, cfg.Enabled)
	return err
}

func (s *Store) DeleteTenantIdpConfig(ctx context.Context, tenantID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tenant_idp_configs WHERE tenant_id = $1`, tenantID)
	return err
}

// --- per-tenant display-label overlays (BRD 23 inc3) — platform-scoped ---

const labelCols = `tenant_id, label_key, label_value, updated_at, updated_by`

func (s *Store) ListTenantDisplayLabels(ctx context.Context, tenantID uuid.UUID) ([]domain.DisplayLabel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+labelCols+` FROM tenant_display_labels WHERE tenant_id = $1 ORDER BY label_key`,
		tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DisplayLabel{}
	for rows.Next() {
		var l domain.DisplayLabel
		if err := rows.Scan(&l.TenantID, &l.Key, &l.Value, &l.UpdatedAt, &l.UpdatedBy); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) UpsertTenantDisplayLabel(ctx context.Context, l *domain.DisplayLabel) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO tenant_display_labels (tenant_id, label_key, label_value, updated_at, updated_by)
		 VALUES ($1, $2, $3, now(), $4)
		 ON CONFLICT (tenant_id, label_key) DO UPDATE SET
		   label_value = EXCLUDED.label_value,
		   updated_at = now(),
		   updated_by = EXCLUDED.updated_by`,
		l.TenantID, l.Key, l.Value, l.UpdatedBy)
	return err
}

func (s *Store) DeleteTenantDisplayLabel(ctx context.Context, tenantID uuid.UUID, key string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM tenant_display_labels WHERE tenant_id = $1 AND label_key = $2`,
		tenantID, key)
	return err
}

// --- platform admins (RLS-exempt registry; queried directly off the pool) ---

func (s *Store) IsPlatformAdmin(ctx context.Context, sub, email string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM platform_admins
		   WHERE ($1 <> '' AND user_sub = $1) OR ($2 <> '' AND lower(email) = lower($2)))`,
		sub, email).Scan(&exists)
	return exists, err
}

func (s *Store) ListPlatformAdmins(ctx context.Context) ([]*domain.PlatformAdmin, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_sub, email, granted_by, granted_at FROM platform_admins ORDER BY granted_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.PlatformAdmin{}
	for rows.Next() {
		pa := &domain.PlatformAdmin{}
		var sub *string
		if err := rows.Scan(&pa.ID, &sub, &pa.Email, &pa.GrantedBy, &pa.GrantedAt); err != nil {
			return nil, err
		}
		if sub != nil {
			pa.UserSub = *sub
		}
		out = append(out, pa)
	}
	return out, rows.Err()
}

func (s *Store) CreatePlatformAdmin(ctx context.Context, pa *domain.PlatformAdmin) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO platform_admins (id, user_sub, email, granted_by, granted_at)
		 VALUES ($1, NULLIF($2,''), lower($3), $4, $5)
		 ON CONFLICT (email) DO UPDATE SET user_sub = COALESCE(EXCLUDED.user_sub, platform_admins.user_sub)`,
		pa.ID, pa.UserSub, pa.Email, pa.GrantedBy, pa.GrantedAt)
	return err
}

func (s *Store) DeletePlatformAdmin(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM platform_admins WHERE id = $1`, id)
	return err
}

func (s *Store) ListTenants(ctx context.Context, f domain.TenantFilter, page domain.PageRequest) ([]*domain.Tenant, domain.PageInfo, error) {
	q := `SELECT ` + tenantCols + ` FROM tenants WHERE 1=1`
	args := []any{}
	n := 0
	add := func(cond string, v any) {
		n++
		q += fmt.Sprintf(" AND %s = $%d", cond, n)
		args = append(args, v)
	}
	if f.Status != "" {
		add("status", f.Status)
	}
	if f.Cloud != "" {
		add("cloud", f.Cloud)
	}
	if f.CellID != "" {
		add("cell_id::text", f.CellID)
	}
	if f.Profile != "" {
		add("profile", f.Profile)
	}
	if page.AfterID != nil {
		n++
		q += fmt.Sprintf(" AND id > $%d", n)
		args = append(args, *page.AfterID)
	}
	n++
	q += fmt.Sprintf(" ORDER BY id LIMIT $%d", n)
	args = append(args, page.Limit+1)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, domain.PageInfo{}, err
	}
	defer rows.Close()
	var out []*domain.Tenant
	for rows.Next() {
		t, err := scanTenant(rows)
		if err != nil {
			return nil, domain.PageInfo{}, err
		}
		out = append(out, t)
	}
	items, info := domain.BuildPage(out, page.Limit, func(t *domain.Tenant) uuid.UUID { return t.ID })
	return items, info, nil
}

func (s *Store) UpdateTenant(ctx context.Context, t *domain.Tenant, evs ...domain.OutboxEvent) error {
	quotas, _ := json.Marshal(t.Quotas)
	return s.platformTx(ctx, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE tenants SET display_name=$2, owner_email=$3, cell_id=$4, quotas=$5,
				platform_version=$6, auto_upgrade=$7, modules=$8, updated_at=$9,
				deleted_at=$10, deletion_scheduled_at=$11
			WHERE id=$1`,
			t.ID, t.DisplayName, t.OwnerEmail, t.CellID, quotas, t.PlatformVersion,
			t.AutoUpgrade, t.Modules, t.UpdatedAt, t.DeletedAt, t.DeletionScheduledAt)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return domain.ENotFound("tenant")
		}
		return insertOutbox(ctx, tx, evs)
	})
}

func (s *Store) TransitionTenant(ctx context.Context, id uuid.UUID, from, to domain.TenantStatus, evs ...domain.OutboxEvent) error {
	if !domain.CanTransition(from, to) {
		return domain.EConflict("invalid tenant status transition " + string(from) + " -> " + string(to))
	}
	return s.platformTx(ctx, func(tx pgx.Tx) error {
		// CAS at the persistence boundary (IDN-FR-003 guards).
		ct, err := tx.Exec(ctx, `UPDATE tenants SET status=$3, updated_at=now() WHERE id=$1 AND status=$2`,
			id, string(from), string(to))
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			var cur string
			if err := tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id=$1`, id).Scan(&cur); err != nil {
				return domain.ENotFound("tenant")
			}
			return domain.EConflict("tenant status is " + cur + ", expected " + string(from))
		}
		return insertOutbox(ctx, tx, evs)
	})
}

// --- commercial: tenant commercial-state (CPL-FR-020) ---

func (s *Store) TransitionTenantCommercial(ctx context.Context, id uuid.UUID, profile domain.TenantProfile, from, to domain.CommercialState, evs ...domain.OutboxEvent) error {
	if !domain.CanTransitionCommercial(profile, from, to) {
		return domain.EConflict("invalid commercial state transition " + string(from) + " -> " + string(to))
	}
	return s.platformTx(ctx, func(tx pgx.Tx) error {
		// CAS at the persistence boundary, mirroring TransitionTenant.
		ct, err := tx.Exec(ctx, `UPDATE tenants SET commercial_state=$3, updated_at=now() WHERE id=$1 AND commercial_state=$2`,
			id, string(from), string(to))
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			var cur string
			if err := tx.QueryRow(ctx, `SELECT commercial_state FROM tenants WHERE id=$1`, id).Scan(&cur); err != nil {
				return domain.ENotFound("tenant")
			}
			return domain.EConflict("tenant commercial_state is " + cur + ", expected " + string(from))
		}
		if err := insertOutbox(ctx, tx, evs); err != nil {
			return err
		}
		return markCommercialDirtyTx(ctx, tx, id)
	})
}

// --- commercial: plan catalog (platform-scoped, no RLS; CPL-FR-001) ---

const planCols = `key, name, description, trial_days_default, status, version, created_at, updated_at`

func scanPlan(row pgx.Row) (*domain.Plan, error) {
	var p domain.Plan
	err := row.Scan(&p.Key, &p.Name, &p.Description, &p.TrialDaysDefault, &p.Status, &p.Version, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ENotFound("plan")
	}
	return &p, err
}

func (s *Store) CreatePlan(ctx context.Context, p *domain.Plan, ents []domain.PlanEntitlement) error {
	err := s.plainTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO plans (`+planCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			p.Key, p.Name, p.Description, p.TrialDaysDefault, p.Status, p.Version, p.CreatedAt, p.UpdatedAt); err != nil {
			return err
		}
		return insertPlanEntitlements(ctx, tx, ents)
	})
	if isUnique(err) {
		return domain.EValidation("plan key already exists", domain.FieldError{Field: "key", Message: "already in use"})
	}
	return err
}

func insertPlanEntitlements(ctx context.Context, tx pgx.Tx, ents []domain.PlanEntitlement) error {
	for _, e := range ents {
		val, err := json.Marshal(e.Value)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO plan_entitlements (id, plan_key, plan_version, kind, entitlement_key, value_json, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			e.ID, e.PlanKey, e.PlanVersion, string(e.Kind), e.Key, val, e.CreatedAt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetPlan(ctx context.Context, key string) (*domain.Plan, error) {
	return scanPlan(s.pool.QueryRow(ctx, `SELECT `+planCols+` FROM plans WHERE key=$1`, key))
}

func (s *Store) ListPlans(ctx context.Context) ([]*domain.Plan, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+planCols+` FROM plans ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Plan
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) UpdatePlan(ctx context.Context, p *domain.Plan, ents []domain.PlanEntitlement) error {
	return s.plainTx(ctx, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE plans SET name=$2, description=$3, trial_days_default=$4, status=$5, version=$6, updated_at=$7
			WHERE key=$1`,
			p.Key, p.Name, p.Description, p.TrialDaysDefault, p.Status, p.Version, p.UpdatedAt)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return domain.ENotFound("plan")
		}
		if ents != nil {
			return insertPlanEntitlements(ctx, tx, ents)
		}
		return nil
	})
}

func (s *Store) ListPlanEntitlements(ctx context.Context, planKey string, planVersion int) ([]domain.PlanEntitlement, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, plan_key, plan_version, kind, entitlement_key, value_json, created_at
		FROM plan_entitlements WHERE plan_key=$1 AND plan_version=$2 ORDER BY kind, entitlement_key`, planKey, planVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.PlanEntitlement
	for rows.Next() {
		var e domain.PlanEntitlement
		var kind string
		var val []byte
		if err := rows.Scan(&e.ID, &e.PlanKey, &e.PlanVersion, &kind, &e.Key, &val, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Kind = domain.EntitlementKind(kind)
		if len(val) > 0 {
			if err := json.Unmarshal(val, &e.Value); err != nil {
				return nil, err
			}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// --- commercial: tenant plan assignment + overrides (tenant-scoped, RLS; CPL-FR-002/010) ---

func (s *Store) AssignTenantPlan(ctx context.Context, tp *domain.TenantPlan, evs ...domain.OutboxEvent) error {
	return s.tenantTx(ctx, tp.TenantID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenant_plan (tenant_id, plan_key, plan_version_snapshot, assigned_at, assigned_by)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (tenant_id) DO UPDATE SET
				plan_key=EXCLUDED.plan_key, plan_version_snapshot=EXCLUDED.plan_version_snapshot,
				assigned_at=EXCLUDED.assigned_at, assigned_by=EXCLUDED.assigned_by`,
			tp.TenantID, tp.PlanKey, tp.PlanVersionSnapshot, tp.AssignedAt, tp.AssignedBy); err != nil {
			return err
		}
		if err := insertOutbox(ctx, tx, evs); err != nil {
			return err
		}
		return markCommercialDirtyTx(ctx, tx, tp.TenantID)
	})
}

func (s *Store) GetTenantPlan(ctx context.Context, tenantID uuid.UUID) (*domain.TenantPlan, error) {
	var tp domain.TenantPlan
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT tenant_id, plan_key, plan_version_snapshot, assigned_at, assigned_by
			FROM tenant_plan WHERE tenant_id=$1`, tenantID).
			Scan(&tp.TenantID, &tp.PlanKey, &tp.PlanVersionSnapshot, &tp.AssignedAt, &tp.AssignedBy)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ENotFound("tenant plan assignment")
	}
	return &tp, err
}

func (s *Store) UpsertEntitlementOverride(ctx context.Context, o *domain.TenantEntitlementOverride, evs ...domain.OutboxEvent) error {
	val, err := json.Marshal(o.Value)
	if err != nil {
		return err
	}
	return s.tenantTx(ctx, o.TenantID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenant_entitlement_overrides (id, tenant_id, kind, entitlement_key, value_json, granted_by, granted_at, reason)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (tenant_id, kind, entitlement_key) DO UPDATE SET
				value_json=EXCLUDED.value_json, granted_by=EXCLUDED.granted_by,
				granted_at=EXCLUDED.granted_at, reason=EXCLUDED.reason`,
			o.ID, o.TenantID, string(o.Kind), o.Key, val, o.GrantedBy, o.GrantedAt, o.Reason); err != nil {
			return err
		}
		if err := insertOutbox(ctx, tx, evs); err != nil {
			return err
		}
		return markCommercialDirtyTx(ctx, tx, o.TenantID)
	})
}

func (s *Store) DeleteEntitlementOverride(ctx context.Context, tenantID uuid.UUID, kind domain.EntitlementKind, key string, evs ...domain.OutboxEvent) error {
	return s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `DELETE FROM tenant_entitlement_overrides WHERE tenant_id=$1 AND kind=$2 AND entitlement_key=$3`,
			tenantID, string(kind), key)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return domain.ENotFound("entitlement override")
		}
		if err := insertOutbox(ctx, tx, evs); err != nil {
			return err
		}
		return markCommercialDirtyTx(ctx, tx, tenantID)
	})
}

func (s *Store) ListEntitlementOverrides(ctx context.Context, tenantID uuid.UUID) ([]domain.TenantEntitlementOverride, error) {
	var out []domain.TenantEntitlementOverride
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, tenant_id, kind, entitlement_key, value_json, granted_by, granted_at, reason
			FROM tenant_entitlement_overrides WHERE tenant_id=$1 ORDER BY kind, entitlement_key`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var o domain.TenantEntitlementOverride
			var kind string
			var val []byte
			if err := rows.Scan(&o.ID, &o.TenantID, &kind, &o.Key, &val, &o.GrantedBy, &o.GrantedAt, &o.Reason); err != nil {
				return err
			}
			o.Kind = domain.EntitlementKind(kind)
			if len(val) > 0 {
				if err := json.Unmarshal(val, &o.Value); err != nil {
					return err
				}
			}
			out = append(out, o)
		}
		return rows.Err()
	})
	return out, err
}

// --- commercial: entitlements_flat dirty queue (CPL-FR-011), mirrors
// rbac-service's projection_dirty ClaimDirty/DeleteDirty shape ---

// markCommercialDirtyTx enqueues a recompute row in the SAME transaction as
// the mutation that made the projection stale (plan assignment, override
// upsert/delete, commercial-state transition).
func markCommercialDirtyTx(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO commercial_dirty (tenant_id) VALUES ($1)`, tenantID)
	return err
}

func (s *Store) ClaimCommercialDirty(ctx context.Context, workerID string, batch int, visibility time.Duration) ([]domain.CommercialDirtyClaim, error) {
	byTenant := map[uuid.UUID]*domain.CommercialDirtyClaim{}
	var order []uuid.UUID
	err := s.platformTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			WITH c AS (
				SELECT id FROM commercial_dirty
				WHERE claimed_at IS NULL OR claimed_at < now() - $1::interval
				ORDER BY id
				LIMIT $2
				FOR UPDATE SKIP LOCKED
			)
			UPDATE commercial_dirty d SET claimed_at = now(), claimed_by = $3
			FROM c WHERE d.id = c.id
			RETURNING d.id, d.tenant_id, d.enqueued_at`,
			visibility.String(), batch, workerID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			var tenant uuid.UUID
			var enq time.Time
			if err := rows.Scan(&id, &tenant, &enq); err != nil {
				return err
			}
			c, ok := byTenant[tenant]
			if !ok {
				c = &domain.CommercialDirtyClaim{TenantID: tenant, OldestEnqueued: enq}
				byTenant[tenant] = c
				order = append(order, tenant)
			}
			c.IDs = append(c.IDs, id)
			if enq.Before(c.OldestEnqueued) {
				c.OldestEnqueued = enq
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	out := make([]domain.CommercialDirtyClaim, 0, len(order))
	for _, t := range order {
		out = append(out, *byTenant[t])
	}
	return out, nil
}

func (s *Store) DeleteCommercialDirty(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	return s.platformTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM commercial_dirty WHERE id = ANY($1)`, ids)
		return err
	})
}

// --- cells ---

func (s *Store) CreateCell(ctx context.Context, c *domain.Cell) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO cells (id, name, cloud, region, capacity, tenant_count) VALUES ($1,$2,$3,$4,$5,$6)`,
		c.ID, c.Name, c.Cloud, c.Region, c.Capacity, c.TenantCount)
	return err
}

func (s *Store) ListCells(ctx context.Context) ([]*domain.Cell, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, name, cloud, region, capacity, tenant_count, created_at, updated_at FROM cells ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Cell
	for rows.Next() {
		var c domain.Cell
		if err := rows.Scan(&c.ID, &c.Name, &c.Cloud, &c.Region, &c.Capacity, &c.TenantCount, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, nil
}

func (s *Store) ReserveCell(ctx context.Context, cellID uuid.UUID) error {
	ct, err := s.pool.Exec(ctx, `
		UPDATE cells SET tenant_count = tenant_count + 1, updated_at = now()
		WHERE id = $1 AND tenant_count < capacity`, cellID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return domain.EConflict("cell at capacity")
	}
	return nil
}

func (s *Store) ReleaseCell(ctx context.Context, cellID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE cells SET tenant_count = GREATEST(tenant_count - 1, 0), updated_at = now() WHERE id = $1`, cellID)
	return err
}

// --- tenant modules ---

func (s *Store) SetTenantModules(ctx context.Context, tenantID uuid.UUID, modules []string, version string) error {
	return s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		for _, m := range modules {
			id, _ := uuid.NewV7()
			if _, err := tx.Exec(ctx, `
				INSERT INTO tenant_modules (id, tenant_id, module, version, enabled)
				VALUES ($1,$2,$3,$4,true)
				ON CONFLICT (tenant_id, module) DO UPDATE SET version=$4, enabled=true, updated_at=now()`,
				id, tenantID, m, version); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) DeleteTenantModules(ctx context.Context, tenantID uuid.UUID) error {
	return s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM tenant_modules WHERE tenant_id = $1`, tenantID)
		return err
	})
}

func (s *Store) GetTenantModules(ctx context.Context, tenantID uuid.UUID) ([]string, error) {
	var out []string
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT module FROM tenant_modules WHERE tenant_id=$1 AND enabled ORDER BY module`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m string
			if err := rows.Scan(&m); err != nil {
				return err
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	return out, err
}

// --- provisioning steps ---

func (s *Store) SaveProvisioningStep(ctx context.Context, r *domain.ProvisioningStep) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO provisioning_runs (id, tenant_id, workflow_id, step_index, step_name, status, attempt, error, compensation, started_at, finished_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (workflow_id, step_index) DO UPDATE SET
			status=EXCLUDED.status, attempt=EXCLUDED.attempt, error=EXCLUDED.error,
			compensation=EXCLUDED.compensation, started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at`,
		r.ID, r.TenantID, r.WorkflowID, r.StepIndex, r.StepName, string(r.Status), r.Attempt, r.Error,
		r.CompensationName, r.StartedAt, r.FinishedAt)
	return err
}

func (s *Store) ListProvisioningSteps(ctx context.Context, tenantID uuid.UUID, workflowID string) ([]*domain.ProvisioningStep, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, workflow_id, step_index, step_name, status, attempt, error, compensation, started_at, finished_at
		FROM provisioning_runs WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY step_index`, tenantID, workflowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.ProvisioningStep
	for rows.Next() {
		var r domain.ProvisioningStep
		var status string
		if err := rows.Scan(&r.ID, &r.TenantID, &r.WorkflowID, &r.StepIndex, &r.StepName, &status,
			&r.Attempt, &r.Error, &r.CompensationName, &r.StartedAt, &r.FinishedAt); err != nil {
			return nil, err
		}
		r.Status = domain.StepStatus(status)
		out = append(out, &r)
	}
	return out, rows.Err()
}

// --- users ---

const userCols = `id, tenant_id, email, full_name, status, idp_subject, last_login_at, created_at, updated_at, deleted_at`

func scanUser(row pgx.Row) (*domain.User, error) {
	var u domain.User
	var status string
	err := row.Scan(&u.ID, &u.TenantID, &u.Email, &u.FullName, &status, &u.IdpSubject,
		&u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt, &u.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ENotFound("user")
	}
	if err != nil {
		return nil, err
	}
	u.Status = domain.UserStatus(status)
	return &u, nil
}

func (s *Store) CreateUser(ctx context.Context, u *domain.User, evs ...domain.OutboxEvent) error {
	err := s.tenantTx(ctx, u.TenantID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (`+userCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			u.ID, u.TenantID, u.Email, u.FullName, string(u.Status), u.IdpSubject,
			u.LastLoginAt, u.CreatedAt, u.UpdatedAt, u.DeletedAt); err != nil {
			return err
		}
		return insertOutbox(ctx, tx, evs)
	})
	if isUnique(err) {
		return domain.EConflict("user email already exists in tenant")
	}
	return err
}

func (s *Store) getUserWhere(ctx context.Context, tenantID uuid.UUID, cond string, arg any) (*domain.User, error) {
	var u *domain.User
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		var err error
		u, err = scanUser(tx.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE `+cond, arg))
		return err
	})
	return u, err
}

func (s *Store) GetUser(ctx context.Context, tenantID, id uuid.UUID) (*domain.User, error) {
	return s.getUserWhere(ctx, tenantID, "id = $1", id)
}

func (s *Store) GetUserByEmail(ctx context.Context, tenantID uuid.UUID, email string) (*domain.User, error) {
	return s.getUserWhere(ctx, tenantID, "lower(email) = lower($1)", email)
}

func (s *Store) GetUserBySub(ctx context.Context, tenantID uuid.UUID, sub string) (*domain.User, error) {
	return s.getUserWhere(ctx, tenantID, "idp_subject = $1", sub)
}

func (s *Store) ListUsers(ctx context.Context, tenantID uuid.UUID, f domain.UserFilter, page domain.PageRequest) ([]*domain.User, domain.PageInfo, error) {
	var out []*domain.User
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		q := `SELECT ` + userCols + ` FROM users WHERE tenant_id=$1`
		args := []any{tenantID}
		if len(f.IDs) > 0 { // filter[id] batch hydration (bff-graphql loaders)
			args = append(args, f.IDs)
			q += fmt.Sprintf(` AND id = ANY($%d)`, len(args))
		}
		if f.Status != "" { // active-only for the assignable-users listing
			args = append(args, f.Status)
			q += fmt.Sprintf(` AND status = $%d`, len(args))
		}
		if page.AfterID != nil {
			args = append(args, *page.AfterID)
			q += fmt.Sprintf(` AND id > $%d`, len(args))
		}
		args = append(args, page.Limit+1)
		q += fmt.Sprintf(` ORDER BY id LIMIT $%d`, len(args))
		rows, err := tx.Query(ctx, q, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			u, err := scanUser(rows)
			if err != nil {
				return err
			}
			out = append(out, u)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, domain.PageInfo{}, err
	}
	items, info := domain.BuildPage(out, page.Limit, func(u *domain.User) uuid.UUID { return u.ID })
	return items, info, nil
}

func (s *Store) UpdateUser(ctx context.Context, u *domain.User, evs ...domain.OutboxEvent) error {
	return s.tenantTx(ctx, u.TenantID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE users SET email=$2, full_name=$3, status=$4, idp_subject=$5, last_login_at=$6,
				updated_at=$7, deleted_at=$8
			WHERE id=$1`,
			u.ID, u.Email, u.FullName, string(u.Status), u.IdpSubject, u.LastLoginAt, u.UpdatedAt, u.DeletedAt)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return domain.ENotFound("user")
		}
		return insertOutbox(ctx, tx, evs)
	})
}

// --- invitations ---

func (s *Store) CreateInvitation(ctx context.Context, inv *domain.Invitation, evs ...domain.OutboxEvent) error {
	return s.tenantTx(ctx, inv.TenantID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO invitations (id, tenant_id, user_id, token_hash, expires_at, accepted_at, invalidated_at, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			inv.ID, inv.TenantID, inv.UserID, inv.TokenHash, inv.ExpiresAt, inv.AcceptedAt,
			inv.InvalidatedAt, inv.CreatedAt, inv.UpdatedAt); err != nil {
			return err
		}
		return insertOutbox(ctx, tx, evs)
	})
}

// GetInvitationByTokenHash is pre-auth (public activation link): platform role.
func (s *Store) GetInvitationByTokenHash(ctx context.Context, tokenHash string) (*domain.Invitation, error) {
	var inv domain.Invitation
	err := s.platformTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT id, tenant_id, user_id, token_hash, expires_at, accepted_at, invalidated_at, created_at, updated_at
			FROM invitations WHERE token_hash=$1`, tokenHash).
			Scan(&inv.ID, &inv.TenantID, &inv.UserID, &inv.TokenHash, &inv.ExpiresAt,
				&inv.AcceptedAt, &inv.InvalidatedAt, &inv.CreatedAt, &inv.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ENotFound("invitation")
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return &inv, nil
}

func (s *Store) UpdateInvitation(ctx context.Context, inv *domain.Invitation, evs ...domain.OutboxEvent) error {
	return s.tenantTx(ctx, inv.TenantID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE invitations SET accepted_at=$2, invalidated_at=$3, updated_at=$4 WHERE id=$1`,
			inv.ID, inv.AcceptedAt, inv.InvalidatedAt, inv.UpdatedAt)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return domain.ENotFound("invitation")
		}
		return insertOutbox(ctx, tx, evs)
	})
}

func (s *Store) InvalidateInvitations(ctx context.Context, tenantID, userID uuid.UUID, now time.Time) error {
	return s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE invitations SET invalidated_at=$3, updated_at=$3
			WHERE tenant_id=$1 AND user_id=$2 AND accepted_at IS NULL AND invalidated_at IS NULL`,
			tenantID, userID, now)
		return err
	})
}

// --- service accounts ---

const saCols = `id, tenant_id, name, secret_hash, old_secret_hash, old_secret_expires_at, scopes, expires_at, last_used_at, revoked_at, created_at, updated_at`

func scanSA(row pgx.Row) (*domain.ServiceAccount, error) {
	var sa domain.ServiceAccount
	err := row.Scan(&sa.ID, &sa.TenantID, &sa.Name, &sa.SecretHash, &sa.OldSecretHash,
		&sa.OldSecretExpiresAt, &sa.Scopes, &sa.ExpiresAt, &sa.LastUsedAt, &sa.RevokedAt,
		&sa.CreatedAt, &sa.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ENotFound("service account")
	}
	if err != nil {
		return nil, err
	}
	return &sa, nil
}

func (s *Store) CreateServiceAccount(ctx context.Context, sa *domain.ServiceAccount, evs ...domain.OutboxEvent) error {
	err := s.tenantTx(ctx, sa.TenantID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO service_accounts (`+saCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			sa.ID, sa.TenantID, sa.Name, sa.SecretHash, sa.OldSecretHash, sa.OldSecretExpiresAt,
			sa.Scopes, sa.ExpiresAt, sa.LastUsedAt, sa.RevokedAt, sa.CreatedAt, sa.UpdatedAt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO api_key_index (sa_id, tenant_id) VALUES ($1,$2)`, sa.ID, sa.TenantID); err != nil {
			return err
		}
		return insertOutbox(ctx, tx, evs)
	})
	if isUnique(err) {
		return domain.EConflict("service account name already exists")
	}
	return err
}

func (s *Store) GetServiceAccount(ctx context.Context, tenantID, id uuid.UUID) (*domain.ServiceAccount, error) {
	var sa *domain.ServiceAccount
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		var err error
		sa, err = scanSA(tx.QueryRow(ctx, `SELECT `+saCols+` FROM service_accounts WHERE id=$1`, id))
		return err
	})
	return sa, err
}

func (s *Store) ResolveAPIKeyTenant(ctx context.Context, saID uuid.UUID) (uuid.UUID, error) {
	var tid uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT tenant_id FROM api_key_index WHERE sa_id=$1`, saID).Scan(&tid)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, domain.ENotFound("api key")
	}
	return tid, err
}

func (s *Store) ListServiceAccounts(ctx context.Context, tenantID uuid.UUID, page domain.PageRequest) ([]*domain.ServiceAccount, domain.PageInfo, error) {
	var out []*domain.ServiceAccount
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		q := `SELECT ` + saCols + ` FROM service_accounts WHERE tenant_id=$1`
		args := []any{tenantID}
		if page.AfterID != nil {
			q += ` AND id > $2 ORDER BY id LIMIT $3`
			args = append(args, *page.AfterID, page.Limit+1)
		} else {
			q += ` ORDER BY id LIMIT $2`
			args = append(args, page.Limit+1)
		}
		rows, err := tx.Query(ctx, q, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			sa, err := scanSA(rows)
			if err != nil {
				return err
			}
			out = append(out, sa)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, domain.PageInfo{}, err
	}
	items, info := domain.BuildPage(out, page.Limit, func(sa *domain.ServiceAccount) uuid.UUID { return sa.ID })
	return items, info, nil
}

func (s *Store) CountServiceAccounts(ctx context.Context, tenantID uuid.UUID) (int, error) {
	var n int
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM service_accounts WHERE tenant_id=$1 AND revoked_at IS NULL`, tenantID).Scan(&n)
	})
	return n, err
}

func (s *Store) UpdateServiceAccount(ctx context.Context, sa *domain.ServiceAccount, evs ...domain.OutboxEvent) error {
	return s.tenantTx(ctx, sa.TenantID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE service_accounts SET secret_hash=$2, old_secret_hash=$3, old_secret_expires_at=$4,
				scopes=$5, expires_at=$6, last_used_at=$7, revoked_at=$8, updated_at=$9
			WHERE id=$1`,
			sa.ID, sa.SecretHash, sa.OldSecretHash, sa.OldSecretExpiresAt, sa.Scopes,
			sa.ExpiresAt, sa.LastUsedAt, sa.RevokedAt, sa.UpdatedAt)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return domain.ENotFound("service account")
		}
		return insertOutbox(ctx, tx, evs)
	})
}

// --- agent principals ---

func (s *Store) UpsertAgentPrincipal(ctx context.Context, a *domain.AgentPrincipal, evs ...domain.OutboxEvent) error {
	return s.tenantTx(ctx, a.TenantID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_principals (id, tenant_id, agent_id, agent_version, scopes, autonomous_allowed, eval_gate_ok, status, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (tenant_id, agent_id, agent_version) DO UPDATE SET
				scopes=EXCLUDED.scopes, autonomous_allowed=EXCLUDED.autonomous_allowed,
				eval_gate_ok=EXCLUDED.eval_gate_ok, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
			a.ID, a.TenantID, a.AgentID, a.AgentVersion, a.Scopes, a.AutonomousAllowed,
			a.EvalGateOK, string(a.Status), a.CreatedAt, a.UpdatedAt); err != nil {
			return err
		}
		return insertOutbox(ctx, tx, evs)
	})
}

func (s *Store) GetAgentPrincipal(ctx context.Context, tenantID uuid.UUID, agentID, version string) (*domain.AgentPrincipal, error) {
	var a domain.AgentPrincipal
	var status string
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT id, tenant_id, agent_id, agent_version, scopes, autonomous_allowed, eval_gate_ok, status, created_at, updated_at
			FROM agent_principals WHERE tenant_id=$1 AND agent_id=$2 AND agent_version=$3`,
			tenantID, agentID, version).
			Scan(&a.ID, &a.TenantID, &a.AgentID, &a.AgentVersion, &a.Scopes, &a.AutonomousAllowed,
				&a.EvalGateOK, &status, &a.CreatedAt, &a.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ENotFound("agent principal")
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	a.Status = domain.AgentPrincipalStatus(status)
	return &a, nil
}

func (s *Store) ListAgentPrincipals(ctx context.Context, tenantID uuid.UUID) ([]*domain.AgentPrincipal, error) {
	var out []*domain.AgentPrincipal
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, tenant_id, agent_id, agent_version, scopes, autonomous_allowed, eval_gate_ok, status, created_at, updated_at
			FROM agent_principals WHERE tenant_id=$1 ORDER BY agent_id, agent_version`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a domain.AgentPrincipal
			var status string
			if err := rows.Scan(&a.ID, &a.TenantID, &a.AgentID, &a.AgentVersion, &a.Scopes,
				&a.AutonomousAllowed, &a.EvalGateOK, &status, &a.CreatedAt, &a.UpdatedAt); err != nil {
				return err
			}
			a.Status = domain.AgentPrincipalStatus(status)
			out = append(out, &a)
		}
		return rows.Err()
	})
	return out, err
}

// --- signing keys ---

func (s *Store) SaveSigningKey(ctx context.Context, k *domain.SigningKey, evs ...domain.OutboxEvent) error {
	return s.platformTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO signing_keys (kid, alg, vault_ref, public_key_pem, not_before, retired_at, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			k.KID, k.Alg, k.VaultRef, k.PublicKeyPEM, k.NotBefore, k.RetiredAt, k.CreatedAt, k.UpdatedAt); err != nil {
			return err
		}
		return insertOutbox(ctx, tx, evs)
	})
}

func (s *Store) ListSigningKeys(ctx context.Context) ([]*domain.SigningKey, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT kid, alg, vault_ref, public_key_pem, not_before, retired_at, created_at, updated_at
		FROM signing_keys ORDER BY not_before`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.SigningKey
	for rows.Next() {
		var k domain.SigningKey
		if err := rows.Scan(&k.KID, &k.Alg, &k.VaultRef, &k.PublicKeyPEM, &k.NotBefore,
			&k.RetiredAt, &k.CreatedAt, &k.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &k)
	}
	return out, rows.Err()
}

func (s *Store) UpdateSigningKey(ctx context.Context, k *domain.SigningKey) error {
	ct, err := s.pool.Exec(ctx, `
		UPDATE signing_keys SET retired_at=$2, updated_at=$3 WHERE kid=$1`,
		k.KID, k.RetiredAt, k.UpdatedAt)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return domain.ENotFound("signing key")
	}
	return nil
}

// --- idempotency ---

func (s *Store) GetIdempotency(ctx context.Context, tenantID uuid.UUID, key string) (*domain.IdempotencyRecord, error) {
	var rec domain.IdempotencyRecord
	err := s.tenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT tenant_id, key, request_hash, status, body, created_at FROM idempotency_keys
			WHERE tenant_id=$1 AND key=$2 AND created_at > $3`,
			tenantID, key, time.Now().UTC().Add(-domain.IdempotencyTTL)).
			Scan(&rec.TenantID, &rec.Key, &rec.RequestHash, &rec.Status, &rec.Body, &rec.CreatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ENotFound("idempotency key")
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *Store) PutIdempotency(ctx context.Context, rec *domain.IdempotencyRecord) error {
	return s.tenantTx(ctx, rec.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO idempotency_keys (tenant_id, key, request_hash, status, body, created_at)
			VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (tenant_id, key) DO NOTHING`,
			rec.TenantID, rec.Key, rec.RequestHash, rec.Status, rec.Body, rec.CreatedAt)
		return err
	})
}

// --- outbox ---

func (s *Store) AppendOutbox(ctx context.Context, evs ...domain.OutboxEvent) error {
	return s.platformTx(ctx, func(tx pgx.Tx) error { return insertOutbox(ctx, tx, evs) })
}

func (s *Store) ListOutbox(ctx context.Context, limit int) ([]*domain.OutboxEvent, error) {
	var out []*domain.OutboxEvent
	err := s.platformTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT event_id, event_type, tenant_id, actor, via_agent, resource_urn, occurred_at, trace_id, payload, published_at
			FROM outbox WHERE published_at IS NULL ORDER BY occurred_at LIMIT $1`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var ev domain.OutboxEvent
			var actor, payload, via []byte
			if err := rows.Scan(&ev.EventID, &ev.EventType, &ev.TenantID, &actor, &via,
				&ev.ResourceURN, &ev.OccurredAt, &ev.TraceID, &payload, &ev.PublishedAt); err != nil {
				return err
			}
			if err := json.Unmarshal(actor, &ev.Actor); err != nil {
				return err
			}
			if len(via) > 0 {
				var v domain.ViaAgent
				if err := json.Unmarshal(via, &v); err != nil {
					return err
				}
				ev.ViaAgent = &v
			}
			if err := json.Unmarshal(payload, &ev.Payload); err != nil {
				return err
			}
			out = append(out, &ev)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Store) MarkOutboxPublished(ctx context.Context, eventIDs []uuid.UUID, at time.Time) error {
	return s.platformTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE outbox SET published_at=$2 WHERE event_id = ANY($1)`, eventIDs, at)
		return err
	})
}
