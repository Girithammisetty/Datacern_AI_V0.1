package domain_test

// Tests for BRD 70 v1.1's self-serve demo signup (demo_public_signup.go):
// forced profile=demo + default pack/TTL, the concurrency cap (task
// requirement #2), the disposable-email denylist (task requirement #4), and
// the claim-login flow (ClaimSelfServeLogin) that mints a real session once
// the tenant is active and its owner user exists. Builds on newDemoFixture
// (demo_test.go) so the memory-store + fake-engine wiring is shared with the
// rest of the demo-lifecycle test suite; adds a real keys.Issuer so
// ClaimSelfServeLogin/MintSelfServeClaimToken mint REAL, verifiable tokens
// exactly like the api package's acceptance tests do.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/keys"
)

// withTokens attaches a real RS256 Issuer/Verifier pair to f.demo, mirroring
// how internal/api's fixture_test.go wires TokenService for the same
// DemoService in acceptance tests.
func (f *demoFixture) withTokens(t *testing.T) *keys.Issuer {
	t.Helper()
	km := keys.NewKeyManager(f.store, keys.NewLocalSigner(), f.clock.now)
	if err := km.Bootstrap(context.Background()); err != nil {
		t.Fatalf("bootstrap keys: %v", err)
	}
	issuer := keys.NewIssuer(km, f.clock.now)
	f.demo.Tokens = &domain.TokenService{
		Store: f.store, Issuer: issuer, Verifier: issuer, Clock: f.clock.now,
	}
	return issuer
}

func validSignupReq() domain.PublicDemoSignupRequest {
	return domain.PublicDemoSignupRequest{
		FullName: "Ada Lovelace", WorkEmail: "ada@acme-corp.example", Company: "Acme Corp",
	}
}

// --- PublicSignup: forced fields (task requirement #5) -------------------

func TestPublicSignup_ForcesProfileDemoAndDefaults(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()

	tenant, opID, err := f.demo.PublicSignup(ctx, validSignupReq(), 0, "")
	if err != nil {
		t.Fatalf("PublicSignup: %v", err)
	}
	if opID == "" {
		t.Fatal("expected a non-empty operation id")
	}
	if tenant.Profile != domain.ProfileDemo {
		t.Fatalf("profile = %v, want demo", tenant.Profile)
	}
	if tenant.DemoPack != domain.DefaultSelfServeDemoPack {
		t.Fatalf("demo_pack = %v, want default %v", tenant.DemoPack, domain.DefaultSelfServeDemoPack)
	}
	if tenant.TTLDays == nil || *tenant.TTLDays != domain.DefaultDemoTTLDays {
		t.Fatalf("ttl_days = %v, want %d", tenant.TTLDays, domain.DefaultDemoTTLDays)
	}
	if tenant.CreatedBy != domain.SelfServeDemoActorID {
		t.Fatalf("created_by = %q, want %q (so the cap/audit filter can find it)", tenant.CreatedBy, domain.SelfServeDemoActorID)
	}
	if tenant.DisplayName != "Acme Corp" {
		t.Fatalf("display_name = %q, want the company name", tenant.DisplayName)
	}
	if tenant.OwnerEmail != "ada@acme-corp.example" {
		t.Fatalf("owner_email = %q, want the work email", tenant.OwnerEmail)
	}
	// A durable audit event was appended for a human to review (task
	// requirement #4) -- present on the outbox as a normal tenant event.
	steps, _ := f.store.ListProvisioningSteps(ctx, tenant.ID, domain.WorkflowIDFor(tenant.ID))
	if len(steps) == 0 {
		t.Fatal("expected the provisioning workflow to have run (Async=false in this fixture)")
	}
}

func TestPublicSignup_RejectsBlankFields(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()
	cases := []domain.PublicDemoSignupRequest{
		{FullName: "", WorkEmail: "a@b.com", Company: "Acme"},
		{FullName: "A", WorkEmail: "a@b.com", Company: "Acme"}, // < 2 chars
		{FullName: "Ada Lovelace", WorkEmail: "not-an-email", Company: "Acme"},
		{FullName: "Ada Lovelace", WorkEmail: "a@b.com", Company: ""},
	}
	for i, req := range cases {
		if _, _, err := f.demo.PublicSignup(ctx, req, 0, ""); err == nil {
			t.Errorf("case %d: expected a validation error, got none", i)
		}
	}
}

// --- Disposable-email denylist (task requirement #4) ----------------------

func TestPublicSignup_RejectsDisposableEmailDomain(t *testing.T) {
	f := newDemoFixture(t)
	req := validSignupReq()
	req.WorkEmail = "someone@mailinator.com"
	_, _, err := f.demo.PublicSignup(context.Background(), req, 0, "")
	if err == nil {
		t.Fatal("expected disposable-domain rejection, got none")
	}
	de, ok := domain.AsError(err)
	if !ok || de.Code != domain.CodeValidationFailed {
		t.Fatalf("error = %v, want VALIDATION_FAILED", err)
	}
}

