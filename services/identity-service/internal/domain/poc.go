// POC mode domain types and ports (BRD 70 slice 3, DSP-FR-020..022). See
// docs/initiatives/demo-sandbox-poc-mode.md §2.9 "POC mode objects" for the
// success_criteria and poc-report.v1 schemas this file implements verbatim.
//
// POC tenants are profile=poc (tenant.go's TenantProfile, already shipped in
// slices 1/2) with commercial_state=trial and trial_ends_at set to the POC
// window's end -- DSP-FR-020's "reuses CPL-FR-020..023 machinery" -- rather
// than a fourth profile or a bolt-on state. Success criteria attach to the
// tenant (not to the trial machinery itself) because a POC's success bar is
// agreed once at kickoff and outlives any individual trial extension.
package domain

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Metric references a success criterion can point at (design §2.9:
// "metric_ref is a union -- either a BRD 69 metric identifier ... or
// manual"). These four names are the BRD 69 value/summary fields this
// build can honestly compute progress against today (decisions.total,
// hours_saved_est, net_value_est_usd, adoption.active_users) -- see
// ValueSummaryReader below. MetricManual is the escape hatch for a
// criterion BRD 69 has no metric for yet (e.g. a qualitative sponsor
// sign-off), sponsor-updated by hand and audited (DSP-FR-021).
const (
	MetricDecisionsTotal      = "decisions_total"
	MetricHoursSavedEst       = "hours_saved_est_hours"
	MetricNetValueEstUSD      = "net_value_est_usd"
	MetricAdoptionActiveUsers = "adoption_active_users"
	MetricManual              = "manual"
)

// ValidMetricRefs gates SetPocSuccessCriteria's write path.
var ValidMetricRefs = map[string]bool{
	MetricDecisionsTotal:      true,
	MetricHoursSavedEst:       true,
	MetricNetValueEstUSD:      true,
	MetricAdoptionActiveUsers: true,
	MetricManual:              true,
}

// Criterion directions: which side of Target counts as "met".
const (
	DirectionGTE = "gte" // actual >= target
	DirectionLTE = "lte" // actual <= target
)

var validDirections = map[string]bool{DirectionGTE: true, DirectionLTE: true}

// Criterion outcomes (design §2.9's poc-report.v1 schema, verbatim).
const (
	OutcomeMet          = "met"
	OutcomeMissed       = "missed"
	OutcomeInconclusive = "inconclusive" // actual value genuinely unavailable -- never fabricated (ROI-NFR-004 spirit)
)

// SuccessCriterion is one entry of DSP-FR-020's success_criteria[] --
// "{key, description, metric_ref, target, direction}" per BRD 70 §3 /
// design §2.9, verbatim field set. A POC tenant may declare 1-3 (the task's
// own framing) though nothing here hard-caps at 3 -- SetPocSuccessCriteria
// only requires at least one.
type SuccessCriterion struct {
	Key         string  `json:"key"`
	Description string  `json:"description"`
	MetricRef   string  `json:"metric_ref"`
	Target      float64 `json:"target"`
	Direction   string  `json:"direction"` // gte|lte
	// ManualValue is only meaningful when MetricRef==MetricManual --
	// sponsor-updatable by hand, audited (DSP-FR-021). nil means "not yet
	// reported", rendered as inconclusive, never a fabricated 0.
	ManualValue *float64 `json:"manual_value,omitempty"`
}

// Validate checks one criterion's shape (called by SetPocSuccessCriteria and
// unit-tested directly). Target is deliberately unconstrained in sign --
// "cost_per_decision <= $0.40" (AC-5) and "decisions >= 500" both need one
// validator, not two.
func (c SuccessCriterion) Validate() error {
	if strings.TrimSpace(c.Key) == "" {
		return EValidation("criterion key is required", FieldError{Field: "key", Message: "required"})
	}
	if strings.TrimSpace(c.Description) == "" {
		return EValidation("criterion description is required", FieldError{Field: "description", Message: "required"})
	}
	if !ValidMetricRefs[c.MetricRef] {
		return EValidation("invalid metric_ref", FieldError{Field: "metric_ref",
			Message: "must be one of decisions_total|hours_saved_est_hours|net_value_est_usd|adoption_active_users|manual"})
	}
	if !validDirections[c.Direction] {
		return EValidation("invalid direction", FieldError{Field: "direction", Message: "must be gte|lte"})
	}
	return nil
}

// CreatePocTenantRequest is POST /poc-tenants's body (DSP-FR-020).
type CreatePocTenantRequest struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	OwnerEmail  string `json:"owner_email"`
	// Pack optionally names a deploy/demo/<pack>/ bundle to seed synthetic
	// walkable content for the POC, exactly like a demo tenant (DSP-FR-020's
	// "{pack?, ...}" -- optional because a POC may instead run entirely on
	// the prospect's own real data as a standard-profile trial, per
	// DSP-FR-022's "conversion follows ... CPL convert if the POC ran on the
	// customer's real data"; that path is out of this build's scope -- see
	// the initiative doc's honesty note).
	Pack            string             `json:"pack,omitempty"`
	Tier            string             `json:"tier,omitempty"`
	Cloud           string             `json:"cloud,omitempty"`
	WindowDays      int                `json:"window_days"`
	Sponsor         string             `json:"sponsor"`
	SuccessCriteria []SuccessCriterion `json:"success_criteria"`
}

