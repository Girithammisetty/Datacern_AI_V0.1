// Package domain holds the core business logic of identity-service:
// entities, state machines, validation rules, token issuance rules, the
// provisioning engine, and the repository interfaces the stores implement.
//
// The package depends only on the standard library plus uuid/argon2 so the
// full unit-test tier runs with no external dependencies (CONVENTIONS.md tier 1).
package domain

import (
	"errors"
	"fmt"
)

// Stable machine-readable error codes (MASTER-FR-024).
const (
	CodeValidationFailed  = "VALIDATION_FAILED"
	CodeNotFound          = "NOT_FOUND"
	CodeConflict          = "CONFLICT"
	CodePermissionDenied  = "PERMISSION_DENIED"
	CodeRateLimited       = "RATE_LIMITED"
	CodeUnauthenticated   = "UNAUTHENTICATED"
	CodeInternal          = "INTERNAL"
	CodeTenantSuspended   = "TENANT_SUSPENDED"
	CodeAgentDisabled     = "AGENT_DISABLED"
	CodeInvitationExpired = "INVITATION_EXPIRED"
	CodeCellCapacity      = "CELL_CAPACITY"
	CodeNotImplemented    = "NOT_IMPLEMENTED"

	// Commercial plane stable error codes (BRD 66, CPL-FR-012/020/031,
	// MASTER-FR-024). Defined in slice 1 even though the enforcement hooks
	// that raise them (pack-service install gate, seat/workspace cap checks,
	// trial-expired write block) are slice 3 -- the design's slice plan calls
	// for the codes to exist now so consumers can code against them early.
	CodeEntitlementRequired    = "ENTITLEMENT_REQUIRED"
	CodeTrialExpired           = "TRIAL_EXPIRED"
	CodeCapExceeded            = "CAP_EXCEEDED"
	CodeEntitlementUnavailable = "ENTITLEMENT_UNAVAILABLE"

	// CodeProvisioningFailed (BRD 70 v1.1, self-serve demo signup): the
	// tenant's provisioning saga hit a terminal, non-retryable-by-the-visitor
	// failure (TenantProvisionFailed). Distinct from a plain 202 "still
	// provisioning" response -- see ClaimSelfServeLogin.
	CodeProvisioningFailed = "PROVISIONING_FAILED"
)

