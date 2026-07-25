//go:build integration

// Integration tier (CONVENTIONS.md tier 2): real Postgres via testcontainers.
// Auto-skips with a clear message when Docker is unavailable.
//
// The test pool connects as a NOSUPERUSER/NOBYPASSRLS role — superusers
// bypass RLS entirely, so testing with the container's default user would
// prove nothing. Production runs the service under a non-superuser role too.
package integration

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	tc "github.com/testcontainers/testcontainers-go"
	tcpg "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	pgstore "github.com/datacern-ai/identity-service/internal/store/postgres"
)

var (
	adminPool *pgxpool.Pool // superuser (setup only)
	appPool   *pgxpool.Pool // NOSUPERUSER app role (all tests)
	skipErr   error
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpg.Run(ctx, "postgres:16-alpine",
		tcpg.WithDatabase("identity"),
		tcpg.WithUsername("postgres"),
		tcpg.WithPassword("postgres"),
		tc.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(90*time.Second)),
	)
	if err != nil {
		skipErr = fmt.Errorf("Docker unavailable — skipping integration tier: %w", err)
		fmt.Println(skipErr)
		os.Exit(m.Run())
	}
	defer func() { _ = tc.TerminateContainer(container) }()

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		skipErr = err
		os.Exit(m.Run())
	}
	if err := pgstore.Migrate(dsn); err != nil {
		fmt.Println("migrate failed:", err)
		os.Exit(1)
	}
	adminPool, err = pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Println("connect failed:", err)
		os.Exit(1)
	}
	// Non-superuser app role: RLS actually applies (FORCE + NOBYPASSRLS).
	//
	// This role is deliberately separate from the real runtime role
	// (identity_app, granted in migrations/0003_app_role.up.sql) -- it's
	// harness-only, so its privileges are set up here rather than via a
	// migration. commercial_dirty (migrations/0011) is the first BIGSERIAL
	// table this harness has ever exercised: table-level DML was already
	// covered by the "ALL TABLES" grant below, but nextval() on its
	// implicit sequence needs its own USAGE grant -- GRANT on a table never
	// implies it on the sequence backing an identity column. Confirmed live:
	// CI failed with "permission denied for sequence commercial_dirty_id_seq"
	// even after the runtime role (identity_app) was separately fixed in
	// 0011.up.sql, because that fix doesn't reach this harness-only role.
	for _, q := range []string{
		`CREATE ROLE app_user WITH LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS`,
		`GRANT USAGE ON SCHEMA public TO app_user`,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`,
		`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user`,
	} {
		if _, err := adminPool.Exec(ctx, q); err != nil {
			fmt.Println("role setup failed:", err)
			os.Exit(1)
		}
	}
	u, _ := url.Parse(dsn)
	u.User = url.UserPassword("app_user", "app_pw")
	appPool, err = pgxpool.New(ctx, u.String())
	if err != nil {
		fmt.Println("app pool failed:", err)
		os.Exit(1)
	}
	code := m.Run()
	appPool.Close()
	adminPool.Close()
	os.Exit(code)
}

// requirePG skips the test when Docker was unavailable.
func requirePG(t *testing.T) {
	t.Helper()
	if skipErr != nil {
		t.Skipf("%v", skipErr)
	}
}
