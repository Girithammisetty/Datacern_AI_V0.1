package domain

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

// CaseTrigger is a tenant-authored event rule (realtime-decisioning INC-1):
// when an ingestion completes into a matching dataset, rows passing Conditions
// are materialized as cases through the same CreateCases path the inference
// auto-case consumer uses. Triggers only create work — they never decide, so
// four-eyes governance on AI proposals is untouched.
type CaseTrigger struct {
	ID          uuid.UUID `json:"id"`
	TenantID    uuid.UUID `json:"-"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Name        string    `json:"name"`
	Enabled     bool      `json:"enabled"`
	// Source match: exact dataset URN, or the target dataset name carried on
	// the ingestion.completed payload (for new_dataset ingestions). At least
	// one is required.
	DatasetURN  string `json:"dataset_urn,omitempty"`
	DatasetName string `json:"dataset_name,omitempty"`
	// Conditions are pushed down to dataset-service browse_rows verbatim as
	// filter=<col>:<op>:<value>.
	Conditions []TriggerCondition `json:"conditions"`
	// RowPKField names the row column whose value becomes the case row_pk
	// (dedup identity); empty = the dataset's first column.
	RowPKField string `json:"row_pk_field,omitempty"`
	Severity   string `json:"severity"`
	DueHours   int    `json:"due_hours"`
	// ProjectionFields lists row columns copied into display_projection;
	// empty = all columns (subject to TruncateProjection caps).
	ProjectionFields []string  `json:"projection_fields"`
	MaxCasesPerEvent int       `json:"max_cases_per_event"`
	CreatedByID      string    `json:"created_by_id"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// TriggerCondition is one pushdown row filter (dataset-service DST-FR-050
// grammar: op ∈ eq|neq|contains|gt|gte|lt|lte).
type TriggerCondition struct {
	Col   string `json:"col"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

// triggerOps mirrors dataset-service's browse_rows filter grammar exactly.
var triggerOps = map[string]bool{
	"eq": true, "neq": true, "contains": true,
	"gt": true, "gte": true, "lt": true, "lte": true,
}

var triggerSeverities = map[string]bool{
	SeverityLow: true, SeverityMedium: true, SeverityHigh: true, SeverityCritical: true,
}

const (
	maxTriggerConditions = 10
	maxTriggerNameLen    = 120
	// DefaultTriggerDueHours / DefaultTriggerMaxCases mirror the migration
	// column defaults; Normalize applies them for zero-valued requests.
	DefaultTriggerDueHours = 72
	DefaultTriggerMaxCases = 100
	maxTriggerDueHours     = 2160 // 90 days
	maxTriggerMaxCases     = 500  // dataset browse_rows page cap
)

// Normalize applies defaults, then Validate returns a field-keyed error map
// (empty when valid) — same shape the API layer feeds EValidation.
func (t *CaseTrigger) Normalize() {
	if t.Severity == "" {
		t.Severity = SeverityMedium
	}
	if t.DueHours == 0 {
		t.DueHours = DefaultTriggerDueHours
	}
	if t.MaxCasesPerEvent == 0 {
		t.MaxCasesPerEvent = DefaultTriggerMaxCases
	}
	if t.Conditions == nil {
		t.Conditions = []TriggerCondition{}
	}
	if t.ProjectionFields == nil {
		t.ProjectionFields = []string{}
	}
}

// Validate checks the rule; returns nil when valid.
func (t *CaseTrigger) Validate() map[string]string {
	errs := map[string]string{}
	if t.Name == "" || len(t.Name) > maxTriggerNameLen {
		errs["name"] = fmt.Sprintf("required, at most %d chars", maxTriggerNameLen)
	}
	if t.DatasetURN == "" && t.DatasetName == "" {
		errs["dataset"] = "dataset_urn or dataset_name is required"
	}
	if !triggerSeverities[t.Severity] {
		errs["severity"] = "must be one of low|medium|high|critical"
	}
	if t.DueHours < 1 || t.DueHours > maxTriggerDueHours {
		errs["due_hours"] = fmt.Sprintf("must be 1..%d", maxTriggerDueHours)
	}
	if t.MaxCasesPerEvent < 1 || t.MaxCasesPerEvent > maxTriggerMaxCases {
		errs["max_cases_per_event"] = fmt.Sprintf("must be 1..%d", maxTriggerMaxCases)
	}
	if len(t.Conditions) > maxTriggerConditions {
		errs["conditions"] = fmt.Sprintf("at most %d conditions", maxTriggerConditions)
	}
	for i, c := range t.Conditions {
		if c.Col == "" {
			errs[fmt.Sprintf("conditions[%d].col", i)] = "required"
		}
		if !triggerOps[c.Op] {
			errs[fmt.Sprintf("conditions[%d].op", i)] = "must be one of eq|neq|contains|gt|gte|lt|lte"
		}
	}
	if len(errs) == 0 {
		return nil
	}
	return errs
}

// MatchesSource reports whether an ingestion.completed payload's dataset
// identity matches this trigger's source. URN match wins when set; otherwise
// the (new_dataset) target name is compared.
func (t *CaseTrigger) MatchesSource(datasetURN, datasetName string) bool {
	if t.DatasetURN != "" {
		return t.DatasetURN == datasetURN
	}
	return t.DatasetName != "" && t.DatasetName == datasetName
}
