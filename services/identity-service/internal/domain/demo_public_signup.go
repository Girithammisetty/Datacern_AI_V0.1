// Public, UNAUTHENTICATED self-serve demo signup (BRD 70 v1.1). The original
// demo-sandbox-poc-mode design explicitly deferred this ("Public self-serve
// demo signup ... explicitly rejected for v1, not merely deferred without
// reason", see docs/initiatives/demo-sandbox-poc-mode.md §Out of scope) --
// this file is the v1.1 / next-round implementation of that deferred item,
// built on top of the same DemoService/DemoReaper machinery slice 1/2
// already shipped, not a parallel path.
//
// Everything in this file assumes an ADVERSARIAL caller: no bearer token, no
// operator, and a route that provisions real infrastructure (a tenant, a
// Terraform-provisioned cell reservation, seeded content). The abuse
// surface is closed by composing several independent, narrow controls
// (rate limiting + a concurrency cap + a disposable-email denylist +
// mandatory audit logging), each documented at its own definition below,
// rather than any single "trust boundary".
package domain

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"github.com/google/uuid"
)

// SelfServeDemoActorID is the audit-attributed Actor.ID for every tenant
// PublicSignup creates. It is deliberately the ONE thing that distinguishes
// a self-serve demo tenant from an operator/partner-created one (POST
// /demo-tenants, requireSuperAdmin, a real staff actor.ID) at the data
// layer -- CountLiveSelfServeDemoTenants below filters on it so the
// concurrency cap (task requirement #2) counts only what the public route
// itself created, never an operator's demo tenants.
const SelfServeDemoActorID = "public-demo-signup"

// SelfServeDemoActor builds the audit Actor every PublicSignup-created
// tenant, and every event this file emits, is attributed to.
func SelfServeDemoActor() Actor {
	return Actor{Type: "system", ID: SelfServeDemoActorID, Scope: "public"}
}

// DefaultSelfServeDemoCap is the hard ceiling on concurrently-live (not
// deleting/deleted) self-serve demo tenants when the deployment doesn't
// override it (task requirement #2: "a hard cap ... configurable via env
// var, default something conservative like 20"). Wired through
// api.Server.PublicDemoSelfServeCap / cmd/server/main.go's
// PUBLIC_DEMO_SIGNUP_CAP env var.
const DefaultSelfServeDemoCap = 20

// DefaultSelfServeDemoPack is the bundle a self-serve signup seeds when the
// deployment doesn't override it (env PUBLIC_DEMO_SIGNUP_PACK). Self-serve
// intentionally does NOT expose a `pack` field on the public wire request
// (unlike the operator-facing CreateDemoTenantRequest) -- an unauthenticated
// caller can never target an unpublished/internal-only bundle by name, only
// ever this one deployment-chosen default (task requirement #5: this route
// must never be usable to create anything but a forced-default demo).
const DefaultSelfServeDemoPack = "insurance-claims-payer"

// Self-serve claim-token / session TTLs (BRD 70 v1.1). SelfServeClaimTTL is
// how long a visitor's claim_token (minted at signup) stays valid while
// provisioning finishes in the background -- generous relative to
// DSP-FR-010's ≤10min p95 creation budget so a slow provision doesn't
// strand a visitor with an expired link. SelfServeLoginTTL is deliberately
// LONGER than the platform's normal 5-minute session TTL (TokenTTL,
// MASTER-FR-010): a self-serve visitor has no OIDC refresh_token (there was
// no real IdP login) so nothing can silently re-mint their session the way
// ui-web's /api/auth/refresh does for a real SSO login -- see the
// initiative doc's honest-gaps note on this tradeoff.
const (
	SelfServeClaimTTL = 30 * time.Minute
	SelfServeLoginTTL = 2 * time.Hour
)

// Self-serve demo-signup rate-limit defaults (task requirement #1: "Rate
// limiting by IP (and ideally by email domain)"). Reuses the SAME
// RateLimiter/SlidingWindowLimiter machinery OBORateLimit already proves out
// (ratelimit.go) rather than inventing a second limiter abstraction.
// Deliberately conservative: this route provisions real infrastructure, so
// the default favors under-serving a legitimate burst over letting a script
// spin up tenants. Overridable via cmd/server/main.go's
// PUBLIC_DEMO_SIGNUP_{IP,DOMAIN}_LIMIT / _WINDOW_MINUTES env vars.
const (
	DefaultSelfServeIPLimit      = 3
	DefaultSelfServeIPWindow     = time.Hour
	DefaultSelfServeDomainLimit  = 8
	DefaultSelfServeDomainWindow = 24 * time.Hour
)

