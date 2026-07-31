package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/case-service/internal/domain"
	"github.com/datacern-ai/case-service/internal/events"
)

// chiURLParam is a thin wrapper so handler files need not import chi directly.
func chiURLParam(r *http.Request, key string) string { return chi.URLParam(r, key) }

// mkActivity builds a timeline entry from op + old/new values.
func mkActivity(op domain.Op, eventType string, oldV, newV any) domain.Activity {
	return domain.Activity{
		ID: domain.NewID(), EventType: eventType, ActorType: op.Actor.Type, ActorID: op.Actor.ID,
		ViaAgent: op.ViaAgent, OldValue: oldV, NewValue: newV, OccurredAt: time.Now().UTC(),
	}
}

// ifMatchVersion parses an If-Match header carrying the expected case_version.
func ifMatchVersion(r *http.Request) *int {
	v := strings.Trim(r.Header.Get("If-Match"), `"`)
	if v == "" {
		return nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return nil
	}
	return &n
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func splitComma(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// validateCustomFields is the write boundary for a case's custom_fields
// (CASE-FR-022/023): unknown keys are rejected, provided values must fit the
// field's DECLARED TYPE, and on create every field authored `required: true`
// must be present. Name-only checking was the earlier behaviour — it let a
// field declared `float` store "not a number", which every downstream reader
// then had to re-parse and re-guess.
//
// `purpose` selects which fields the required check applies to: create-mode
// fields on create, update-mode fields on update. The full catalog is still
// used for the known-key and type checks, so an update carrying a create-purpose
// value does not read as unknown.
func (s *Server) validateCustomFields(ctx context.Context, tenant, ws uuid.UUID, queryURN string, fields map[string]any, purpose int16) error {
	defs, err := s.Store.ListFields(ctx, tenant, ws, queryURN, nil)
	if err != nil {
		return err
	}
	applicable := make([]*domain.CaseField, 0, len(defs))
	for _, d := range defs {
		if d.Purpose == purpose || d.Purpose == domain.PurposeBoth {
			applicable = append(applicable, d)
		}
	}
	return domain.ValidateCustomValues(defs, applicable, fields, purpose == domain.PurposeCreate)
}

var _ = events.Topic
