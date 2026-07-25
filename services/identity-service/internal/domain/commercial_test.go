package domain

import (
	"testing"
	"time"
)

// TestCommercialTransitionMatrix exercises every (from, to) pair of the
// commercial-state guard table (CPL-FR-020), mirroring
// TestTenantTransitionMatrix: allowed pairs succeed, everything else is a 409.
func TestCommercialTransitionMatrix(t *testing.T) {
	allowed := map[[2]CommercialState]bool{
		{CommercialNone, CommercialTrial}:                true,
		{CommercialNone, CommercialActive}:                true,
		{CommercialTrial, CommercialActive}:               true,
		{CommercialTrial, CommercialSuspendedCommercial}:  true,
		{CommercialActive, CommercialChurned}:             true,
		{CommercialSuspendedCommercial, CommercialActive}: true,
		{CommercialSuspendedCommercial, CommercialChurned}: true,
	}
	now := time.Now()
	for _, from := range AllCommercialStates {
		for _, to := range AllCommercialStates {
			tn := &Tenant{CommercialState: from}
			err := tn.TransitionCommercial(to, now)
			want := allowed[[2]CommercialState{from, to}]
			if want && err != nil {
				t.Errorf("%s -> %s: expected allowed, got %v", from, to, err)
			}
			if !want {
				de, ok := AsError(err)
				if !ok || de.HTTP != 409 || de.Code != CodeConflict {
					t.Errorf("%s -> %s: expected 409 CONFLICT, got %v", from, to, err)
				}
				if tn.CommercialState != from {
					t.Errorf("%s -> %s: commercial_state mutated on rejected transition", from, to)
				}
			}
		}
	}
	if len(allowed) != 7 {
		t.Fatalf("matrix drift: expected 7 allowed transitions, table has %d", len(allowed))
	}
	// churned is terminal: no outbound edges at all.
	for _, to := range AllCommercialStates {
		if CanTransitionCommercial(CommercialChurned, to) {
			t.Errorf("churned should be terminal, but ->%s is allowed", to)
		}
	}
}

// TestResolveEffectiveEntitlements_OverrideWinsByKindKey covers CPL-FR-010:
// overrides shadow a plan default by (kind, key); overrides that don't match
// any default are additive; keys the tenant doesn't override fall through to
// the plan default with provenance "plan_default".
func TestResolveEffectiveEntitlements_OverrideWinsByKindKey(t *testing.T) {
	defaults := []PlanEntitlement{
		{Kind: KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(10)}},
		{Kind: KindWorkspaceCap, Key: "workspaces", Value: map[string]any{"n": float64(5)}},
		{Kind: KindFeature, Key: "sso", Value: nil},
	}
	overrides := []TenantEntitlementOverride{
		// Shadows the seat_cap default with a negotiated higher limit.
		{Kind: KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(50)}},
		// Additive: not present in plan defaults at all.
		{Kind: KindPackSKU, Key: "banking-aml", Value: nil},
	}
	got := ResolveEffectiveEntitlements(defaults, overrides)
	if len(got) != 4 {
		t.Fatalf("expected 4 effective entitlements (3 defaults, 1 shadowed + 1 additive), got %d: %+v", len(got), got)
	}
	byKey := map[string]EffectiveEntitlement{}
	for _, e := range got {
		byKey[string(e.Kind)+"/"+e.Key] = e
	}
	seats := byKey["seat_cap/seats"]
	if seats.Provenance != ProvenanceOverride || seats.Value["n"] != float64(50) {
		t.Errorf("seat_cap/seats: want override n=50, got %+v", seats)
	}
	ws := byKey["workspace_cap/workspaces"]
	if ws.Provenance != ProvenancePlanDefault || ws.Value["n"] != float64(5) {
		t.Errorf("workspace_cap/workspaces: want plan_default n=5, got %+v", ws)
	}
	sso := byKey["feature/sso"]
	if sso.Provenance != ProvenancePlanDefault {
		t.Errorf("feature/sso: want plan_default, got %+v", sso)
	}
	sku := byKey["pack_sku/banking-aml"]
	if sku.Provenance != ProvenanceOverride {
		t.Errorf("pack_sku/banking-aml: want override (additive), got %+v", sku)
	}
}

func TestResolveEffectiveEntitlements_EmptyInputs(t *testing.T) {
	if got := ResolveEffectiveEntitlements(nil, nil); len(got) != 0 {
		t.Fatalf("expected empty effective set, got %+v", got)
	}
}

func TestValidateEntitlementRef(t *testing.T) {
	if err := ValidateEntitlementRef(KindSeatCap, "seats"); err != nil {
		t.Fatalf("valid ref rejected: %v", err)
	}
	if err := ValidateEntitlementRef("not-a-kind", "x"); err == nil {
		t.Fatal("expected invalid-kind rejection")
	}
	if err := ValidateEntitlementRef(KindFeature, ""); err == nil {
		t.Fatal("expected empty-key rejection")
	}
}

func TestValidatePlanKey(t *testing.T) {
	cases := []struct {
		in      string
		wantErr bool
	}{
		{"pilot", false}, {"design-partner", false}, {"internal-demo", false},
		{"Pilot", true}, {"", true}, {"1pilot", true}, {"a", true},
	}
	for _, c := range cases {
		err := ValidatePlanKey(c.in)
		if (err != nil) != c.wantErr {
			t.Errorf("ValidatePlanKey(%q): err=%v, wantErr=%v", c.in, err, c.wantErr)
		}
	}
}
