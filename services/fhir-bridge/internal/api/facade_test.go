package api

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/datacern-ai/fhir-bridge/internal/authz"
	"github.com/datacern-ai/fhir-bridge/internal/fhirclient"
)

// The backend facade is the tool-plane federation target (TPL-FR-012). These
// tests pin the peer-identity contract (fail-closed SPIFFE allowlist), the
// OPA re-check of the effective human, the tool_id dispatch and the
// {"output":...} response shapes tool-plane maps onto its error codes.

const goodSpiffe = "spiffe://datacern/ns/tools/sa/mcp-gateway"

func facadeCall(t *testing.T, s *Server, spiffe, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/internal/v1/mcp/invoke", strings.NewReader(body))
	if spiffe != "" {
		r.Header.Set("X-Spiffe-Id", spiffe)
	}
	w := httptest.NewRecorder()
	s.handleToolFacade(w, r)
	return w
}

func facadeOutputOf(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out struct {
		Output map[string]any `json:"output"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad envelope %q: %v", w.Body.String(), err)
	}
	if out.Output == nil {
		t.Fatalf("missing output envelope: %s", w.Body.String())
	}
	return out.Output
}

// TestFacade_FailsClosedWithoutAllowlist pins the fail-closed contract: with
// FHIR_FACADE_ALLOWED_SPIFFE unset the facade must refuse even a non-empty
// X-Spiffe-Id, because there is nothing to verify the (spoofable) header against.
func TestFacade_FailsClosedWithoutAllowlist(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", "")
	s := &Server{}
	w := facadeCall(t, s, goodSpiffe, `{"tool_id":"fhir.read_resource","tenant":"t","obo_sub":"u","args":{}}`)
	if w.Code != 403 {
		t.Fatalf("unconfigured allowlist must fail closed with 403, got %d", w.Code)
	}
	if facadeOutputOf(t, w)["error"] == nil {
		t.Fatal("expected output.error")
	}
}

func TestFacade_RejectsWrongSpiffe(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	s := &Server{}
	for _, spiffe := range []string{"", "spiffe://evil/sa/other"} {
		w := facadeCall(t, s, spiffe, `{"tool_id":"fhir.read_resource","tenant":"t","obo_sub":"u","args":{}}`)
		if w.Code != 403 {
			t.Fatalf("spiffe %q must be 403, got %d", spiffe, w.Code)
		}
	}
}

func TestFacade_UnknownToolID(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	s := &Server{}
	w := facadeCall(t, s, goodSpiffe, `{"tool_id":"fhir.delete_resource","tenant":"t","obo_sub":"u","args":{}}`)
	if w.Code != 404 {
		t.Fatalf("unknown tool_id must be 404, got %d", w.Code)
	}
}

func TestFacade_OPADenyIs403Shaped(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	tenant := uuid.New()
	st := newFakeStore()
	be := mustBackend(st, tenant, "epic", "active")
	s := &Server{
		Store: st,
		FHIR:  &fakeFHIR{resp: &fhirclient.Response{Status: 200, Body: []byte(`{}`)}},
		Authz: authz.Static{Denied: map[string]bool{authz.ActionResourceRead: true}},
	}
	body := fmt.Sprintf(`{"tool_id":"fhir.read_resource","tenant":"%s","obo_sub":"user-1",
		"args":{"backend_id":"%s","resource_type":"Patient","resource_id":"p1"}}`, tenant, be.ID)
	w := facadeCall(t, s, goodSpiffe, body)
	if w.Code != 403 {
		t.Fatalf("OPA deny must be 403, got %d %s", w.Code, w.Body.String())
	}
	msg, _ := facadeOutputOf(t, w)["error"].(string)
	if !strings.Contains(msg, authz.ActionResourceRead) {
		t.Fatalf("error must name the denied action, got %q", msg)
	}
}

func TestFacade_NilAuthzFailsClosed(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	s := &Server{Store: newFakeStore()}
	w := facadeCall(t, s, goodSpiffe,
		`{"tool_id":"fhir.read_resource","tenant":"`+uuid.NewString()+`","obo_sub":"u","args":{}}`)
	if w.Code != 403 {
		t.Fatalf("nil authorizer must fail closed 403, got %d", w.Code)
	}
}

func TestFacade_BackendMissingDisabledOrCrossTenantIs404(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	tenant := uuid.New()
	st := newFakeStore()
	disabled := mustBackend(st, tenant, "off", "disabled")
	other := mustBackend(st, uuid.New(), "other-tenant", "active")
	s := &Server{Store: st, FHIR: &fakeFHIR{}, Authz: authz.Static{}}
	for name, backendID := range map[string]string{
		"missing": uuid.NewString(), "disabled": disabled.ID.String(), "cross-tenant": other.ID.String(),
	} {
		body := fmt.Sprintf(`{"tool_id":"fhir.read_resource","tenant":"%s","obo_sub":"u",
			"args":{"backend_id":"%s","resource_type":"Patient","resource_id":"p1"}}`, tenant, backendID)
		if w := facadeCall(t, s, goodSpiffe, body); w.Code != 404 {
			t.Fatalf("%s backend must be 404, got %d", name, w.Code)
		}
	}
}

func TestFacade_ReadHappyPath(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	tenant := uuid.New()
	st := newFakeStore()
	be := mustBackend(st, tenant, "epic", "active")
	fh := &fakeFHIR{resp: &fhirclient.Response{Status: 200, Body: []byte(`{"resourceType":"Patient","id":"p1"}`)}}
	s := &Server{Store: st, FHIR: fh, Authz: authz.Static{}}
	body := fmt.Sprintf(`{"tool_id":"fhir.read_resource","tenant":"%s","obo_sub":"user-1","agent_id":"agent-9",
		"args":{"backend_id":"%s","resource_type":"Patient","resource_id":"p1"}}`, tenant, be.ID)
	w := facadeCall(t, s, goodSpiffe, body)
	if w.Code != 200 {
		t.Fatalf("code = %d body = %s", w.Code, w.Body.String())
	}
	out := facadeOutputOf(t, w)
	res, _ := out["resource"].(map[string]any)
	if res["id"] != "p1" {
		t.Fatalf("output.resource = %v", out["resource"])
	}
	if out["status"] != float64(200) {
		t.Fatalf("output.status = %v", out["status"])
	}
	if fh.lastOp != "read" || fh.lastType != "Patient" || fh.lastID != "p1" || fh.lastBackend.ID != be.ID.String() {
		t.Fatalf("fhir call = %+v", fh)
	}
}

func TestFacade_SearchHappyPath(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	tenant := uuid.New()
	st := newFakeStore()
	be := mustBackend(st, tenant, "epic", "active")
	fh := &fakeFHIR{resp: &fhirclient.Response{Status: 200, Body: []byte(`{"resourceType":"Bundle","total":2}`)}}
	s := &Server{Store: st, FHIR: fh, Authz: authz.Static{}}
	body := fmt.Sprintf(`{"tool_id":"fhir.search_resources","tenant":"%s","obo_sub":"user-1",
		"args":{"backend_id":"%s","resource_type":"Observation","params":{"patient":"p1","code":"1234-5"}}}`, tenant, be.ID)
	w := facadeCall(t, s, goodSpiffe, body)
	if w.Code != 200 {
		t.Fatalf("code = %d body = %s", w.Code, w.Body.String())
	}
	out := facadeOutputOf(t, w)
	bundle, _ := out["bundle"].(map[string]any)
	if bundle["resourceType"] != "Bundle" {
		t.Fatalf("output.bundle = %v", out["bundle"])
	}
	if fh.lastOp != "search" || fh.lastParams["code"] != "1234-5" {
		t.Fatalf("fhir call = %+v", fh)
	}
}

func TestFacade_CreateAndUpdateHappyPath(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	tenant := uuid.New()
	st := newFakeStore()
	be := mustBackend(st, tenant, "epic", "active")
	fh := &fakeFHIR{resp: &fhirclient.Response{Status: 201, Body: []byte(`{"resourceType":"Patient","id":"new"}`)}}
	s := &Server{Store: st, FHIR: fh, Authz: authz.Static{}}

	body := fmt.Sprintf(`{"tool_id":"fhir.create_resource","tenant":"%s","obo_sub":"u",
		"args":{"backend_id":"%s","resource_type":"Patient","resource":{"resourceType":"Patient","name":[{"family":"X"}]}}}`, tenant, be.ID)
	w := facadeCall(t, s, goodSpiffe, body)
	if w.Code != 200 {
		t.Fatalf("create code = %d body = %s", w.Code, w.Body.String())
	}
	if fh.lastOp != "create" || !strings.Contains(string(fh.lastResource), `"family":"X"`) {
		t.Fatalf("fhir call = %+v", fh)
	}

	fh.resp = &fhirclient.Response{Status: 200, Body: []byte(`{"resourceType":"Patient","id":"p9"}`)}
	body = fmt.Sprintf(`{"tool_id":"fhir.update_resource","tenant":"%s","obo_sub":"u",
		"args":{"backend_id":"%s","resource_type":"Patient","resource_id":"p9","resource":{"resourceType":"Patient","id":"p9"}}}`, tenant, be.ID)
	w = facadeCall(t, s, goodSpiffe, body)
	if w.Code != 200 {
		t.Fatalf("update code = %d body = %s", w.Code, w.Body.String())
	}
	if fh.lastOp != "update" || fh.lastID != "p9" {
		t.Fatalf("fhir call = %+v", fh)
	}
}

func TestFacade_ArgValidation(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	tenant := uuid.New()
	st := newFakeStore()
	be := mustBackend(st, tenant, "epic", "active")
	s := &Server{Store: st, FHIR: &fakeFHIR{}, Authz: authz.Static{}}
	cases := []string{
		`{"tool_id":"fhir.read_resource","tenant":"not-a-uuid","obo_sub":"u","args":{}}`,
		fmt.Sprintf(`{"tool_id":"fhir.read_resource","tenant":"%s","obo_sub":"u","args":{"backend_id":"nope","resource_type":"Patient","resource_id":"p"}}`, tenant),
		fmt.Sprintf(`{"tool_id":"fhir.read_resource","tenant":"%s","obo_sub":"u","args":{"backend_id":"%s","resource_type":"../etc","resource_id":"p"}}`, tenant, be.ID),
		fmt.Sprintf(`{"tool_id":"fhir.read_resource","tenant":"%s","obo_sub":"u","args":{"backend_id":"%s","resource_type":"Patient","resource_id":"a/b"}}`, tenant, be.ID),
		fmt.Sprintf(`{"tool_id":"fhir.create_resource","tenant":"%s","obo_sub":"u","args":{"backend_id":"%s","resource_type":"Patient","resource":"not-an-object"}}`, tenant, be.ID),
		fmt.Sprintf(`{"tool_id":"fhir.search_resources","tenant":"%s","obo_sub":"u","args":{"backend_id":"%s","resource_type":"Patient","params":{"a":1}}}`, tenant, be.ID),
	}
	for i, body := range cases {
		if w := facadeCall(t, s, goodSpiffe, body); w.Code != 400 {
			t.Errorf("case %d: code = %d, want 400 (%s)", i, w.Code, w.Body.String())
		}
	}
}

func TestFacade_UpstreamErrorsRelayedWithoutBodies(t *testing.T) {
	t.Setenv("FHIR_FACADE_ALLOWED_SPIFFE", goodSpiffe)
	tenant := uuid.New()
	st := newFakeStore()
	be := mustBackend(st, tenant, "epic", "active")
	fh := &fakeFHIR{resp: &fhirclient.Response{Status: 404, Body: []byte(`{"resourceType":"OperationOutcome","issue":[{"diagnostics":"SENSITIVE"}]}`)}}
	s := &Server{Store: st, FHIR: fh, Authz: authz.Static{}}
	body := fmt.Sprintf(`{"tool_id":"fhir.read_resource","tenant":"%s","obo_sub":"u",
		"args":{"backend_id":"%s","resource_type":"Patient","resource_id":"gone"}}`, tenant, be.ID)
	w := facadeCall(t, s, goodSpiffe, body)
	if w.Code != 404 {
		t.Fatalf("upstream 404 must relay as 404, got %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "SENSITIVE") {
		t.Fatal("upstream body must never be echoed into facade errors")
	}
	fh.resp = &fhirclient.Response{Status: 500, Body: []byte(`{}`)}
	if w := facadeCall(t, s, goodSpiffe, body); w.Code != 502 {
		t.Fatalf("upstream 500 must become 502, got %d", w.Code)
	}
}