// PublicDemoSignupRequest is POST /public/demo-signup's body: deliberately
// the smallest possible surface (full name / work email / company) -- no
// pack, no tier, no cloud, no ttl_days, no profile. Every field
// CreateDemoTenantRequest exposes to an operator is forced server-side in
// PublicSignup below, never taken from this request, so a public caller
// structurally cannot shape the created tenant beyond "one more default
// demo" (task requirement #5). Website is a honeypot (mirrors ui-web's
// existing request-demo/route.ts pattern): real visitors never populate a
// hidden field; a filled one is treated as a silent no-op success by the
// HTTP handler, not rejected here (nothing to validate).
type PublicDemoSignupRequest struct {
	FullName  string `json:"full_name"`
	WorkEmail string `json:"work_email"`
	Company   string `json:"company"`
	Website   string `json:"website,omitempty"` // honeypot, never a real field
}

// disposableEmailDomains is a small, EXPLICITLY-NOT-EXHAUSTIVE denylist of
// well-known disposable/throwaway email providers (task requirement #4:
// "require a valid-looking business email (reject obvious disposable-email
// domains via a small denylist)"). This repo has no CAPTCHA/Turnstile/
// reCAPTCHA integration anywhere (grepped services/ for
// captcha|turnstile|recaptcha -- zero real hits outside vendored fonts), so
// this denylist plus the rate limits/cap above are ALL the bot resistance
// this endpoint has in v1.1. That is a real, documented limitation, not
// something this comment is pretending is equivalent to a CAPTCHA -- see
// docs/initiatives/demo-sandbox-poc-mode.md §3's honest-gaps note.
var disposableEmailDomains = map[string]bool{
	"mailinator.com": true, "10minutemail.com": true, "guerrillamail.com": true,
	"tempmail.com": true, "temp-mail.org": true, "yopmail.com": true,
	"trashmail.com": true, "throwawaymail.com": true, "getnada.com": true,
	"dispostable.com": true, "fakeinbox.com": true, "sharklasers.com": true,
	"maildrop.cc": true, "mintemail.com": true, "mailnesia.com": true,
	"discard.email": true, "spamgourmet.com": true, "moakt.com": true,
	"tempinbox.com": true, "emailondeck.com": true, "33mail.com": true,
	"mailcatch.com": true, "inboxbear.com": true, "mytemp.email": true,
	"mohmal.com": true, "spam4.me": true, "burnermail.io": true,
}

// IsDisposableEmailDomain reports whether domain (lowercased, no leading @)
// is a known disposable/throwaway provider.
func IsDisposableEmailDomain(domain string) bool {
	return disposableEmailDomains[strings.ToLower(strings.TrimSpace(domain))]
}

// emailDomain extracts the domain part of an address already validated by
// ValidateEmail (so a single "@" is guaranteed present).
func emailDomain(email string) string {
	i := strings.LastIndex(email, "@")
	if i < 0 || i == len(email)-1 {
		return ""
	}
	return strings.ToLower(email[i+1:])
}

// randomDemoTenantName generates a tenant name satisfying tenantNameRe
// (^[a-z][a-z0-9-]{2,38}$) without ever deriving it from caller-supplied
// text (company names routinely contain characters the tenant-name regex
// rejects, and echoing a visitor's company name into a public,
// internet-routable subdomain is also just unnecessary exposure for a
// throwaway sandbox). "demo-" + 24 random hex chars = 29 chars, comfortably
// inside the 39-char cap.
func randomDemoTenantName() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "demo-" + hex.EncodeToString(b), nil
}

// CountLiveSelfServeDemoTenants counts self-serve demo tenants (Profile=demo
// AND CreatedBy=SelfServeDemoActorID) that are not yet deleting/deleted --
// "concurrently live" for the resource-ceiling check (task requirement #2).
// Paginates the whole profile=demo set rather than adding a new Store method
// + Postgres migration for a narrower indexed count query: the cap itself
// is small (default 20, expected to stay in the tens-to-low-hundreds range
// for any real deployment), so an O(live demo tenants) scan on every signup
// attempt is an accepted, documented tradeoff -- see the initiative doc.
func (s *DemoService) CountLiveSelfServeDemoTenants(ctx context.Context) (int, error) {
	count := 0
	page := PageRequest{Limit: 200}
	for {
		tenants, info, err := s.Store.ListTenants(ctx, TenantFilter{Profile: string(ProfileDemo)}, page)
		if err != nil {
			return 0, err
		}
		for _, t := range tenants {
			if t.CreatedBy == SelfServeDemoActorID && t.Status != TenantDeleting && t.Status != TenantDeleted {
				count++
			}
		}
		if !info.HasMore || info.NextCursor == nil {
			return count, nil
		}
		id, err := uuid.Parse(*info.NextCursor)
		if err != nil {
			return count, nil
		}
		page.AfterID = &id
	}
}

