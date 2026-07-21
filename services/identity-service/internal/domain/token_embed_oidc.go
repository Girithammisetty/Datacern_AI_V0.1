package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// EmbedOIDCRequest is the POST /token/embed/oidc body (task #84, embed-federated
// SSO). Unlike /token/embed — where the tenant's backend presents a shared
// secret and ASSERTS the user's `sub` — here the USER's own OIDC ID token (from
// the tenant's IdP) proves their identity. No shared secret: the verified
// id_token IS the credential, so the embedded surface renders as the real user.
type EmbedOIDCRequest struct {
	TenantID    string   `json:"tenant_id"`
	IDToken     string   `json:"id_token"`
	WorkspaceID string   `json:"workspace_id"`
	Scopes      []string `json:"scopes"`
	Surface     []string `json:"surface"`
	TTLSeconds  int      `json:"ttl_seconds"`
}

// EmbedOIDCExchange implements POST /token/embed/oidc (task #84): verify the
// user's OIDC ID token against the IdP, bind it to a real Datacern user WITHIN
// the requested tenant (by email), and mint the same short-lived, workspace-
// scoped embed token /token/embed produces — but authenticated by federation,
// not a shared secret. The tenant's embed config still supplies the allowed
// frame-ancestors (and gates that embed is enabled for the tenant), so only
// registered origins can frame the surface. Increment 1 verifies against the
// deployment IdP; per-tenant IdP config is the documented generalization.
func (s *TokenService) EmbedOIDCExchange(ctx context.Context, req EmbedOIDCRequest, traceID string) (*TokenResponse, error) {
	if s.IDP == nil {
		return nil, EValidation("embed OIDC federation is not enabled on this deployment")
	}
	if req.TenantID == "" || req.IDToken == "" || req.WorkspaceID == "" {
		return nil, EValidation("tenant_id, id_token and workspace_id are required")
	}
	tenantID, err := uuid.Parse(req.TenantID)
	if err != nil {
		return nil, EValidation("tenant_id must be a uuid")
	}
	surface := make([]string, 0, len(req.Surface))
	for _, sfc := range req.Surface {
		if KnownEmbedSurfaces[sfc] {
			surface = append(surface, sfc)
		}
	}
	if len(surface) == 0 {
		return nil, EValidation("surface must include one of dashboard, cases, copilot")
	}

	ident, err := s.IDP.VerifyIDToken(ctx, req.IDToken)
	if err != nil {
		return nil, EUnauthenticated("invalid id_token")
	}
	if ident.Email == "" {
		return nil, EUnauthenticated("id_token has no email claim to resolve a user")
	}

	// Embed must be configured for the tenant (supplies frame_ancestors and
	// gates that embedding is enabled at all). Uniform failure — no oracle.
	cfg, err := s.Store.GetTenantEmbedConfig(ctx, tenantID)
	if err != nil || cfg == nil {
		return nil, EUnauthenticated("invalid embed credentials")
	}
	tenant, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, EUnauthenticated("invalid embed credentials")
	}
	if err := tenantIssuable(tenant); err != nil {
		return nil, err
	}

	// Bind the verified OIDC identity to a real user IN THIS TENANT: an identity
	// from another tenant's directory cannot embed here even with a valid token.
	user, err := s.Store.GetUserByEmail(ctx, tenantID, ident.Email)
	if err != nil {
		return nil, EPermissionDenied("no datacern user is provisioned for this identity in the tenant")
	}
	if user.Status == UserDeactivated || user.DeletedAt != nil {
		return nil, EPermissionDenied("user is deactivated")
	}

	ttl := EmbedTokenDefaultTTL
	if req.TTLSeconds > 0 {
		ttl = time.Duration(req.TTLSeconds) * time.Second
	}
	if ttl < EmbedTokenMinTTL {
		ttl = EmbedTokenMinTTL
	}
	if ttl > EmbedTokenMaxTTL {
		ttl = EmbedTokenMaxTTL
	}
	scopes := req.Scopes
	if len(scopes) == 0 {
		scopes = []string{"chart.dashboard.read"}
	}

	tok, expiresIn, err := s.Issuer.IssueWithTTL(Claims{
		Subject:        user.ID.String(),
		TenantID:       tenantID,
		Typ:            TypUser,
		Scopes:         scopes,
		WorkspaceID:    req.WorkspaceID,
		Embed:          true,
		Surface:        surface,
		FrameAncestors: cfg.AllowedOrigins,
	}, ttl)
	if err != nil {
		return nil, err
	}
	ev := NewEvent("identity.embed_token_issued", tenantID,
		Actor{Type: "user", ID: user.ID.String()}, PlatformURN("tenant", tenantID.String()), s.now(),
		map[string]any{"surface": surface, "workspace_id": req.WorkspaceID, "ttl_seconds": int(ttl.Seconds()), "federated": true})
	ev.TraceID = traceID
	_ = s.Store.AppendOutbox(ctx, ev)
	return &TokenResponse{AccessToken: tok, TokenType: "Bearer", ExpiresIn: expiresIn}, nil
}
