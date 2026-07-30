package api

// Realtime-case-streams add-on gate (slice 2): the mapping from an
// entitlement-check outcome to the error a trigger write receives when it
// turns intake-snapshot evidence on. The full HTTP path (create/update against
// real PG + Redis projection) runs in the integration tier.

import (
	"net/http"
	"strings"
	"testing"

	"github.com/datacern-ai/case-service/internal/domain"
	"github.com/datacern-ai/case-service/internal/entitlements"
)

func TestAttachEvidenceGateEntitledPasses(t *testing.T) {
	if err := attachEvidenceGate(entitlements.Entitled); err != nil {
		t.Fatalf("entitled must pass, got %v", err)
	}
}

func TestAttachEvidenceGateBlockedNamesTheSKU(t *testing.T) {
	// A refusal the buyer can act on: 403, and the message names the add-on
	// and the exact entitlement key — not a bare "forbidden".
	err := attachEvidenceGate(entitlements.Blocked)
	if err == nil || err.HTTP != http.StatusForbidden || err.Code != domain.CodePermissionDenied {
		t.Fatalf("want 403 PERMISSION_DENIED, got %+v", err)
	}
	for _, want := range []string{"realtime-case-streams", "realtime_case_streams"} {
		if !strings.Contains(err.Message, want) {
			t.Fatalf("message must name %q: %q", want, err.Message)
		}
	}
}

func TestAttachEvidenceGateUnavailableFailsClosedAndSaysWhy(t *testing.T) {
	// "Could not check" is 503 with its own code — distinct from "not
	// entitled" (403), and never a silent grant (CPL-NFR-004).
	err := attachEvidenceGate(entitlements.Unavailable)
	if err == nil || err.HTTP != http.StatusServiceUnavailable || err.Code != "ENTITLEMENT_UNAVAILABLE" {
		t.Fatalf("want 503 ENTITLEMENT_UNAVAILABLE, got %+v", err)
	}
	if !strings.Contains(err.Message, "refusing") {
		t.Fatalf("message must state the fail-closed refusal: %q", err.Message)
	}
}
