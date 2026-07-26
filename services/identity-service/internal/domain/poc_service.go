package domain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// DefaultPocWindowDays is used when a POST /poc-tenants caller omits
// window_days -- the roadmap's own "90-day playbook" (shadow -> proposal ->
// ROI report, docs/initiatives/demo-sandbox-poc-mode.md §1a) is the natural
// default, distinct from DemoService's 14-day sandbox TTL.
const DefaultPocWindowDays = 90

// PocService owns the POC-mode lifecycle use cases (BRD 70 §2.9,
// DSP-FR-020..022): create-with-criteria, criteria CRUD, live progress
// (actual-vs-target from BRD 69's real value data), and the poc-report.v1
// export. It composes TenantService (tenant creation) exactly like
// DemoService does, rather than duplicating tenant-creation logic.
type PocService struct {
	Store   Store
	Tenants *TenantService
	// Value reads usage-service's real value/summary data (BRD 69) to
	// compute progress. Nil is an honest "not configured" state: Progress
	// and ExportReport fail loud (EInternal) rather than fabricating
	// figures, mirroring DemoService.Bundles/Seed's "fail loud on nil
	// adapter" rule.
	Value ValueSummaryReader
	// Exports stores the poc-report.v1 JSON artifact (design §2.9,
	// "stored/checksummed like other audited exports"). Nil disables
	// ExportReport with the same fail-loud convention.
	Exports PocReportObjectStore
	Clock   func() time.Time
}

func (s *PocService) now() time.Time { return s.Clock().UTC() }

// PocReportObjectStore stores one poc-report.v1 artifact and returns a
// downloadable URL -- the identity-service-local mirror of usage-service's
// valueexport.ObjectStore (internal/pocexport implements the real adapter).
type PocReportObjectStore interface {
	Put(ctx context.Context, key string, data []byte, ttl time.Duration) (url string, expiresAt time.Time, err error)
}

// Create provisions a profile=poc tenant with commercial_state=trial
// (DSP-FR-020) and stores its declared success criteria. Optionally seeds a
// demo bundle for a walkable POC (Pack, reusing the SAME SeedDemoContent
// saga step DemoService.Create relies on -- the step is gated on
// t.Profile==ProfileDemo today; see the initiative doc's "Known limits" for
// why a bundle-seeded POC is deferred rather than silently half-wired).
func (s *PocService) Create(ctx context.Context, req CreatePocTenantRequest, actor Actor) (*Tenant, string, error) {
	if strings.TrimSpace(req.Sponsor) == "" {
		return nil, "", EValidation("sponsor is required", FieldError{Field: "sponsor", Message: "required"})
	}
	if len(req.SuccessCriteria) == 0 {
		return nil, "", EValidation("at least one success criterion is required",
			FieldError{Field: "success_criteria", Message: "must declare at least 1"})
	}
	if len(req.SuccessCriteria) > 3 {
		return nil, "", EValidation("at most 3 success criteria are supported",
			FieldError{Field: "success_criteria", Message: "declare 1-3 criteria"})
	}
	seen := map[string]bool{}
	for _, c := range req.SuccessCriteria {
		if err := c.Validate(); err != nil {
			return nil, "", err
		}
		if seen[c.Key] {
			return nil, "", EValidation("duplicate criterion key", FieldError{Field: "key", Message: c.Key})
		}
		seen[c.Key] = true
	}
	days := req.WindowDays
	if days <= 0 {
		days = DefaultPocWindowDays
	}
	t, _, err := s.Tenants.Create(ctx, CreateTenantRequest{
		Name: req.Name, DisplayName: req.DisplayName, OwnerEmail: req.OwnerEmail,
		Tier: firstNonEmpty(req.Tier, "pool"), Cloud: firstNonEmpty(req.Cloud, "aws"),
		Publish:   false, // publish explicitly below, after criteria are recorded
		Profile:   ProfilePOC,
		DemoPack:  req.Pack,
		TrialDays: days,
	}, actor)
	if err != nil {
		return nil, "", err
	}
	now := s.now()
	tev := newTrialEvent(t.ID, TrialEventStarted, days, "poc kickoff: "+req.Sponsor, actor.ID, now)
	trialEv := NewEvent(EvCommercialTrialStarted, t.ID, actor, t.URN(), now, map[string]any{
		"trial_days": days, "trial_ends_at": t.TrialEndsAt, "profile": string(ProfilePOC),
	})
	if err := s.Store.InsertTrialEvent(ctx, tev, trialEv); err != nil {
		return nil, "", err
	}
	criteriaEv := NewEvent(EvPocCriteriaSet, t.ID, actor, t.URN(), now, map[string]any{
		"criteria_count": len(req.SuccessCriteria), "sponsor": req.Sponsor,
	})
	if err := s.Store.SetPocSuccessCriteria(ctx, t.ID, req.SuccessCriteria, criteriaEv); err != nil {
		return nil, "", err
	}
	opID, err := s.Tenants.Publish(ctx, t.ID, actor)
	if err != nil {
		return nil, "", err
	}
	t2, err := s.Store.GetTenant(ctx, t.ID)
	if err != nil {
		return nil, "", err
	}
	return t2, opID, nil
}

