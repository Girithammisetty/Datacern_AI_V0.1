package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
	"testing"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// fakeLogoStore is a real in-memory implementation of api.LogoStore for tests
// (not a mock of the handlers -- Put/Get/Delete really round-trip bytes; only
// the MinIO transport is swapped out).
type fakeLogoStore struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func newFakeLogoStore() *fakeLogoStore { return &fakeLogoStore{objs: map[string][]byte{}} }

func (f *fakeLogoStore) Put(_ context.Context, key string, data []byte, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := append([]byte(nil), data...)
	f.objs[key] = cp
	return nil
}

func (f *fakeLogoStore) Get(_ context.Context, key string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.objs[key]
	if !ok {
		return nil, domain.ENotFound("logo")
	}
	return d, nil
}

func (f *fakeLogoStore) Delete(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objs, key)
	return nil
}

// uploadLogo builds a real multipart/form-data POST (f.do only supports JSON
// bodies) so the handler's ParseMultipartForm/FormFile path is exercised as a
// real HTTP request, not a hand-built *http.Request.
func uploadLogo(t *testing.T, f *fixture, token string, data []byte, contentType string) resp {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="file"; filename="logo.png"`},
		"Content-Type":        {contentType},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/v1/tenants/self/branding/logo", &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{status: res.StatusCode, raw: raw, headers: res.Header}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out.body)
	}
	return out
}

// TestBranding_GetUnconfiguredIsOkNotNotFound: a tenant that never set
// branding gets the all-empty "unconfigured" 200 shape, not a 404 -- the app
// shell always has something to render.
func TestBranding_GetUnconfiguredIsOkNotNotFound(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("brand-unconf")
	u := f.activeUser(tn, "member@brand-unconf.com")
	r := f.do(http.MethodGet, "/api/v1/tenants/self/branding", f.userToken(u), nil)
	if r.status != http.StatusOK {
		t.Fatalf("want 200, got %d %s", r.status, string(r.raw))
	}
	if r.body["configured"] != false {
		t.Fatalf("want configured=false, got %v", r.body)
	}
}

// TestBranding_SetRequiresAdminScope: a zero-scope member cannot set branding
// colors; a tenant admin can.
func TestBranding_SetRequiresAdminScope(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("brand-scope")
	u := f.activeUser(tn, "member@brand-scope.com")

	r := f.do(http.MethodPut, "/api/v1/tenants/self/branding", f.userToken(u),
		map[string]any{"primary_color": "221 83% 53%", "accent_color": "210 40% 94%"})
	if r.status != http.StatusForbidden {
		t.Fatalf("zero-scope set branding: want 403, got %d %s", r.status, string(r.raw))
	}

	r = f.do(http.MethodPut, "/api/v1/tenants/self/branding", f.adminToken(tn.ID),
		map[string]any{"primary_color": "221 83% 53%", "accent_color": "210 40% 94%"})
	if r.status != http.StatusOK {
		t.Fatalf("admin set branding: want 200, got %d %s", r.status, string(r.raw))
	}
	if r.body["primary_color"] != "221 83% 53%" || r.body["accent_color"] != "210 40% 94%" {
		t.Fatalf("unexpected body: %v", r.body)
	}

	// Any member (not just the admin who set it) reads the same colors back.
	r = f.do(http.MethodGet, "/api/v1/tenants/self/branding", f.userToken(u), nil)
	if r.status != http.StatusOK || r.body["primary_color"] != "221 83% 53%" {
		t.Fatalf("member read-back: %d %v", r.status, r.body)
	}
}

// TestBranding_RejectsMalformedColor: a color that isn't a bare "H S% L%"
// triplet is rejected -- this string is interpolated directly into a CSS
// custom property, so anything else (a full hsl(...) call, a stray ';' or
// '}') could inject other CSS if it reached the client unvalidated.
func TestBranding_RejectsMalformedColor(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("brand-bad-color")
	cases := []string{"hsl(221, 83%, 53%)", "221 83% 53%; } body{display:none", "red", "not-a-color"}
	for _, c := range cases {
		r := f.do(http.MethodPut, "/api/v1/tenants/self/branding", f.adminToken(tn.ID),
			map[string]any{"primary_color": c, "accent_color": ""})
		if r.status != http.StatusUnprocessableEntity {
			t.Fatalf("color %q: want 422, got %d %s", c, r.status, string(r.raw))
		}
	}
}

// TestBranding_LogoUploadRequiresConfiguredStore: without a Logo store wired
// (the fixture's default), upload honestly 501s rather than silently no-op'ing.
func TestBranding_LogoUploadRequiresConfiguredStore(t *testing.T) {
	f := newFixture(t)
	tn := f.activeTenant("brand-nologo")
	r := uploadLogo(t, f, f.adminToken(tn.ID), []byte("\x89PNG\r\n\x1a\n"), "image/png")
	if r.status != http.StatusNotImplemented {
		t.Fatalf("want 501 with no Logo store, got %d %s", r.status, string(r.raw))
	}
}

// TestBranding_LogoRoundTrip: with a real (fake) object store wired, an admin
// uploads a logo, any member can fetch it back byte-for-byte with the right
// content type, and it survives independently of the color tokens (uploading
// a logo does not clobber previously-set colors, and vice versa).
func TestBranding_LogoRoundTrip(t *testing.T) {
	f := newFixture(t)
	f.srv.Logo = newFakeLogoStore()
	tn := f.activeTenant("brand-logo")
	u := f.activeUser(tn, "member@brand-logo.com")

	// Set colors first.
	if r := f.do(http.MethodPut, "/api/v1/tenants/self/branding", f.adminToken(tn.ID),
		map[string]any{"primary_color": "221 83% 53%", "accent_color": ""}); r.status != http.StatusOK {
		t.Fatalf("set colors: %d %s", r.status, string(r.raw))
	}

	png := []byte("\x89PNG\r\n\x1a\nfake-logo-bytes")
	if r := uploadLogo(t, f, f.adminToken(tn.ID), png, "image/png"); r.status != http.StatusOK {
		t.Fatalf("upload logo: %d %s", r.status, string(r.raw))
	} else if r.body["has_logo"] != true || r.body["primary_color"] != "221 83% 53%" {
		t.Fatalf("upload response should keep prior colors: %v", r.body)
	}

	// Any member can fetch the bytes back.
	req, _ := http.NewRequest(http.MethodGet, f.ts.URL+"/api/v1/tenants/self/branding/logo", nil)
	req.Header.Set("Authorization", "Bearer "+f.userToken(u))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get logo: want 200, got %d", res.StatusCode)
	}
	if !bytes.Equal(got, png) {
		t.Fatalf("logo bytes mismatch: got %q want %q", got, png)
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type: got %q", ct)
	}

	// Uploading a logo for a DIFFERENT tenant must never surface here.
	tn2 := f.activeTenant("brand-logo-2")
	png2 := []byte("\x89PNG\r\n\x1a\nOTHER-TENANT-LOGO")
	if r := uploadLogo(t, f, f.adminToken(tn2.ID), png2, "image/png"); r.status != http.StatusOK {
		t.Fatalf("upload logo tenant 2: %d %s", r.status, string(r.raw))
	}
	req2, _ := http.NewRequest(http.MethodGet, f.ts.URL+"/api/v1/tenants/self/branding/logo", nil)
	req2.Header.Set("Authorization", "Bearer "+f.userToken(u)) // still tenant 1's member
	res2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	got2, _ := io.ReadAll(res2.Body)
	if !bytes.Equal(got2, png) {
		t.Fatal("cross-tenant leak: tenant 1's member fetched tenant 2's logo")
	}
}

// TestBranding_RejectsUnsupportedContentType: only image/{png,jpeg,svg+xml,webp}
// are accepted -- an arbitrary upload (e.g. an HTML file, which could be a
// stored-XSS vector if ever served inline) is rejected before it reaches
// object storage.
func TestBranding_RejectsUnsupportedContentType(t *testing.T) {
	f := newFixture(t)
	f.srv.Logo = newFakeLogoStore()
	tn := f.activeTenant("brand-badtype")
	r := uploadLogo(t, f, f.adminToken(tn.ID), []byte("<script>alert(1)</script>"), "text/html")
	if r.status != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 for text/html upload, got %d %s", r.status, string(r.raw))
	}
}

// TestBranding_DeleteRevertsToDefault: DELETE clears both colors and the
// logo, and is idempotent (admin-only; a zero-scope caller is forbidden).
func TestBranding_DeleteRevertsToDefault(t *testing.T) {
	f := newFixture(t)
	f.srv.Logo = newFakeLogoStore()
	tn := f.activeTenant("brand-delete")
	u := f.activeUser(tn, "member@brand-delete.com")

	f.do(http.MethodPut, "/api/v1/tenants/self/branding", f.adminToken(tn.ID),
		map[string]any{"primary_color": "221 83% 53%", "accent_color": ""})
	uploadLogo(t, f, f.adminToken(tn.ID), []byte("\x89PNG\r\n\x1a\n"), "image/png")

	if r := f.do(http.MethodDelete, "/api/v1/tenants/self/branding", f.userToken(u), nil); r.status != http.StatusForbidden {
		t.Fatalf("zero-scope delete: want 403, got %d", r.status)
	}
	if r := f.do(http.MethodDelete, "/api/v1/tenants/self/branding", f.adminToken(tn.ID), nil); r.status != http.StatusNoContent {
		t.Fatalf("admin delete: want 204, got %d %s", r.status, string(r.raw))
	}
	r := f.do(http.MethodGet, "/api/v1/tenants/self/branding", f.userToken(u), nil)
	if r.body["configured"] != false || r.body["has_logo"] != false {
		t.Fatalf("want fully reverted, got %v", r.body)
	}
	// Idempotent: deleting an already-cleared branding is still a clean 204.
	if r := f.do(http.MethodDelete, "/api/v1/tenants/self/branding", f.adminToken(tn.ID), nil); r.status != http.StatusNoContent {
		t.Fatalf("second delete: want 204, got %d", r.status)
	}
}
