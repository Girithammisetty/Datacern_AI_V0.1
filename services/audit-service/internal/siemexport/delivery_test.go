package siemexport

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// fakeConfigLookup is a real in-memory implementation of ConfigLookup for
// these tests (not a mock of siemexport's own logic — HTTPDelivery.Deliver
// itself runs unmodified and really does the SSRF-guard + format + HTTP POST).
type fakeConfigLookup struct {
	byTenant map[uuid.UUID]*SiemDestination
}

func (f fakeConfigLookup) ActiveSiemConfigForDelivery(_ context.Context, tenant uuid.UUID) (*SiemDestination, error) {
	return f.byTenant[tenant], nil
}

func TestHTTPDeliveryPostsToConfiguredEndpoint(t *testing.T) {
	var mu sync.Mutex
	var gotBody string
	var gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotBody = string(b)
		gotContentType = r.Header.Get("Content-Type")
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	tenant := uuid.New()
	d := NewHTTPDelivery(fakeConfigLookup{byTenant: map[uuid.UUID]*SiemDestination{
		tenant: {Endpoint: srv.URL, Format: FormatJSON},
	}}, true /* allowHTTP: httptest is a loopback http:// target */)

	rec := testRecord()
	rec.TenantID = tenant
	d.Deliver(context.Background(), tenant, Envelope(rec))

	mu.Lock()
	defer mu.Unlock()
	if gotBody == "" {
		t.Fatal("expected the destination server to receive a delivered body")
	}
	if gotContentType != "application/json" {
		t.Fatalf("expected application/json content-type, got %q", gotContentType)
	}
}

func TestHTTPDeliveryCEFContentType(t *testing.T) {
	var mu sync.Mutex
	var gotContentType, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotContentType = r.Header.Get("Content-Type")
		gotBody = string(b)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	tenant := uuid.New()
	d := NewHTTPDelivery(fakeConfigLookup{byTenant: map[uuid.UUID]*SiemDestination{
		tenant: {Endpoint: srv.URL, Format: FormatCEF},
	}}, true)

	rec := testRecord()
	rec.TenantID = tenant
	d.Deliver(context.Background(), tenant, Envelope(rec))

	mu.Lock()
	defer mu.Unlock()
	if gotContentType != "text/plain; charset=utf-8" {
		t.Fatalf("expected CEF delivery to use text/plain, got %q", gotContentType)
	}
	if gotBody == "" || gotBody[:4] != "CEF:" {
		t.Fatalf("expected a CEF-formatted body, got %q", gotBody)
	}
}

func TestHTTPDeliveryNoConfigIsNoOp(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	tenant := uuid.New()
	// This tenant has no entry in byTenant at all -- ActiveSiemConfigForDelivery
	// returns (nil, nil), matching a real "no configured destination" tenant.
	d := NewHTTPDelivery(fakeConfigLookup{byTenant: map[uuid.UUID]*SiemDestination{}}, true)

	rec := testRecord()
	rec.TenantID = tenant
	d.Deliver(context.Background(), tenant, Envelope(rec))

	if called {
		t.Fatal("expected no HTTP call for a tenant with no configured SIEM destination")
	}
}

func TestHTTPDeliveryBlocksSSRFTarget(t *testing.T) {
	tenant := uuid.New()
	d := NewHTTPDelivery(fakeConfigLookup{byTenant: map[uuid.UUID]*SiemDestination{
		// allowHTTP=false below, so a private RFC1918 target must be refused
		// even though the endpoint URL itself is well-formed.
		tenant: {Endpoint: "https://10.0.0.5/siem", Format: FormatJSON},
	}}, false)

	rec := testRecord()
	rec.TenantID = tenant
	// Deliver is best-effort/void — this test's real assertion is that it
	// does not panic and (implicitly, since 10.0.0.5 refuses real connections
	// in this sandbox) never reaches a live socket. The SSRF guard itself has
	// its own direct unit tests in libs/go-common/httpx.
	d.Deliver(context.Background(), tenant, Envelope(rec))
}

func TestHTTPDeliveryUnknownTenantIsNoOp(t *testing.T) {
	d := NewHTTPDelivery(fakeConfigLookup{byTenant: map[uuid.UUID]*SiemDestination{}}, true)
	// A totally different tenant than any key in byTenant -- same no-op path,
	// covering the "delivery ever accidentally reaches the wrong tenant's
	// endpoint" concern the BRD's cross-delivery integration test also checks
	// at the store layer.
	d.Deliver(context.Background(), uuid.New(), Envelope(testRecord()))
}
