package billing

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/datacern-ai/usage-service/internal/domain"
)

func TestDecideClose_Gates(t *testing.T) {
	cases := []struct {
		name        string
		in          CloseInputs
		shouldClose bool
		version     int
		reasonHas   string
	}{
		{
			name:      "not finalized → skip",
			in:        CloseInputs{MonthFinalized: false, ReconStatus: domain.ReconMatched},
			reasonHas: "not finalized",
		},
		{
			name:      "variance → blocked",
			in:        CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconVariance},
			reasonHas: "variance",
		},
		{
			name:      "pending recon → not settled",
			in:        CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconPending},
			reasonHas: "not settled",
		},
		{
			name:        "finalized + matched, never closed → v1",
			in:          CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconMatched, PriorVersion: 0},
			shouldClose: true, version: 1,
		},
		{
			name:        "finalized + adjusted, never closed → v1",
			in:          CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconAdjusted, PriorVersion: 0},
			shouldClose: true, version: 1,
		},
		{
			name:        "finalized + acknowledged, never closed → v1",
			in:          CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconAcknowledged, PriorVersion: 0},
			shouldClose: true, version: 1,
		},
		{
			name:        "already closed + correction → v+1",
			in:          CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconMatched, PriorVersion: 2, Corrected: true},
			shouldClose: true, version: 3,
		},
		{
			name:      "already closed, no correction → no-op",
			in:        CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconMatched, PriorVersion: 1, Corrected: false},
			reasonHas: "already closed at v1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DecideClose(tc.in)
			assert.Equal(t, tc.shouldClose, got.ShouldClose)
			if tc.shouldClose {
				assert.Equal(t, tc.version, got.Version)
				assert.Empty(t, got.Reason)
			} else {
				assert.Contains(t, got.Reason, tc.reasonHas)
				assert.Zero(t, got.Version)
			}
		})
	}
}

// The gate is a pure function of its inputs — running it repeatedly on the same
// state never flips to a second close (idempotent decision; the advisory lock
// only guards the concurrent version-insert, not correctness).
func TestDecideClose_IdempotentForClosedState(t *testing.T) {
	in := CloseInputs{MonthFinalized: true, ReconStatus: domain.ReconMatched, PriorVersion: 1, Corrected: false}
	for i := 0; i < 3; i++ {
		assert.False(t, DecideClose(in).ShouldClose)
	}
}