// PublicSignup provisions a profile=demo tenant for an UNAUTHENTICATED,
// PUBLIC visitor (BRD 70 v1.1). It is a thin, deliberately-narrow wrapper
// over Create (DSP-FR-010): every field Create's operator-facing request
// exposes (pack/tier/cloud/ttl_days) is forced here, never taken from the
// caller (task requirement #5 -- this route can NEVER create a standard
// tenant or target a non-default pack). HTTP-layer concerns (IP/domain rate
// limiting, the honeypot check, request size limits) are the api.Server
// handler's job, not this method's -- same layering Create/Reset/Clone
// already keep (domain validation here, transport there).
//
// signupCap<=0 defers to DefaultSelfServeDemoCap; pack=="" defers to
// DefaultSelfServeDemoPack.
func (s *DemoService) PublicSignup(ctx context.Context, req PublicDemoSignupRequest, signupCap int, pack string) (*Tenant, string, error) {
	name := strings.TrimSpace(req.FullName)
	if len(name) < 2 {
		return nil, "", EValidation("full_name is required", FieldError{Field: "full_name", Message: "required, min length 2"})
	}
	if len(name) > 200 {
		return nil, "", EValidation("full_name is too long", FieldError{Field: "full_name", Message: "max length 200"})
	}
	company := strings.TrimSpace(req.Company)
	if company == "" {
		return nil, "", EValidation("company is required", FieldError{Field: "company", Message: "required"})
	}
	if len(company) > 200 {
		return nil, "", EValidation("company is too long", FieldError{Field: "company", Message: "max length 200"})
	}
	email, err := ValidateEmail(req.WorkEmail)
	if err != nil {
		return nil, "", err
	}
	if IsDisposableEmailDomain(emailDomain(email)) {
		return nil, "", EValidation("please sign up with a business email address",
			FieldError{Field: "work_email", Message: "disposable/throwaway email domains are not accepted"})
	}

	if signupCap <= 0 {
		signupCap = DefaultSelfServeDemoCap
	}
	live, err := s.CountLiveSelfServeDemoTenants(ctx)
	if err != nil {
		return nil, "", err
	}
	if live >= signupCap {
		return nil, "", EDemoSignupAtCapacity(live, signupCap)
	}

	if pack == "" {
		pack = DefaultSelfServeDemoPack
	}
	tenantName, err := randomDemoTenantName()
	if err != nil {
		return nil, "", EInternal("failed to generate a tenant name")
	}
	ttl := DefaultDemoTTLDays
	t, opID, err := s.Create(ctx, CreateDemoTenantRequest{
		Name: tenantName, DisplayName: company, OwnerEmail: email,
		Pack: pack, Tier: "pool", Cloud: "aws", TTLDays: &ttl,
	}, SelfServeDemoActor())
	if err != nil {
		return nil, "", err
	}

	// Task requirement #4: "log/audit every self-service creation for a
	// human to review after the fact." Durable (outbox -> the same
	// identity.events.v1 topic every other tenant-lifecycle event flows
	// through), independent of whatever the handler additionally logs to
	// stdout/slog with request-scoped metadata (IP, user agent) this domain
	// method has no business knowing about.
	if err := s.Store.AppendOutbox(ctx, NewEvent(EvDemoTenantPublicSignup, t.ID, SelfServeDemoActor(), t.URN(), s.now(), map[string]any{
		"full_name":         name,
		"company":           company,
		"work_email_domain": emailDomain(email),
		"pack":              pack,
	})); err != nil {
		return nil, "", err
	}
	return t, opID, nil
}

// MintSelfServeClaimToken issues the short-lived, narrow-purpose claim token
// (Typ=TypDemoClaim) a self-serve signup response carries when the real
// login couldn't be minted immediately (provisioning is async in every real
// deployment -- see ClaimSelfServeLogin). The token's only power is
// resolving to ClaimSelfServeLogin for THIS tenant; it carries no scopes and
// isAdminIssuableTyp (api/middleware.go) rejects it everywhere else.
func (s *DemoService) MintSelfServeClaimToken(t *Tenant) (string, int, error) {
	if s.Tokens == nil || s.Tokens.Issuer == nil {
		return "", 0, EInternal("self-serve demo login is not configured on this deployment (Tokens/Issuer unset)")
	}
	return s.Tokens.Issuer.IssueWithTTL(Claims{
		Subject: "pending-owner", TenantID: t.ID, Typ: TypDemoClaim, Scopes: []string{},
	}, SelfServeClaimTTL)
}

