// Package store is fhir-bridge's persistence layer: a pgx-backed Postgres
// store with Postgres RLS for tenant isolation (MASTER-FR-001). Every access
// runs inside a transaction with app.tenant_id set from the verified caller
// context, so the tenant_isolation policy (migrations/000002) binds even the
// service's own reads. The ONE table here holds backend CONNECTION CONFIG
// only — no PHI, no FHIR payloads, no secret material (secrets live in Vault
// behind vault_ref).
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound maps to 404; cross-tenant reads surface as this via RLS.
var ErrNotFound = errors.New("not found")

// ErrNameConflict maps to 409: (tenant_id, name) is unique.
var ErrNameConflict = errors.New("backend name already exists")

// AuthMethods is the closed set of supported upstream auth methods.
var AuthMethods = map[string]bool{
	"none": true, "bearer": true, "basic": true,
	"oauth2_client_credentials": true, "smart_backend_services": true,
}

// Backend is one tenant-registered external FHIR R4 server.
type Backend struct {
	ID          uuid.UUID  `json:"id"`
	TenantID    uuid.UUID  `json:"tenant_id"`
	WorkspaceID *uuid.UUID `json:"workspace_id,omitempty"`
	Name        string     `json:"name"`
	BaseURL     string     `json:"base_url"`
	AuthMethod  string     `json:"auth_method"`
	TokenURL    string     `json:"token_url,omitempty"`
	ClientID    string     `json:"client_id,omitempty"`
	Scopes      string     `json:"scopes,omitempty"`
	VaultRef    string     `json:"vault_ref"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// PG is the pgx-backed store.
type PG struct {
	pool *pgxpool.Pool
}

// NewPG builds a store over a pgx pool.
func NewPG(pool *pgxpool.Pool) *PG { return &PG{pool: pool} }

// Ping checks connectivity (readyz).
func (s *PG) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// withTenant runs fn inside a tx with app.tenant_id set (RLS, MASTER-FR-001).
func (s *PG) withTenant(ctx context.Context, tenant uuid.UUID, fn func(tx pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant.String()); err != nil {
			return fmt.Errorf("set tenant context: %w", err)
		}
		return fn(tx)
	})
}

const backendCols = `id, tenant_id, workspace_id, name, base_url, auth_method,
	COALESCE(token_url,''), COALESCE(client_id,''), COALESCE(scopes,''),
	vault_ref, status, created_at, updated_at`

func scanBackend(row pgx.Row) (*Backend, error) {
	var b Backend
	err := row.Scan(&b.ID, &b.TenantID, &b.WorkspaceID, &b.Name, &b.BaseURL,
		&b.AuthMethod, &b.TokenURL, &b.ClientID, &b.Scopes, &b.VaultRef,
		&b.Status, &b.CreatedAt, &b.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// Create inserts a backend row (id and vault_ref pre-assigned by the caller).
func (s *PG) Create(ctx context.Context, b *Backend) error {
	return s.withTenant(ctx, b.TenantID, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			INSERT INTO fhir_backends
			  (id, tenant_id, workspace_id, name, base_url, auth_method,
			   token_url, client_id, scopes, vault_ref, status)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),$10,$11)
			RETURNING `+backendCols,
			b.ID, b.TenantID, b.WorkspaceID, b.Name, b.BaseURL, b.AuthMethod,
			b.TokenURL, b.ClientID, b.Scopes, b.VaultRef, b.Status)
		nb, err := scanBackend(row)
		if isUniqueViolation(err) {
			return ErrNameConflict
		}
		if err != nil {
			return err
		}
		*b = *nb
		return nil
	})
}

// List returns the tenant's backends, newest first.
func (s *PG) List(ctx context.Context, tenant uuid.UUID) ([]Backend, error) {
	var out []Backend
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+backendCols+`
			FROM fhir_backends ORDER BY created_at DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			b, err := scanBackend(rows)
			if err != nil {
				return err
			}
			out = append(out, *b)
		}
		return rows.Err()
	})
	return out, err
}

// Get returns one backend by id within the tenant (RLS-scoped).
func (s *PG) Get(ctx context.Context, tenant, id uuid.UUID) (*Backend, error) {
	var b *Backend
	err := s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		var err error
		b, err = scanBackend(tx.QueryRow(ctx,
			`SELECT `+backendCols+` FROM fhir_backends WHERE id = $1`, id))
		return err
	})
	return b, err
}

// Update rewrites the mutable columns of b (caller merged the patch already).
func (s *PG) Update(ctx context.Context, b *Backend) error {
	return s.withTenant(ctx, b.TenantID, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			UPDATE fhir_backends SET
			  name=$2, base_url=$3, auth_method=$4, token_url=NULLIF($5,''),
			  client_id=NULLIF($6,''), scopes=NULLIF($7,''), vault_ref=$8,
			  status=$9, updated_at=now()
			WHERE id=$1
			RETURNING `+backendCols,
			b.ID, b.Name, b.BaseURL, b.AuthMethod, b.TokenURL, b.ClientID,
			b.Scopes, b.VaultRef, b.Status)
		nb, err := scanBackend(row)
		if isUniqueViolation(err) {
			return ErrNameConflict
		}
		if err != nil {
			return err
		}
		*b = *nb
		return nil
	})
}

// Delete removes the row (Vault cleanup is the caller's best-effort concern).
func (s *PG) Delete(ctx context.Context, tenant, id uuid.UUID) error {
	return s.withTenant(ctx, tenant, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM fhir_backends WHERE id = $1`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
