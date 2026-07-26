// Public, UNAUTHENTICATED self-serve demo signup (BRD 70 v1.1). The
// original demo-sandbox-poc-mode design explicitly deferred a public
// self-serve flow (docs/initiatives/demo-sandbox-poc-mode.md §Out of
// scope); this file is that deferred item's v1.1 implementation, layered
// entirely on top of the operator-facing domain.DemoService slice 1/2
// already shipped (handlers_demo.go, requireSuperAdmin) rather than
// duplicating it.
//
// Abuse-prevention layering (each independently defeatable, composed so a
// caller has to clear all of them):
//  1. Sliding-window rate limits by client IP AND by work-email domain
//     (domain.RateLimiter, the same abstraction OBORateLimit already uses).
//  2. A hard concurrency ceiling on LIVE self-serve demo tenants
//     (domain.DemoService.PublicSignup's cap param) -- refuses with a
//     clear 503 "at capacity" response, never silently degrades.
//  3. The existing TTL reaper (domain.DemoReaper) is reused untouched:
//     every self-serve tenant gets DefaultDemoTTLDays like any other demo
//     tenant, so the cap in (2) self-clears over time with no new expiry
//     mechanism.
//  4. A disposable-email-domain denylist (domain.IsDisposableEmailDomain)
//     plus a honeypot field plus mandatory audit logging (structured log +
//     durable outbox event) for a human to review after the fact. This
//     repo has no CAPTCHA/Turnstile/reCAPTCHA anywhere (grepped
//     services/ for captcha|turnstile|recaptcha; zero real hits) -- that is
//     a real, documented gap, not something this file pretends to cover.
//  5. Every field that could shape the created tenant beyond "one more
//     default demo" (pack/tier/cloud/ttl_days/profile) is forced
//     server-side in DemoService.PublicSignup, never taken from the
//     request -- see demo_public_signup.go.
package api

