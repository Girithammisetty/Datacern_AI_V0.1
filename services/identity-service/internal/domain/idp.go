package domain

import "context"

// NormalizedIdentity is the vendor-neutral shape an IdentityProvider returns
// after verifying an external OIDC identity assertion (BYO-P4). Every IdP
// adapter — generic OIDC, and Keycloak/Okta/Auth0/Entra as configurations of
// it — normalizes to this, so the "external login → Windrose session" mapping
// stays provider-agnostic.
type NormalizedIdentity struct {
	Subject string         // the IdP's stable subject id (`sub`)
	Email   string         // primary email — resolves the Windrose user
	Name    string         // display name, best-effort
	Claims  map[string]any // the raw verified ID-token claims (for claims-mapping)
}

// IdentityProvider verifies an external OIDC ID token against the IdP's own
// published keys and returns the normalized identity. It is deliberately
// narrow: the OAuth authorization-code + PKCE dance runs in the web tier, and
// identity-service only VERIFIES the resulting assertion and maps it to a
// Windrose session — session-JWT minting stays on this side of the trust
// boundary (BYO-P4, docs/design/byo-infra-hardening.md).
type IdentityProvider interface {
	// VerifyIDToken validates the ID token's RS256 signature (via the IdP's
	// JWKS), issuer, audience and expiry, returning the normalized identity.
	VerifyIDToken(ctx context.Context, rawIDToken string) (*NormalizedIdentity, error)
	// Issuer is the expected `iss` this provider trusts (for diagnostics).
	Issuer() string
}
