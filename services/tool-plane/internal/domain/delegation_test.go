package domain

import "testing"

// A declaration is the ONLY thing that can widen a forwarded token, so the
// registration gate is a security boundary: it must refuse anything that is not
// a read action on a read-tier tool.
func TestValidateDownstreamActions(t *testing.T) {
	cases := []struct {
		name    string
		tier    string
		actions []string
		wantErr bool
	}{
		{"empty declaration is always fine", TierWriteProposal, nil, false},
		{"read tier + read verbs", TierRead,
			[]string{"dataset.dataset.list", "chart.dashboard.list", "case.case.export"}, false},
		{"read tier + read verb", TierRead, []string{"case.case.read"}, false},

		// The tool must not be able to grant itself write authority.
		{"write verb refused", TierRead, []string{"case.case.update"}, true},
		{"delete verb refused", TierRead, []string{"chart.dashboard.delete"}, true},
		{"admin verb refused", TierRead, []string{"chart.dashboard.admin"}, true},
		{"execute verb refused", TierRead, []string{"chart.dashboard.execute"}, true},

		// Nor may a non-read tool delegate at all.
		{"write-proposal tier refused", TierWriteProposal, []string{"case.case.read"}, true},
		{"write-direct tier refused", TierWriteDirect, []string{"case.case.read"}, true},
		{"admin tier refused", TierAdmin, []string{"case.case.read"}, true},

		// Nor may it name something that is not a canonical action.
		{"wildcard refused", TierRead, []string{"*"}, true},
		{"two-segment name refused", TierRead, []string{"case.read"}, true},
		{"four-segment name refused", TierRead, []string{"a.b.c.read"}, true},
		{"prefix wildcard refused", TierRead, []string{"dataset.dataset.*"}, true},
		{"uppercase refused", TierRead, []string{"Dataset.Dataset.list"}, true},
		{"empty string refused", TierRead, []string{""}, true},
		{"duplicate refused", TierRead, []string{"case.case.read", "case.case.read"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			errs := ValidateDownstreamActions(tc.tier, tc.actions)
			if tc.wantErr && len(errs) == 0 {
				t.Fatalf("expected a validation error for %v on tier %s", tc.actions, tc.tier)
			}
			if !tc.wantErr && len(errs) > 0 {
				t.Fatalf("unexpected errors %+v", errs)
			}
		})
	}
}

func TestValidateDownstreamActionsCap(t *testing.T) {
	actions := make([]string, 0, MaxDownstreamActions+1)
	for i := 0; i <= MaxDownstreamActions; i++ {
		actions = append(actions, "svc"+string(rune('a'+i%26))+".res.read")
	}
	if errs := ValidateDownstreamActions(TierRead, actions); len(errs) == 0 {
		t.Fatalf("a declaration over the cap must be refused")
	}
}

// TokenDelegable is the call-time half. It must accept ONLY a token narrowed to
// the declaration — everything else denies, loudly, with a reason.
func TestTokenDelegable(t *testing.T) {
	const tool = "search.query"
	declared := []string{"dataset.dataset.list", "case.case.list"}

	cases := []struct {
		name   string
		scopes []string
		want   bool
	}{
		{"tool id alone", []string{tool}, true},
		{"tool id + one declared", []string{tool, "case.case.list"}, true},
		{"tool id + all declared", []string{tool, "dataset.dataset.list", "case.case.list"}, true},
		{"order does not matter", []string{"case.case.list", tool}, true},

		{"wildcard refused", []string{"*"}, false},
		{"wildcard alongside the tool refused", []string{tool, "*"}, false},
		{"undeclared action refused", []string{tool, "chart.dashboard.list"}, false},
		{"undeclared WRITE action refused", []string{tool, "case.case.update"}, false},
		{"another tool id refused", []string{tool, "case.assign"}, false},
		{"not scoped to this tool refused", []string{"dataset.dataset.list"}, false},
		{"empty scopes refused", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, why := TokenDelegable(tool, declared, tc.scopes)
			if ok != tc.want {
				t.Fatalf("TokenDelegable(%v) = %v (%q), want %v", tc.scopes, ok, why, tc.want)
			}
			if !ok && why == "" {
				t.Fatal("a refusal must carry a reason — a silent refusal is indistinguishable from an empty result")
			}
		})
	}
}

// A tool that declared nothing can never delegate, whatever the token says.
func TestTokenDelegableRefusesUndeclaredTool(t *testing.T) {
	for _, scopes := range [][]string{{"*"}, {"search.query"}, nil, {"search.query", "dataset.dataset.list"}} {
		if ok, _ := TokenDelegable("case.get", nil, scopes); ok {
			t.Fatalf("a tool declaring no downstream actions must never delegate (scopes=%v)", scopes)
		}
	}
}

func TestDelegableScopes(t *testing.T) {
	got := DelegableScopes("search.query", []string{"dataset.dataset.list"})
	want := []string{"search.query", "dataset.dataset.list"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}