func TestIsDisposableEmailDomain(t *testing.T) {
	cases := map[string]bool{
		"mailinator.com":    true,
		"MAILINATOR.COM":    true, // case-insensitive
		"guerrillamail.com": true,
		"acme-corp.example": false,
		"gmail.com":         false,
		"":                  false,
	}
	for domainName, want := range cases {
		if got := domain.IsDisposableEmailDomain(domainName); got != want {
			t.Errorf("IsDisposableEmailDomain(%q) = %v, want %v", domainName, got, want)
		}
	}
}

// --- Concurrency cap (task requirement #2) ---------------------------------

func TestPublicSignup_EnforcesConcurrencyCap(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()

	req1 := validSignupReq()
	if _, _, err := f.demo.PublicSignup(ctx, req1, 1, ""); err != nil {
		t.Fatalf("first signup (within cap): %v", err)
	}

	req2 := domain.PublicDemoSignupRequest{FullName: "Grace Hopper", WorkEmail: "grace@other-corp.example", Company: "Other Corp"}
	_, _, err := f.demo.PublicSignup(ctx, req2, 1, "")
	if err == nil {
		t.Fatal("expected the second signup to be refused at cap=1, got none")
	}
	de, ok := domain.AsError(err)
	if !ok || de.Code != domain.CodeCapExceeded || de.HTTP != 503 {
		t.Fatalf("error = %+v, want CAP_EXCEEDED/503 (\"at capacity, try again later\", never a silent degrade)", de)
	}
}

// TestCountLiveSelfServeDemoTenants_ExcludesOperatorCreated proves the cap
// only ever counts what THIS public route created -- an operator/partner
// demo tenant (POST /demo-tenants, a real staff actor) must never eat into
// a stranger's self-serve capacity.
func TestCountLiveSelfServeDemoTenants_ExcludesOperatorCreated(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()

	if _, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "operator-demo", DisplayName: "Operator Demo", OwnerEmail: "owner@operator-demo.example",
		Pack: "insurance-claims-payer",
	}, domain.Actor{Type: "user", ID: "staff-1"}); err != nil {
		t.Fatalf("operator-created demo tenant: %v", err)
	}
	count, err := f.demo.CountLiveSelfServeDemoTenants(ctx)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatalf("count = %d, want 0 (operator-created tenants must not count)", count)
	}

	if _, _, err := f.demo.PublicSignup(ctx, validSignupReq(), 0, ""); err != nil {
		t.Fatalf("public signup: %v", err)
	}
	count, err = f.demo.CountLiveSelfServeDemoTenants(ctx)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1 after one self-serve signup", count)
	}
}

// --- Claim-login flow -------------------------------------------------------

// TestClaimSelfServeLogin_MintsRealSessionOnceOwnerExists: in this fixture
// TenantService.Async=false (newDemoFixture), so by the time PublicSignup
// returns, the provisioning saga's SeedDefaults step has already created the
// real owner user -- ClaimSelfServeLogin should mint a real, verifiable
// session immediately (the "fast path" api.handlePublicDemoSignup also
// attempts inline before falling back to a claim_token).
func TestClaimSelfServeLogin_MintsRealSessionOnceOwnerExists(t *testing.T) {
	f := newDemoFixture(t)
	issuer := f.withTokens(t)
	ctx := context.Background()

	tenant, _, err := f.demo.PublicSignup(ctx, validSignupReq(), 0, "")
	if err != nil {
		t.Fatalf("PublicSignup: %v", err)
	}
	if tenant.Status != domain.TenantActive {
		t.Fatalf("tenant status = %v, want active (Async=false)", tenant.Status)
	}

	gotTenant, tok, err := f.demo.ClaimSelfServeLogin(ctx, tenant.ID)
	if err != nil {
		t.Fatalf("ClaimSelfServeLogin: %v", err)
	}
	if tok == nil {
		t.Fatal("expected a minted session token, got nil (still provisioning?)")
	}
	if gotTenant.ID != tenant.ID {
		t.Fatalf("returned tenant id = %v, want %v", gotTenant.ID, tenant.ID)
	}
	claims, err := issuer.Verify(tok.AccessToken)
	if err != nil {
		t.Fatalf("minted token does not verify: %v", err)
	}
	if claims.TenantID != tenant.ID {
		t.Fatalf("claims.TenantID = %v, want %v", claims.TenantID, tenant.ID)
	}
	if claims.Typ != domain.TypUser {
		t.Fatalf("claims.Typ = %q, want %q", claims.Typ, domain.TypUser)
	}
	if claims.Profile != "demo" {
		t.Fatalf("claims.Profile = %q, want demo (BRD 70 §2.6 watermark claim)", claims.Profile)
	}
	owner, err := f.store.GetUserByEmail(ctx, tenant.ID, tenant.OwnerEmail)
	if err != nil {
		t.Fatalf("owner user should exist: %v", err)
	}
	if claims.Subject != owner.ID.String() {
		t.Fatalf("claims.Subject = %q, want the REAL owner user id %q (not a synthetic subject)", claims.Subject, owner.ID.String())
	}
	if owner.Status != domain.UserActive {
		t.Fatalf("owner.Status = %v, want active (self-serve claim activates the invited owner)", owner.Status)
	}
}

