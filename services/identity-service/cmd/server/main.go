// identity-service entrypoint. Wires the domain services onto either the
// Postgres store (DATABASE_URL set) or the in-memory store (dev mode),
// bootstraps signing keys, and starts the HTTP server + background loops
// (outbox poller, key-cache refresh, scheduled deletions).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datacern-ai/go-common/objectstore"
	"github.com/datacern-ai/go-common/otelx"
	gcoutbox "github.com/datacern-ai/go-common/outbox"
	"github.com/datacern-ai/go-common/redisx"

	"github.com/datacern-ai/identity-service/internal/adapters/awskms"
	"github.com/datacern-ai/identity-service/internal/adapters/azurekeyvault"
	"github.com/datacern-ai/identity-service/internal/adapters/demobundle"
	"github.com/datacern-ai/identity-service/internal/adapters/demoseed"
	"github.com/datacern-ai/identity-service/internal/adapters/denylist"
	"github.com/datacern-ai/identity-service/internal/adapters/gcpkms"
	"github.com/datacern-ai/identity-service/internal/adapters/leaderlease"
	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/adapters/keycloak"
	"github.com/datacern-ai/identity-service/internal/adapters/localinfra"
	"github.com/datacern-ai/identity-service/internal/adapters/oidc"
	"github.com/datacern-ai/identity-service/internal/adapters/valueclient"
	"github.com/datacern-ai/identity-service/internal/adapters/vault"
	"github.com/datacern-ai/identity-service/internal/api"
	"github.com/datacern-ai/identity-service/internal/authz"
	"github.com/datacern-ai/identity-service/internal/blob"
	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/events"
	"github.com/datacern-ai/identity-service/internal/keys"
	"github.com/datacern-ai/identity-service/internal/pocexport"
	"github.com/datacern-ai/identity-service/internal/projection"
	"github.com/datacern-ai/identity-service/internal/rbacclient"
	"github.com/datacern-ai/identity-service/internal/store/memory"
	"github.com/datacern-ai/identity-service/internal/store/postgres"
)

// envInt reads a positive integer from env, falling back to def when unset
// or unparseable/non-positive (BRD 70 v1.1 self-serve demo signup config).
func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// envMinutes reads a positive integer count of minutes from env and
// returns it as a time.Duration, falling back to def when unset/invalid.
func envMinutes(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Minute
		}
	}
	return def
}