// PocTenantPlanKey is the plan a POC tenant is assigned at creation, purely
// for entitlement defaults (seat_cap/workspace_cap) -- mirrors
// DemoTenantPlanKey's role for profile=demo. POC tenants use the same
// internal-demo plan as demo tenants: neither is a paying relationship yet
// (commercial_state=trial carries no billing implication on its own until
// TrialService.Convert moves it to active), and BRD 66 seeds no
// POC-specific plan. See docs/initiatives/demo-sandbox-poc-mode.md §3 for
// why this reuses internal-demo rather than inventing a new seeded plan.
const PocTenantPlanKey = DemoTenantPlanKey

// CriterionProgress pairs a declared SuccessCriterion with its live
// actual-vs-target read (DSP-FR-021's success dashboard). ActualValue is nil
// whenever the underlying data is genuinely absent (a manual criterion never
// reported, or a BRD 69 metric_ref whose value/summary field came back null)
// -- Outcome is then "inconclusive", never a fabricated "missed" or a
// fabricated 0-vs-target comparison. This is the ROI-NFR-004 "real data or
// honest null" convention applied to POC progress.
type CriterionProgress struct {
	SuccessCriterion
	ActualValue *float64 `json:"actual_value"`
	Outcome     string   `json:"outcome"`
	// DataSource records where ActualValue came from (or why it's absent) --
	// "usage-service value/summary", "manual", or an explicit gap reason
	// (e.g. "usage-service unreachable", "governed_decision meter not
	// emitted yet (BRD 67 VMB-FR-001)" -- the latter is carried straight
	// from usage-service's own provenance.meter_gap, never re-worded).
	DataSource string `json:"data_source"`
}

// PocProgress is GET /tenants/{id}/poc/progress's response (DSP-FR-021).
type PocProgress struct {
	TenantID    uuid.UUID           `json:"tenant_id"`
	WindowStart time.Time           `json:"window_start"`
	WindowEnd   time.Time           `json:"window_end"`
	AsOf        time.Time           `json:"as_of"`
	Criteria    []CriterionProgress `json:"criteria"`
}

// PocReportCriterion is one entry of poc-report.v1's criteria[] (design
// §2.9: "{key, target, direction, final_value, outcome(met|missed|
// inconclusive), metric_source(brd69|manual)}", verbatim).
type PocReportCriterion struct {
	Key          string   `json:"key"`
	Description  string   `json:"description"`
	Target       float64  `json:"target"`
	Direction    string   `json:"direction"`
	FinalValue   *float64 `json:"final_value"`
	Outcome      string   `json:"outcome"`
	MetricSource string   `json:"metric_source"` // "brd69" | "manual"
}

// PocReportSchema is the poc-report.v1 export's schema tag (DSP-FR-022).
const PocReportSchema = "poc-report.v1"