// SetCriteria replaces a POC tenant's success criteria (operator edit after
// kickoff -- e.g. a criterion typo, or the sponsor and SE agreeing to amend
// scope). Only valid for profile=poc tenants.
func (s *PocService) SetCriteria(ctx context.Context, tenantID uuid.UUID, criteria []SuccessCriterion, actor Actor) error {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	if t.Profile != ProfilePOC {
		return EValidation("success criteria are only valid for profile=poc tenants",
			FieldError{Field: "profile", Message: string(t.Profile)})
	}
	if len(criteria) == 0 {
		return EValidation("at least one success criterion is required",
			FieldError{Field: "success_criteria", Message: "must declare at least 1"})
	}
	if len(criteria) > 3 {
		return EValidation("at most 3 success criteria are supported",
			FieldError{Field: "success_criteria", Message: "declare 1-3 criteria"})
	}
	seen := map[string]bool{}
	for _, c := range criteria {
		if err := c.Validate(); err != nil {
			return err
		}
		if seen[c.Key] {
			return EValidation("duplicate criterion key", FieldError{Field: "key", Message: c.Key})
		}
		seen[c.Key] = true
	}
	ev := NewEvent(EvPocCriteriaSet, tenantID, actor, t.URN(), s.now(), map[string]any{"criteria_count": len(criteria)})
	return s.Store.SetPocSuccessCriteria(ctx, tenantID, criteria, ev)
}

// GetCriteria returns a POC tenant's declared success criteria.
func (s *PocService) GetCriteria(ctx context.Context, tenantID uuid.UUID) ([]SuccessCriterion, error) {
	return s.Store.GetPocSuccessCriteria(ctx, tenantID)
}

// UpdateManualValue updates one manual-metric criterion's reported value
// (DSP-FR-021: "manual criteria updatable by sponsor with audit"). Rejects
// non-manual criteria -- a metric_ref pointed at real BRD 69 data must never
// be silently overridden by hand, or the dashboard would stop being honest.
func (s *PocService) UpdateManualValue(ctx context.Context, tenantID uuid.UUID, key string, value float64, actor Actor) error {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	criteria, err := s.Store.GetPocSuccessCriteria(ctx, tenantID)
	if err != nil {
		return err
	}
	found := false
	for _, c := range criteria {
		if c.Key == key {
			found = true
			if c.MetricRef != MetricManual {
				return EValidation("only manual criteria can be updated by hand",
					FieldError{Field: "metric_ref", Message: c.MetricRef})
			}
		}
	}
	if !found {
		return ENotFound("success criterion")
	}
	ev := NewEvent(EvPocManualValueUpdated, tenantID, actor, t.URN(), s.now(), map[string]any{
		"key": key, "value": value,
	})
	return s.Store.UpdatePocCriterionManualValue(ctx, tenantID, key, value, ev)
}

