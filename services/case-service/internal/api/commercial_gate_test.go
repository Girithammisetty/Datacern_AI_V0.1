package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/datacern-ai/case-service/internal/domain"
)

// TestRequireCommercialActive is the BRD 66 CPL-FR-022 (AC-2) gate: a
// suspended_commercial tenant is refused a value-delivering write with the
// stable TRIAL_EXPIRED code, while any other commercial state (or a
// pre-commercial token with no claim) passes through untouched.
func TestRequireCommercialActive(t *testing.T) {
	reached := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})
	handler := (&Server{}).RequireCommercialActive(next)

	cases := []struct {
		name          string
		claims        *Claims
		wantStatus    int
		wantReached   bool
		wantErrorCode string
	}{
		{"suspended is blocked", &Claims{CommercialState: "suspended_commercial"},
			http.StatusForbidden, false, domain.CodeTrialExpired},
		{"trial passes", &Claims{CommercialState: "trial"}, http.StatusOK, true, ""},
		{"active passes", &Claims{CommercialState: "active"}, http.StatusOK, true, ""},
		{"pre-commercial (no claim) passes", &Claims{}, http.StatusOK, true, ""},
		{"nil claims pass (authn already ran)", nil, http.StatusOK, true, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached = false
			req := httptest.NewRequest(http.MethodPost, "/api/v1/cases/x/resolve", nil)
			if tc.claims != nil {
				req = req.WithContext(context.WithValue(req.Context(), ctxKeyClaims, tc.claims))
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if reached != tc.wantReached {
				t.Fatalf("next reached = %v, want %v", reached, tc.wantReached)
			}
			if tc.wantErrorCode != "" {
				var env struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
					t.Fatalf("decode error envelope: %v", err)
				}
				if env.Error.Code != tc.wantErrorCode {
					t.Fatalf("error code = %q, want %q", env.Error.Code, tc.wantErrorCode)
				}
			}
		})
	}
}

// TestWritesSuspended pins the claim contract shared with libs/py-common.
func TestWritesSuspended(t *testing.T) {
	if !(&Claims{CommercialState: "suspended_commercial"}).WritesSuspended() {
		t.Fatal("suspended_commercial must suspend writes")
	}
	for _, s := range []string{"", "none", "trial", "active", "churned"} {
		if (&Claims{CommercialState: s}).WritesSuspended() {
			t.Fatalf("commercial_state=%q must NOT suspend writes", s)
		}
	}
}