func main() {
	log := slog.New(otelx.WrapLogHandler(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Distributed tracing (no-op unless DATACERN_OTEL_ENABLED / an OTLP endpoint
	// is configured) — installs the global TracerProvider + W3C propagator.
	otelShutdown := otelx.InitFromEnv(ctx, "identity-service")
	defer func() { _ = otelShutdown(context.Background()) }()

	// Stabilization guard (rule: no fake/mock/stub in a runtime path). When
	// REQUIRE_REAL_ADAPTERS=true — set in every real deploy — the service REFUSES
	// to boot on an in-memory/fake adapter instead of silently faking success.
	// Absent (local unit dev), the loud-warn fallbacks below keep dev
	// self-contained. This is what stops a misconfigured prod (e.g. a secret that
	// ships POSTGRES_*/REDIS_URL but not DATABASE_URL/REDIS_ADDR/KEYCLOAK_URL)
	// from coming up "healthy" while provisioning users into a map.
	requireReal := os.Getenv("REQUIRE_REAL_ADAPTERS") == "true"
	mustReal := func(realEnv, adapter string) {
		log.Error("REQUIRE_REAL_ADAPTERS=true but " + realEnv + " is unset — refusing to boot on the " + adapter + " fallback")
		os.Exit(1)
	}

	var store domain.Store
	ready := func() error { return nil }
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		// Migrations need DDL/ownership + role creation, so they run under a
		// privileged role (MIGRATE_DATABASE_URL, default = DATABASE_URL). The
		// runtime pool connects as DATABASE_URL, which in a hardened deploy is a
		// NON-superuser app role (identity_app) so FORCE row-level security is
		// actually enforced — a superuser/BYPASSRLS runtime role would silently
		// defeat tenant isolation.
		migrateURL := dsn
		if m := os.Getenv("MIGRATE_DATABASE_URL"); m != "" {
			migrateURL = m
		}
		if err := postgres.Migrate(migrateURL); err != nil {
			log.Error("migrate failed", "error", err)
			os.Exit(1)
		}
		poolCfg, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			log.Error("db connect failed", "error", err)
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
			log.Error("db connect failed", "error", err)
			os.Exit(1)
		}
		defer pool.Close()
		store = postgres.New(pool)
		ready = func() error { return pool.Ping(context.Background()) }
		log.Info("store: postgres")
		// B6 (BRD 58): published outbox rows are drained but never pruned; sweep
		// them past a retention window so the table doesn't grow unboundedly.
		go gcoutbox.NewPruner(pool, "outbox", "app.role", "platform").Run(ctx)
	} else {
		if requireReal {
			mustReal("DATABASE_URL", "in-memory store")
		}
		store = memory.New()
		log.Warn("store: in-memory (set DATABASE_URL for postgres)")
	}

	// Bootstrap first-class platform admins from env (idempotent upsert). Lets an
	// operator (or the dev seed) designate cross-tenant platform admins without a
	// pre-existing platform.admin token — resolves the chicken-and-egg on the
	// super-admin-gated management API.
	if raw := os.Getenv("PLATFORM_ADMIN_BOOTSTRAP_EMAILS"); raw != "" {
		for _, e := range strings.Split(raw, ",") {
			email, err := domain.ValidateEmail(strings.TrimSpace(e))
			if err != nil {
				continue
			}
			if err := store.CreatePlatformAdmin(context.Background(), &domain.PlatformAdmin{
				ID: uuid.New(), Email: email, GrantedBy: "bootstrap", GrantedAt: time.Now().UTC(),
			}); err != nil {
				log.Warn("platform-admin bootstrap upsert failed", "email", email, "error", err)
			} else {
				log.Info("platform-admin bootstrapped", "email", email)
			}
		}
	}

	clock := time.Now

	// Signing keys (BYO Infra Hardening Phase 2, docs/design/
	// byo-infra-hardening.md): SECRETS_BACKEND=vault|aws|azure|gcp selects the
	// signer, default "vault" preserving the original VAULT_ADDR-gated
	// behavior unchanged when the env var is unset. Private keys never leave
	// whichever backend is selected (IDN-FR-050); LocalSigner is the only
	// dev/tests fallback (backend "vault" with VAULT_ADDR unset).
	signer, signerDesc, err := buildSigner(ctx, log)
	if err != nil {
		log.Error("signer init failed", "error", err)
		os.Exit(1)
	}
	log.Info("signer: " + signerDesc)
	km := keys.NewKeyManager(store, signer, clock)
	if err := km.Bootstrap(ctx); err != nil {
		log.Error("key bootstrap failed", "error", err)
		os.Exit(1)
	}
	issuer := keys.NewIssuer(km, clock)

	// Adapters. Real Keycloak admin is used when KEYCLOAK_URL is set;
	// otherwise the fake keeps dev mode self-contained. With
	// KEYCLOAK_ADMIN_USER/KEYCLOAK_ADMIN_PASSWORD set the adapter obtains (and
	// caches/refreshes) admin tokens itself via the master-realm password
	// grant (admin-cli); KEYCLOAK_ADMIN_TOKEN remains as a static fallback.
	var kc domain.KeycloakAdmin = keycloak.NewFake()
	if base := os.Getenv("KEYCLOAK_URL"); base != "" {
		tokenFn := func(context.Context) (string, error) {
			return os.Getenv("KEYCLOAK_ADMIN_TOKEN"), nil
		}
		if user := os.Getenv("KEYCLOAK_ADMIN_USER"); user != "" {
			tokenFn = keycloak.PasswordGrant(base, user, os.Getenv("KEYCLOAK_ADMIN_PASSWORD"), nil)
			log.Info("keycloak: real admin adapter (password grant)", "url", base, "user", user)
		} else {
			log.Info("keycloak: real admin adapter (static KEYCLOAK_ADMIN_TOKEN)", "url", base)
		}
		kc = &keycloak.HTTPAdmin{BaseURL: base, Token: tokenFn}
	} else {
		if requireReal {
			mustReal("KEYCLOAK_URL", "fake Keycloak (user/realm provisioning would silently no-op)")
		}
		log.Warn("keycloak: fake (set KEYCLOAK_URL for a real Keycloak)")
	}
	// Local-equivalent infra adapters (adapters/localinfra): honest no-op
	// runners for the ports with no real single-Mac target — the per-cloud
	// Terraform runner (step 3), the per-tenant schema provisioner (step 4),
	// and the synthetic health prober (step 7). They SUCCEED and advance the
	// saga to `active`, and log loudly so nothing is silently faked. The
	// substantive local gate is the REAL Keycloak realm/user step. In a cloud
	// deploy these bind to the real per-cloud infra module runner.
	tf := localinfra.Runner{Log: log}
	db := localinfra.DB{Log: log}
	prober := localinfra.Prober{Log: log}
	log.Warn("infra: local-equivalent Terraform/DB/Prober (no cloud target on this host; " +
		"Keycloak realm/user provisioning is REAL)")

	// API-key denylist: real Redis (≤5s propagation, IDN-FR-033) when REDIS_ADDR
	// is set; in-memory otherwise (single-replica dev/tests).
	var deny domain.Denylist = denylist.NewMemory()
	if redisAddr := os.Getenv("REDIS_ADDR"); redisAddr != "" {
		deny = &denylist.Redis{Cmd: redisx.NewFromEnv(redisAddr, os.Getenv), Prefix: "denylist:apikey:", TTL: 24 * time.Hour}
		log.Info("denylist: redis")
	} else {
		if requireReal {
			mustReal("REDIS_ADDR", "in-memory API-key denylist (revocations would not propagate across replicas)")
		}
		log.Warn("denylist: in-memory (set REDIS_ADDR for multi-replica Redis)")
	}

	// BRD 59 WS3: tenant branding logo object storage (real MinIO/S3, same
	// adapter case-service uses for evidence). Unlike case-service's evidence
	// store, a MinIO outage here is NOT fatal to boot: identity-service is on
	// the critical path for every login/token mint in the platform, while a
	// branding logo is a small, non-core feature -- color tokens still work
	// with Logo left nil, and the logo endpoints honestly 501 instead.
	// Declared as the api.LogoStore interface (not *blob.MinioLogoStore) so the
	// unconfigured case stays a TRUE nil interface -- assigning a nil *T to an
	// interface-typed field would make Server.Logo != nil even when unset.
	var logoStore api.LogoStore
	if minioEndpoint := os.Getenv("MINIO_ENDPOINT"); minioEndpoint != "" || requireReal {
		if minioEndpoint == "" {
			minioEndpoint = "localhost:9000"
		}
		accessKey, secretKey, bucket := os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_SECRET_KEY"), os.Getenv("TENANT_BRANDING_BUCKET")
		if accessKey == "" {
			accessKey = "datacern"
		}
		if secretKey == "" {
			secretKey = "datacern_dev"
		}
		if bucket == "" {
			bucket = "datacern-tenant-branding"
		}
		ls, err := blob.NewMinioLogoStore(ctx, blob.Config{
			Endpoint: minioEndpoint, AccessKey: accessKey, SecretKey: secretKey,
			UseSSL: os.Getenv("MINIO_USE_SSL") == "true", Bucket: bucket,
		})
		if err != nil {
			if requireReal {
				log.Error("tenant branding logo store init failed", "error", err)
				os.Exit(1)
			}
			log.Warn("tenant branding logo store unavailable — logo upload/download will 501", "error", err)
		} else {
			logoStore = ls
			log.Info("tenant branding logo store: minio")
		}
	} else {
		log.Warn("tenant branding logo store: not configured (set MINIO_ENDPOINT) — logo upload/download will 501")
	}

	// BRD 70 slice 1/2: demo-sandbox bundle loader + seeding runner
	// (§2.2/§2.3). DEMO_BUNDLES_ROOT/DEMO_SEED_SCRIPT default to the repo
	// layout this service ships alongside (deploy/demo/, packs/
	// demo_seed_runner.py) -- override in a container image that places
	// them elsewhere. A demo tenant hitting an unconfigured/missing bundle
	// or script fails its SeedDemoContent step loud (engine_steps.go), it
	// is never silently skipped.
	demoBundles := &demobundle.FSLoader{Root: envOr("DEMO_BUNDLES_ROOT", "deploy/demo")}
	demoSeed := &demoseed.SubprocessRunner{
		PythonBin:  envOr("DEMO_SEED_PYTHON", "python3"),
		ScriptPath: envOr("DEMO_SEED_SCRIPT", "packs/demo_seed_runner.py"),
		Timeout:    8 * time.Minute,
		Issuer:     issuer,
	}
	deps := domain.StepDeps{
		Store: store, Keycloak: kc, Terraform: tf, DB: db, Prober: prober, Clock: clock,
		DemoBundles: demoBundles, DemoSeed: demoSeed,
	}
	notify := func(ctx context.Context, t *domain.Tenant, st *domain.ProvisioningStep) {
		// IDN-FR-010: provisioning progress events -> realtime-hub via outbox.
		_ = store.AppendOutbox(ctx, domain.NewEvent(domain.EvTenantStepCompleted, t.ID,
			domain.Actor{Type: "service", ID: "identity-service"}, t.URN(), clock().UTC(),
			map[string]any{"step": st.StepName, "status": string(st.Status), "attempt": st.Attempt}))
	}
	engine := domain.NewEngine(store, domain.DefaultEngineConfig(), deps.ProvisionSteps, deps.DestroySteps, notify)

	tenants := &domain.TenantService{
		Store: store, Engine: engine, Graph: domain.DefaultModuleGraph(), Prober: prober,
		Clock: clock, Async: true,
	}
	// BR-9 last-admin guard: real rbac-backed checker when RBAC_URL is set;
	// otherwise the allow-all stub (BR-9 NOT enforced — dev/tests only).
	rbacURL := os.Getenv("RBAC_URL")
	var lastAdmin domain.LastAdminChecker = domain.AllowAllLastAdminChecker{}
	if rbacURL != "" {
		lastAdmin = &rbacclient.Checker{BaseURL: rbacURL, Store: store, Issuer: issuer, Log: log}
		log.Info("last-admin checker: rbac", "url", rbacURL)
	} else {
		if requireReal {
			mustReal("RBAC_URL", "allow-all last-admin checker (BR-9 not enforced)")
		}
		log.Warn("last-admin checker: allow-all — BR-9 (last tenant admin cannot be deactivated) is NOT enforced; set RBAC_URL to enable the real rbac-backed checker")
	}
	users := &domain.UserService{Store: store, Keycloak: kc, LastAdmin: lastAdmin, Clock: clock}
	sas := &domain.ServiceAccountService{Store: store, Denylist: deny, Clock: clock}
	// BRD 66 slice 1: commercial plan catalog + tenant plan assignment /
	// entitlement overrides / effective-entitlements resolution.
	plans := &domain.PlanService{Store: store, Clock: clock}
	commercial := &domain.CommercialService{Store: store, Clock: clock}
	// BRD 66 slice 2: trial lifecycle (start/extend/convert).
	trials := &domain.TrialService{Store: store, Clock: clock}
	// BRD 70 slice 1/2: demo-sandbox lifecycle (create/reset/clone).
	demo := &domain.DemoService{
		Store: store, Tenants: tenants, Commercial: commercial,
		Bundles: demoBundles, Seed: demoSeed, Clock: clock,
	}
	tokens := &domain.TokenService{
		Store: store, Issuer: issuer, Verifier: issuer, Denylist: deny,
		Limiter: domain.NewSlidingWindowLimiter(domain.OBORateLimit, domain.OBORateWindow), Clock: clock,
	}
	// Real-OIDC login default-workspace resolution (see WorkspaceResolver) —
	// same RBAC_URL gate as the last-admin checker above; a missing RBAC_URL
	// just leaves OIDC sessions unscoped, as before this was added.
	if rbacURL != "" {
		tokens.Workspaces = &rbacclient.WorkspaceResolver{BaseURL: rbacURL, Issuer: issuer, Log: log}
	}
	// BRD 70 v1.1: self-serve demo signup's claim-login flow (PublicSignup /
	// ClaimSelfServeLogin, demo_public_signup.go) mints real session tokens
	// through the same Issuer/Workspaces every other login path uses.
	demo.Tokens = tokens

	// BRD 70 slice 3: POC-mode lifecycle (create-with-criteria, progress,
	// poc-report.v1 export). Value reads real BRD 69 data from usage-service
	// over HTTP when USAGE_SERVICE_URL is set -- same real-adapter-vs-honest-
	// fallback gate as the RBAC_URL-backed last-admin checker above; unlike
	// that checker (which has an allow-all fallback), Poc.Value has no
	// fallback at all -- Progress/ExportReport simply fail loud (EInternal)
	// rather than fabricate figures when unset, matching Bundles/Seed's own
	// "fail loud on nil adapter" rule.
	poc := &domain.PocService{Store: store, Tenants: tenants, Commercial: commercial, Clock: clock}
	if usageURL := os.Getenv("USAGE_SERVICE_URL"); usageURL != "" {
		poc.Value = &valueclient.Client{BaseURL: usageURL, Issuer: issuer}
		log.Info("poc value reader: usage-service", "url", usageURL)
	} else {
		if requireReal {
			mustReal("USAGE_SERVICE_URL", "poc progress/export disabled (no ValueSummaryReader configured)")
		}
		log.Warn("poc value reader: not configured — POC progress/export will fail loud until USAGE_SERVICE_URL is set")
	}
	// poc-report.v1 export object store: real MinIO/S3 when MINIO_ENDPOINT is
	// set (multi-replica safe, every real deploy; the same MINIO_* env vars the
	// tenant-branding logo store above reads), the local filesystem FSStore
	// otherwise (single-replica dev/demo only -- its files are pinned to
	// whichever replica wrote them).
	if minioEndpoint := os.Getenv("MINIO_ENDPOINT"); minioEndpoint != "" || requireReal {
		if minioEndpoint == "" {
			minioEndpoint = "localhost:9000"
		}
		accessKey, secretKey := os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_SECRET_KEY")
		if accessKey == "" {
			accessKey = "datacern"
		}
		if secretKey == "" {
			secretKey = "datacern_dev"
		}
		osClient, err := objectstore.New(ctx, objectstore.Config{
			Endpoint: minioEndpoint, AccessKey: accessKey, SecretKey: secretKey,
			UseSSL: os.Getenv("MINIO_USE_SSL") == "true", Bucket: envOr("POC_EXPORT_BUCKET", "datacern-poc-reports"),
		})
		if err != nil {
			if requireReal {
				log.Error("poc report export store init failed", "error", err)
				os.Exit(1)
			}
			log.Warn("poc report export store unavailable — poc report export will fail loud", "error", err)
		} else {
			poc.Exports = pocexport.NewS3Store(osClient)
			log.Info("poc report export store: minio")
		}
	} else {
		pocExportSecret := []byte(os.Getenv("POC_EXPORT_SIGNING_SECRET"))
		if len(pocExportSecret) == 0 {
			pocExportSecret = []byte(uuid.NewString())
			log.Warn("POC_EXPORT_SIGNING_SECRET unset; generated ephemeral secret (poc report download links break on restart)")
		}
		poc.Exports = pocexport.NewFSStore(
			envOr("POC_EXPORT_ROOT", "/var/lib/identity-service/poc-reports"),
			envOr("PUBLIC_URL", "http://localhost:8080"),
			pocExportSecret,
		)
		log.Warn("poc report export store: local filesystem (set MINIO_ENDPOINT for multi-replica deploys)")
	}

	// BYO-P4 per-tenant IdP: build an OIDC provider from a tenant's stored config
	// (tenant_idp_configs). Injected so the domain layer stays free of the OIDC
	// adapter; the token service caches the built provider per tenant.
	tokens.IdpBuild = func(c domain.TenantIdpConfig) domain.IdentityProvider {
		return oidc.New(oidc.Config{
			Issuer:       c.Issuer,
			ClientID:     c.ClientID,
			DiscoveryURL: c.DiscoveryURL,
		})
	}

	// BYO-P4 real OIDC login: enable POST /token/oidc when a generic OIDC IdP is
	// configured (deployment-level; Keycloak/Okta/Auth0/Entra are all just a
	// different OIDC_ISSUER). Off by default — the dev/persona login path is
	// untouched. Per-tenant IdP config (above) routes by the token's issuer;
	// this env path is the legacy single-IdP fallback.
	if iss := os.Getenv("OIDC_ISSUER"); iss != "" {
		if tid, err := uuid.Parse(os.Getenv("OIDC_TENANT_ID")); err == nil {
			tokens.IDP = oidc.New(oidc.Config{
				Issuer:       iss,
				ClientID:     os.Getenv("OIDC_CLIENT_ID"),
				DiscoveryURL: os.Getenv("OIDC_DISCOVERY_URL"),
			})
			tokens.OIDCTenantID = tid
			log.Info("oidc login enabled", "issuer", iss, "client_id", os.Getenv("OIDC_CLIENT_ID"), "tenant", tid.String())
		} else {
			log.Warn("OIDC_ISSUER set but OIDC_TENANT_ID missing/invalid — oidc login disabled", "err", err)
		}
	}

	trusted := map[string]bool{}
	for _, id := range strings.Split(os.Getenv("TRUSTED_SPIFFE_IDS"), ",") {
		if id = strings.TrimSpace(id); id != "" {
			trusted[id] = true
		}
	}
	if len(trusted) == 0 {
		trusted["spiffe://datacern.ai/ns/platform/sa/agent-runtime"] = true
	}

	// Runtime authorizer: the REAL OPA-over-projection path (MASTER-FR-012),
	// like every other Go service — a tenant Admin's rbac projection admin flag
	// (BR-7) authorizes identity's guarded actions without the scope being baked
	// into the token. ScopeAuthorizer remains only as the dev/test fallback when
	// no OPA sidecar is configured.
	var authorizer authz.Authorizer = authz.ScopeAuthorizer{}
	if opaURL := os.Getenv("OPA_URL"); opaURL != "" {
		authorizer = authz.NewOPAAuthorizer(opaURL, os.Getenv("REDIS_ADDR"))
		log.Info("authorizer: OPA over rbac projection", "opa", opaURL)
		// Make identity's guarded actions catalog-known in rbac (fail-loud via
		// logs; retries because identity boots before rbac). Without this the
		// OPA admin short-circuit denies them with reason "unknown_action".
		if rbacURL != "" {
			reg := &rbacclient.Registrar{BaseURL: rbacURL, Issuer: issuer, Log: log}
			go reg.Run(ctx)
		} else {
			log.Warn("authorizer: OPA enabled but RBAC_URL unset — cannot register identity's guarded actions; they may deny as unknown_action")
		}
	} else {
		if requireReal {
			mustReal("OPA_URL", "token-scope authorizer fallback (does not honor rbac projection grants)")
		}
		log.Warn("authorizer: token-scope fallback (set OPA_URL for the real rbac-projection path; scope-based authz does NOT honor a tenant Admin's projection grant)")
	}

	// BRD 70 v1.1: self-serve demo signup abuse-prevention knobs (task
	// requirement #1/#2 -- rate limits + concurrency cap, both env-
	// overridable, both defaulting to domain's own conservative constants
	// so a deployment that never sets these env vars is still protected).
	publicDemoIPLimiter := domain.NewSlidingWindowLimiter(
		envInt("PUBLIC_DEMO_SIGNUP_IP_LIMIT", domain.DefaultSelfServeIPLimit),
		envMinutes("PUBLIC_DEMO_SIGNUP_IP_WINDOW_MINUTES", domain.DefaultSelfServeIPWindow))
	publicDemoDomainLimiter := domain.NewSlidingWindowLimiter(
		envInt("PUBLIC_DEMO_SIGNUP_DOMAIN_LIMIT", domain.DefaultSelfServeDomainLimit),
		envMinutes("PUBLIC_DEMO_SIGNUP_DOMAIN_WINDOW_MINUTES", domain.DefaultSelfServeDomainWindow))
	publicDemoCap := envInt("PUBLIC_DEMO_SIGNUP_CAP", domain.DefaultSelfServeDemoCap)
	publicDemoPack := os.Getenv("PUBLIC_DEMO_SIGNUP_PACK")
	if publicDemoPack == "" {
		publicDemoPack = domain.DefaultSelfServeDemoPack
	}

	srv := &api.Server{
		Store: store, Tenants: tenants, Users: users, SAs: sas, Tokens: tokens,
		KM: km, Verifier: issuer, Authz: authorizer,
		Plans: plans, Commercial: commercial, Demo: demo, Trials: trials,
		Poc: poc, PocExports: poc.Exports,
		TrustedSpiffeIDs: trusted,
		// F-2: only honor X-Spiffe-Id when explicitly enabled (mesh strips +
		// re-injects it). TRUST_SPIFFE_HEADER=true to enable.
		TrustSpiffeHeader: os.Getenv("TRUST_SPIFFE_HEADER") == "true",
		Clock:             clock, Log: log, Ready: ready,
		PublicDemoIPLimiter: publicDemoIPLimiter, PublicDemoDomainLimiter: publicDemoDomainLimiter,
		PublicDemoSelfServeCap: publicDemoCap, PublicDemoPack: publicDemoPack,
		Logo: logoStore,
	}

	// Background loops.
	// Event publishing: real Kafka producer (Redpanda) via libs/go-common,
	// draining the transactional outbox (MASTER-FR-030/034). KAFKA_BROKERS
	// defaults to the local Redpanda so the runtime path has no log stub.
	var publisher events.Publisher
	kafkaBrokers := os.Getenv("KAFKA_BROKERS")
	if requireReal && (kafkaBrokers == "" || kafkaBrokers == "false") {
		mustReal("KAFKA_BROKERS", "log-only/localhost publisher (outbox events would not reach Kafka)")
	}
	if brokers := kafkaBrokers; brokers != "false" {
		if brokers == "" {
			brokers = "localhost:9092"
		}
		kp := events.NewKafkaPublisher(ctx, strings.Split(brokers, ","), os.Getenv("SCHEMA_REGISTRY_URL"))
		defer func() { _ = kp.Close() }()
		publisher = kp
		log.Info("publisher: kafka", "brokers", brokers)
	} else {
		publisher = &events.LogPublisher{Log: log} // KAFKA_BROKERS=false: log-only (local dev without a broker)
		log.Warn("publisher: log-only (KAFKA_BROKERS=false)")
	}
	poller := &events.Poller{Store: store, Publisher: publisher, Interval: 2 * time.Second, BatchSize: 100, Log: log}
	go poller.Run(ctx)

	// entitlements_flat projection worker (BRD 66 slice 1, CPL-FR-011):
	// mirrors rbac-service's permissions_flat discipline (outbox/dirty-queue
	// -driven recompute, ent.invalidate pub/sub). Slice 1 ships this dark --
	// no consumer reads it synchronously yet (that's slice 3's enforcement
	// hooks) -- so an unset REDIS_ADDR just leaves the projection uncomputed
	// rather than blocking boot; identity-service's own
	// GET /tenants/{id}/entitlements reads live from Postgres, not this cache.
	if redisAddr := os.Getenv("REDIS_ADDR"); redisAddr != "" {
		projRDB := redisx.NewFromEnv(redisAddr, os.Getenv)
		loader := projection.StoreLoader{Store: store, Commercial: commercial, Now: clock}
		writer := projection.NewRedisWriter(projRDB.R, projection.DefaultTTL)
		worker := projection.NewWorker("identity-"+uuid.NewString(), loader, writer)
		worker.Log = log
		go worker.Run(ctx)
		log.Info("commercial projection worker: redis", "addr", redisAddr)

		// BRD 66 slice 2 (CPL-FR-031): identity-service's own invite-path
		// seat_cap gate reads entitlements_flat directly (CPL-NFR-001, no
		// synchronous call to this service's own HTTP API) via the same Redis
		// connection as the projection worker above. Unlike the worker itself
		// (which is allowed to ship "dark" -- nothing reads it yet in slice
		// 1), this IS a live enforcement point, so an unset REDIS_ADDR in
		// strict/production mode fails closed at boot (mustReal) rather than
		// silently shipping an unenforced cap.
		users.Entitlements = domain.EntitlementReaderFunc(
			func(rctx context.Context, tenantID uuid.UUID) (domain.EffectiveSet, bool, error) {
				return projection.ReadSet(rctx, projRDB.R, tenantID.String())
			})
	} else {
		if requireReal {
			mustReal("REDIS_ADDR", "seat_cap invite enforcement (CPL-FR-031) has no entitlements_flat to read")
		}
		log.Warn("commercial projection worker: disabled (set REDIS_ADDR) — entitlements_flat will not be populated")
		log.Warn("seat_cap invite enforcement: disabled (set REDIS_ADDR) — invites will not be capped")
	}

	// BRD 70 §2.5 (DSP-FR-013): the demo-tenant TTL reaper. Real leader
	// election over Redis when REDIS_ADDR is set (leaderlease.Lease mirrors
	// realtime-hub's proven SET-NX-PX + Lua-CAS pattern, RTH-FR-042);
	// without it, Reaper.Lease stays nil ("always leader") -- correct for
	// single-replica dev/tests but NOT leader-elected for real multi-replica
	// safety, so this is loud-warned exactly like the other REDIS_ADDR-gated
	// adapters above rather than silently degrading.
	reaper := &domain.DemoReaper{Store: store, Tenants: tenants, Engine: engine, Clock: clock}
	if redisAddr := os.Getenv("REDIS_ADDR"); redisAddr != "" {
		lease := leaderlease.NewLease(redisx.NewFromEnv(redisAddr, os.Getenv).R,
			"demo-reaper", "identity-"+uuid.NewString(), 15*time.Second)
		go lease.Run(ctx)
		reaper.Lease = lease
		log.Info("demo TTL reaper: leader-elected (redis)", "addr", redisAddr)
	} else {
		if requireReal {
			mustReal("REDIS_ADDR", "single-replica demo TTL reaper (not leader-elected; a second replica could double-reap)")
		}
		log.Warn("demo TTL reaper: single-replica (set REDIS_ADDR for real leader election across replicas)")
	}
	go func() { // demo-tenant TTL sweep (DSP-FR-013): minute-or-coarser per §2.5
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if n, err := reaper.Sweep(ctx); err != nil {
					log.Error("demo TTL reaper sweep failed", "error", err)
				} else if n > 0 {
					log.Info("demo TTL reaper: tenants reaped", "count", n)
				}
			}
		}
	}()

	// BRD 66 slice 2 (CPL-FR-022, design doc "Trial sweep job"): the
	// leader-elected trial-expiry + T-14/T-7/T-1 threshold-event sweep.
	// Copies the demo reaper's exact leaderlease.NewLease wiring above, but
	// with the design's own literal parameters: resource "commercial:
	// trial-sweep", 5s TTL (renewed at half-TTL = 2.5s by Lease.Run, matching
	// "5s TTL, 2.5s renew" verbatim) rather than the reaper's coarser 15s.
	sweep := &domain.TrialSweep{Store: store, Clock: clock, Log: log}
	if redisAddr := os.Getenv("REDIS_ADDR"); redisAddr != "" {
		trialLease := leaderlease.NewLease(redisx.NewFromEnv(redisAddr, os.Getenv).R,
			"commercial:trial-sweep", "identity-"+uuid.NewString(), 5*time.Second)
		go trialLease.Run(ctx)
		sweep.Lease = trialLease
		log.Info("trial sweep: leader-elected (redis)", "addr", redisAddr)
	} else {
		if requireReal {
			mustReal("REDIS_ADDR", "single-replica trial sweep (not leader-elected; a second replica could double-transition/double-emit)")
		}
		log.Warn("trial sweep: single-replica (set REDIS_ADDR for real leader election across replicas)")
	}
	go func() { // 1-minute ticker: tight enough that CPL-NFR-003's "exactly-once
		// per tenant/day" holds even with the ≤60s projection staleness budget
		// elsewhere (design doc "Trial sweep job").
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if expired, ending, err := sweep.SweepOnce(ctx); err != nil {
					log.Error("trial sweep failed", "error", err)
				} else if expired > 0 || ending > 0 {
					log.Info("trial sweep: tick complete", "expired", expired, "threshold_events", ending)
				}
			}
		}
	}()

	// IDN-FR-008b's grace-period deletion sweep (RunScheduledDeletions).
	// Already drives every tenant through the same real deprovision saga
	// (Engine.Deprovision) DemoReaper and TenantService.Delete's force path
	// use -- there is one teardown implementation, not a divergent one. Until
	// now this was the one sweep in the service still a plain, non-leader-
	// elected ticker (docs/initiatives/demo-sandbox-poc-mode.md §3 "Honest
	// gaps"); wire the same leaderlease.Lease pattern as the demo reaper and
	// trial sweep above, under its own resource key so the three sweeps hold
	// independent leases (any one of them may be led by a different replica).
	if redisAddr := os.Getenv("REDIS_ADDR"); redisAddr != "" {
		delLease := leaderlease.NewLease(redisx.NewFromEnv(redisAddr, os.Getenv).R,
			"tenant-scheduled-deletions", "identity-"+uuid.NewString(), 15*time.Second)
		go delLease.Run(ctx)
		tenants.Lease = delLease
		log.Info("scheduled-deletion sweep: leader-elected (redis)", "addr", redisAddr)
	} else {
		if requireReal {
			mustReal("REDIS_ADDR", "single-replica scheduled-deletion sweep (not leader-elected; a second replica could double-deprovision)")
		}
		log.Warn("scheduled-deletion sweep: single-replica (set REDIS_ADDR for real leader election across replicas)")
	}

	go func() { // key-cache refresh so retirements take effect (AC-8)
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = km.RetireDueKeys(ctx)
				_ = tenants.RunScheduledDeletions(ctx)
			}
		}
	}()

	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	httpSrv := &http.Server{Addr: addr, Handler: otelx.WrapHandler(srv.Router(), "identity-service"), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shCtx)
	}()
	log.Info("identity-service listening", "addr", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server error", "error", err)
		os.Exit(1)
	}
}