// Progress computes live actual-vs-target for every declared criterion
// (DSP-FR-021's success dashboard), reading real data: BRD 69's
// usage-service value/summary for metric_ref-backed criteria, the stored
// manual_value for MetricManual ones. Never fabricates a value when the
// underlying data is absent -- ActualValue stays nil and Outcome is
// "inconclusive" (the ROI-NFR-004 "real data or honest null" convention
// this initiative's task explicitly asks for).
func (s *PocService) Progress(ctx context.Context, tenantID uuid.UUID) (*PocProgress, error) {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if t.Profile != ProfilePOC {
		return nil, EValidation("progress is only valid for profile=poc tenants",
			FieldError{Field: "profile", Message: string(t.Profile)})
	}
	criteria, err := s.Store.GetPocSuccessCriteria(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	windowStart := t.CreatedAt
	if t.TrialStartedAt != nil {
		windowStart = *t.TrialStartedAt
	}
	windowEnd := s.now()
	if t.TrialEndsAt != nil {
		windowEnd = *t.TrialEndsAt
	}
	asOf := s.now()
	agg, meterGap, err := s.aggregateValueSummary(ctx, tenantID, windowStart, windowEnd, asOf)
	if err != nil {
		return nil, err
	}
	out := &PocProgress{TenantID: tenantID, WindowStart: windowStart, WindowEnd: windowEnd, AsOf: asOf}
	for _, c := range criteria {
		out.Criteria = append(out.Criteria, s.evaluateCriterion(c, agg, meterGap))
	}
	return out, nil
}

// valueAgg is the sum/latest-snapshot aggregate this build computes across
// every calendar month a POC window spans (see pocMonthsInWindow) -- decision
// counts and estimated value are additive across months; adoption is a
// snapshot, so the LATEST month with a value wins rather than summing users.
type valueAgg struct {
	decisionsTotal      *int64
	hoursSavedEstHours  *float64
	netValueEstUSD      *float64
	adoptionActiveUsers *int64
	lastRaw             map[string]any
	anyDataAvailable    bool
}

// aggregateValueSummary calls ValueSummaryReader once per calendar month in
// [windowStart, min(windowEnd, asOf)] and sums the additive fields. A field
// is only populated in the aggregate if EVERY queried month reported a
// non-nil value for it -- a partial sum presented as complete would be
// exactly the "invented number" the honesty convention forbids, so a single
// gap month makes that field's aggregate nil (surfaced via meter_gap).
func (s *PocService) aggregateValueSummary(ctx context.Context, tenantID uuid.UUID, windowStart, windowEnd, asOf time.Time) (*valueAgg, *string, error) {
	agg := &valueAgg{}
	if s.Value == nil {
		gap := "usage-service value/summary reader is not configured on this deployment"
		return agg, &gap, nil
	}
	months := pocMonthsInWindow(windowStart, windowEnd, asOf)
	if len(months) == 0 {
		gap := "POC window has not started yet"
		return agg, &gap, nil
	}
	var decisionsSum, hoursSum, netSum float64
	decisionsOK, hoursOK, netOK := true, true, true
	var lastGap *string
	for _, period := range months {
		view, err := s.Value.Summary(ctx, tenantID, period)
		if err != nil {
			gap := "usage-service value/summary unavailable: " + err.Error()
			return agg, &gap, nil
		}
		agg.anyDataAvailable = true
		agg.lastRaw = view.Raw
		if view.MeterGap != nil {
			lastGap = view.MeterGap
		}
		if view.DecisionsTotal != nil {
			decisionsSum += float64(*view.DecisionsTotal)
		} else {
			decisionsOK = false
		}
		if view.HoursSavedEstHours != nil {
			hoursSum += *view.HoursSavedEstHours
		} else {
			hoursOK = false
		}
		if view.NetValueEstUSD != nil {
			netSum += *view.NetValueEstUSD
		} else {
			netOK = false
		}
		if view.AdoptionActiveUsers != nil {
			agg.adoptionActiveUsers = view.AdoptionActiveUsers // latest snapshot wins
		}
	}
	if decisionsOK {
		d := int64(decisionsSum)
		agg.decisionsTotal = &d
	}
	if hoursOK {
		agg.hoursSavedEstHours = &hoursSum
	}
	if netOK {
		agg.netValueEstUSD = &netSum
	}
	return agg, lastGap, nil
}

func (s *PocService) evaluateCriterion(c SuccessCriterion, agg *valueAgg, meterGap *string) CriterionProgress {
	cp := CriterionProgress{SuccessCriterion: c}
	var actual *float64
	switch c.MetricRef {
	case MetricManual:
		actual = c.ManualValue
		cp.DataSource = "manual"
	case MetricDecisionsTotal:
		if agg.decisionsTotal != nil {
			v := float64(*agg.decisionsTotal)
			actual = &v
		}
		cp.DataSource = dataSourceOrGap(actual, meterGap)
	case MetricHoursSavedEst:
		actual = agg.hoursSavedEstHours
		cp.DataSource = dataSourceOrGap(actual, meterGap)
	case MetricNetValueEstUSD:
		actual = agg.netValueEstUSD
		cp.DataSource = dataSourceOrGap(actual, meterGap)
	case MetricAdoptionActiveUsers:
		if agg.adoptionActiveUsers != nil {
			v := float64(*agg.adoptionActiveUsers)
			actual = &v
		}
		cp.DataSource = dataSourceOrGap(actual, meterGap)
	default:
		cp.DataSource = "unknown metric_ref"
	}
	cp.ActualValue = actual
	if actual == nil {
		cp.Outcome = OutcomeInconclusive
		return cp
	}
	met := false
	switch c.Direction {
	case DirectionGTE:
		met = *actual >= c.Target
	case DirectionLTE:
		met = *actual <= c.Target
	}
	if met {
		cp.Outcome = OutcomeMet
	} else {
		cp.Outcome = OutcomeMissed
	}
	return cp
}

func dataSourceOrGap(actual *float64, meterGap *string) string {
	if actual != nil {
		return "usage-service value/summary"
	}
	if meterGap != nil {
		return *meterGap
	}
	return "no data for this period"
}

// ExportReport builds and stores a poc-report.v1 export (DSP-FR-022):
// recomputes Progress server-side (never trusts client-supplied figures,
// mirroring BRD 69's value-report.v1 export discipline), assembles the
// checksummed JSON document, and persists it through Exports + a new
// poc_exports row. Re-running for the same tenant inserts version N+1;
// prior versions are never overwritten.
func (s *PocService) ExportReport(ctx context.Context, tenantID uuid.UUID, actor Actor) (PocExport, error) {
	if s.Exports == nil {
		return PocExport{}, EInternal("poc report export is not configured on this deployment (Exports adapter unset)")
	}
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return PocExport{}, err
	}
	if t.Profile != ProfilePOC {
		return PocExport{}, EValidation("poc-report.v1 export is only valid for profile=poc tenants",
			FieldError{Field: "profile", Message: string(t.Profile)})
	}
	progress, err := s.Progress(ctx, tenantID)
	if err != nil {
		return PocExport{}, err
	}
	criteria, err := s.Store.GetPocSuccessCriteria(ctx, tenantID)
	if err != nil {
		return PocExport{}, err
	}
	descByKey := map[string]string{}
	for _, c := range criteria {
		descByKey[c.Key] = c.Description
	}
	var reportCriteria []PocReportCriterion
	var lastMeterGap *string
	for _, cp := range progress.Criteria {
		source := "manual"
		if cp.MetricRef != MetricManual {
			source = "brd69"
		}
		reportCriteria = append(reportCriteria, PocReportCriterion{
			Key: cp.Key, Description: descByKey[cp.Key], Target: cp.Target, Direction: cp.Direction,
			FinalValue: cp.ActualValue, Outcome: cp.Outcome, MetricSource: source,
		})
		if cp.ActualValue == nil && cp.MetricRef != MetricManual {
			gap := cp.DataSource
			lastMeterGap = &gap
		}
	}
	valueSummary := map[string]any{}
	agg, meterGap, err := s.aggregateValueSummary(ctx, tenantID, progress.WindowStart, progress.WindowEnd, progress.AsOf)
	if err != nil {
		return PocExport{}, err
	}
	if meterGap != nil {
		lastMeterGap = meterGap
	}
	if agg.lastRaw != nil {
		valueSummary = agg.lastRaw
	}

	now := s.now()
	report := PocReport{
		Schema:   PocReportSchema,
		TenantID: tenantID.String(),
		Window: PocReportWindow{
			Start: progress.WindowStart.Format(time.RFC3339),
			End:   progress.WindowEnd.Format(time.RFC3339),
		},
		Criteria:     reportCriteria,
		ValueSummary: valueSummary,
		MeterGap:     lastMeterGap,
		GeneratedAt:  now.Format(time.RFC3339),
		GeneratedBy:  actor.Type + ":" + actor.ID,
	}
	jsonBytes, checksum, err := checksummedJSON(report)
	if err != nil {
		return PocExport{}, EInternal("failed to build poc-report.v1: " + err.Error())
	}

	existing, err := s.Store.ListPocExports(ctx, tenantID)
	if err != nil {
		return PocExport{}, err
	}
	nextVersion := 1
	for _, e := range existing {
		if e.Version >= nextVersion {
			nextVersion = e.Version + 1
		}
	}
	key := "poc-reports/" + tenantID.String() + "/" + strconv.Itoa(nextVersion) + "/report.json"
	if _, _, err := s.Exports.Put(ctx, key, jsonBytes, 24*time.Hour); err != nil {
		return PocExport{}, err
	}
	ev := NewEvent(EvPocReportExported, tenantID, actor, t.URN(), now, map[string]any{
		"version": nextVersion, "json_sha256": checksum,
	})
	return s.Store.CreatePocExport(ctx, tenantID, PocExport{
		JSONKey: key, JSONSHA256: checksum, GeneratedBy: actor.Type + ":" + actor.ID,
	}, ev)
}

// ListExports returns a POC tenant's poc-report.v1 exports, newest first.
func (s *PocService) ListExports(ctx context.Context, tenantID uuid.UUID) ([]PocExport, error) {
	return s.Store.ListPocExports(ctx, tenantID)
}

// checksummedJSON marshals report with ChecksumSHA256 zeroed, hashes that
// output, then marshals again with the real checksum populated (design
// §2.9: "sha256 of this document with checksum_sha256 itself zeroed").
func checksummedJSON(report PocReport) ([]byte, string, error) {
	report.ChecksumSHA256 = ""
	zeroed, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(zeroed)
	checksum := hex.EncodeToString(sum[:])
	report.ChecksumSHA256 = checksum
	final, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return nil, "", err
	}
	return final, checksum, nil
}
