package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Token types per MASTER-FR-011.
const (
	TypUser            = "user"
	TypService         = "service"
	TypAgentOBO        = "agent_obo"
	TypAgentAutonomous = "agent_autonomous"
	// TypDemoClaim (BRD 70 v1.1, self-serve demo signup) is a narrow,
	// short-lived, non-admin-issuable token type (isAdminIssuableTyp in
	// api/middleware.go rejects it, same as agent_obo/agent_autonomous):
	// its ONLY purpose is proving "I am the visitor who just requested this
	// one demo tenant" to POST /public/demo-signup/claim. It carries empty
	// scopes and is never accepted by requireScope/requireSuperAdmin gates.
	TypDemoClaim = "demo_claim"
)

// TokenTTL is the platform JWT TTL (MASTER-FR-010: 5 min).
const TokenTTL = 5 * time.Minute

// ClockSkew tolerance on all token validation (BR-8).
const ClockSkew = 60 * time.Second

// Claims is the platform JWT claim set (MASTER-FR-011 + IDN-FR-041).
type Claims struct {
	Subject      string    `json:"sub"`
	TenantID     uuid.UUID `json:"tenant_id"`
	Typ          string    `json:"typ"` // user|service|agent_obo|agent_autonomous
	AgentID      string    `json:"agent_id,omitempty"`
	AgentVersion string    `json:"agent_version,omitempty"`
	OBOSub       string    `json:"obo_sub,omitempty"` // original user for agent_obo
	Scopes       []string  `json:"scopes"`
	// PlatformAdmin (IDN: first-class cross-tenant operator) marks a human
	// platform administrator. It is a clean UI/BFF signal that travels alongside
	// the injected platform scopes; backend predicates still key off the scopes.
	PlatformAdmin bool   `json:"platform_admin,omitempty"`
	SessionID     string `json:"session_id,omitempty"`
	// Embedded-UI (IDN-FR-043): workspace-scoped embed tokens. `Embed` marks
	// the token as an embed token; `Surface` is the UI-surface allowlist; the
	// UI enforces both. `FrameAncestors` is the tenant's allowed embedding
	// origins, bound into the (signed) token so the UI can set a per-tenant
	// `frame-ancestors` CSP without a per-request lookup. `WorkspaceID` scopes
	// the token to one workspace.
	WorkspaceID    string   `json:"workspace_id,omitempty"`
	Embed          bool     `json:"embed,omitempty"`
	Surface        []string `json:"surface,omitempty"`
	FrameAncestors []string `json:"frame_ancestors,omitempty"`
	// Profile (BRD 70 §2.6, DSP-FR-014) mirrors Tenant.Profile at mint time
	// -- "from session claim, not tenant lookup" for the ui-web demo
	// watermark banner. Empty is equivalent to "standard" (the common case
	// is left unset on the wire to keep the common token small, matching
	// Embed/Surface's own omitempty convention).
	Profile string `json:"profile,omitempty"`
	// CommercialState (BRD 66 slice 2, CPL-FR-022/design doc "Commercial-state
	// claim + fail-open/fail-closed"): mirrors Tenant.CommercialState at mint
	// time, read from the tenant row directly (mint already loads the tenant
	// -- no extra lookup, same "from session claim" shape as Profile above).
	// Lets a downstream service do the fast, request-local "is this tenant on
	// an expired trial" check (writes -> 403 TRIAL_EXPIRED) with no round
	// trip. Unlike Profile, this is never omitted: CommercialNone ("none") is
	// itself a meaningful, non-empty value, so the claim is always present
	// once minted (design doc's fail-open/fail-closed table: "claim is always
	// present once minted... no fail-open/closed ambiguity here since it's
	// not projection-dependent").
	CommercialState string `json:"commercial_state,omitempty"`
	// Standard claims (filled by the issuer).
	Issuer    string    `json:"iss,omitempty"`
	Audience  string    `json:"aud,omitempty"`
	ExpiresAt time.Time `json:"-"`
	IssuedAt  time.Time `json:"-"`
	JTI       string    `json:"jti,omitempty"`
}

// profileClaim renders a Tenant.Profile onto the wire claim (BRD 70 §2.6):
// ProfileStandard (the overwhelming common case) is left empty to keep the
// token small, matching every other omitempty claim's convention.
func profileClaim(p TenantProfile) string {
	if p == "" || p == ProfileStandard {
		return ""
	}
	return string(p)
}

// HasScope reports whether the claim set carries the given action scope
// (MASTER-FR-016 action naming) or a covering wildcard.
func (c *Claims) HasScope(action string) bool {
	for _, s := range c.Scopes {
		if s == action || s == "platform.admin" {
			return true
		}
	}
	return false
}

// IsSuperAdmin: platform-staff tokens carry the platform.admin scope and no
// tenant binding requirement (IDN-FR-025 platform realm).
func (c *Claims) IsSuperAdmin() bool { return c.HasScope("platform.admin") }

// TokenIssuer abstracts JWT creation so domain logic stays crypto-free.
// Implemented by internal/keys (local RSA signer / Vault adapter).
type TokenIssuer interface {
	// Issue signs claims with the active key; returns the compact JWT and TTL seconds.
	Issue(claims Claims) (token string, expiresIn int, err error)
	// IssueWithTTL signs claims with an explicit lifetime (embed tokens are short).
	IssueWithTTL(claims Claims, ttl time.Duration) (token string, expiresIn int, err error)
}

// WorkspaceResolver looks up a tenant's default workspace so an interactive
// login (real OIDC — dev-login gets this from a seeded persona instead) can
// set the session's workspace_id claim without a hardcoded config. Optional:
// a nil resolver (or a lookup error) leaves workspace_id unset, matching
// prior behavior — a missing default workspace must never block sign-in.
type WorkspaceResolver interface {
	DefaultWorkspaceID(ctx context.Context, tenantID uuid.UUID) (string, error)
}

// TokenVerifier verifies inbound platform JWTs. Implementations MUST accept
// only RS256/ES256 and reject alg=none (IDN-FR-045, AC-13).
type TokenVerifier interface {
	Verify(token string) (*Claims, error)
}

// OBORequest is the POST /token/obo body (IDN-FR-041).
type OBORequest struct {
	SubjectToken string `json:"subject_token"`
	AgentID      string `json:"agent_id"`
	AgentVersion string `json:"agent_version"`
	SessionID    string `json:"session_id"`
}

// AutonomousTokenRequest is the POST /token/agent body (IDN-FR-042).
type AutonomousTokenRequest struct {
	AgentID      string    `json:"agent_id"`
	AgentVersion string    `json:"version"`
	TenantID     uuid.UUID `json:"tenant_id"`
}

// TokenResponse is the issuance response shape.
type TokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}
