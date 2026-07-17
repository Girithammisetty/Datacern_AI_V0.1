package domain

import (
	"context"

	"github.com/google/uuid"
)

// OIDCLoginRequest carries the ID token the web tier obtained from the tenant's
// OIDC IdP after the authorization-code + PKCE exchange (BYO-P4).
type OIDCLoginRequest struct {
	IDToken string `json:"id_token"`
}

// OIDCLogin implements the real interactive-login half of BYO-P4: it verifies an
// external OIDC ID token against the IdP's own keys, resolves it to the Windrose
// user by email within the deployment's bound tenant, and mints the platform
// session JWT. A first successful SSO login activates an invited account and
// links the IdP subject. Downstream authorization runs off the RBAC projection
// (not JWT scopes), so the minted token carries identity + tenant and an empty
// scope list; capabilities are resolved per-request from Redis.
func (s *TokenService) OIDCLogin(ctx context.Context, req OIDCLoginRequest, traceID string) (*TokenResponse, error) {
	if s.IDP == nil || s.OIDCTenantID == uuid.Nil {
		return nil, EValidation("oidc login is not enabled on this deployment")
	}
	if req.IDToken == "" {
		return nil, EValidation("id_token is required", FieldError{Field: "id_token", Message: "required"})
	}
	ident, err := s.IDP.VerifyIDToken(ctx, req.IDToken)
	if err != nil {
		return nil, EUnauthenticated("invalid id_token")
	}
	if ident.Email == "" {
		return nil, EUnauthenticated("id_token has no email claim to resolve a user")
	}

	tenant, err := s.Store.GetTenant(ctx, s.OIDCTenantID)
	if err != nil {
		return nil, EPermissionDenied("unknown tenant")
	}
	if err := tenantIssuable(tenant); err != nil {
		return nil, err
	}

	user, err := s.Store.GetUserByEmail(ctx, s.OIDCTenantID, ident.Email)
	if err != nil {
		// No pre-provisioned Windrose user for this verified identity. JIT
		// provisioning is a documented follow-up; for now deny cleanly.
		return nil, EPermissionDenied("no windrose user is provisioned for this identity")
	}
	if user.Status == UserDeactivated || user.DeletedAt != nil {
		return nil, EPermissionDenied("user is deactivated")
	}

	// First SSO login accepts the invitation and binds the IdP subject so
	// subsequent logins (and DisableUser/RevokeSessions) can key on it.
	now := s.now()
	dirty := false
	if user.Status == UserInvited {
		user.Status = UserActive
		dirty = true
	}
	if user.IdpSubject == nil || *user.IdpSubject != ident.Subject {
		sub := ident.Subject
		user.IdpSubject = &sub
		dirty = true
	}
	user.LastLoginAt = &now
	if dirty {
		user.UpdatedAt = now
	}
	// Best-effort: a login must not fail because the profile write lagged.
	_ = s.Store.UpdateUser(ctx, user)

	tok, expiresIn, err := s.Issuer.Issue(Claims{
		Subject:  user.ID.String(),
		TenantID: tenant.ID,
		Typ:      TypUser,
		Scopes:   []string{},
	})
	if err != nil {
		return nil, err
	}
	return &TokenResponse{AccessToken: tok, TokenType: "Bearer", ExpiresIn: expiresIn}, nil
}
