// Package dbcheck guards against the single most dangerous multi-tenancy
// misconfiguration: running a service's RUNTIME pool as a Postgres role with
// rolsuper or rolbypassrls. Either attribute silently defeats FORCE ROW LEVEL
// SECURITY, so every tenant would see every other tenant's rows with no error.
//
// The dev-default DSNs connect as the cluster superuser (fine locally); in
// production the Helm chart injects a NOSUPERUSER NOBYPASSRLS `*_app` role and
// sets DB_REQUIRE_NONSUPERUSER=true. This check is the belt to that suspenders:
//
//   DB_REQUIRE_NONSUPERUSER=true  -> a privileged runtime role REFUSES to start
//                                    (fail closed — production).
//   otherwise (default)           -> a privileged runtime role logs a loud
//                                    warning but continues (local dev against the
//                                    superuser default DSN).
package dbcheck

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AssertNonSuperuser reads the current runtime role's privilege attributes and,
// if it can bypass RLS, either refuses (strict) or warns (default).
func AssertNonSuperuser(ctx context.Context, pool *pgxpool.Pool) error {
	var role string
	var super, bypass bool
	err := pool.QueryRow(ctx,
		`SELECT current_user, rolsuper, rolbypassrls
		   FROM pg_roles WHERE rolname = current_user`).Scan(&role, &super, &bypass)
	if err != nil {
		return fmt.Errorf("dbcheck: could not read current_user role attributes: %w", err)
	}

	privileged, refuse := decide(super, bypass, strict())
	if !privileged {
		return nil
	}
	msg := fmt.Sprintf("runtime DB role %q has rolsuper=%v rolbypassrls=%v — this DEFEATS "+
		"RLS tenant isolation; use a NOSUPERUSER NOBYPASSRLS app role", role, super, bypass)
	if refuse {
		return errors.New("dbcheck: refusing to start: " + msg)
	}
	slog.Warn("dbcheck: " + msg + " — ALLOWED because DB_REQUIRE_NONSUPERUSER!=true (dev only; set it true in production)")
	return nil
}

// strict reports whether a privileged role must hard-fail the boot.
func strict() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("DB_REQUIRE_NONSUPERUSER")), "true")
}

// decide is the pure decision (unit-testable without a database):
// returns whether the role is privileged, and whether that must refuse the boot.
func decide(super, bypass, strictMode bool) (privileged, refuse bool) {
	privileged = super || bypass
	return privileged, privileged && strictMode
}
