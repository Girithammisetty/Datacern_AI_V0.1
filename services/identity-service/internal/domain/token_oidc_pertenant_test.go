package domain_test

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/store/memory"
)

// mkIDToken builds a syntactically-valid JWT carrying just an `iss` claim, so
// OIDCLogin's unverified issuer peek can route it. Signature is not real — the
// stub IdP "verifies" it.
func mkIDToken(iss string) string {
	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	return b64(`{"alg":"RS256"}`) + "." + b64(`{"iss":"`+iss+`"}`) + ".sig"
}

// issuerStubIDP is an IdP whose Issuer() drives which identity it returns, so a
// single IdpBuild can stand in for many per-tenant providers.
type issuerStubIDP struct {
	issuer string
	ident  *domain.NormalizedIdentity
}

func (s issuerStubIDP) VerifyIDToken(_ context.Context, _ string) (*domain.NormalizedIdentity, error) {
	return s.ident, nil
}
func (s issuerStubIDP) Issuer() string { return s.issuer }

func TestOIDCLogin_RoutesByIssuerToTenant(t *testing.T) {
	ctx := context.Background()
	store := memory.New()

	// Two tenants, each with their OWN IdP + a user of the same email shape.
	tenantA, tenantB := uuid.New(), uuid.New()
	for _, tc := range []struct {
		id    uuid.UUID
		name  string
		iss   string
		email string
	}{
		{tenantA, "Acme Insurance", "https://a.okta.example", "adjuster@a.example"},
		{tenantB, "Globex Bank", "https://b.auth0.example", "adjuster@b.example"},
	} {
		if err := store.CreateTenant(ctx, &domain.Tenant{
			ID: tc.id, Name: tc.name, Subdomain: tc.name, K8sNamespace: tc.name,
			SchemaPrefix: tc.name, Status: domain.TenantActive,
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.CreateUser(ctx, &domain.User{ID: uuid.New(), TenantID: tc.id, Email: tc.email, Status: domain.UserActive}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertTenantIdpConfig(ctx, &domain.TenantIdpConfig{
			TenantID: tc.id, Issuer: tc.iss, ClientID: "datacern", Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	iss := &captureIssuer{}
	ident := map[string]*domain.NormalizedIdentity{
		"https://a.okta.example":  {Subject: "a-sub", Email: "adjuster@a.example"},
		"https://b.auth0.example": {Subject: "b-sub", Email: "adjuster@b.example"},
	}
	ts := &domain.TokenService{
		Store: store, Issuer: iss, Clock: func() time.Time { return time.Now().UTC() },
		IdpBuild: func(c domain.TenantIdpConfig) domain.IdentityProvider {
			return issuerStubIDP{issuer: c.Issuer, ident: ident[c.Issuer]}
		},
	}

	// Token from A's issuer mints a session scoped to tenant A.
	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://a.okta.example")}, "t"); err != nil {
		t.Fatalf("A login: %v", err)
	}
	if iss.last.TenantID != tenantA {
		t.Fatalf("expected tenant A %s, got %s", tenantA, iss.last.TenantID)
	}

	// Token from B's issuer routes to tenant B — same code path, different config.
	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://b.auth0.example")}, "t"); err != nil {
		t.Fatalf("B login: %v", err)
	}
	if iss.last.TenantID != tenantB {
		t.Fatalf("expected tenant B %s, got %s", tenantB, iss.last.TenantID)
	}
}

// TestOIDCLogin_CarriesDemoProfileClaim is BRD 70 §2.6's watermark-claim
// flow at the mint boundary: a profile=demo tenant's real login carries
// `profile: "demo"` (from Tenant.Profile, no extra DB round-trip -- the
// tenant record is already loaded to resolve the IdP), while a
// profile=standard tenant's login carries no profile claim at all (kept
// off the wire for the common case, see profileClaim in token.go).
func TestOIDCLogin_CarriesDemoProfileClaim(t *testing.T) {
	ctx := context.Background()
	store := memory.New()

	demoTenant, stdTenant := uuid.New(), uuid.New()
	for _, tc := range []struct {
		id      uuid.UUID
		name    string
		iss     string
		email   string
		profile domain.TenantProfile
	}{
		{demoTenant, "Acme Demo", "https://demo.okta.example", "se@demo.example", domain.ProfileDemo},
		{stdTenant, "Acme Prod", "https://prod.okta.example", "user@prod.example", domain.ProfileStandard},
	} {
		if err := store.CreateTenant(ctx, &domain.Tenant{
			ID: tc.id, Name: tc.name, Subdomain: tc.name, K8sNamespace: tc.name,
			SchemaPrefix: tc.name, Status: domain.TenantActive, Profile: tc.profile,
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.CreateUser(ctx, &domain.User{ID: uuid.New(), TenantID: tc.id, Email: tc.email, Status: domain.UserActive}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertTenantIdpConfig(ctx, &domain.TenantIdpConfig{
			TenantID: tc.id, Issuer: tc.iss, ClientID: "datacern", Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	iss := &captureIssuer{}
	ident := map[string]*domain.NormalizedIdentity{
		"https://demo.okta.example": {Subject: "demo-sub", Email: "se@demo.example"},
		"https://prod.okta.example": {Subject: "prod-sub", Email: "user@prod.example"},
	}
	ts := &domain.TokenService{
		Store: store, Issuer: iss, Clock: func() time.Time { return time.Now().UTC() },
		IdpBuild: func(c domain.TenantIdpConfig) domain.IdentityProvider {
			return issuerStubIDP{issuer: c.Issuer, ident: ident[c.Issuer]}
		},
	}

	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://demo.okta.example")}, "t"); err != nil {
		t.Fatalf("demo login: %v", err)
	}
	if iss.last.Profile != "demo" {
		t.Fatalf("demo tenant login profile claim = %q, want %q", iss.last.Profile, "demo")
	}

	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://prod.okta.example")}, "t"); err != nil {
		t.Fatalf("standard login: %v", err)
	}
	if iss.last.Profile != "" {
		t.Fatalf("standard tenant login profile claim = %q, want empty (kept off the wire)", iss.last.Profile)
	}
}

// TestOIDCLogin_CarriesCommercialStateClaim covers BRD 66 slice 2's
// commercial_state JWT claim (CPL-FR-022, design doc "Commercial-state claim
// + fail-open/fail-closed"): minted from the tenant row directly (mint
// already loads the tenant to resolve the IdP, so no extra lookup), and --
// unlike Profile -- always present on the wire, since CommercialNone
// ("none") is itself a meaningful non-empty value.
func TestOIDCLogin_CarriesCommercialStateClaim(t *testing.T) {
	ctx := context.Background()
	store := memory.New()

	trialTenant, noneTenant := uuid.New(), uuid.New()
	for _, tc := range []struct {
		id    uuid.UUID
		name  string
		iss   string
		email string
		state domain.CommercialState
	}{
		{trialTenant, "Acme Trial", "https://trial.okta.example", "se@trial.example", domain.CommercialTrial},
		{noneTenant, "Acme None", "https://none.okta.example", "user@none.example", domain.CommercialNone},
	} {
		if err := store.CreateTenant(ctx, &domain.Tenant{
			ID: tc.id, Name: tc.name, Subdomain: tc.name, K8sNamespace: tc.name,
			SchemaPrefix: tc.name, Status: domain.TenantActive, CommercialState: tc.state,
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.CreateUser(ctx, &domain.User{ID: uuid.New(), TenantID: tc.id, Email: tc.email, Status: domain.UserActive}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertTenantIdpConfig(ctx, &domain.TenantIdpConfig{
			TenantID: tc.id, Issuer: tc.iss, ClientID: "datacern", Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	iss := &captureIssuer{}
	ident := map[string]*domain.NormalizedIdentity{
		"https://trial.okta.example": {Subject: "trial-sub", Email: "se@trial.example"},
		"https://none.okta.example":  {Subject: "none-sub", Email: "user@none.example"},
	}
	ts := &domain.TokenService{
		Store: store, Issuer: iss, Clock: func() time.Time { return time.Now().UTC() },
		IdpBuild: func(c domain.TenantIdpConfig) domain.IdentityProvider {
			return issuerStubIDP{issuer: c.Issuer, ident: ident[c.Issuer]}
		},
	}

	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://trial.okta.example")}, "t"); err != nil {
		t.Fatalf("trial tenant login: %v", err)
	}
	if iss.last.CommercialState != "trial" {
		t.Fatalf("trial tenant login commercial_state claim = %q, want %q", iss.last.CommercialState, "trial")
	}

	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://none.okta.example")}, "t"); err != nil {
		t.Fatalf("none tenant login: %v", err)
	}
	if iss.last.CommercialState != "none" {
		t.Fatalf("none tenant login commercial_state claim = %q, want %q (always present, unlike Profile)", iss.last.CommercialState, "none")
	}
}

func TestOIDCLogin_DisabledConfigRejected(t *testing.T) {
	ctx := context.Background()
	store := memory.New()
	tid := uuid.New()
	_ = store.CreateTenant(ctx, &domain.Tenant{ID: tid, Name: "T", Status: domain.TenantActive})
	_ = store.UpsertTenantIdpConfig(ctx, &domain.TenantIdpConfig{
		TenantID: tid, Issuer: "https://off.example", Enabled: false,
	})
	ts := &domain.TokenService{
		Store: store, Issuer: &captureIssuer{}, Clock: func() time.Time { return time.Now().UTC() },
		IdpBuild: func(c domain.TenantIdpConfig) domain.IdentityProvider { return issuerStubIDP{issuer: c.Issuer} },
	}
	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://off.example")}, "t"); err == nil {
		t.Fatal("expected a disabled IdP to reject login")
	}
}

func TestOIDCLogin_UnknownIssuerNoLegacyRejected(t *testing.T) {
	ctx := context.Background()
	store := memory.New()
	ts := &domain.TokenService{
		Store: store, Issuer: &captureIssuer{}, Clock: func() time.Time { return time.Now().UTC() },
		IdpBuild: func(c domain.TenantIdpConfig) domain.IdentityProvider { return issuerStubIDP{issuer: c.Issuer} },
	}
	// No per-tenant config matches + no legacy env IDP → clean "not configured".
	if _, err := ts.OIDCLogin(ctx, domain.OIDCLoginRequest{IDToken: mkIDToken("https://nobody.example")}, "t"); err == nil {
		t.Fatal("expected rejection when no IdP matches the token issuer")
	}
}
