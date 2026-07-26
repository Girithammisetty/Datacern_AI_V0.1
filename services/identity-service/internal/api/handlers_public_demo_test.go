package api_test

// Acceptance tests for BRD 70 v1.1's public, unauthenticated self-serve demo
// signup surface (POST /public/demo-signup, POST /public/demo-signup/claim).
// Uses the SAME shared fixture (fixture_test.go) every other acceptance
// test in this package does -- a real HTTP round trip through chi routing,
// not a domain-layer-only test -- so these exercise the actual abuse-
// prevention wiring (rate limiters, cap, honeypot) as configured on
// api.Server, not just the domain methods underneath.

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/datacern-ai/identity-service/internal/domain"
)

func validPublicSignupBody(email string) map[string]any {
	return map[string]any{
		"full_name": "Ada Lovelace", "work_email": email, "company": "Acme Corp",
	}
}

// TestPublicDemoSignup_CreatesAndClaimsLiveDemo is the happy path end to
// end: signup with no bearer token succeeds, forces profile=demo, and (this
// fixture's TenantService.Async=false, so provisioning finishes inline)
// returns a real access_token in the SAME response -- "log the visitor
// straight into it, with NO operator in the loop".
func TestPublicDemoSignup_CreatesAndClaimsLiveDemo(t *testing.T) {
	f := newFixture(t)

	r := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("ada@acme-corp.example"))
	if r.status != http.StatusCreated {
		t.Fatalf("signup: %d %s", r.status, string(r.raw))
	}
	tenant, ok := r.body["tenant"].(map[string]any)
	if !ok {
		t.Fatalf("no tenant in response: %s", string(r.raw))
	}
	if tenant["profile"] != "demo" {
		t.Fatalf("profile = %v, want demo", tenant["profile"])
	}
	// The public view must NOT leak internal plumbing fields.
	for _, leaky := range []string{"owner_email", "schema_prefix", "k8s_namespace", "cell_id", "created_by"} {
		if _, present := tenant[leaky]; present {
			t.Errorf("public tenant view leaks internal field %q", leaky)
		}
	}
	tok, _ := r.body["access_token"].(string)
	if tok == "" {
		t.Fatalf("expected an access_token in the immediate response (fast path), got: %s", string(r.raw))
	}

	// The minted token actually works against a real, member-safe endpoint.
	self := f.do(http.MethodGet, "/api/v1/tenants/self", tok, nil)
	if self.status != http.StatusOK {
		t.Fatalf("GET /tenants/self with the minted token: %d %s", self.status, string(self.raw))
	}
	if self.body["id"] != tenant["id"] {
		t.Fatalf("tenants/self id = %v, want %v", self.body["id"], tenant["id"])
	}

	// The minted token must NOT be admin-issuable -- an unauthenticated
	// visitor's session must never reach a requireSuperAdmin/requireScope
	// gated route just because it verifies.
	forbidden := f.do(http.MethodPost, "/api/v1/demo-tenants", tok, map[string]any{
		"name": "should-not-exist", "owner_email": "o@x.com", "pack": "insurance-claims-payer",
	})
	if forbidden.status != http.StatusForbidden && forbidden.status != http.StatusUnauthorized {
		t.Fatalf("expected the self-serve session to be denied on an admin route, got %d", forbidden.status)
	}
}

// TestPublicDemoSignup_RejectsDisposableEmail exercises the HTTP path for
// task requirement #4's denylist.
func TestPublicDemoSignup_RejectsDisposableEmail(t *testing.T) {
	f := newFixture(t)
	r := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("someone@mailinator.com"))
	if r.status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 VALIDATION_FAILED: %s", r.status, string(r.raw))
	}
	if r.errCode(t) != domain.CodeValidationFailed {
		t.Fatalf("code = %s, want %s", r.errCode(t), domain.CodeValidationFailed)
	}
}

// TestPublicDemoSignup_Honeypot: a filled hidden `website` field is treated
// as a bot -- 202 with no tenant created (silent no-op, mirroring ui-web's
// existing request-demo/route.ts honeypot), never a validation error a bot
// script could learn from.
func TestPublicDemoSignup_Honeypot(t *testing.T) {
	f := newFixture(t)
	body := validPublicSignupBody("bot@acme-corp.example")
	body["website"] = "http://spam.example"
	r := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", body)
	if r.status != http.StatusAccepted {
		t.Fatalf("honeypot response status = %d, want 202: %s", r.status, string(r.raw))
	}
	if r.body["tenant"] != nil {
		t.Fatalf("honeypot must not create a tenant, got: %s", string(r.raw))
	}
	live, err := f.srv.Demo.CountLiveSelfServeDemoTenants(context.Background())
	if err == nil && live != 0 {
		t.Fatalf("honeypot submission created %d live tenant(s), want 0", live)
	}
}

