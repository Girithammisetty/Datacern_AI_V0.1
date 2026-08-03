package api

// WS5 evidence-upload registry check: definitive miss -> 422 naming the key;
// registry outage -> fail soft (the tag is optional metadata, an outage never
// blocks evidence upload); nil checker / empty key -> no check at all.

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type fakeOntology struct {
	declared bool
	err      error
	calls    int
}

func (f *fakeOntology) OntologyTypeExists(ctx context.Context, tenant uuid.UUID,
	workspaceID uuid.UUID, entityKey string) (bool, error) {
	f.calls++
	return f.declared, f.err
}

func TestCheckEvidenceEntityKeyDeclaredPasses(t *testing.T) {
	f := &fakeOntology{declared: true}
	if verr := checkEvidenceEntityKey(context.Background(), f, uuid.New(), uuid.New(), "policy"); verr != nil {
		t.Fatalf("declared key must pass, got %+v", verr)
	}
	if f.calls != 1 {
		t.Fatalf("expected one registry call, got %d", f.calls)
	}
}

func TestCheckEvidenceEntityKeyDefinitiveMissNamesTheKey(t *testing.T) {
	f := &fakeOntology{declared: false}
	verr := checkEvidenceEntityKey(context.Background(), f, uuid.New(), uuid.New(), "ghost")
	if verr == nil || verr.HTTP != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %+v", verr)
	}
	if !strings.Contains(verr.Message, `"ghost"`) || !strings.Contains(verr.Message, "not declared") {
		t.Fatalf("message must name the key: %q", verr.Message)
	}
}

func TestCheckEvidenceEntityKeyOutageFailsSoft(t *testing.T) {
	f := &fakeOntology{err: fmt.Errorf("dataset-service returned 503")}
	if verr := checkEvidenceEntityKey(context.Background(), f, uuid.New(), uuid.New(), "policy"); verr != nil {
		t.Fatalf("outage must fail soft, got %+v", verr)
	}
}

func TestCheckEvidenceEntityKeySkipsWhenAbsent(t *testing.T) {
	f := &fakeOntology{}
	if verr := checkEvidenceEntityKey(context.Background(), f, uuid.New(), uuid.New(), ""); verr != nil {
		t.Fatalf("empty key must skip, got %+v", verr)
	}
	if f.calls != 0 {
		t.Fatalf("empty key must not call the registry")
	}
	if verr := checkEvidenceEntityKey(context.Background(), nil, uuid.New(), uuid.New(), "policy"); verr != nil {
		t.Fatalf("nil checker must skip, got %+v", verr)
	}
}