// PocReport is the poc-report.v1 export document (design §2.9, verbatim
// field set): "{tenant_id, window{start,end}, criteria[...], value_summary
// (BRD 69's assumption-labeled figures, carried through verbatim -- never
// re-derived), assumptions_snapshot, generated_at, checksum}". ValueSummary
// is stored as the raw decoded usage-service response (map[string]any) so
// every field usage-service returns -- including fields this build doesn't
// otherwise interpret -- survives into the export untouched, matching BRD
// 69's "every derived figure displays its inputs" honesty rule.
type PocReport struct {
	Schema       string               `json:"schema"`
	TenantID     string               `json:"tenant_id"`
	Window       PocReportWindow      `json:"window"`
	Sponsor      string               `json:"sponsor,omitempty"`
	Criteria     []PocReportCriterion `json:"criteria"`
	ValueSummary map[string]any       `json:"value_summary"`
	// MeterGap surfaces (never hides) the reason value_summary may be
	// partial/absent for any queried period -- carried from usage-service's
	// own provenance.meter_gap, the last one seen across the window if
	// several periods disagree.
	MeterGap            *string `json:"meter_gap,omitempty"`
	AssumptionsSnapshot any     `json:"assumptions_snapshot,omitempty"`
	GeneratedAt         string  `json:"generated_at"`
	GeneratedBy         string  `json:"generated_by"`
	// ChecksumSHA256 is computed over this document with ChecksumSHA256
	// itself zeroed (design §2.9), mirroring value-report.v1's own
	// checksum discipline.
	ChecksumSHA256 string `json:"checksum_sha256"`
}

// PocReportWindow is poc-report.v1's window{start,end} (design §2.9).
type PocReportWindow struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// PocExport is a row in poc_exports (DSP-FR-022: "stored/checksummed like
// other audited exports"), mirroring usage-service's ValueExport shape
// (internal/store/value_exports.go) -- the one proven precedent for this
// exact requirement, per the design's own "flagged as an integration point
// to confirm at implementation time" note.
type PocExport struct {
	ID          uuid.UUID `json:"id"`
	TenantID    uuid.UUID `json:"tenant_id"`
	Version     int       `json:"version"`
	JSONKey     string    `json:"json_key"`
	JSONSHA256  string    `json:"json_sha256"`
	GeneratedBy string    `json:"generated_by"`
	CreatedAt   time.Time `json:"created_at"`
}

// ValueSummaryView is the subset of usage-service's GET /api/v1/value/summary
// response this build reads to compute POC progress (BRD 69's ValueSummary,
// internal/domain/value.go in usage-service -- NOT imported directly, since
// services don't share Go packages across DB-per-service boundaries; this is
// a hand-decoded mirror of the wire shape). Raw carries the full decoded
// JSON body so PocReport.ValueSummary can embed it verbatim, per the
// "never re-derived" rule above.
type ValueSummaryView struct {
	Period              string
	DecisionsTotal      *int64
	HoursSavedEstHours  *float64
	NetValueEstUSD      *float64
	AdoptionActiveUsers *int64
	AssumptionVersion   *int
	MeterGap            *string
	Raw                 map[string]any
}

// ValueSummaryReader is the port to usage-service's real value/summary API
// (BRD 69, GET /api/v1/value/summary) -- the same "honest optional adapter"
// convention DemoBundleLoader/DemoSeedRunner already use (nil is a legitimate
// "not configured" deployment state; Progress/Export fail loud with
// EInternal rather than fabricating figures). The production adapter
// (internal/adapters/valueclient) drives the real HTTP API under a
// short-lived service token, mirroring internal/rbacclient's pattern for
// calling rbac-service.
type ValueSummaryReader interface {
	// Summary reads one calendar-month period ("YYYY-MM", matching
	// usage-service's own period grain -- see design §2.3) for tenantID.
	Summary(ctx context.Context, tenantID uuid.UUID, period string) (*ValueSummaryView, error)
}

// pocMonthsInWindow enumerates the "YYYY-MM" periods a POC window spans, up
// to asOf (never querying future months). Used by PocService.Progress/
// ExportReport to aggregate usage-service's per-month summary across the
// whole POC window, since GET /value/summary is period-scoped (design §2.3)
// with no built-in date-range aggregate.
func pocMonthsInWindow(start, end, asOf time.Time) []string {
	if end.After(asOf) {
		end = asOf
	}
	if end.Before(start) {
		return nil
	}
	var months []string
	cur := time.Date(start.Year(), start.Month(), 1, 0, 0, 0, 0, time.UTC)
	last := time.Date(end.Year(), end.Month(), 1, 0, 0, 0, 0, time.UTC)
	for !cur.After(last) {
		months = append(months, cur.Format("2006-01"))
		cur = cur.AddDate(0, 1, 0)
	}
	return months
}
