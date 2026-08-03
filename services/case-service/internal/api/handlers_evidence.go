package api

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"

	"github.com/datacern-ai/case-service/internal/domain"
)

// entityKeyRe mirrors the restricted name shape the ontology registry enforces
// on entity keys (dataset-service; same shape semantic-service validates).
var entityKeyRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// OntologyChecker resolves whether a workspace declares an entity type
// (dataset-service's governed registry). (false, nil) is a DEFINITIVE miss;
// a non-nil error means the registry was unreachable — callers fail soft.
type OntologyChecker interface {
	OntologyTypeExists(ctx context.Context, tenant uuid.UUID,
		workspaceID uuid.UUID, entityKey string) (bool, error)
}

// checkEvidenceEntityKey applies the WS5 registry check to an upload's
// optional entity_key. Semantics mirror semantic-service's authoring
// validation: a DEFINITIVE "not declared" is a client error naming the key
// (typo protection — the UI feeds this field from the registry, so a miss
// means staleness or a rogue client); a registry outage fails SOFT and keeps
// the shape-checked tag, because the tag is optional metadata and an outage
// must never block evidence upload. A nil checker disables the check.
func checkEvidenceEntityKey(ctx context.Context, ontology OntologyChecker,
	tenant, workspaceID uuid.UUID, entityKey string) *domain.Error {
	if entityKey == "" || ontology == nil {
		return nil
	}
	declared, err := ontology.OntologyTypeExists(ctx, tenant, workspaceID, entityKey)
	if err != nil {
		slog.Warn("evidence entity_key registry check skipped (registry unreachable)",
			"entity_key", entityKey, "err", err)
		return nil
	}
	if !declared {
		return domain.EValidation(fmt.Sprintf(
			"entity_key %q is not declared in this workspace's ontology", entityKey), nil)
	}
	return nil
}

// maxEvidenceBytes caps a single evidence upload (25 MiB): claim photos, PDFs,
// scanned reports. Large enough for real documents, small enough to hold in
// memory for the MinIO put + Postgres pointer in one request.
const maxEvidenceBytes = 25 << 20

// handleAddEvidence attaches an uploaded file to a case (task #77, multipart
// "file"). The bytes go to object storage; a tenant-isolated pointer row is
// recorded. Needs case.evidence.create.
func (s *Server) handleAddEvidence(w http.ResponseWriter, r *http.Request) {
	op, id, ok := s.opCase(w, r)
	if !ok {
		return
	}
	// The case must exist (and, via RLS, be in the caller's tenant); its
	// workspace anchors the evidence row.
	c0, err := s.Store.GetCase(r.Context(), op.Tenant, id)
	if err != nil {
		s.writeLookupErr(w, r, err)
		return
	}
	if err := r.ParseMultipartForm(maxEvidenceBytes + 1024); err != nil {
		writeErr(w, r, domain.EValidation("invalid multipart form", nil))
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, r, domain.EValidation("a 'file' part is required", nil))
		return
	}
	defer func() { _ = file.Close() }()

	// Read with a hard cap (one extra byte detects an over-limit file).
	data, err := io.ReadAll(io.LimitReader(file, maxEvidenceBytes+1))
	if err != nil {
		writeErr(w, r, domain.EValidation("could not read upload", nil))
		return
	}
	if len(data) == 0 {
		writeErr(w, r, domain.EValidation("uploaded file is empty", nil))
		return
	}
	if len(data) > maxEvidenceBytes {
		writeErr(w, r, domain.EValidation("file exceeds the 25 MiB limit", nil))
		return
	}

	filename := sanitizeFilename(hdr.Filename)
	contentType := hdr.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Optional (Knowledge Spine WS5): the governed ontology entity type this
	// document instantiates. Shape-checked only — the registry lives in
	// dataset-service and the UI feeds this field from it, so a malformed
	// value here is a client bug worth a 400, while registry existence is
	// deliberately NOT re-verified cross-service on the upload hot path.
	entityKey := strings.TrimSpace(r.FormValue("entity_key"))
	if entityKey != "" && !entityKeyRe.MatchString(entityKey) {
		writeErr(w, r, domain.EValidation(
			"entity_key must match the ontology key shape (lowercase slug)", nil))
		return
	}
	// WS5 registry check: a definitive "not declared" is rejected before any
	// bytes are stored; a registry outage fails soft inside the helper.
	if verr := checkEvidenceEntityKey(
		r.Context(), s.Ontology, op.Tenant, c0.WorkspaceID, entityKey); verr != nil {
		writeErr(w, r, verr)
		return
	}

	eid := domain.NewID()
	// Object key is tenant/case/evidence — RLS + the case_id check on download
	// are the real isolation; the key just organizes the bucket.
	key := fmt.Sprintf("%s/%s/%s", op.Tenant, id, eid)
	if err := s.Evidence.Put(r.Context(), key, data, contentType); err != nil {
		writeErr(w, r, domain.EInternal("evidence store write failed"))
		return
	}

	e := &domain.CaseEvidence{
		ID: eid, TenantID: op.Tenant, WorkspaceID: c0.WorkspaceID, CaseID: id,
		Filename: filename, ContentType: contentType, SizeBytes: int64(len(data)),
		StorageKey: key, UploadedBy: op.Actor.ID, EntityKey: entityKey,
	}
	if err := s.Store.InsertEvidence(r.Context(), op, e); err != nil {
		writeErr(w, r, domain.EInternal("evidence record failed"))
		return
	}
	writeData(w, http.StatusCreated, e)
}

// handleListEvidence lists a case's evidence (metadata only). Needs
// case.evidence.read.
func (s *Server) handleListEvidence(w http.ResponseWriter, r *http.Request) {
	op, id, ok := s.opCase(w, r)
	if !ok {
		return
	}
	list, err := s.Store.ListEvidence(r.Context(), op.Tenant, id)
	if err != nil {
		writeErr(w, r, domain.EInternal("evidence list failed"))
		return
	}
	writeData(w, http.StatusOK, list)
}

// handleDownloadEvidence streams one evidence file back. Needs
// case.evidence.read; the evidence must belong to the path case.
func (s *Server) handleDownloadEvidence(w http.ResponseWriter, r *http.Request) {
	op, id, ok := s.opCase(w, r)
	if !ok {
		return
	}
	eid, err := uuid.Parse(chiURLParam(r, "eid"))
	if err != nil {
		s.notFound(w, r)
		return
	}
	e, err := s.Store.GetEvidence(r.Context(), op.Tenant, eid)
	if err != nil {
		s.writeLookupErr(w, r, err)
		return
	}
	if e.CaseID != id {
		s.notFound(w, r)
		return
	}
	data, err := s.Evidence.Get(r.Context(), e.StorageKey)
	if err != nil {
		s.notFound(w, r)
		return
	}
	w.Header().Set("Content-Type", e.ContentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+e.Filename+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// sanitizeFilename strips any path components and control chars from an
// uploaded filename so it is safe in a Content-Disposition header and as a
// display label (the object key never uses it).
func sanitizeFilename(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(rr rune) rune {
		if rr < 0x20 || rr == '"' || rr == '\\' {
			return '_'
		}
		return rr
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "evidence"
	}
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}
