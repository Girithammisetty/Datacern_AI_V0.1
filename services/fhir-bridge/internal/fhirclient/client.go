// Package fhirclient is the real outbound HTTP adapter to a configured
// external FHIR R4 backend (Epic / Cerner / OpenEMR / HAPI-class). Four
// operations — Read, Search, Create, Update — plus the /metadata capability
// probe. It attaches per-backend auth (bearer / basic / OAuth2 client
// credentials / SMART Backend Services, secret material from Vault), caps
// response size at 4 MiB, never follows a redirect off the backend's host,
// and validates resource types and ids against conservative grammars so a
// crafted arg can never traverse the URL path.
//
// The bridge is stateless: nothing read from the backend is persisted, and
// callers must log only metadata (type/id/status/latency) — never bodies.
package fhirclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// MaxResponseBytes caps any upstream body relayed by the bridge (4 MiB).
const MaxResponseBytes = 4 << 20

// requestTimeout bounds every upstream call (backend and token endpoints).
const requestTimeout = 30 * time.Second

// Backend is the connection config the client needs (a projection of the
// store row — this package does not import the store).
type Backend struct {
	ID         string // cache key for minted tokens
	BaseURL    string
	AuthMethod string // none|bearer|basic|oauth2_client_credentials|smart_backend_services
	TokenURL   string
	ClientID   string
	Scopes     string
	VaultRef   string
}

// SecretStore reads the secret material behind a backend's vault_ref
// (implemented by go-common/secrets; faked in tests).
type SecretStore interface {
	Get(ctx context.Context, path string) (map[string]string, error)
}

// Response is a relayed upstream response: status + raw FHIR JSON body.
type Response struct {
	Status int
	Body   json.RawMessage
}

// ErrResponseTooLarge is returned when the upstream body exceeds MaxResponseBytes.
var ErrResponseTooLarge = errors.New("upstream response exceeds 4 MiB cap")

var (
	resourceTypeRe = regexp.MustCompile(`^[A-Za-z]{1,64}$`)
	resourceIDRe   = regexp.MustCompile(`^[A-Za-z0-9\-\.]{1,64}$`)
)

// ValidResourceType reports whether rt is a plausible FHIR resource type
// (conservative: ASCII letters only, so `../`, `?`, `#` etc. cannot reach the
// URL path).
func ValidResourceType(rt string) bool { return resourceTypeRe.MatchString(rt) }

// ValidResourceID reports whether id matches the FHIR id grammar (letters,
// digits, `-`, `.`; and therefore no `/`, so no path traversal).
func ValidResourceID(id string) bool { return resourceIDRe.MatchString(id) }

// Client performs the four FHIR operations with per-backend auth.
type Client struct {
	Secrets SecretStore
	http    *http.Client

	mu     sync.Mutex
	tokens map[string]cachedToken // backend id -> minted token
	now    func() time.Time
}

type cachedToken struct {
	token  string
	expiry time.Time
}

// New builds a client over the given secret store. The HTTP client refuses
// any redirect that leaves the original request's scheme://host.
func New(secrets SecretStore) *Client {
	return &Client{
		Secrets: secrets,
		http: &http.Client{
			Timeout: requestTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return errors.New("too many redirects")
				}
				first := via[0].URL
				if req.URL.Host != first.Host || req.URL.Scheme != first.Scheme {
					return fmt.Errorf("redirect to a different host refused (%s://%s)", req.URL.Scheme, req.URL.Host)
				}
				return nil
			},
		},
		tokens: map[string]cachedToken{},
		now:    time.Now,
	}
}

// Read is GET {base}/{ResourceType}/{id}.
func (c *Client) Read(ctx context.Context, be Backend, resourceType, id string) (*Response, error) {
	if err := validate(resourceType, id); err != nil {
		return nil, err
	}
	return c.do(ctx, be, http.MethodGet, resourceType+"/"+id, nil, nil)
}

// Search is GET {base}/{ResourceType}?{urlencoded params}.
func (c *Client) Search(ctx context.Context, be Backend, resourceType string, params map[string]string) (*Response, error) {
	if err := validate(resourceType, ""); err != nil {
		return nil, err
	}
	q := url.Values{}
	for k, v := range params {
		q.Set(k, v)
	}
	return c.do(ctx, be, http.MethodGet, resourceType, q, nil)
}

// Create is POST {base}/{ResourceType} with a JSON body.
func (c *Client) Create(ctx context.Context, be Backend, resourceType string, resource []byte) (*Response, error) {
	if err := validate(resourceType, ""); err != nil {
		return nil, err
	}
	return c.do(ctx, be, http.MethodPost, resourceType, nil, resource)
}

// Update is PUT {base}/{ResourceType}/{id} with a JSON body.
func (c *Client) Update(ctx context.Context, be Backend, resourceType, id string, resource []byte) (*Response, error) {
	if err := validate(resourceType, id); err != nil {
		return nil, err
	}
	return c.do(ctx, be, http.MethodPut, resourceType+"/"+id, nil, resource)
}

// Metadata is GET {base}/metadata — the CapabilityStatement connectivity probe.
func (c *Client) Metadata(ctx context.Context, be Backend) (*Response, error) {
	return c.do(ctx, be, http.MethodGet, "metadata", nil, nil)
}

func validate(resourceType, id string) error {
	if !ValidResourceType(resourceType) {
		return fmt.Errorf("invalid resource_type %q", resourceType)
	}
	if id != "" && !ValidResourceID(id) {
		return fmt.Errorf("invalid resource_id %q", id)
	}
	return nil
}

func (c *Client) do(ctx context.Context, be Backend, method, path string, query url.Values, body []byte) (*Response, error) {
	u := strings.TrimRight(be.BaseURL, "/") + "/" + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/fhir+json")
	if body != nil {
		req.Header.Set("Content-Type", "application/fhir+json")
	}
	if err := c.attachAuth(ctx, req, be); err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxResponseBytes {
		return nil, ErrResponseTooLarge
	}
	return &Response{Status: resp.StatusCode, Body: raw}, nil
}
