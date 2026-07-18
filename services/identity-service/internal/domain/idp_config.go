package domain

import (
	"time"

	"github.com/google/uuid"
)

// TenantIdpConfig is a tenant's own OIDC identity provider (BYO-P4). When set,
// an inbound ID token whose `iss` matches this issuer routes to THIS tenant at
// login — so each tenant brings their own Okta/Auth0/Entra/Keycloak rather than
// the whole deployment sharing one OIDC_ISSUER. DiscoveryURL is optional (it
// defaults to Issuer + "/.well-known/openid-configuration").
type TenantIdpConfig struct {
	TenantID     uuid.UUID
	Issuer       string
	ClientID     string
	DiscoveryURL string
	Enabled      bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Validate rejects an unusable IdP config before it is stored.
func (c *TenantIdpConfig) Validate() error {
	if c.Issuer == "" {
		return EValidation("issuer is required", FieldError{Field: "issuer", Message: "required"})
	}
	if !isHTTPSURL(c.Issuer) {
		return EValidation("issuer must be an https URL",
			FieldError{Field: "issuer", Message: "must be an https URL"})
	}
	if c.DiscoveryURL != "" && !isHTTPSURL(c.DiscoveryURL) {
		return EValidation("discovery_url must be an https URL",
			FieldError{Field: "discovery_url", Message: "must be an https URL"})
	}
	return nil
}

func isHTTPSURL(s string) bool {
	// http:// is allowed for localhost only (dev IdPs like a local Keycloak);
	// everything else must be https so a token is never verified over cleartext.
	if len(s) >= 8 && s[:8] == "https://" {
		return true
	}
	if len(s) >= 16 && s[:16] == "http://localhost" {
		return true
	}
	if len(s) >= 17 && s[:17] == "http://127.0.0.1:" {
		return true
	}
	return false
}
