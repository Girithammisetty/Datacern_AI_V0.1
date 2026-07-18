package domain

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

// maxLabelKey / maxLabelValue bound a display-label override so a pack (or a
// tenant admin) cannot store unbounded text as a UI string.
const (
	maxLabelKey   = 128
	maxLabelValue = 200
)

// DisplayLabel is one per-tenant UI label override (BRD 23 inc3). Key is a
// ui-web i18n key (e.g. "cases.title"); Value is the string the app overlays
// onto its base catalog for this tenant. Platform-scoped (keyed by tenant), not
// RLS-partitioned — the whole tenant sees the same labels.
type DisplayLabel struct {
	TenantID  uuid.UUID
	Key       string
	Value     string
	UpdatedAt time.Time
	UpdatedBy string
}

// ValidateDisplayLabel rejects an unusable key/value before it is stored.
func ValidateDisplayLabel(key, value string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return EValidation("label key is required",
			FieldError{Field: "key", Message: "required"})
	}
	if len(key) > maxLabelKey {
		return EValidation("label key too long",
			FieldError{Field: "key", Message: "too long"})
	}
	// i18n keys are dotted lower identifiers (cases.title, nav.cases); keep the
	// charset tight so a key can safely ride a URL path segment on delete.
	for _, r := range key {
		ok := r == '.' || r == '_' || r == '-' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9')
		if !ok {
			return EValidation("label key has invalid characters",
				FieldError{Field: "key", Message: "only letters, digits, '.', '_', '-'"})
		}
	}
	if strings.TrimSpace(value) == "" {
		return EValidation("label value is required",
			FieldError{Field: "value", Message: "required"})
	}
	if len(value) > maxLabelValue {
		return EValidation("label value too long",
			FieldError{Field: "value", Message: "too long"})
	}
	return nil
}
