package domain

import (
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// TenantBranding is a tenant's white-label identity (BRD 59 WS3): an optional
// logo asset (bytes live in object storage; this row only tracks the key +
// content type) and primary/accent color tokens. Platform-scoped like
// TenantEmbedConfig/DisplayLabel (one row per tenant, no RLS).
type TenantBranding struct {
	TenantID        uuid.UUID
	LogoObjectKey   string
	LogoContentType string
	PrimaryColor    string
	AccentColor     string
	UpdatedAt       time.Time
	UpdatedBy       string
}

// hslTriplet matches an HSL color triplet in the exact shape
// services/ui-web/src/app/globals.css's CSS custom properties expect, e.g.
// "221 83% 53%" or "221.5 83% 53%" -- H (0-360, optional decimal), S%, L%.
var hslTriplet = regexp.MustCompile(`^\d{1,3}(\.\d+)?\s+\d{1,3}(\.\d+)?%\s+\d{1,3}(\.\d+)?%$`)

// ValidateBrandColor rejects anything that is not a bare "H S% L%" triplet --
// this string is later interpolated directly into a CSS custom property value
// (`--primary: <value>`), so anything else (a full hsl(...)/rgb(...) call, a
// stray semicolon, a "}") could break out of the property or inject other CSS.
// An empty string is valid (it means "unset / use the platform default").
func ValidateBrandColor(field, s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if len(s) > 32 || !hslTriplet.MatchString(s) {
		return EValidation(field+` must be an "H S% L%" HSL triplet, e.g. "221 83% 53%"`,
			FieldError{Field: field, Message: "invalid HSL triplet"})
	}
	return nil
}
