// Command server runs chart-service (BRD 07): dashboards + charts, the
// compile→execute→shape data-resolution flow, the Redis result cache, drilldown
// and export. Every adapter is real (Postgres RLS, Redis cache, OPA authz, JWKS
// verification, Kafka outbox + invalidation consumers); there is no stub in the
// runtime path.
package main

import (
	"context"
	"crypto/rand"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datacern-ai/chart-service/internal/api"
	"github.com/datacern-ai/chart-service/internal/config"
	"github.com/datacern-ai/chart-service/internal/events"
	"github.com/datacern-ai/chart-service/internal/export"
	"github.com/datacern-ai/chart-service/internal/register"
	"github.com/datacern-ai/chart-service/internal/store"
	"github.com/datacern-ai/go-common/kafka"
	"github.com/datacern-ai/go-common/objectstore"
	"github.com/datacern-ai/go-common/otelx"
	"github.com/datacern-ai/go-common/outbox"
)

func main() {
	slog.SetDefault(slog.New(otelx.WrapLogHandler(slog.NewJSONHandler(os.Stdout, nil)))) // MASTER-FR-050

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Distributed tracing (no-op unless DATACERN_OTEL_ENABLED / an OTLP endpoint
	// is configured) — installs the global TracerProvider + W3C propagator.
	otelShutdown := otelx.InitFromEnv(ctx, "chart-service")
	defer func() { _ = otelShutdown(context.Background()) }()

	cfg := config.Load()

	// Migrations run under the OWNER DSN; they also create the non-owner
	// chart_app role the runtime pool uses (RLS is authoritative).
	if err := store.Migrate(cfg.MigrateDatabaseURL); err != nil {
		slog.Error("migrations failed", "err", err)
		os.Exit(1)
	}
	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
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

	core := config.BuildCore(cfg)
	rep := core.Describe()
	slog.Info("wired real adapters (no stubs)", "authz", rep.Authz, "cache", rep.Cache,
		"semantic", rep.Semantic, "query", rep.Query, "verifier", rep.Verifier, "producer", rep.Producer)

	// Chart export object store (CHART-FR-041): real MinIO/S3 when
	// MINIO_ENDPOINT is set (multi-replica safe, every real deploy), the local
	// filesystem FSStore otherwise (single-replica dev/demo only -- its files
	// are pinned to whichever replica wrote them). REQUIRE_REAL_ADAPTERS=true
	// forces the MinIO branch even without MINIO_ENDPOINT (localhost:9000
	// default) and fails boot loudly if it can't connect.
	requireReal := os.Getenv("REQUIRE_REAL_ADAPTERS") == "true"
	var exports export.ObjectStore
	if cfg.MinIOEndpoint != "" || requireReal {
		endpoint := cfg.MinIOEndpoint
		if endpoint == "" {
			endpoint = "localhost:9000"
		}
		osClient, err := objectstore.New(ctx, objectstore.Config{
			Endpoint: endpoint, AccessKey: cfg.MinIOAccessKey, SecretKey: cfg.MinIOSecretKey,
			UseSSL: cfg.MinIOUseSSL, Bucket: cfg.ExportBucket,
		})
		if err != nil {
			if requireReal {
				slog.Error("chart export store init failed", "err", err)
				os.Exit(1)
			}
			slog.Warn("chart export store: minio unavailable, exports will fail loud until fixed", "err", err)
		} else {
			exports = export.NewS3Store(osClient)
			slog.Info("chart export store: minio (real)", "endpoint", endpoint)
		}
	} else {
		secret := []byte(cfg.ExportSecret)
		if len(secret) == 0 {
			secret = make([]byte, 32)
			if _, err := rand.Read(secret); err != nil {
				slog.Error("secret generation failed", "err", err)
				os.Exit(1)
			}
			slog.Warn("EXPORT_SIGNING_SECRET unset; generated ephemeral secret (links break on restart)")
		}
		exports = export.NewFSStore(cfg.ExportRoot, cfg.PublicURL, secret)
		slog.Warn("chart export store: local filesystem (set MINIO_ENDPOINT for multi-replica deploys)")
	}

	srv := &api.Server{
		Store:        st,
		Cache:        core.Cache,
		Authz:        core.Authz,
		Resolver:     core.Resolver,
		Verifier:     core.Verifier,
		Exports:      exports,
		Fields:       core.Semantic, // real known-field validation (CHART-FR-013)
		DefaultModel: cfg.DefaultModel,
		PreviewSem:   make(chan struct{}, 5),
		PNGRenderer:  cfg.PNGRenderer,
	}

	// Outbox relay → real Kafka (MASTER-FR-034). KAFKA_BROKERS=false disables.
	if core.Producer != nil {
		relay := outbox.New(st, core.Producer, events.Topic)
		relay.Interval = time.Second
		go relay.Run(ctx)
		// B6 (BRD 58): published outbox rows are drained but never pruned; sweep
		// them past a retention window so the table doesn't grow unboundedly.
		go outbox.NewPruner(pool, "outbox", "app.role", "platform").Run(ctx)

		// Cache-invalidation consumers (CHART-FR-031): semantic/query/dataset.
		inv := &events.Invalidator{Store: st, Cache: core.Cache, Log: slog.Default()}
		brokers := strings.Split(cfg.KafkaBrokers, ",")
		cg := kafka.NewConsumerGroup(kafka.ConsumerConfig{
			Brokers: brokers, GroupID: "chart-service-invalidation",
			Topics:  []string{events.TopicSemantic, events.TopicQuery, events.TopicDataset},
			Handler: inv.Handle, Dedup: core.Redis, DLQ: core.Producer,
			SASL: kafka.SASLFromEnv(os.Getenv), TLS: kafka.TLSFromEnv(os.Getenv),
		})
		go cg.Run(ctx)
		defer func() { _ = cg.Close() }()
	} else {
		slog.Warn("KAFKA_BROKERS=false; outbox relay + invalidation consumers disabled (local dev only)")
	}

	// Register the action catalog with rbac (RBC-FR-022), non-fatal.
	go func() {
		err := register.Register(ctx, register.Config{
			RBACURL: cfg.RBACURL, SigningKeyPEM: cfg.SigningKeyPEM, SigningKID: cfg.SigningKID,
			Issuer: cfg.JWTIssuer, Audience: cfg.JWTAudience, TenantID: "00000000-0000-0000-0000-000000000000",
		})
		if err != nil {
			slog.Warn("action registration failed", "err", err)
		}
	}()

	httpSrv := &http.Server{Addr: cfg.ListenAddr, Handler: otelx.WrapHandler(srv.Router(), "chart-service"), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()
	slog.Info("chart-service listening", "addr", cfg.ListenAddr)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}
