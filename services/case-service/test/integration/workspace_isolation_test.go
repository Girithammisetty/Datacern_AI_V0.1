package integration

// Department isolation (realtime-case-streams initiative): a workspace-bearing
// token is confined to cases of its own workspace. Before RequireCaseWorkspace
// landed, any tenant user holding case.case.read could fetch ANY workspace's
// case by id — the search index carried workspace_id but nothing enforced it.
// The boundary 404s (never 403s): the cross-tenant-404 discipline
// (MASTER-FR-003) applied one level down, so another department's case ids are
// not even confirmed to exist. Workspace-less tokens (service-to-service
// writers, platform operations) stay tenant-scoped — asserted here too, so the
// trigger applier and tool-plane writers keep working.

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/case-service/internal/domain"
)

func TestWorkspaceIsolationOnCaseObjects(t *testing.T) {
	h := requireHarness(t)
	deptA := h.newActor(t)
	// Same tenant, different department (workspace).
	wsB := uuid.New()
	deptBTok := h.token(t, deptA.tenant, wsB, domain.TypUser, "u-dept-b", nil)

	created := h.createOne(t, deptA, "", time.Now().Add(72*time.Hour), nil)
	id := created["id"].(string)

	// The owning department sees its case.
	require.Equal(t, http.StatusOK,
		h.do(t, "GET", "/api/v1/cases/"+id, deptA.tok, nil, nil).status)

	// The other department gets 404 — on the object, its timeline, its
	// evidence, and on write verbs alike. Not 403: the id's existence is not
	// confirmed across the department boundary.
	for _, probe := range []struct{ method, path string }{
		{"GET", "/api/v1/cases/" + id},
		{"GET", "/api/v1/cases/" + id + "/timeline"},
		{"GET", "/api/v1/cases/" + id + "/evidence"},
		{"POST", "/api/v1/cases/" + id + "/assign"},
	} {
		var body any
		if probe.method == "POST" {
			body = map[string]any{"assignee_id": uuid.NewString()}
		}
		r := h.do(t, probe.method, probe.path, deptBTok, body, nil)
		require.Equal(t, http.StatusNotFound, r.status,
			"%s %s must 404 across the workspace boundary, got %d %v",
			probe.method, probe.path, r.status, r.body)
		require.Equal(t, "NOT_FOUND", errCode(r))
	}

	// A workspace-less token (service writers, platform ops) stays
	// tenant-scoped: the boundary must not break the trigger applier or the
	// tool-plane's federated write.
	svcTok := h.token(t, deptA.tenant, uuid.Nil, domain.TypService, "svc:probe",
		map[string]any{"workspace_id": ""})
	require.Equal(t, http.StatusOK,
		h.do(t, "GET", "/api/v1/cases/"+id, svcTok, nil, nil).status)
}