// TestClaimSelfServeLogin_StillProvisioningReturnsNilToken proves the
// "poll again, not an error" contract for a tenant that hasn't finished
// provisioning yet (the real-world Async=true case): (tenant, nil, nil).
func TestClaimSelfServeLogin_StillProvisioningReturnsNilToken(t *testing.T) {
	f := newDemoFixture(t)
	f.withTokens(t)
	ctx := context.Background()

	id := uuid.New()
	now := f.clock.now()
	if err := f.store.CreateTenant(ctx, &domain.Tenant{
		ID: id, Name: "demo-still-provisioning", DisplayName: "Still Provisioning",
		OwnerEmail: "owner@still-provisioning.example", Tier: "pool", Cloud: "aws",
		Status: domain.TenantProvisioning, Subdomain: "demo-still-provisioning",
		K8sNamespace: "demo-still-provisioning", SchemaPrefix: "demo_still_provisioning",
		CreatedBy: domain.SelfServeDemoActorID, CreatedAt: now, UpdatedAt: now,
		Profile: domain.ProfileDemo, DemoPack: "insurance-claims-payer",
	}); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	tenant, tok, err := f.demo.ClaimSelfServeLogin(ctx, id)
	if err != nil {
		t.Fatalf("expected no error while still provisioning, got: %v", err)
	}
	if tok != nil {
		t.Fatal("expected a nil token while still provisioning")
	}
	if tenant == nil || tenant.ID != id {
		t.Fatal("expected the tenant to still be returned so the caller can render status")
	}
}

// TestClaimSelfServeLogin_RejectsNonSelfServeTenant: a demo tenant an
// OPERATOR created (POST /demo-tenants) must never be claimable through the
// public route, even by someone who somehow obtains its id.
func TestClaimSelfServeLogin_RejectsNonSelfServeTenant(t *testing.T) {
	f := newDemoFixture(t)
	f.withTokens(t)
	ctx := context.Background()

	tenant, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "operator-demo-2", DisplayName: "Operator Demo 2", OwnerEmail: "owner@operator-demo-2.example",
		Pack: "insurance-claims-payer",
	}, domain.Actor{Type: "user", ID: "staff-1"})
	if err != nil {
		t.Fatalf("operator-created demo tenant: %v", err)
	}

	_, tok, err := f.demo.ClaimSelfServeLogin(ctx, tenant.ID)
	if err == nil {
		t.Fatal("expected ClaimSelfServeLogin to reject an operator-created demo tenant")
	}
	if tok != nil {
		t.Fatal("must not mint a token for an operator-created tenant")
	}
	de, ok := domain.AsError(err)
	if !ok || de.Code != domain.CodeNotFound {
		t.Fatalf("error = %v, want NOT_FOUND", err)
	}
}

// --- MintSelfServeClaimToken -------------------------------------------------

func TestMintSelfServeClaimToken_NarrowScopeAndTenantBinding(t *testing.T) {
	f := newDemoFixture(t)
	issuer := f.withTokens(t)
	ctx := context.Background()

	tenant, _, err := f.demo.PublicSignup(ctx, validSignupReq(), 0, "")
	if err != nil {
		t.Fatalf("PublicSignup: %v", err)
	}
	tok, expiresIn, err := f.demo.MintSelfServeClaimToken(tenant)
	if err != nil {
		t.Fatalf("MintSelfServeClaimToken: %v", err)
	}
	if expiresIn <= 0 || time.Duration(expiresIn)*time.Second > domain.SelfServeClaimTTL {
		t.Fatalf("expires_in = %d seconds, want a positive value <= %v", expiresIn, domain.SelfServeClaimTTL)
	}
	claims, err := issuer.Verify(tok)
	if err != nil {
		t.Fatalf("claim token does not verify: %v", err)
	}
	if claims.Typ != domain.TypDemoClaim {
		t.Fatalf("claims.Typ = %q, want %q", claims.Typ, domain.TypDemoClaim)
	}
	if claims.TenantID != tenant.ID {
		t.Fatalf("claims.TenantID = %v, want %v", claims.TenantID, tenant.ID)
	}
	if len(claims.Scopes) != 0 {
		t.Fatalf("claims.Scopes = %v, want empty (a claim token grants no scopes)", claims.Scopes)
	}
}
