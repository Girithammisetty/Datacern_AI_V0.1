// Command server runs fhir-bridge: the platform's stateless FHIR R4 proxy.
// Agents reach external FHIR backends (Epic / Cerner / OpenEMR / HAPI-class)
// only through the tool-plane, whose dispatcher federates to this service's
// MCP facade; humans administer the per-tenant backend registry on the
// JWT-guarded /api/v1 plane. NO PHI is stored and NO response bodies are
// logged — only resource type/id, status, latency, tenant and backend id.
// Every adapter is real: Postgres (RLS), Vault (KV v2), the OPA sidecar over
// the Redis projection, and real net/http to the FHIR servers.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datacern-ai/go-common/authjwt"
	"github.com/datacern-ai/go-common/otelx"
	"github.com/datacern-ai/go-common/secrets"

	"github.com/datacern-ai/fhir-bridge/internal/api"
	"github.com/datacern-ai/fhir-bridge/internal/authz"
	"github.com/datacern-ai/fhir-bridge/internal/fhirclient"
	"github.com/datacern-ai/fhir-bridge/internal/register"
	"github.com/datacern-ai/fhir-bridge/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	slog.SetDefault(slog.New(otelx.WrapLogHandler(slog.NewJSONHandler(os.Stdout, nil)))) // MASTER-FR-050
	log := slog.Default()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// OTel tracing (MASTER-FR-050), best-effort.
	if shutdown, err := otelx.Init(ctx, otelx.Config{ServiceName: "fhir-bridge",
		Endpoint: os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"), Insecure: true}); err == nil {
		defer func() { _ = shutdown(context.Background()) }()
	} else {
		log.Warn("otel init failed; continuing without tracing", "err", err)
	}

	requireReal := os.Getenv("REQUIRE_REAL_ADAPTERS") == "true"

	// Postgres is the backend registry — the service is useless without it, so
	// an empty DATABASE_URL is boot-fatal in EVERY mode (no in-memory fallback
	// exists outside *_test.go).
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Error("DATABASE_URL is required (fhir_bridge database, fhirbridge_app role); refusing to boot")
		os.Exit(1)
	}
	// Migrations run under a privileged role (MIGRATE_DATABASE_URL, default =
	// DATABASE_URL); the runtime pool connects as DATABASE_URL, which in a
	// hardened deploy is the NON-superuser app role (fhirbridge_app) so FORCE
	// row-level security is actually enforced on fhir_backends.
	migrateURL := dbURL
	if m := os.Getenv("MIGRATE_DATABASE_URL"); m != "" {
		migrateURL = m
	}
	if err := store.Migrate(migrateURL); err != nil {
		log.Error("migrations failed", "err", err)
		os.Exit(1)
	}
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Error("db connect failed", "err", err)
		os.Exit(1)
	}
	if v := os.Getenv("DB_MAX_CONNS"); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n > 0 {
			poolCfg.MaxConns = int32(n)
		}
	} else {
		poolCfg.MaxConns = 20
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		log.Error("db connect failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	st := store.NewPG(pool)

	// Vault (KV v2) holds ALL backend secret material — there are no secret
	// columns in Postgres. Stabilization guard (no fake/mock/stub in a runtime
	// path): with REQUIRE_REAL_ADAPTERS=true an unset VAULT_ADDR refuses to
	// boot; in local dev the client stays wired but every secret-needing call
	// fails loudly (auth_method=none backends still work).
	vaultAddr := os.Getenv("VAULT_ADDR")
	if vaultAddr == "" {
		if requireReal {
			log.Error("REQUIRE_REAL_ADAPTERS=true but VAULT_ADDR is unset — refusing to boot without the real secret store")
			os.Exit(1)
		}
		log.Warn("VAULT_ADDR unset; secret-backed auth methods will fail loudly (dev mode)")
	}
	vault := secrets.New(vaultAddr, os.Getenv("VAULT_TOKEN"))

	// Real outbound FHIR client (30s timeout, 4 MiB cap, same-host redirects only).
	fhir := fhirclient.New(vault)

	// Real authorizer: OPA sidecar over the Redis permissions_flat projection
	// (MASTER-FR-012). No allow-all escape hatch in the runtime path.
	az := authz.NewOPAClient(env("OPA_URL", "http://localhost:8281"), env("REDIS_ADDR", "localhost:6379"))

	// JWT verifier against the identity-service JWKS (MASTER-FR-010).
	verifier := authjwt.NewJWKS(
		env("JWKS_URL", "http://identity-service/api/v1/.well-known/jwks.json"),
		os.Getenv("JWT_ISSUER"), os.Getenv("JWT_AUDIENCE"))

	// Deploy-time action-catalog registration (RBC-FR-022): push fhir-bridge's
	// action manifest to rbac so OPA's catalog knows each action
	// (`action_known`). Failure is LOUD: /readyz reports 503 until it succeeds
	// (register.Status pattern). Dev mode (RBAC_URL / signing key unset) skips
	// the call and leaves readiness ungated.
	var regGate *api.RegGate
	if os.Getenv("RBAC_URL") == "" || os.Getenv("REGISTER_SIGNING_KEY_PEM") == "" {
		log.Warn("action registration skipped (RBAC_URL or REGISTER_SIGNING_KEY_PEM unset); dev mode, /readyz ungated")
	} else {
		regGate = api.NewRegGate()
		regCfg := register.Config{
			RBACURL:       os.Getenv("RBAC_URL"),
			SigningKeyPEM: os.Getenv("REGISTER_SIGNING_KEY_PEM"),
			SigningKID:    os.Getenv("REGISTER_SIGNING_KID"),
			Issuer:        os.Getenv("JWT_ISSUER"),
			Audience:      os.Getenv("JWT_AUDIENCE"),
			TenantID:      os.Getenv("REGISTER_TENANT_ID"),
		}
		go func(gate *api.RegGate) {
			for {
				err := register.Register(ctx, regCfg)
				if err == nil {
					gate.Succeed()
					return
				}
				log.Error("action catalog registration failed; /readyz degraded until it succeeds", "err", err)
				gate.Fail(err.Error())
				select {
				case <-ctx.Done():
					return
				case <-time.After(30 * time.Second):
				}
			}
		}(regGate)
	}

	srv := &api.Server{
		Store: st, FHIR: fhir, Secrets: vault, Authz: az, Verifier: verifier,
		DB: st, RegGate: regGate, Log: log,
	}

	addr := env("LISTEN_ADDR", ":8325")
	httpSrv := &http.Server{Addr: addr, Handler: srv.Router(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()
	log.Info("fhir-bridge listening", "addr", addr)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server failed", "err", err)
		os.Exit(1)
	}
}
