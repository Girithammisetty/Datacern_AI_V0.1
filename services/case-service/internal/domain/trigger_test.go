package domain

import "testing"

func validTrigger() *CaseTrigger {
	t := &CaseTrigger{Name: "high-value", DatasetName: "auto-claims"}
	t.Normalize()
	return t
}

func TestTriggerNormalizeDefaults(t *testing.T) {
	tr := &CaseTrigger{Name: "x", DatasetURN: "wr:t:dataset:dataset/1"}
	tr.Normalize()
	if tr.Severity != SeverityMedium || tr.DueHours != DefaultTriggerDueHours ||
		tr.MaxCasesPerEvent != DefaultTriggerMaxCases {
		t.Fatalf("defaults not applied: %+v", tr)
	}
	if tr.Conditions == nil || tr.ProjectionFields == nil {
		t.Fatal("nil slices not normalized")
	}
}

func TestTriggerValidate(t *testing.T) {
	cases := []struct {
		name   string
		mut    func(*CaseTrigger)
		errKey string
	}{
		{"valid", func(*CaseTrigger) {}, ""},
		{"missing name", func(tr *CaseTrigger) { tr.Name = "" }, "name"},
		{"missing source", func(tr *CaseTrigger) { tr.DatasetName, tr.DatasetURN = "", "" }, "dataset"},
		{"bad severity", func(tr *CaseTrigger) { tr.Severity = "urgent" }, "severity"},
		{"due too high", func(tr *CaseTrigger) { tr.DueHours = 5000 }, "due_hours"},
		{"cap too high", func(tr *CaseTrigger) { tr.MaxCasesPerEvent = 9999 }, "max_cases_per_event"},
		{"bad op", func(tr *CaseTrigger) { tr.Conditions = []TriggerCondition{{Col: "a", Op: "like", Value: "x"}} }, "conditions[0].op"},
		{"missing col", func(tr *CaseTrigger) { tr.Conditions = []TriggerCondition{{Op: "eq", Value: "x"}} }, "conditions[0].col"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tr := validTrigger()
			tc.mut(tr)
			errs := tr.Validate()
			if tc.errKey == "" {
				if errs != nil {
					t.Fatalf("expected valid, got %v", errs)
				}
				return
			}
			if errs == nil || errs[tc.errKey] == "" {
				t.Fatalf("expected error on %q, got %v", tc.errKey, errs)
			}
		})
	}
}

func TestTriggerMatchesSource(t *testing.T) {
	byURN := &CaseTrigger{DatasetURN: "wr:t:dataset:dataset/1"}
	if !byURN.MatchesSource("wr:t:dataset:dataset/1", "anything") {
		t.Fatal("URN match failed")
	}
	if byURN.MatchesSource("wr:t:dataset:dataset/2", "anything") {
		t.Fatal("URN mismatch matched")
	}
	byName := &CaseTrigger{DatasetName: "auto-claims"}
	if !byName.MatchesSource("wr:whatever", "auto-claims") {
		t.Fatal("name match failed")
	}
	if byName.MatchesSource("wr:whatever", "other") {
		t.Fatal("name mismatch matched")
	}
	// URN set wins: name is ignored even if it would match.
	both := &CaseTrigger{DatasetURN: "wr:t:dataset:dataset/1", DatasetName: "auto-claims"}
	if both.MatchesSource("wr:other", "auto-claims") {
		t.Fatal("URN-set trigger must not fall back to name match")
	}
}