import (
	"net"
	"net/http"
	"strings"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// publicTenantView is the minimal, safe subset of domain.Tenant an
// unauthenticated caller may see -- deliberately excludes internal plumbing
// (schema_prefix, k8s_namespace, cell_id, owner_email, etc.) that the
// operator-facing /demo-tenants response includes for a super-admin caller.
type publicTenantView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`
	Profile     string `json:"profile"`
}

func newPublicTenantView(t *domain.Tenant) publicTenantView {
	return publicTenantView{
		ID: t.ID.String(), Name: t.Name, DisplayName: t.DisplayName,
		Status: string(t.Status), Profile: string(t.Profile),
	}
}

// publicDemoIPLimiter/publicDemoDomainLimiter return the configured limiter,
// falling back to an always-present conservative default limiter (built
// once and cached on the Server) when the operator never wired one --
// task requirement #1 must hold even on a deployment that forgot the knob.
func (s *Server) publicDemoIPLimiter() domain.RateLimiter {
	if s.PublicDemoIPLimiter != nil {
		return s.PublicDemoIPLimiter
	}
	s.publicDemoIPOnce.Do(func() {
		s.publicDemoIPFallback = domain.NewSlidingWindowLimiter(domain.DefaultSelfServeIPLimit, domain.DefaultSelfServeIPWindow)
	})
	return s.publicDemoIPFallback
}

func (s *Server) publicDemoDomainLimiter() domain.RateLimiter {
	if s.PublicDemoDomainLimiter != nil {
		return s.PublicDemoDomainLimiter
	}
	s.publicDemoDomainOnce.Do(func() {
		s.publicDemoDomainFallback = domain.NewSlidingWindowLimiter(domain.DefaultSelfServeDomainLimit, domain.DefaultSelfServeDomainWindow)
	})
	return s.publicDemoDomainFallback
}

// clientIP extracts the caller's address for rate-limit keying: the first
// hop of X-Forwarded-For when present (this service sits behind an
// ingress/LB in every real deployment, per every other service in this
// repo), else RemoteAddr's host part. Best-effort -- an empty result still
// rate-limits (keyed on "") rather than skipping the check.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if xrip := r.Header.Get("X-Real-Ip"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// emailDomainOf returns the lowercased domain of an email-shaped string, or
// "" if it isn't email-shaped (validated for real, server-side, inside
// domain.DemoService.PublicSignup -- this is only used for the rate-limit
// key and structured logging before that validation runs).
func emailDomainOf(email string) string {
	i := strings.LastIndex(email, "@")
	if i < 0 || i == len(email)-1 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(email[i+1:]))
}

// POST /public/demo-signup -- BRD 70 v1.1. Unauthenticated by design (the
// entire point is no operator in the loop); see the package doc above for
// the abuse-prevention layering.
func (s *Server) handlePublicDemoSignup(w http.ResponseWriter, r *http.Request) {
	if s.Demo == nil {
		writeErr(w, r, domain.ENotImplemented("self-serve demo signup is not configured on this deployment"))
		return
	}
	var req domain.PublicDemoSignupRequest
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, r, err)
		return
	}

	// Honeypot: a real visitor never populates a hidden field; bots that
	// blindly fill every input do. Report success without doing anything,
	// mirroring ui-web's existing request-demo/route.ts honeypot pattern --
	// a bot that gets a real-looking 202 has no signal to adapt on.
	if strings.TrimSpace(req.Website) != "" {
		writeJSON(w, http.StatusAccepted, map[string]any{"tenant": nil, "operation_id": ""})
		return
	}

	ip := clientIP(r)
	if ok, retry := s.publicDemoIPLimiter().Allow("ip:"+ip, s.Clock().UTC()); !ok {
		writeErr(w, r, domain.ERateLimited(retry))
		return
	}
	domainKey := emailDomainOf(req.WorkEmail)
	if domainKey != "" {
		if ok, retry := s.publicDemoDomainLimiter().Allow("domain:"+domainKey, s.Clock().UTC()); !ok {
			writeErr(w, r, domain.ERateLimited(retry))
			return
		}
	}

	t, opID, err := s.Demo.PublicSignup(r.Context(), req, s.PublicDemoSelfServeCap, s.PublicDemoPack)
	if err != nil {
		if s.Log != nil {
			s.Log.Warn("public demo signup rejected", "ip", ip, "email_domain", domainKey, "error", err)
		}
		writeErr(w, r, err)
		return
	}
	if s.Log != nil {
		// Task requirement #4: "log/audit every self-service creation for a
		// human to review after the fact." Includes network origin (not
		// persisted on the Tenant record itself), complementing the durable
		// demo.tenant_public_signup outbox event PublicSignup itself appends.
		s.Log.Info("public demo signup created",
			"tenant_id", t.ID.String(), "ip", ip, "email_domain", domainKey, "company", t.DisplayName)
	}

	resp := map[string]any{"tenant": newPublicTenantView(t), "operation_id": opID}

	// Best-effort immediate claim: works when provisioning already finished
	// synchronously (tests, or a fast/local deployment) -- see
	// ClaimSelfServeLogin's own doc for why this is only ever best-effort in
	// a real deployment (provisioning is async, TenantService.Async=true).
	if _, tok, err := s.Demo.ClaimSelfServeLogin(r.Context(), t.ID); err == nil && tok != nil {
		resp["access_token"] = tok.AccessToken
		resp["token_type"] = tok.TokenType
		resp["expires_in"] = tok.ExpiresIn
		writeJSON(w, http.StatusCreated, resp)
		return
	}

	// Not ready yet: hand back a narrow, short-lived claim token the caller
	// polls POST /public/demo-signup/claim with until provisioning finishes.
	claimTok, claimExpiresIn, err := s.Demo.MintSelfServeClaimToken(t)
	if err != nil {
		// The tenant was already created successfully -- a claim-token mint
		// hiccup must not fail the whole signup. Loud-logged, not swallowed.
		if s.Log != nil {
			s.Log.Error("public demo signup: claim token mint failed", "tenant_id", t.ID.String(), "error", err)
		}
		writeJSON(w, http.StatusAccepted, resp)
		return
	}
	resp["claim_token"] = claimTok
	resp["claim_expires_in"] = claimExpiresIn
	writeJSON(w, http.StatusAccepted, resp)
}

// POST /public/demo-signup/claim -- redeems the claim_token a still-
// provisioning signup returned for a real login session, once the tenant is
// active and its owner user exists. Bearer-token-shaped (Authorization:
// Bearer <claim_token>) like every other token exchange in this API, but
// deliberately NOT routed through the shared authMiddleware group: the
// claim token's Typ (domain.TypDemoClaim) is intentionally rejected by
// isAdminIssuableTyp, and this route needs its own "still provisioning ->
// 202, not 401" response shape that authMiddleware doesn't have.
func (s *Server) handlePublicDemoSignupClaim(w http.ResponseWriter, r *http.Request) {
	if s.Demo == nil {
		writeErr(w, r, domain.ENotImplemented("self-serve demo signup is not configured on this deployment"))
		return
	}
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		writeErr(w, r, domain.EUnauthenticated("missing bearer claim_token"))
		return
	}
	claims, err := s.Verifier.Verify(strings.TrimPrefix(h, "Bearer "))
	if err != nil {
		writeErr(w, r, domain.EUnauthenticated("invalid or expired claim_token"))
		return
	}
	if claims.Typ != domain.TypDemoClaim {
		writeErr(w, r, domain.EUnauthenticated("not a demo claim token"))
		return
	}

	// Light IP rate limiting on the claim/poll path too -- defense in depth,
	// even though the claim_token itself is the real possession proof (a
	// signed, tenant-scoped, 30-minute-TTL JWT nothing else can forge).
	ip := clientIP(r)
	if ok, retry := s.publicDemoIPLimiter().Allow("claim-ip:"+ip, s.Clock().UTC()); !ok {
		writeErr(w, r, domain.ERateLimited(retry))
		return
	}

	t, tok, err := s.Demo.ClaimSelfServeLogin(r.Context(), claims.TenantID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if tok == nil {
		// Still provisioning -- same "poll again" shape POST /tenants/{id}/
		// provisioning already establishes for the operator-facing flow.
		writeJSON(w, http.StatusAccepted, map[string]any{
			"tenant": newPublicTenantView(t), "ready": false,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tenant": newPublicTenantView(t), "ready": true,
		"access_token": tok.AccessToken, "token_type": tok.TokenType, "expires_in": tok.ExpiresIn,
	})
}
