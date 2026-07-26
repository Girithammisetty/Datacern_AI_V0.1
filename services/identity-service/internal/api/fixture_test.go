package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/adapters/denylist"
	"github.com/datacern-ai/identity-service/internal/adapters/keycloak"
	"github.com/datacern-ai/identity-service/internal/adapters/terraform"
	"github.com/datacern-ai/identity-service/internal/api"
	"github.com/datacern-ai/identity-service/internal/authz"
	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/keys"
	"github.com/datacern-ai/identity-service/internal/store/memory"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

const testSpiffeAgentRuntime = "spiffe://datacern.ai/ns/platform/sa/agent-runtime"

// fakeDemoBundleLoader/fakeDemoSeedRunner back BRD 70's SeedDemoContent step
// + DemoService in acceptance tests, mirroring internal/domain's own unit
// fakes (demo_test.go) but local to this package (api_test can't import an
// internal test file from another package).
type fakeDemoBundleLoader struct{ calls int }

func (f *fakeDemoBundleLoader) Load(pack string) (*domain.DemoBundle, error) {
	f.calls++
	return &domain.DemoBundle{Pack: pack, Version: "1.0.0", Provenance: "synthetic"}, nil
}

type fakeDemoSeedRunner struct{ calls int }

func (f *fakeDemoSeedRunner) Seed(_ context.Context, _ *domain.Tenant, _ *domain.DemoBundle) error {
	f.calls++
	return nil
}

type fixture struct {
	t      *testing.T
	store  *memory.Store
	clock  *fakeClock
	km     *keys.KeyManager
	issuer *keys.Issuer
	kc     *keycloak.Fake
	tf     *terraform.Fake
	db     *terraform.FakeDBProvisioner
	prober *terraform.FakeProber
	deny   *denylist.Memory
	engine *domain.Engine
	tokens *domain.TokenService
	tenSvc *domain.TenantService
	srv    *api.Server
	ts     *httptest.Server
	cellID uuid.UUID
}

func (f *fixture) tenants() *domain.TenantService { return f.tenSvc }

func newFixture(t *testing.T) *fixture { return newFixtureOpt(t, true) }

