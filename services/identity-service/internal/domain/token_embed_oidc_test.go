package domain_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/windrose-ai/identity-service/internal/domain"
	"github.com/windrose-ai/identity-service/internal/store/memory"
)

// captureIssuer records the last claims it was asked to sign so tests can assert
// on the token SHAPE without real crypto.
type captureIssuer struct{ last domain.Claims }

func (c *captureIssuer) Issue(cl domain.Claims) (string, int, error) { c.last = cl; return "tok", 600, nil }
func (c *captureIssuer) IssueWithTTL(cl domain.Claims, _ time.Duration) (string, int, error) {
	c.last = cl
	return "tok", 600, nil
}

// stubIDP returns a fixed verified identity (or an error to simulate a bad token).
type stubIDP struct {
	id  *domain.NormalizedIdentity
	err error
}

func (s stubIDP) VerifyIDToken(_ context.Context, _ string) (*domain.NormalizedIdentity, error) {
	return s.id, s.err
}
func (s stubIDP) Issuer() string { return "https://idp.example" }

func newEmbedFixture(t *testing.T, idp domain.IdentityProvider) (*domain.TokenService, *captureIssuer, uuid.UUID, uuid.UUID) {
	t.Helper()
	store := memory.New()
	ctx := context.Background()
	tenantID := uuid.New()
	if err := store.CreateTenant(ctx, &domain.Tenant{ID: tenantID, Name: "Acme", Status: domain.TenantActive}); err != nil {
		t.Fatal(err)
	}
	userID := uuid.New()
	if err := store.CreateUser(ctx, &domain.User{ID: userID, TenantID: tenantID, Email: "ann@acme.com", Status: domain.UserActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertTenantEmbedConfig(ctx, &domain.TenantEmbedConfig{
		TenantID: tenantID, SecretHash: "unused", AllowedOrigins: []string{"https://portal.acme.com"},
	}); err != nil {
		t.Fatal(err)
	}
	iss := &captureIssuer{}
	ts := &domain.TokenService{Store: store, Issuer: iss, IDP: idp, Clock: func() time.Time { return time.Now().UTC() }}
	return ts, iss, tenantID, userID
}

func TestEmbedOIDCExchange_MintsPerUserEmbedToken(t *testing.T) {
	idp := stubIDP{id: &domain.NormalizedIdentity{Subject: "kc-1", Email: "ann@acme.com", Name: "Ann"}}
	ts, iss, tenantID, userID := newEmbedFixture(t, idp)

	wsID := uuid.NewString()
	resp, err := ts.EmbedOIDCExchange(context.Background(), domain.EmbedOIDCRequest{
		TenantID: tenantID.String(), IDToken: "any", WorkspaceID: wsID, Surface: []string{"dashboard", "bogus"},
	}, "trace")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if resp.AccessToken == "" {
		t.Fatal("no token")
	}
	c := iss.last
	// The federated identity is bound to the real Windrose user, not the IdP sub.
	if c.Subject != userID.String() {
		t.Fatalf("subject = %q want windrose user id %q", c.Subject, userID.String())
	}
	if !c.Embed || c.WorkspaceID != wsID {
		t.Fatalf("embed=%v workspace=%q", c.Embed, c.WorkspaceID)
	}
	if len(c.Surface) != 1 || c.Surface[0] != "dashboard" {
		t.Fatalf("surface = %v (bogus must be dropped)", c.Surface)
	}
	if len(c.FrameAncestors) != 1 || c.FrameAncestors[0] != "https://portal.acme.com" {
		t.Fatalf("frame_ancestors = %v (must come from tenant embed config)", c.FrameAncestors)
	}
}

func TestEmbedOIDCExchange_Rejects(t *testing.T) {
	good := &domain.NormalizedIdentity{Subject: "kc-1", Email: "ann@acme.com"}

	t.Run("bad id_token", func(t *testing.T) {
		ts, _, tid, _ := newEmbedFixture(t, stubIDP{err: context.Canceled})
		_, err := ts.EmbedOIDCExchange(context.Background(), domain.EmbedOIDCRequest{
			TenantID: tid.String(), IDToken: "x", WorkspaceID: uuid.NewString(), Surface: []string{"dashboard"},
		}, "t")
		if err == nil {
			t.Fatal("expected rejection of an unverifiable id_token")
		}
	})

	t.Run("identity not a user in tenant", func(t *testing.T) {
		ts, _, tid, _ := newEmbedFixture(t, stubIDP{id: &domain.NormalizedIdentity{Subject: "kc-2", Email: "stranger@evil.com"}})
		_, err := ts.EmbedOIDCExchange(context.Background(), domain.EmbedOIDCRequest{
			TenantID: tid.String(), IDToken: "x", WorkspaceID: uuid.NewString(), Surface: []string{"dashboard"},
		}, "t")
		if err == nil {
			t.Fatal("expected rejection: verified identity has no user in this tenant")
		}
	})

	t.Run("no embed config for tenant", func(t *testing.T) {
		ts := &domain.TokenService{Store: memory.New(), Issuer: &captureIssuer{}, IDP: stubIDP{id: good}, Clock: func() time.Time { return time.Now().UTC() }}
		_, err := ts.EmbedOIDCExchange(context.Background(), domain.EmbedOIDCRequest{
			TenantID: uuid.NewString(), IDToken: "x", WorkspaceID: uuid.NewString(), Surface: []string{"dashboard"},
		}, "t")
		if err == nil {
			t.Fatal("expected rejection when tenant has no embed config")
		}
	})

	t.Run("idp not configured", func(t *testing.T) {
		ts := &domain.TokenService{Store: memory.New(), Issuer: &captureIssuer{}, Clock: func() time.Time { return time.Now().UTC() }}
		_, err := ts.EmbedOIDCExchange(context.Background(), domain.EmbedOIDCRequest{
			TenantID: uuid.NewString(), IDToken: "x", WorkspaceID: uuid.NewString(), Surface: []string{"dashboard"},
		}, "t")
		if err == nil {
			t.Fatal("expected rejection when IDP is nil (federation off)")
		}
	})
}
