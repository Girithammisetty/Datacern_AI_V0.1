package authjwt

import "testing"

func TestWritesSuspended(t *testing.T) {
	if !(&Claims{CommercialState: SuspendedCommercial}).WritesSuspended() {
		t.Fatal("suspended_commercial must suspend writes")
	}
	for _, s := range []string{"", "none", "trial", "active", "churned"} {
		if (&Claims{CommercialState: s}).WritesSuspended() {
			t.Fatalf("commercial_state=%q must NOT suspend writes", s)
		}
	}
}