// envOr returns the env var if set (even to a non-empty override), else def.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// buildSigner selects the keys.Signer backend via SECRETS_BACKEND=
// vault|aws|azure|gcp (BYO Infra Hardening Phase 2,
// docs/design/byo-infra-hardening.md). Default "vault" preserves the original
// VAULT_ADDR-gated LocalSigner-fallback behavior unchanged when the env var
// is unset — no regression to existing deployments.
func buildSigner(ctx context.Context, log *slog.Logger) (keys.Signer, string, error) {
	backend := strings.ToLower(os.Getenv("SECRETS_BACKEND"))
	if backend == "" {
		backend = "vault"
	}
	switch backend {
	case "vault":
		if vaultAddr := os.Getenv("VAULT_ADDR"); vaultAddr != "" {
			vs, err := vault.New(vaultAddr, os.Getenv("VAULT_TOKEN"), os.Getenv("VAULT_TRANSIT_MOUNT"))
			if err != nil {
				return nil, "", err
			}
			return vs, "vault transit", nil
		}
		log.Warn("signer: local RSA (set VAULT_ADDR for Vault transit, or SECRETS_BACKEND=aws|azure|gcp)")
		return keys.NewLocalSigner(), "local RSA (dev)", nil
	case "aws":
		cfg := awskms.Config{
			Region:          os.Getenv("AWS_REGION"),
			EndpointURL:     os.Getenv("AWS_KMS_ENDPOINT_URL"),
			AccessKeyID:     os.Getenv("AWS_ACCESS_KEY_ID"),
			SecretAccessKey: os.Getenv("AWS_SECRET_ACCESS_KEY"),
		}
		s, err := awskms.New(ctx, cfg)
		if err != nil {
			return nil, "", err
		}
		return s, "aws kms", nil
	case "azure":
		vaultURL := os.Getenv("AZURE_KEY_VAULT_URL")
		if vaultURL == "" {
			return nil, "", errors.New("SECRETS_BACKEND=azure requires AZURE_KEY_VAULT_URL")
		}
		s, err := azurekeyvault.New(vaultURL, nil, nil)
		if err != nil {
			return nil, "", err
		}
		return s, "azure key vault", nil
	case "gcp":
		keyRing := os.Getenv("GCP_KMS_KEY_RING")
		if keyRing == "" {
			return nil, "", errors.New("SECRETS_BACKEND=gcp requires GCP_KMS_KEY_RING (projects/*/locations/*/keyRings/*)")
		}
		s, err := gcpkms.New(ctx, keyRing)
		if err != nil {
			return nil, "", err
		}
		return s, "gcp cloud kms", nil
	default:
		return nil, "", fmt.Errorf("unknown SECRETS_BACKEND: %q", backend)
	}
}