// Error is the domain error type. The API layer maps it onto the master BRD
// error envelope {error:{code,message,details,trace_id}} (MASTER-FR-024).
type Error struct {
	Code    string
	HTTP    int
	Message string
	Details any
	// RetryAfterSeconds is set for RATE_LIMITED errors (AC-14).
	RetryAfterSeconds int
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// FieldError is one entry of a VALIDATION_FAILED details list (MASTER-FR-024).
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func EValidation(msg string, fields ...FieldError) *Error {
	var det any
	if len(fields) > 0 {
		det = fields
	}
	return &Error{Code: CodeValidationFailed, HTTP: 422, Message: msg, Details: det}
}

func ENotFound(what string) *Error {
	return &Error{Code: CodeNotFound, HTTP: 404, Message: what + " not found"}
}

func EConflict(msg string) *Error {
	return &Error{Code: CodeConflict, HTTP: 409, Message: msg}
}

func EPermissionDenied(msg string) *Error {
	return &Error{Code: CodePermissionDenied, HTTP: 403, Message: msg}
}

func EUnauthenticated(msg string) *Error {
	return &Error{Code: CodeUnauthenticated, HTTP: 401, Message: msg}
}

func ETenantSuspended() *Error {
	return &Error{Code: CodeTenantSuspended, HTTP: 403, Message: "tenant is suspended"}
}

func EAgentDisabled(msg string) *Error {
	return &Error{Code: CodeAgentDisabled, HTTP: 403, Message: msg}
}

func EInvitationExpired() *Error {
	return &Error{
		Code: CodeInvitationExpired, HTTP: 410,
		Message: "invitation has expired",
		Details: map[string]string{"hint": "ask a tenant admin to resend the invitation via POST /api/v1/users/{id}/invite/resend"},
	}
}

func ERateLimited(retryAfterSeconds int) *Error {
	return &Error{Code: CodeRateLimited, HTTP: 429, Message: "rate limit exceeded", RetryAfterSeconds: retryAfterSeconds}
}

func EInternal(msg string) *Error {
	return &Error{Code: CodeInternal, HTTP: 500, Message: msg}
}

func ENotImplemented(msg string) *Error {
	return &Error{Code: CodeNotImplemented, HTTP: 501, Message: msg}
}

// EEntitlementRequired: a commercial gate blocked a write because the tenant
// lacks a required pack_sku entitlement (CPL-FR-012/030, AC-1). 403, listing
// the missing SKU (design doc "Enforcement hook contracts").
func EEntitlementRequired(missingSKU string) *Error {
	return &Error{
		Code: CodeEntitlementRequired, HTTP: 403,
		Message: "entitlement required: " + missingSKU,
		Details: map[string]string{"missing_sku": missingSKU},
	}
}

// ETrialExpired: a write was attempted by a tenant whose trial has expired
// and moved to suspended_commercial (CPL-FR-022, AC-2). 403; reads still
// succeed (NFR-004 fail-open-on-read).
func ETrialExpired() *Error {
	return &Error{Code: CodeTrialExpired, HTTP: 403, Message: "trial has expired"}
}

// ECapExceeded: a seat_cap/workspace_cap gate blocked a write (CPL-FR-031,
// AC-3). 403, current/limit in the details envelope.
func ECapExceeded(current, limit int) *Error {
	return &Error{
		Code: CodeCapExceeded, HTTP: 403,
		Message: "capacity exceeded",
		Details: map[string]int{"current": current, "limit": limit},
	}
}

// EEntitlementUnavailable: the entitlements_flat projection could not be read
// and the caller is on the fail-closed side of NFR-004 (entitlement-gated
// writes; reads instead fail open and proceed unchecked).
func EEntitlementUnavailable() *Error {
	return &Error{Code: CodeEntitlementUnavailable, HTTP: 503, Message: "entitlement projection unavailable"}
}

// EDemoSignupAtCapacity: the self-serve demo signup concurrency ceiling
// (BRD 70 v1.1, PublicSignup's cap parameter) has been reached. Reuses
// CodeCapExceeded (the same stable machine-readable code CAP_EXCEEDED
// callers already know from seat_cap/workspace_cap, CPL-FR-031) but as a
// 503, not a 403: this is a transient resource ceiling that clears on its
// own as the TTL reaper expires older self-serve tenants, not a permission
// decision -- "at capacity, try again later", never a silent degrade.
func EDemoSignupAtCapacity(current, limit int) *Error {
	return &Error{
		Code: CodeCapExceeded, HTTP: 503,
		Message: "self-serve demo capacity reached, please try again later",
		Details: map[string]int{"current": current, "limit": limit},
	}
}

// EDemoProvisioningFailed: a self-serve demo tenant's provisioning saga
// reached TenantProvisionFailed (a terminal state -- ProvisioningEngine
// already exhausted its own retries per step before landing here). 500, not
// 202: this used to be indistinguishable from "still provisioning" in
// ClaimSelfServeLogin, which left the /live-demo poller spinning for up to
// SelfServeClaimTTL (30 min) before a misleading "link expired" message.
func EDemoProvisioningFailed() *Error {
	return &Error{
		Code: CodeProvisioningFailed, HTTP: 500,
		Message: "demo tenant provisioning failed; please try again",
	}
}

// AsError unwraps err into a *domain.Error if possible.
func AsError(err error) (*Error, bool) {
	var de *Error
	if errors.As(err, &de) {
		return de, true
	}
	return nil, false
}
