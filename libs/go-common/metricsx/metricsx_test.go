package metricsx

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddlewareRecordsAndHandlerRenders(t *testing.T) {
	reg := New("test-service")
	h := reg.Middleware(func(r *http.Request) string { return r.URL.Path })(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusTeapot)
			_, _ = w.Write([]byte("hi"))
		}),
	)
	// drive one request through the middleware
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/widgets", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status passthrough broke: %d", rec.Code)
	}

	// scrape /metrics
	mrec := httptest.NewRecorder()
	reg.Handler().ServeHTTP(mrec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body, _ := io.ReadAll(mrec.Result().Body)
	text := string(body)
	for _, want := range []string{
		`http_requests_total{`, `service="test-service"`, `route="/widgets"`,
		`status="418"`, `http_request_duration_seconds_bucket`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("metrics output missing %q\n---\n%s", want, text)
		}
	}
}

// TestMiddlewarePreservesOptionalWriterInterfaces guards the bug class that has
// now bitten this middleware twice: embedding http.ResponseWriter promotes only
// that interface's own methods, so every OPTIONAL interface a handler asserts on
// silently disappears behind the wrapper. Losing http.Flusher broke SSE; losing
// http.Hijacker broke WebSocket upgrades with a 500 on every attempt. Both are
// invisible to a status-code test — the wrapper looks perfectly healthy.
//
// Assert on the wrapper the handler ACTUALLY receives, so a third omission
// fails here instead of in a service's integration suite.
func TestMiddlewarePreservesOptionalWriterInterfaces(t *testing.T) {
	reg := New("iface-service")
	var flushed, hijackable bool
	h := reg.Middleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, flushed = w.(http.Flusher)
		_, hijackable = w.(http.Hijacker)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))

	if !flushed {
		t.Fatal("handler saw no http.Flusher through the middleware — SSE would break")
	}
	if !hijackable {
		t.Fatal("handler saw no http.Hijacker through the middleware — WS upgrades would 500")
	}
}

// A writer that cannot be hijacked must produce an error, not a panic: HTTP/2
// and httptest.ResponseRecorder are both non-hijackable, and a crashed handler
// is a far worse failure than a refused upgrade.
func TestHijackOnNonHijackableWriterErrorsInsteadOfPanicking(t *testing.T) {
	rec := &statusRecorder{ResponseWriter: httptest.NewRecorder(), status: http.StatusOK}
	conn, rw, err := rec.Hijack()
	if err == nil {
		t.Fatal("expected an error hijacking a non-hijackable writer")
	}
	if conn != nil || rw != nil {
		t.Fatal("failed hijack must not hand back a connection")
	}
	if !strings.Contains(err.Error(), "http.Hijacker") {
		t.Fatalf("error should name the missing interface, got %v", err)
	}
}
