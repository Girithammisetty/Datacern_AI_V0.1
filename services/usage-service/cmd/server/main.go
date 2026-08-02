// Command server runs usage-service: the platform's metering, cost-attribution
// and budget-enforcement authority (BRD 17). Every adapter is real by default —
// real Postgres (meter store + rollups), real Redpanda (Kafka ingest + outbox),
// real Redis (dedup + counters), real OPA sidecar (authz). There is no env flag
// that swaps a real adapter for a fake; doubles exist only in *_test.go.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	gckafka "github.com/datacern-ai/go-common/kafka"
	"github.com/datacern-ai/go-common/objectstore"
	"github.com/datacern-ai/go-common/otelx"
	gcoutbox "github.com/datacern-ai/go-common/outbox"
	"github.com/datacern-ai/go-common/redisx"

	"github.com/datacern-ai/usage-service/internal/api"
	"github.com/datacern-ai/usage-service/internal/authz"
	"github.com/datacern-ai/usage-service/internal/billing"
	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/entitlements"
	"github.com/datacern-ai/usage-service/internal/events"
	"github.com/datacern-ai/usage-service/internal/ingest"
	"github.com/datacern-ai/usage-service/internal/jobs"
	"github.com/datacern-ai/usage-service/internal/metrics"
	"github.com/datacern-ai/usage-service/internal/register"
	"github.com/datacern-ai/usage-service/internal/store"
	"github.com/datacern-ai/usage-service/internal/valueexport"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	slog.SetDefault(slog.New(otelx.WrapLogHandler(slog.NewJSONHandler(os.Stdout, nil)))) // MASTER-FR-050

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Stabilization guard (rule: no fake/mock/stub in a runtime path). When
	// REQUIRE_REAL_ADAPTERS=true — set in every real deploy — the service REFUSES
	// to boot on a fallback adapter (here: the local-filesystem export store)
	// instead of silently running multi-replica-unsafe. Absent (local unit dev),
	// the loud-warn fallback below keeps dev self-contained.
	requireReal := os.Getenv("REQUIRE_REAL_ADAPTERS") == "true"

	// Distributed tracing (no-op unless datacern_OTEL_ENABLED / an OTLP endpoint
	// is configured) — installs the global TracerProvider + W3C propagator.
	otelShutdown := otelx.InitFromEnv(ctx, "usage-service")
	defer func() { _ = otelShutdown(context.Background()) }()

	// Migrations run as the owner/admin role (creates the non-owner runtime
	// role usage_app); the service pool connects as usage_app (RLS applies).
	adminURL := env("MIGRATE_DATABASE_URL", "postgres://datacern:datacern_dev@localhost:5432/usage?sslmode=disable")
	if err := store.Migrate(adminURL); err != nil {
		slog.Error("migrations failed", "err", err)
		os.Exit(1)
	}
	dbURL := env("DATABASE_URL", "postgres://usage_app:usage_app@localhost:5432/usage?sslmode=disable")
	slog.Info("db adapter: postgres (real)", "runtime_role", roleOf(dbURL))
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		slog.Error("db connect failed", "err", err)
		os.Exit(1)
	}
	if v := os.Getenv("DB_MAX_CONNS"); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n > 0 {
			poolCfg.MaxConns = int32(n)
		}
	} else {
		poolCfg.MaxConns = 20 // explicit default, up from pgx's ~4
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		slog.Error("db connect failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	st := store.NewPG(pool)
	if err := st.SeedMeters(ctx); err != nil {
		slog.Error("seed meters failed", "err", err)
		os.Exit(1)
	}

	m := metrics.New(prometheus.DefaultRegisterer)

	// Real Redis (dedup + counters). No in-memory mode.
	redis := redisx.NewFromEnv(env("REDIS_ADDR", "localhost:6379"), os.Getenv)
	defer func() { _ = redis.Close() }()
	slog.Info("cache adapter: redis (real)", "addr", env("REDIS_ADDR", "localhost:6379"))

	// Real authz via the OPA sidecar over the Redis permissions_flat projection.
	az := authz.NewOPAClient(env("OPA_URL", "http://localhost:8281"), env("REDIS_ADDR", "localhost:6379"))
	slog.Info("authz adapter: opa sidecar (real)", "opa", env("OPA_URL", "http://localhost:8281"))

	// Real JWKS verification (MASTER-FR-010).
	verifier := api.NewVerifierJWKS(
		env("JWKS_URL", "http://identity-service/api/v1/.well-known/jwks.json"),
		os.Getenv("JWT_ISSUER"), os.Getenv("JWT_AUDIENCE"))

	// Real Kafka (Redpanda): one shared producer for the emit publisher and the
	// ingest DLQ.
	brokers := strings.Split(env("KAFKA_BROKERS", "localhost:9092"), ",")
	srURL := os.Getenv("SCHEMA_REGISTRY_URL")
	producer := gckafka.NewProducer(gckafka.Config{
		Brokers: brokers,
		SASL:    gckafka.SASLFromEnv(os.Getenv), TLS: gckafka.TLSFromEnv(os.Getenv),
	})
	defer func() { _ = producer.Close() }()
	kpub := events.NewKafkaPublisher(ctx, brokers, srURL)
	defer func() { _ = kpub.Close() }()
	slog.Info("event adapter: kafka (real)", "brokers", brokers)

	// Ingest pipeline (mapping catalog validated at startup, USG-FR-015).
	mappings := ingest.Catalog()
	if err := ingest.ValidateCatalog(mappings); err != nil {
		slog.Error("mapping catalog invalid", "err", err)
		os.Exit(1)
	}
	pipeline := ingest.NewPipeline(mappings, st, st, m)

	// Real inbound consumer group (Redis dedup + DLQ) over the metering topics.
	consumer := events.NewIngestConsumer(brokers, redis, producer, pipeline)
	defer func() { _ = consumer.Close() }()
	go consumer.Run(ctx)

	// Outbox relay drains committed budget/anomaly/reconciliation events to
	// usage.events.v1 (MASTER-FR-034).
	relay := &events.Relay{Source: st, Publisher: kpub, Interval: 500 * time.Millisecond}
	go relay.Run(ctx)
	// B6 (BRD 58): published outbox rows are drained but never pruned; sweep
	// them past a retention window so the table doesn't grow unboundedly. (This
	// service's own usage_* tables already have EnforceRetention above.)
	go gcoutbox.NewPruner(pool, "outbox", "app.role", "platform").Run(ctx)

	// Periodic workers.
	runner := &jobs.Runner{Store: st, BillPrefix: env("PROVIDER_BILL_PREFIX", "bills/")}

	// Provider-bill object store (USG-FR-070/071): real MinIO/S3 prefix that an
	// operator (or an out-of-repo pull job) drops provider invoice CSV exports
	// into; the reconciliation job below only reads them. This is genuinely
	// real local object storage (CONVENTIONS table), not a live AWS CUR/Azure/
	// GCP/LLM-provider billing API client -- no such adapter exists anywhere in
	// this repo, and per README "No credential-gated exceptions" that stays out
	// of scope. Separate bucket from the value-report exports above so the two
	// concerns don't share a lifecycle.
	if minioEndpoint := os.Getenv("MINIO_ENDPOINT"); minioEndpoint != "" || requireReal {
		ep := minioEndpoint
		if ep == "" {
			ep = "localhost:9000"
		}
		billsClient, err := objectstore.New(ctx, objectstore.Config{
			Endpoint:  ep,
			AccessKey: env("MINIO_ACCESS_KEY", "datacern"),
			SecretKey: env("MINIO_SECRET_KEY", "datacern_dev"),
			UseSSL:    os.Getenv("MINIO_USE_SSL") == "true",
			Bucket:    env("PROVIDER_BILL_BUCKET", "datacern-provider-bills"),
		})
		if err != nil {
			if requireReal {
				slog.Error("provider-bill object store init failed", "err", err)
				os.Exit(1)
			}
			slog.Warn("provider-bill object store: minio unavailable, reconciliation has nothing to reconcile until fixed", "err", err)
		} else {
			runner.Bills = jobs.NewMinioBillStore(billsClient)
			slog.Info("provider-bill object store: minio (real)", "endpoint", ep, "bucket", billsClient.Bucket())
		}
	} else {
		slog.Warn("provider-bill object store: MINIO_ENDPOINT unset, reconciliation job has no bill source (dev-only; the variance-block gate stays inert -- always 'pending' -- until a real bucket is configured)")
	}

	// Billing pusher (revenue side, GTM B2 / value-metering-billing-export
	// slice 4): forwards closed periods' billable meter quantities to an
	// external rating system. Defaults to an honest UnconfiguredPusher — the
	// file/CSV export is the source of truth and a provider push is opt-in
	// (set BILLING_PUSHER=stripe + STRIPE_API_KEY + STRIPE_CUSTOMER_MAP). The
	// close job that calls Push is not built yet (slice 3); this constructs and
	// logs the pusher's configured state so the posture is visible at boot.
	runner.Pusher = billing.BuildPusher(billing.FromEnv(os.Getenv))
	if _, unconfigured := runner.Pusher.(*domain.UnconfiguredPusher); unconfigured {
		slog.Warn("billing pusher: unconfigured (export-only); set BILLING_PUSHER=stripe + STRIPE_API_KEY + STRIPE_CUSTOMER_MAP to push metered usage to Stripe")
	} else {
		slog.Info("billing pusher: configured", "adapter", env("BILLING_PUSHER", "none"))
	}

	startJobs(ctx, runner)

	// Register the action manifest with rbac (best-effort, RBC-FR-022).
	go func() {
		err := register.Register(ctx, register.Config{
			RBACURL:       os.Getenv("RBAC_URL"),
			SigningKeyPEM: os.Getenv("SERVICE_SIGNING_KEY_PEM"),
			SigningKID:    os.Getenv("SERVICE_SIGNING_KID"),
			Issuer:        os.Getenv("JWT_ISSUER"),
			Audience:      os.Getenv("JWT_AUDIENCE"),
			TenantID:      env("PLATFORM_TENANT_ID", "00000000-0000-0000-0000-000000000000"),
		})
		if err != nil {
			slog.Warn("action registration failed", "err", err)
		}
	}()

	// Value-report export object store (BRD 69 design §2.8): real MinIO/S3 when
	// MINIO_ENDPOINT is set (multi-replica safe, every real deploy), the local
	// filesystem FSStore otherwise (single-replica dev/demo only — its files are
	// pinned to whichever replica wrote them, same weight class as
	// chart-service's export mechanics, no Object-Lock/WORM since this is not a
	// compliance record).
	var exports valueexport.ObjectStore
	if minioEndpoint := os.Getenv("MINIO_ENDPOINT"); minioEndpoint != "" || requireReal {
		if minioEndpoint == "" {
			minioEndpoint = "localhost:9000"
		}
		osClient, err := objectstore.New(ctx, objectstore.Config{
			Endpoint:  minioEndpoint,
			AccessKey: env("MINIO_ACCESS_KEY", "datacern"),
			SecretKey: env("MINIO_SECRET_KEY", "datacern_dev"),
			UseSSL:    os.Getenv("MINIO_USE_SSL") == "true",
			Bucket:    env("VALUE_EXPORT_BUCKET", "datacern-value-exports"),
		})
		if err != nil {
			if requireReal {
				slog.Error("value-report export store init failed", "err", err)
				os.Exit(1)
			}
			slog.Warn("value-report export store: minio unavailable, exports will fail loud until fixed", "err", err)
		} else {
			exports = valueexport.NewS3Store(osClient)
			slog.Info("value-report export store: minio (real)", "endpoint", minioEndpoint)
		}
	} else {
		exportSecret := []byte(os.Getenv("VALUE_EXPORT_SIGNING_SECRET"))
		if len(exportSecret) == 0 {
			exportSecret = []byte(uuid.NewString())
			slog.Warn("VALUE_EXPORT_SIGNING_SECRET unset; generated ephemeral secret (download links break on restart)")
		}
		exports = valueexport.NewFSStore(
			env("VALUE_EXPORT_ROOT", "/var/lib/usage-service/value-exports"),
			env("PUBLIC_URL", "http://localhost:8080"),
			exportSecret,
		)
		slog.Warn("value-report export store: local filesystem (set MINIO_ENDPOINT for multi-replica deploys)")
	}

	srv := &api.Server{
		Store:    st,
		Authz:    az,
		Verifier: verifier,
		Exports:  exports,
		// Contracted meter allowances for the value summary (CPL-FR-032),
		// read from the same projection Redis identity-service writes.
		Entitlements: entitlements.NewReader(redis.R),
		Ready: func(ctx context.Context) error {
			if err := st.Ping(ctx); err != nil {
				return err
			}
			return redis.Ping(ctx)
		},
	}

	addr := env("LISTEN_ADDR", ":8080")
	httpSrv := &http.Server{Addr: addr, Handler: otelx.WrapHandler(srv.Router(), "usage-service"), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()
	slog.Info("usage-service listening", "addr", addr)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}

// startJobs launches the periodic workers as real background loops.
func startJobs(ctx context.Context, r *jobs.Runner) {
	every(ctx, time.Minute, func() {
		if err := r.RefreshRollups(ctx); err != nil {
			slog.Warn("rollup refresh failed", "err", err)
		}
		if err := r.SweepBudgets(ctx); err != nil {
			slog.Warn("budget sweep failed", "err", err)
		}
	})
	every(ctx, 30*time.Minute, func() {
		if _, err := r.AnomalyScan(ctx, time.Now().AddDate(0, 0, -1)); err != nil {
			slog.Warn("anomaly scan failed", "err", err)
		}
	})
	every(ctx, time.Hour, func() {
		if n, err := r.Reconcile(ctx); err != nil {
			slog.Warn("reconciliation failed", "err", err)
		} else if n > 0 {
			slog.Info("reconciliation processed", "count", n)
		}
	})
	every(ctx, 6*time.Hour, func() {
		if err := r.EnforceRetention(ctx); err != nil {
			slog.Warn("retention failed", "err", err)
		}
	})
}

func every(ctx context.Context, d time.Duration, fn func()) {
	go func() {
		t := time.NewTicker(d)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				fn()
			}
		}
	}()
}

func roleOf(dsn string) string {
	u, err := url.Parse(dsn)
	if err != nil || u.User == nil {
		return "unknown"
	}
	return u.User.Username()
}
