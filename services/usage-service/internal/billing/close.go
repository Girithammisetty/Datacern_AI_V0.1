package billing

import (
	"fmt"

	"github.com/datacern-ai/usage-service/internal/domain"
)

// The close-gate decision (value-metering-billing-export design §2.6). This is
// the pure ordering logic the advisory-lock close job wraps: given the month's
// finalization + reconciliation state and what's already been closed, decide
// whether to close now and at what version. Extracted as a pure function so the
// gate is unit-testable without Postgres (the same discipline as jobs.go's scan
// logic being testable against the store).

// CloseInputs is the state the close job reads before closing a period.
type CloseInputs struct {
	// MonthFinalized is usage_monthly.finalized_at being set — the period is
	// past the 48h late-event window (USG-FR-014) and its rollups are frozen.
	MonthFinalized bool
	// ReconStatus is the reconciliation status for the month (domain.Recon*).
	// Closing is blocked while a provider-bill variance is unresolved.
	ReconStatus string
	// PriorVersion is the highest existing billing_periods.version for this
	// (tenant, period); 0 when the period has never been closed.
	PriorVersion int
	// Corrected is true when a correction trigger (usage.month_refinalized or a
	// late adjustment landing after PriorVersion closed) fired — the signal that
	// a new version is warranted for an already-closed period.
	Corrected bool
}

// CloseDecision is the gate's verdict.
type CloseDecision struct {
	ShouldClose bool
	Version     int    // the version to write when ShouldClose
	Reason      string // why not, when !ShouldClose (for the skip log)
}

// reconSettled reports whether a reconciliation status permits billing close.
// Matches BRD 17 §4: variance blocks; pending is not yet settled; matched,
// adjusted and acknowledged all clear (the same condition chargeback export is
// already gated on).
func reconSettled(status string) bool {
	switch status {
	case domain.ReconMatched, domain.ReconAdjusted, domain.ReconAcknowledged:
		return true
	default:
		return false
	}
}

// DecideClose applies the §2.6 ordering rules:
//   - the month must be finalized (past the late-event window);
//   - reconciliation must be settled (not pending, not variance);
//   - a never-closed period closes at v1;
//   - an already-closed period closes again only on a correction, at v+1;
//   - an already-closed, uncorrected period is a no-op.
//
// It never decides to close twice for the same state, so running it on every
// replica is safe — the advisory lock only prevents two replicas racing the
// same version insert, it is not what makes the decision correct.
func DecideClose(in CloseInputs) CloseDecision {
	if !in.MonthFinalized {
		return CloseDecision{Reason: "month not finalized (still within the late-event window)"}
	}
	if in.ReconStatus == domain.ReconVariance {
		return CloseDecision{Reason: "reconciliation variance unresolved — close blocked (BRD 17 §4)"}
	}
	if !reconSettled(in.ReconStatus) {
		return CloseDecision{Reason: fmt.Sprintf("reconciliation not settled (status %q)", in.ReconStatus)}
	}
	if in.PriorVersion <= 0 {
		return CloseDecision{ShouldClose: true, Version: 1}
	}
	if in.Corrected {
		return CloseDecision{ShouldClose: true, Version: in.PriorVersion + 1}
	}
	return CloseDecision{Reason: fmt.Sprintf("already closed at v%d, no correction pending", in.PriorVersion)}
}
