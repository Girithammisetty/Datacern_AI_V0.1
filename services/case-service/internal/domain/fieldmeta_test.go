package domain

import "testing"

// The catalog validated NAMES only before this: a field declared `float` stored
// the string "not a number", and a required field could be omitted. These tests
// pin the declared type actually meaning something at the write boundary —
// otherwise every downstream reader has to re-parse what the schema promised.

func field(name, dt string, meta map[string]any) *CaseField {
	return &CaseField{Name: name, DataType: dt, FieldMeta: meta, Purpose: PurposeBoth}
}

func TestValidateFieldValueTypes(t *testing.T) {
	cases := []struct {
		name  string
		f     *CaseField
		value any
		ok    bool
	}{
		// JSON numbers arrive as float64 — integer is checked for whole-ness.
		{"integer accepts a whole float64", field("n", "integer", nil), float64(42), true},
		{"integer rejects a fraction", field("n", "integer", nil), 42.5, false},
		{"integer rejects a formatted string", field("n", "integer", nil), "9,000", false},
		{"float accepts a fraction", field("x", "float", nil), 0.75, true},
		{"float rejects prose", field("x", "float", nil), "not a number", false},
		{"boolean rejects the string yes", field("b", "boolean", nil), "yes", false},
		{"boolean accepts false", field("b", "boolean", nil), false, true},
		{"date accepts an ISO day", field("d", "date", nil), "2026-02-11", true},
		{"date rejects a US format", field("d", "date", nil), "02/11/2026", false},
		{"date rejects an impossible day", field("d", "date", nil), "2026-02-31", false},
		{"string rejects a number", field("s", "string", nil), float64(3), false},
		{"text accepts a string", field("s", "text", nil), "a note", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateFieldValue(tc.f, tc.value)
			if tc.ok && err != nil {
				t.Fatalf("expected accept, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("expected rejection, got accept")
			}
		})
	}
}

func TestEnumChecksDeclaredOptions(t *testing.T) {
	f := field("priority", "enum", map[string]any{"options": []any{"high", "low"}})
	if err := ValidateFieldValue(f, "high"); err != nil {
		t.Fatalf("declared option rejected: %v", err)
	}
	// Not a fuzzy match: an option the workspace never declared is a rejection,
	// so an enum column cannot silently grow values nobody governs.
	if err := ValidateFieldValue(f, "HIGH"); err == nil {
		t.Fatal("expected case-mismatched option to be rejected")
	}
	if err := ValidateFieldValue(f, "urgent"); err == nil {
		t.Fatal("expected undeclared option to be rejected")
	}
	// An enum with no options authored is free text in practice — rejecting
	// everything would make the field unusable rather than safe.
	open := field("free", "enum", nil)
	if err := ValidateFieldValue(open, "anything"); err != nil {
		t.Fatalf("optionless enum should accept a string: %v", err)
	}
}

func TestValidateCustomValuesRejectsUnknownKeys(t *testing.T) {
	defs := []*CaseField{field("exposure", "float", nil)}
	err := ValidateCustomValues(defs, defs, map[string]any{"secret_backdoor": "oops"}, false)
	if err == nil {
		t.Fatal("expected an undeclared key to be rejected")
	}
}

func TestRequiredIsEnforcedOnCreateOnly(t *testing.T) {
	req := field("siu_referral", "enum", map[string]any{
		"required": true, "options": []any{"yes", "no"},
	})
	defs := []*CaseField{req}

	// create: the pack authored `required: true`, so omitting it is a 422.
	if err := ValidateCustomValues(defs, defs, map[string]any{}, true); err == nil {
		t.Fatal("expected a required field to be enforced on create")
	}
	// an empty string is not a value
	if err := ValidateCustomValues(defs, defs, map[string]any{"siu_referral": ""}, true); err == nil {
		t.Fatal("expected an empty string to fail the required check")
	}
	if err := ValidateCustomValues(defs, defs, map[string]any{"siu_referral": "yes"}, true); err != nil {
		t.Fatalf("a filled required field should pass: %v", err)
	}
	// update: partial patches must stay partial — required is not re-checked.
	if err := ValidateCustomValues(defs, defs, map[string]any{}, false); err != nil {
		t.Fatalf("update must not re-enforce required: %v", err)
	}
}

func TestRequiredOnlyAppliesToTheApplicablePurpose(t *testing.T) {
	// A field authored for UPDATE only must not block a CREATE, even when the
	// author marked it required — that is what `purpose` is for.
	updateOnly := field("resolution_code", "string", map[string]any{"required": true})
	updateOnly.Purpose = PurposeUpdate
	createField := field("exposure", "float", nil)
	defs := []*CaseField{updateOnly, createField}
	applicable := []*CaseField{createField} // purpose-filtered by the caller

	if err := ValidateCustomValues(defs, applicable, map[string]any{"exposure": 10.0}, true); err != nil {
		t.Fatalf("update-purpose required field blocked a create: %v", err)
	}
}

func TestMetaBoolReadsYamlishStrings(t *testing.T) {
	if !MetaBool(map[string]any{"required": true}, "required") {
		t.Fatal("bool true not read")
	}
	if !MetaBool(map[string]any{"required": "true"}, "required") {
		t.Fatal("stringified true not read (YAML/JSON round-trips produce this)")
	}
	if MetaBool(nil, "required") {
		t.Fatal("nil meta must default to false")
	}
}
