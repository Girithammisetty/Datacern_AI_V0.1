package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/go-common/authjwt"

	"github.com/datacern-ai/fhir-bridge/internal/authz"
	"github.com/datacern-ai/fhir-bridge/internal/fhirclient"
	"github.com/datacern-ai/fhir-bridge/internal/store"
)

// The CRUD handlers are exercised directly with verified claims stashed on the
// context (the same way the authjwt middleware would) and a chi route context
// for {id} — no network, doubles only.

func adminReq(t *testing.T, method, target, body string, tenant uuid.UUID, id string) *http.Request {
	t.Helper()
	var rdr *strings.Reader
	if body == "" {
		rdr = strings.NewReader("")
	} else {
		rdr = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, target, rdr)
	claims := &authjwt.Claims{Sub: "admin-1", TenantID: tenant.String(), Typ: "user"}
	ctx := authjwt.WithClaims(r.Context(), claims)
	if id != "" {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", id)
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	}
	return r.WithContext(ctx)
}

func dataOf(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad envelope %q: %v", w.Body.String(), err)
	}
	return out.Data
}

func TestCreateBackend_WritesSecretToVaultNotPostgres(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	vault := newFakeVault()
	s := &Server{Store: st, Secrets: vault}
	body := `{"name":"epic-prod","base_url":"https://fhir.example.com/r4","auth_method":"bearer",
		"secret":{"token":"top-secret-token"}}`
	w := httptest.NewRecorder()
	s.handleCreateBackend(w, adminReq(t, "POST", "/api/v1/fhir-backends", body, tenant, ""))
	if w.Code != 201 {
		t.Fatalf("code = %d body = %s", w.Code, w.Body.String())
	}
	data := dataOf(t, w)
	ref, _ := data["vault_ref"].(string)
	wantPrefix := fmt.Sprintf("secret/data/tenants/%s/fhir-backends/", tenant)
	if !strings.HasPrefix(ref, wantPrefix) {
		t.Fatalf("vault_ref = %q, want prefix %q", ref, wantPrefix)
	}
	if vault.data[ref]["token"] != "top-secret-token" {
		t.Fatalf("vault data = %v", vault.data)
	}
	// The secret must appear NOWHERE outside Vault: not in the response, not
	// in the stored row.
	if strings.Contains(w.Body.String(), "top-secret-token") {
		t.Fatal("secret material leaked into the API response")
	}
	for _, row := range st.rows {
		raw, _ := json.Marshal(row)
		if strings.Contains(string(raw), "top-secret-token") {
			t.Fatal("secret material leaked into the store row")
		}
	}
}

func TestCreateBackend_Validation(t *testing.T) {
	tenant := uuid.New()
	s := &Server{Store: newFakeStore(), Secrets: newFakeVault()}
	cases := []string{
		`{"base_url":"https://x.example","auth_method":"none"}`,                       // missing name
		`{"name":"a","base_url":"ftp://x.example","auth_method":"none"}`,              // bad scheme
		`{"name":"a","base_url":"https://x.example","auth_method":"magic"}`,           // bad method
		`{"name":"a","base_url":"https://x.example","auth_method":"bearer"}`,          // secret required
		`{"name":"a","base_url":"https://x.example","auth_method":"oauth2_client_credentials","secret":{"client_secret":"s"}}`, // token_url/client_id required
	}
	for i, body := range cases {
		w := httptest.NewRecorder()
		s.handleCreateBackend(w, adminReq(t, "POST", "/api/v1/fhir-backends", body, tenant, ""))
		if w.Code != 400 {
			t.Errorf("case %d: code = %d, want 400 (%s)", i, w.Code, w.Body.String())
		}
	}
}

func TestCreateBackend_NameConflict(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	mustBackend(st, tenant, "epic", "active")
	s := &Server{Store: st, Secrets: newFakeVault()}
	w := httptest.NewRecorder()
	s.handleCreateBackend(w, adminReq(t, "POST", "/api/v1/fhir-backends",
		`{"name":"epic","base_url":"https://x.example","auth_method":"none"}`, tenant, ""))
	if w.Code != 409 {
		t.Fatalf("duplicate name must be 409, got %d", w.Code)
	}
}

