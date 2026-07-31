package domain

import (
	"fmt"
	"math"
	"regexp"
	"time"
)

// Custom-field authoring lives in `field_meta` — that is the shape a pack's
// cases/fields.yaml writes and the shape the settings UI edits. These helpers
// read it, and ValidateFieldValue makes the DECLARED TYPE mean something at the
// write boundary.
//
// Before this, the catalog validated field NAMES only (CASE-FR-023): a field
// declared `float` happily stored the string "not a number", and a field
// declared required could be omitted entirely. A typed catalog that does not
// check types is a naming convention, not a schema — downstream readers
// (decision surfaces, exports, ML feature builds) then have to re-parse and
// re-guess exactly the thing the declaration promised.

// MetaBool reads a boolean hint from field_meta, defaulting to false. YAML/JSON
// round-trips can land a bool as a string, so both are accepted.
func MetaBool(meta map[string]any, key string) bool {
	if meta == nil {
		return false
	}
	switch v := meta[key].(type) {
	case bool:
		return v
	case string:
		return v == "true"
	default:
		return false
	}
}

// MetaStrings reads a string list from field_meta (e.g. enum `options`).
func MetaStrings(meta map[string]any, key string) []string {
	if meta == nil {
		return nil
	}
	raw, ok := meta[key].([]any)
	if !ok {
		if direct, ok := meta[key].([]string); ok {
			return direct
		}
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)

// ValidateFieldValue checks one submitted value against a field's declared
// type, returning a validation error naming the field. JSON numbers arrive as
// float64, so `integer` is checked for whole-ness rather than Go type.
//
// A nil value is treated as "not provided" by the caller (see
// ValidateCustomValues) and never reaches here.
func ValidateFieldValue(f *CaseField, value any) error {
	switch f.DataType {
	case "integer":
		n, ok := asNumber(value)
		if !ok {
			return EValidation(fmt.Sprintf("custom field %q must be an integer", f.Name), nil)
		}
		if n != math.Trunc(n) {
			return EValidation(fmt.Sprintf("custom field %q must be a whole number", f.Name), nil)
		}
	case "float":
		if _, ok := asNumber(value); !ok {
			return EValidation(fmt.Sprintf("custom field %q must be a number", f.Name), nil)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return EValidation(fmt.Sprintf("custom field %q must be true or false", f.Name), nil)
		}
	case "date":
		s, ok := value.(string)
		if !ok || !isoDate.MatchString(s) {
			return EValidation(fmt.Sprintf("custom field %q must be a date (YYYY-MM-DD)", f.Name), nil)
		}
		if _, err := time.Parse("2006-01-02", s[:10]); err != nil {
			return EValidation(fmt.Sprintf("custom field %q must be a real calendar date", f.Name), nil)
		}
	case "enum":
		s, ok := value.(string)
		if !ok {
			return EValidation(fmt.Sprintf("custom field %q must be one of its declared options", f.Name), nil)
		}
		// An enum with no declared options is a free-text field in practice —
		// accept any string rather than reject everything.
		opts := MetaStrings(f.FieldMeta, "options")
		if len(opts) == 0 {
			return nil
		}
		for _, o := range opts {
			if o == s {
				return nil
			}
		}
		return EValidation(fmt.Sprintf("custom field %q must be one of its declared options", f.Name), nil)
	default: // string, text
		if _, ok := value.(string); !ok {
			return EValidation(fmt.Sprintf("custom field %q must be a string", f.Name), nil)
		}
	}
	return nil
}

func asNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

// ValidateCustomValues is the whole write-boundary check for a case's
// custom_fields map:
//
//   - every provided key must exist in the workspace catalog (CASE-FR-023);
//   - every provided value must fit its declared type;
//   - when requireAll is set (create), every field declared `required: true`
//     in `applicable` must be present and non-empty.
//
// `defs` is the full catalog (so an update may carry a create-purpose field
// without it reading as unknown); `applicable` is the purpose-filtered subset
// the required check runs over.
func ValidateCustomValues(defs, applicable []*CaseField, values map[string]any, requireAll bool) error {
	byName := make(map[string]*CaseField, len(defs))
	for _, d := range defs {
		byName[d.Name] = d
	}
	for k, v := range values {
		def, ok := byName[k]
		if !ok {
			return EValidation("unknown custom field: "+k, nil)
		}
		if v == nil {
			continue
		}
		if err := ValidateFieldValue(def, v); err != nil {
			return err
		}
	}
	if !requireAll {
		return nil
	}
	for _, def := range applicable {
		if !MetaBool(def.FieldMeta, "required") {
			continue
		}
		v, present := values[def.Name]
		if !present || v == nil || v == "" {
			return EValidation(fmt.Sprintf("custom field %q is required", def.Name), nil)
		}
	}
	return nil
}
