package httpx

import "testing"

// TestGuardURL proves private/link-local/metadata targets are refused and
// non-https is rejected (ported from notification-service's webhook SSRF
// guard test, BRD 59 WS2).
func TestGuardURL(t *testing.T) {
	forbidden := []string{
		"http://169.254.169.254/",   // cloud metadata (and non-https)
		"https://169.254.169.254/",  // metadata
		"https://10.0.0.5/hook",     // RFC1918
		"https://192.168.1.10/hook", // RFC1918
		"https://127.0.0.1/hook",    // loopback
		"https://[::1]/hook",        // ipv6 loopback
		"ftp://example.com/hook",    // bad scheme
	}
	for _, u := range forbidden {
		if _, err := GuardURL(u, false); err == nil {
			t.Errorf("expected %s to be forbidden", u)
		}
	}
}

func TestGuardURLAllowHTTPEscape(t *testing.T) {
	// allowHTTP permits both http:// and a loopback target -- the dev/e2e
	// escape used by tests exercising real delivery against an httptest server.
	if _, err := GuardURL("http://127.0.0.1:8080/hook", true); err != nil {
		t.Fatalf("expected allowHTTP to permit a loopback http target, got: %v", err)
	}
}

func TestGuardURLInvalidURL(t *testing.T) {
	if _, err := GuardURL("://not a url", false); err == nil {
		t.Fatal("expected an error for a malformed URL")
	}
}