func TestListBackends_TenantScoped(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	mustBackend(st, tenant, "mine", "active")
	mustBackend(st, uuid.New(), "other", "active")
	s := &Server{Store: st}
	w := httptest.NewRecorder()
	s.handleListBackends(w, adminReq(t, "GET", "/api/v1/fhir-backends", "", tenant, ""))
	if w.Code != 200 {
		t.Fatalf("code = %d", w.Code)
	}
	var out struct {
		Data []map[string]any `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Data) != 1 || out.Data[0]["name"] != "mine" {
		t.Fatalf("data = %v", out.Data)
	}
}

func TestGetBackend_NotFoundAndCrossTenant(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	other := mustBackend(st, uuid.New(), "other", "active")
	s := &Server{Store: st}
	for _, id := range []string{uuid.NewString(), other.ID.String(), "not-a-uuid"} {
		w := httptest.NewRecorder()
		s.handleGetBackend(w, adminReq(t, "GET", "/api/v1/fhir-backends/"+id, "", tenant, id))
		if w.Code != 404 {
			t.Fatalf("id %q: code = %d, want 404", id, w.Code)
		}
	}
}

func TestPatchBackend_UpdatesAndRotatesSecret(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	vault := newFakeVault()
	b := &store.Backend{ID: uuid.New(), TenantID: tenant, Name: "epic",
		BaseURL: "https://old.example", AuthMethod: "bearer",
		VaultRef: fmt.Sprintf("secret/data/tenants/%s/fhir-backends/x", tenant), Status: "active"}
	_ = st.Create(context.Background(), b)
	vault.data[b.VaultRef] = map[string]string{"token": "old"}
	s := &Server{Store: st, Secrets: vault}

	body := `{"base_url":"https://new.example","status":"disabled","secret":{"token":"rotated"}}`
	w := httptest.NewRecorder()
	s.handlePatchBackend(w, adminReq(t, "PATCH", "/api/v1/fhir-backends/"+b.ID.String(), body, tenant, b.ID.String()))
	if w.Code != 200 {
		t.Fatalf("code = %d body = %s", w.Code, w.Body.String())
	}
	got, _ := st.Get(context.Background(), tenant, b.ID)
	if got.BaseURL != "https://new.example" || got.Status != "disabled" {
		t.Fatalf("row = %+v", got)
	}
	if vault.data[b.VaultRef]["token"] != "rotated" {
		t.Fatalf("vault = %v, want rotated secret", vault.data)
	}
}

func TestPatchBackend_RejectsBadStatus(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	b := mustBackend(st, tenant, "epic", "active")
	s := &Server{Store: st, Secrets: newFakeVault()}
	w := httptest.NewRecorder()
	s.handlePatchBackend(w, adminReq(t, "PATCH", "/x", `{"status":"paused"}`, tenant, b.ID.String()))
	if w.Code != 400 {
		t.Fatalf("code = %d, want 400", w.Code)
	}
}

func TestDeleteBackend_RemovesRowAndVaultEntry(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	vault := newFakeVault()
	b := &store.Backend{ID: uuid.New(), TenantID: tenant, Name: "epic",
		BaseURL: "https://x.example", AuthMethod: "bearer",
		VaultRef: "secret/data/tenants/t/fhir-backends/y", Status: "active"}
	_ = st.Create(context.Background(), b)
	vault.data[b.VaultRef] = map[string]string{"token": "x"}
	s := &Server{Store: st, Secrets: vault}
	w := httptest.NewRecorder()
	s.handleDeleteBackend(w, adminReq(t, "DELETE", "/x", "", tenant, b.ID.String()))
	if w.Code != 204 {
		t.Fatalf("code = %d", w.Code)
	}
	if _, err := st.Get(context.Background(), tenant, b.ID); err == nil {
		t.Fatal("row must be gone")
	}
	if _, ok := vault.data[b.VaultRef]; ok {
		t.Fatal("vault entry must be deleted")
	}
}

func TestDeleteBackend_VaultFailureIsBestEffort(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	vault := newFakeVault()
	b := &store.Backend{ID: uuid.New(), TenantID: tenant, Name: "epic",
		BaseURL: "https://x.example", AuthMethod: "bearer",
		VaultRef: "secret/data/t/y", Status: "active"}
	_ = st.Create(context.Background(), b)
	vault.errs = true
	s := &Server{Store: st, Secrets: vault}
	w := httptest.NewRecorder()
	s.handleDeleteBackend(w, adminReq(t, "DELETE", "/x", "", tenant, b.ID.String()))
	if w.Code != 204 {
		t.Fatalf("vault failure must not fail the delete: code = %d", w.Code)
	}
}

func TestTestBackend_ProbesMetadata(t *testing.T) {
	tenant := uuid.New()
	st := newFakeStore()
	b := mustBackend(st, tenant, "hapi", "active")
	fh := &fakeFHIR{resp: &fhirclient.Response{Status: 200,
		Body: []byte(`{"resourceType":"CapabilityStatement","fhirVersion":"4.0.1"}`)}}
	s := &Server{Store: st, FHIR: fh}
	w := httptest.NewRecorder()
	s.handleTestBackend(w, adminReq(t, "POST", "/x", "", tenant, b.ID.String()))
	if w.Code != 200 {
		t.Fatalf("code = %d", w.Code)
	}
	data := dataOf(t, w)
	if data["ok"] != true || data["fhir_version"] != "4.0.1" || data["status"] != float64(200) {
		t.Fatalf("data = %v", data)
	}
	if fh.lastOp != "metadata" {
		t.Fatalf("op = %s", fh.lastOp)
	}
}

// TestRequireActionDeniedThroughRouter exercises the full /api/v1 stack with a
// static-key verifier: an OPA deny surfaces as the 403 envelope, and the
// authorized path reaches the handler.
func TestRequireActionDeniedThroughRouter(t *testing.T) {
	tenant := uuid.New()
	verifier, token := staticVerifier(t, tenant)
	s := &Server{
		Store: newFakeStore(), Secrets: newFakeVault(), Verifier: verifier,
		Authz: authz.Static{Denied: map[string]bool{authz.ActionBackendList: true}},
	}
	h := s.Router()

	// Denied action → 403 envelope.
	r := httptest.NewRequest("GET", "/api/v1/fhir-backends", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 || !strings.Contains(w.Body.String(), "PERMISSION_DENIED") {
		t.Fatalf("code = %d body = %s", w.Code, w.Body.String())
	}

	// No token → 401.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/fhir-backends", nil))
	if w.Code != 401 {
		t.Fatalf("missing token: code = %d", w.Code)
	}

	// Allowed action (read on {id}) reaches the handler (404: no such row).
	r = httptest.NewRequest("GET", "/api/v1/fhir-backends/"+uuid.NewString(), nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatalf("allowed path: code = %d body = %s", w.Code, w.Body.String())
	}
}
