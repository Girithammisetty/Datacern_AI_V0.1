// Trial lifecycle data types (BRD 66 slice 2, CPL-FR-020..023). Trial
// start/extend/convert are guarded transitions on Tenant.CommercialState
// (see tenant.go's commercialTransitions* tables); this file adds the
// trial_events audit-trail row shape shared by the write-path services
// (trial_service.go) and the leader-elected sweep (trial_sweep.go).
package domain

import (
	"time"

	"github.com/google/uuid"
)

// Trial event types (trial_events.event_type, design doc §2 "trial_events").
// started/extended/converted/expired are the write-path + sweep-expiry
// lifecycle; ending_t14/t7/t1 are the CPL-FR-023 threshold notifications
// emitted by the same sweep tick's second query.
const (
	TrialEventStarted   = "started"
	TrialEventExtended  = "extended"
	TrialEventExpired   = "expired"
	TrialEventConverted = "converted"
	TrialEventEndingT14 = "ending_t14"
	TrialEventEndingT7  = "ending_t7"
	TrialEventEndingT1  = "ending_t1"
)

// TrialEvent is one trial_events row (BRD 66 §6): a tenant-scoped, RLS,
// append-only audit trail of every trial lifecycle transition -- gives
// Tenant Admin / operator UI a full history (US-4) without re-deriving it
// from the outbox, and is the CPL-FR-023 dedup key for threshold events
// (the sweep's second query excludes tenants that already have a row of the
// relevant ending_tN type).
type TrialEvent struct {
	ID         uuid.UUID `json:"id"`
	TenantID   uuid.UUID `json:"tenant_id"`
	EventType  string    `json:"event_type"`
	TrialDays  int       `json:"trial_days,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	Actor      string    `json:"actor,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

// newTrialEvent builds a TrialEvent with a fresh uuidv7 id, mirroring
// NewEvent's shape for outbox events.
func newTrialEvent(tenantID uuid.UUID, eventType string, trialDays int, reason, actor string, now time.Time) TrialEvent {
	id, _ := uuid.NewV7()
	return TrialEvent{
		ID: id, TenantID: tenantID, EventType: eventType,
		TrialDays: trialDays, Reason: reason, Actor: actor, OccurredAt: now.UTC(),
	}
}
