package dbcheck

import "testing"

func TestDecide(t *testing.T) {
	cases := []struct {
		name              string
		super, bypass     bool
		strict            bool
		wantPriv, wantRef bool
	}{
		{"app role, strict — ok", false, false, true, false, false},
		{"app role, lax — ok", false, false, false, false, false},
		{"superuser, strict — refuse", true, false, true, true, true},
		{"superuser, lax — warn only", true, false, false, true, false},
		{"bypassrls, strict — refuse", false, true, true, true, true},
		{"bypassrls, lax — warn only", false, true, false, true, false},
		{"both, strict — refuse", true, true, true, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			priv, ref := decide(c.super, c.bypass, c.strict)
			if priv != c.wantPriv || ref != c.wantRef {
				t.Fatalf("decide(%v,%v,%v) = (priv=%v, refuse=%v), want (priv=%v, refuse=%v)",
					c.super, c.bypass, c.strict, priv, ref, c.wantPriv, c.wantRef)
			}
		})
	}
}

func TestStrictEnvGate(t *testing.T) {
	t.Setenv("DB_REQUIRE_NONSUPERUSER", "true")
	if !strict() {
		t.Fatal("DB_REQUIRE_NONSUPERUSER=true must enforce (strict)")
	}
	t.Setenv("DB_REQUIRE_NONSUPERUSER", "TRUE") // case-insensitive
	if !strict() {
		t.Fatal("case-insensitive true must enforce")
	}
	t.Setenv("DB_REQUIRE_NONSUPERUSER", "")
	if strict() {
		t.Fatal("unset must default to LAX (warn, not refuse) so local dev is not broken")
	}
	t.Setenv("DB_REQUIRE_NONSUPERUSER", "false")
	if strict() {
		t.Fatal("false must be lax")
	}
}
