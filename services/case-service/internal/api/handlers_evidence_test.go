package api

import "testing"

// entityKeyRe must accept exactly the ontology registry's restricted key shape
// (Knowledge Spine WS5) — lowercase slug, letter first, max 64 chars.
func TestEntityKeyShape(t *testing.T) {
	ok := []string{"policy", "bank_statement_entry", "claim2", "a"}
	for _, k := range ok {
		if !entityKeyRe.MatchString(k) {
			t.Fatalf("expected %q to be a valid entity key", k)
		}
	}
	bad := []string{"Policy", "2claim", "_x", "claim-form", "claim form", "", "café",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} // 65 chars
	for _, k := range bad {
		if entityKeyRe.MatchString(k) {
			t.Fatalf("expected %q to be rejected", k)
		}
	}
}