// TestPublicDemoSignup_RateLimitedByIP: task requirement #1. Overrides the
// fixture's generous default limiter with a tiny one so the test is fast
// and deterministic.
func TestPublicDemoSignup_RateLimitedByIP(t *testing.T) {
	f := newFixture(t)
	f.srv.PublicDemoIPLimiter = domain.NewSlidingWindowLimiter(1, time.Hour)

	ok := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("first@acme-corp.example"),
		[2]string{"X-Forwarded-For", "203.0.113.7"})
	if ok.status != http.StatusCreated && ok.status != http.StatusAccepted {
		t.Fatalf("first request from this IP: %d %s", ok.status, string(ok.raw))
	}

	limited := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("second@acme-corp.example"),
		[2]string{"X-Forwarded-For", "203.0.113.7"})
	if limited.status != http.StatusTooManyRequests {
		t.Fatalf("second request from the SAME IP: status = %d, want 429: %s", limited.status, string(limited.raw))
	}
	if limited.errCode(t) != domain.CodeRateLimited {
		t.Fatalf("code = %s, want %s", limited.errCode(t), domain.CodeRateLimited)
	}
	if limited.headers.Get("Retry-After") == "" {
		t.Error("expected a Retry-After header on a 429 (AC-14 precedent)")
	}

	// A DIFFERENT IP is unaffected -- the limit is per-IP, not global.
	other := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("third@acme-corp.example"),
		[2]string{"X-Forwarded-For", "198.51.100.9"})
	if other.status != http.StatusCreated && other.status != http.StatusAccepted {
		t.Fatalf("request from a different IP: %d %s", other.status, string(other.raw))
	}
}

// TestPublicDemoSignup_RateLimitedByEmailDomain: task requirement #1's
// "ideally by email domain" -- two different IPs, same work-email domain,
// still get rate limited together.
func TestPublicDemoSignup_RateLimitedByEmailDomain(t *testing.T) {
	f := newFixture(t)
	f.srv.PublicDemoDomainLimiter = domain.NewSlidingWindowLimiter(1, time.Hour)

	first := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("alice@shared-domain.example"),
		[2]string{"X-Forwarded-For", "203.0.113.10"})
	if first.status != http.StatusCreated && first.status != http.StatusAccepted {
		t.Fatalf("first signup: %d %s", first.status, string(first.raw))
	}

	second := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("bob@shared-domain.example"),
		[2]string{"X-Forwarded-For", "198.51.100.20"}) // different IP, same email domain
	if second.status != http.StatusTooManyRequests {
		t.Fatalf("second signup (same email domain, different IP): status = %d, want 429: %s", second.status, string(second.raw))
	}
}

// TestPublicDemoSignup_CapacityExceeded: task requirement #2 end to end
// through HTTP -- a clear, non-degrading 503 once the self-serve
// concurrency ceiling is reached.
func TestPublicDemoSignup_CapacityExceeded(t *testing.T) {
	f := newFixture(t)
	f.srv.PublicDemoSelfServeCap = 1

	first := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("first@acme-corp.example"))
	if first.status != http.StatusCreated && first.status != http.StatusAccepted {
		t.Fatalf("first signup (within cap): %d %s", first.status, string(first.raw))
	}

	second := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", validPublicSignupBody("second@other-corp.example"))
	if second.status != http.StatusServiceUnavailable {
		t.Fatalf("second signup at cap=1: status = %d, want 503: %s", second.status, string(second.raw))
	}
	if second.errCode(t) != domain.CodeCapExceeded {
		t.Fatalf("code = %s, want %s", second.errCode(t), domain.CodeCapExceeded)
	}

	// An operator-created demo tenant (POST /demo-tenants) does NOT count
	// against this cap -- it must still succeed.
	op := f.do(http.MethodPost, "/api/v1/demo-tenants", f.superToken(), map[string]any{
		"name": "operator-demo-http", "owner_email": "owner@operator-demo-http.com",
		"pack": "insurance-claims-payer",
	})
	if op.status != http.StatusAccepted {
		t.Fatalf("operator-created demo tenant must not be blocked by the self-serve cap: %d %s", op.status, string(op.raw))
	}
}

// TestPublicDemoSignup_NeverCreatesNonDemoProfile: task requirement #5.
// Nothing on the public wire body can select a profile or pack; the create
// tenant always comes back profile=demo regardless of extra JSON keys
// (decodeBody's DisallowUnknownFields rejects them outright, which is
// itself part of the guarantee).
func TestPublicDemoSignup_NeverCreatesNonDemoProfile(t *testing.T) {
	f := newFixture(t)
	body := validPublicSignupBody("carol@acme-corp.example")
	body["profile"] = "standard" // attempted injection
	body["pack"] = "some-other-pack"
	r := f.do(http.MethodPost, "/api/v1/public/demo-signup", "", body)
	if r.status != http.StatusUnprocessableEntity && r.status != http.StatusBadRequest {
		t.Fatalf("expected unknown fields to be rejected outright, got %d %s", r.status, string(r.raw))
	}
}

// TestPublicDemoSignupClaim_RejectsForgedOrWrongTypToken proves the claim
// endpoint only accepts a real, correctly-typed claim token -- not an
// ordinary user session, not a forged/garbage bearer value.
func TestPublicDemoSignupClaim_RejectsForgedOrWrongTypToken(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("acme-claim-reject")

	// An ordinary user session token must be rejected (wrong Typ).
	userTok := f.userToken(&domain.User{ID: tn.ID, TenantID: tn.ID})
	r := f.do(http.MethodPost, "/api/v1/public/demo-signup/claim", userTok, nil)
	if r.status != http.StatusUnauthorized {
		t.Fatalf("wrong-typ token: status = %d, want 401: %s", r.status, string(r.raw))
	}

	// A garbage bearer value must also be rejected.
	garbage := f.do(http.MethodPost, "/api/v1/public/demo-signup/claim", "not-a-real-token", nil)
	if garbage.status != http.StatusUnauthorized {
		t.Fatalf("garbage token: status = %d, want 401: %s", garbage.status, string(garbage.raw))
	}
}