// ClaimSelfServeLogin resolves the real owner user the provisioning saga's
// SeedDefaults step (engine_steps.go) creates and, once BOTH the tenant is
// active AND that user row exists, mints a real platform session for it --
// the same claim shape OIDCLogin mints for a verified SSO login (empty
// scopes; downstream authorization runs off the rbac projection, not JWT
// scopes; Profile/CommercialState claims; best-effort default-workspace
// resolution) EXCEPT there is no external IdP verification step here: for a
// self-serve demo tenant, closing the identity question is exactly what
// PublicSignup's rate limiting + disposable-domain denylist + concurrency
// cap already did at signup time, not a second login-time check.
//
// Returns (tenant, nil, nil) -- not an error -- when the tenant/owner user
// aren't ready yet: the caller (the HTTP handler) turns that into a 202
// "still provisioning, poll again" response, the same shape every other
// async-provisioning surface in this API already uses (POST /tenants,
// POST /demo-tenants).
func (s *DemoService) ClaimSelfServeLogin(ctx context.Context, tenantID uuid.UUID) (*Tenant, *TokenResponse, error) {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	if t.Profile != ProfileDemo || t.CreatedBy != SelfServeDemoActorID {
		// Structurally cannot be reached for any tenant PublicSignup didn't
		// create itself -- the claim token's own TenantID claim is what
		// selects tenantID in the first place, but this is defense in depth
		// against a future caller that resolves tenantID some other way.
		return nil, nil, ENotFound("demo signup")
	}
	if t.Status == TenantProvisionFailed {
		// A terminal failure, not a transient "not ready yet" -- the
		// ProvisioningEngine already exhausted its own per-step retries
		// before landing the tenant here (see provisioning.go). Returning
		// (t, nil, nil) here (as if still provisioning) was the bug: the
		// HTTP handler turns that into 202 "poll again", so the /live-demo
		// page's poller would spin until the claim token's own 30-minute
		// SelfServeClaimTTL expired, then show a misleading "this demo link
		// expired" message instead of the real failure.
		return t, nil, EDemoProvisioningFailed()
	}
	if t.Status != TenantActive {
		return t, nil, nil // still provisioning
	}
	owner, err := s.Store.GetUserByEmail(ctx, t.ID, t.OwnerEmail)
	if err != nil {
		return t, nil, nil // SeedDefaults hasn't landed yet -- keep polling
	}
	if owner.Status == UserDeactivated || owner.DeletedAt != nil {
		return nil, nil, EPermissionDenied("owner account is deactivated")
	}
	if s.Tokens == nil || s.Tokens.Issuer == nil {
		return nil, nil, EInternal("self-serve demo login is not configured on this deployment (Tokens/Issuer unset)")
	}

	now := s.now()
	dirty := owner.Status == UserInvited
	if dirty {
		owner.Status = UserActive
	}
	owner.LastLoginAt = &now
	owner.UpdatedAt = now
	_ = s.Store.UpdateUser(ctx, owner) // best-effort, mirrors OIDCLogin's own bookkeeping

	workspaceID := ""
	if s.Tokens.Workspaces != nil {
		if ws, err := s.Tokens.Workspaces.DefaultWorkspaceID(ctx, t.ID); err == nil {
			workspaceID = ws
		}
	}
	tok, expiresIn, err := s.Tokens.Issuer.IssueWithTTL(Claims{
		Subject: owner.ID.String(), TenantID: t.ID, Typ: TypUser,
		Scopes: []string{}, WorkspaceID: workspaceID,
		Profile:         profileClaim(t.Profile),
		CommercialState: string(t.CommercialState),
	}, SelfServeLoginTTL)
	if err != nil {
		return nil, nil, err
	}
	if err := s.Store.AppendOutbox(ctx, NewEvent(EvDemoTenantPublicSignupClaimed, t.ID, SelfServeDemoActor(), t.URN(), now, map[string]any{
		"owner_user_id": owner.ID.String(),
	})); err != nil {
		return nil, nil, err
	}
	return t, &TokenResponse{AccessToken: tok, TokenType: "Bearer", ExpiresIn: expiresIn}, nil
}