// newFixtureOpt builds a fixture; trustSpiffe toggles Server.TrustSpiffeHeader
// (F-2). Production default is false; most tests use true so the SPIFFE-gated
// agent-token path is exercisable.
func newFixtureOpt(t *testing.T, trustSpiffe bool) *fixture {
	t.Helper()
	f := &fixture{
		t: t, store: memory.New(), clock: &fakeClock{t: time.Now().UTC()},
		kc: keycloak.NewFake(), tf: terraform.NewFake(), db: terraform.NewFakeDB(),
		prober: &terraform.FakeProber{}, deny: denylist.NewMemory(),
	}
	f.km = keys.NewKeyManager(f.store, keys.NewLocalSigner(), f.clock.Now)
	if err := f.km.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.issuer = keys.NewIssuer(f.km, f.clock.Now)

	demoLoader := &fakeDemoBundleLoader{}
	demoSeed := &fakeDemoSeedRunner{}
	deps := domain.StepDeps{
		Store: f.store, Keycloak: f.kc, Terraform: f.tf, DB: f.db, Prober: f.prober, Clock: f.clock.Now,
		DemoBundles: demoLoader, DemoSeed: demoSeed,
	}
	cfg := domain.DefaultEngineConfig()
	cfg.Backoff = func(int) time.Duration { return 0 }
	cfg.Clock = f.clock.Now
	f.engine = domain.NewEngine(f.store, cfg, deps.ProvisionSteps, deps.DestroySteps, nil)

	tenants := &domain.TenantService{
		Store: f.store, Engine: f.engine, Graph: domain.DefaultModuleGraph(),
		Prober: f.prober, Clock: f.clock.Now, Async: false,
	}
	f.tenSvc = tenants
	users := &domain.UserService{Store: f.store, Keycloak: f.kc, LastAdmin: domain.AllowAllLastAdminChecker{}, Clock: f.clock.Now}
	sas := &domain.ServiceAccountService{Store: f.store, Denylist: f.deny, Clock: f.clock.Now}
	f.tokens = &domain.TokenService{
		Store: f.store, Issuer: f.issuer, Verifier: f.issuer, Denylist: f.deny,
		Limiter: domain.NewSlidingWindowLimiter(domain.OBORateLimit, domain.OBORateWindow),
		Clock:   f.clock.Now,
	}
	commercial := &domain.CommercialService{Store: f.store, Clock: f.clock.Now}
	f.srv = &api.Server{
		Store: f.store, Tenants: tenants, Users: users, SAs: sas, Tokens: f.tokens,
		KM: f.km, Verifier: f.issuer, Authz: authz.ScopeAuthorizer{},
		Plans:      &domain.PlanService{Store: f.store, Clock: f.clock.Now},
		Commercial: commercial,
		// BRD 66 slice 2: trial lifecycle (start/extend/convert).
		Trials: &domain.TrialService{Store: f.store, Clock: f.clock.Now},
		// BRD 70 slice 1/2: demo-sandbox lifecycle over the same fake
		// bundle-loader/seed-runner the provisioning saga's SeedDemoContent
		// step uses above.
		Demo: &domain.DemoService{
			Store: f.store, Tenants: tenants, Commercial: commercial,
			Bundles: demoLoader, Seed: demoSeed, Clock: f.clock.Now,
			// BRD 70 v1.1: self-serve claim-login mints through the SAME
			// fixture Issuer every other token in this test suite uses.
			Tokens: f.tokens,
		},
		// BRD 70 v1.1: generous defaults so ordinary acceptance tests never
		// trip the abuse-prevention limits by accident -- tests that
		// specifically exercise rate limiting / the concurrency cap
		// (handlers_public_demo_test.go) override these fields directly on
		// f.srv before making requests.
		PublicDemoIPLimiter:     domain.NewSlidingWindowLimiter(1000, time.Hour),
		PublicDemoDomainLimiter: domain.NewSlidingWindowLimiter(1000, 24*time.Hour),
		PublicDemoSelfServeCap:  domain.DefaultSelfServeDemoCap,
		TrustedSpiffeIDs:        map[string]bool{testSpiffeAgentRuntime: true},
		TrustSpiffeHeader:       trustSpiffe, // F-2
		Clock:                   f.clock.Now,
	}
	f.ts = httptest.NewServer(f.srv.Router())
	t.Cleanup(f.ts.Close)

	f.cellID, _ = uuid.NewV7()
	if err := f.store.CreateCell(context.Background(), &domain.Cell{
		ID: f.cellID, Name: "cell-aws-1", Cloud: "aws", Region: "us-east-1", Capacity: 100,
	}); err != nil {
		t.Fatal(err)
	}
	// BRD 66 migrations/0010 seeds the internal-demo plan in postgres;
	// the memory store used by tests needs it created explicitly so
	// DemoService.Create's forced-plan assignment (DSP-FR-001) resolves.
	if err := f.store.CreatePlan(context.Background(), &domain.Plan{
		Key: domain.DemoTenantPlanKey, Name: "Internal Demo", Status: "active", Version: 1,
		CreatedAt: f.clock.Now(), UpdatedAt: f.clock.Now(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	return f
}

// --- token helpers ---

func (f *fixture) mint(c domain.Claims) string {
	f.t.Helper()
	tok, _, err := f.issuer.Issue(c)
	if err != nil {
		f.t.Fatal(err)
	}
	return tok
}

func (f *fixture) superToken() string {
	return f.mint(domain.Claims{Subject: "staff-1", TenantID: uuid.Nil, Typ: domain.TypUser, Scopes: []string{"platform.admin"}})
}

func (f *fixture) adminToken(tenantID uuid.UUID) string {
	return f.mint(domain.Claims{
		Subject: uuid.NewString(), TenantID: tenantID, Typ: domain.TypUser,
		Scopes: []string{api.ActUserAdmin, api.ActSvcAcctAdmin, api.ActCredentialRead},
	})
}

func (f *fixture) userToken(u *domain.User) string {
	return f.mint(domain.Claims{Subject: u.ID.String(), TenantID: u.TenantID, Typ: domain.TypUser, Scopes: []string{}})
}

// --- HTTP helpers ---

type resp struct {
	status  int
	body    map[string]any
	raw     []byte
	headers http.Header
}

func (f *fixture) do(method, path, token string, body any, headers ...[2]string) resp {
	f.t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, f.ts.URL+path, rd)
	if err != nil {
		f.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	for _, h := range headers {
		req.Header.Set(h[0], h[1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{status: res.StatusCode, raw: raw, headers: res.Header}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out.body)
	}
	return out
}

func (r resp) errCode(t *testing.T) string {
	t.Helper()
	e, ok := r.body["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error envelope in body: %s", string(r.raw))
	}
	code, _ := e["code"].(string)
	if e["trace_id"] == "" {
		t.Error("error envelope missing trace_id")
	}
	return code
}

// createTenant creates (and optionally publishes+provisions) a tenant.
func (f *fixture) createTenant(name string, publish bool) resp {
	f.t.Helper()
	return f.do(http.MethodPost, "/api/v1/tenants", f.superToken(), map[string]any{
		"name": name, "owner_email": "owner@" + name + ".com", "tier": "pool", "cloud": "aws", "publish": publish,
	})
}

func (f *fixture) activeTenant(name string) *domain.Tenant {
	f.t.Helper()
	r := f.createTenant(name, true)
	if r.status != http.StatusAccepted {
		f.t.Fatalf("create tenant %s: status %d body %s", name, r.status, string(r.raw))
	}
	tn, err := f.store.GetTenantByName(context.Background(), name)
	if err != nil {
		f.t.Fatal(err)
	}
	if tn.Status != domain.TenantActive {
		f.t.Fatalf("tenant %s status %s, want active", name, tn.Status)
	}
	return tn
}

// activeUser invites + activates a user in a tenant.
func (f *fixture) activeUser(tn *domain.Tenant, email string) *domain.User {
	f.t.Helper()
	r := f.do(http.MethodPost, "/api/v1/users/invite", f.adminToken(tn.ID), map[string]any{"email": email})
	if r.status != http.StatusCreated {
		f.t.Fatalf("invite: %d %s", r.status, string(r.raw))
	}
	tok := f.lastActivationToken(email)
	r = f.do(http.MethodPost, "/api/v1/invitations/"+tok+"/accept", "", map[string]any{"idp_subject": "kc-" + email})
	if r.status != http.StatusOK {
		f.t.Fatalf("accept: %d %s", r.status, string(r.raw))
	}
	u, err := f.store.GetUserByEmail(context.Background(), tn.ID, email)
	if err != nil {
		f.t.Fatal(err)
	}
	return u
}

// lastActivationToken pulls the newest user.invited event token for an email.
func (f *fixture) lastActivationToken(email string) string {
	f.t.Helper()
	evs := f.store.EventsOfType(domain.EvUserInvited)
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].Payload["email"] == email {
			return evs[i].Payload["activation_token"].(string)
		}
	}
	f.t.Fatalf("no user.invited event for %s", email)
	return ""
}

// enableAgent seeds an agent principal via the registry event path (IDN-FR-040).
func (f *fixture) enableAgent(tn *domain.Tenant, agentID, version string, autonomous bool) {
	f.t.Helper()
	if err := f.tokens.ApplyAgentEvent(context.Background(), domain.AgentRegistryEvent{
		EventType: "agent_version.published", TenantID: tn.ID, AgentID: agentID, AgentVersion: version,
		Scopes: []string{"dataset.dataset.read"}, AutonomousAllowed: autonomous,
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) oboExchange(userTok, agentID, version string) resp {
	return f.do(http.MethodPost, "/api/v1/token/obo", "", map[string]any{
		"subject_token": userTok, "agent_id": agentID, "agent_version": version, "session_id": "s-1",
	})
}
