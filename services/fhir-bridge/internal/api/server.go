// Package api is fhir-bridge's HTTP layer: the JWT-guarded /api/v1 backend
// admin plane, the tool-plane MCP facade (/internal/v1/mcp/invoke) and the
// health/metrics endpoints. Contracts match the other Datacern Go services
// (same claim names, same error envelope, same middleware order).
package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/go-common/authjwt"
	"github.com/datacern-ai/go-common/httpx"
	"github.com/datacern-ai/go-common/metricsx"

	"github.com/datacern-ai/fhir-bridge/internal/authz"
	"github.com/datacern-ai/fhir-bridge/internal/fhirclient"
	"github.com/datacern-ai/fhir-bridge/internal/store"
)

// BackendStore is the persistence port (real: store.PG; tests: in-memory fake).
type BackendStore interface {
	Create(ctx context.Context, b *store.Backend) error
	List(ctx context.Context, tenant uuid.UUID) ([]store.Backend, error)
	Get(ctx context.Context, tenant, id uuid.UUID) (*store.Backend, error)
	Update(ctx context.Context, b *store.Backend) error
	Delete(ctx context.Context, tenant, id uuid.UUID) error
}

// FHIRProxy is the outbound FHIR port (real: fhirclient.Client; tests: fake).
type FHIRProxy interface {
	Read(ctx context.Context, be fhirclient.Backend, resourceType, id string) (*fhirclient.Response, error)
	Search(ctx context.Context, be fhirclient.Backend, resourceType string, params map[string]string) (*fhirclient.Response, error)
	Create(ctx context.Context, be fhirclient.Backend, resourceType string, resource []byte) (*fhirclient.Response, error)
	Update(ctx context.Context, be fhirclient.Backend, resourceType, id string, resource []byte) (*fhirclient.Response, error)
	Metadata(ctx context.Context, be fhirclient.Backend) (*fhirclient.Response, error)
}

// SecretWriter writes/rotates/deletes backend secret material in Vault
// (real: go-common/secrets.Client; tests: fake).
type SecretWriter interface {
	Put(ctx context.Context, path string, data map[string]string) error
	Delete(ctx context.Context, path string) error
}

// Pinger is the DB readiness probe port.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Server wires the HTTP layer.
type Server struct {
	Store    BackendStore
	FHIR     FHIRProxy
	Secrets  SecretWriter
	Authz    authz.Authorizer
	Verifier *authjwt.Verifier
	DB       Pinger // nil in unit tests; the runtime always wires it
	RegGate  *RegGate
	Log      *slog.Logger
}

// chiRoutePattern resolves the matched chi route template for a bounded
// metrics route label (evaluated after routing), falling back to "other".
func chiRoutePattern(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			return p
		}
	}
	return "other"
}

// Router builds the chi router (base path /api/v1, MASTER-FR-020).
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	metrics := metricsx.New("fhir-bridge")
	r.Use(TraceMiddleware, RecoverMiddleware, metrics.Middleware(chiRoutePattern))

	r.Get("/healthz", s.handleHealthz)
	r.Get("/readyz", s.handleReadyz)
	r.Handle("/metrics", metrics.Handler())

	// Backend MCP facade the tool-plane federates to (BRD 13 / TPL-FR-012).
	// Not under the JWT-authed /api/v1 group: the peer is the mesh-injected
	// SPIFFE identity and the call is authorized against OPA for the effective
	// human inside the handler.
	r.Post("/internal/v1/mcp/invoke", s.handleToolFacade)

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(s.Verifier.Middleware(func(w http.ResponseWriter, req *http.Request, _ error) {
			httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthenticated,
				"invalid or missing token", TraceID(req.Context()), nil, 0)
		}))

		r.Route("/fhir-backends", func(r chi.Router) {
			r.With(s.RequireAction(authz.ActionBackendCreate)).Post("/", s.handleCreateBackend)
			r.With(s.RequireAction(authz.ActionBackendList)).Get("/", s.handleListBackends)
			r.With(s.RequireAction(authz.ActionBackendRead)).Get("/{id}", s.handleGetBackend)
			r.With(s.RequireAction(authz.ActionBackendUpdate)).Patch("/{id}", s.handlePatchBackend)
			r.With(s.RequireAction(authz.ActionBackendDelete)).Delete("/{id}", s.handleDeleteBackend)
			// Connectivity probe: reads config + calls the upstream /metadata;
			// no config mutation, so it is gated as a backend read.
			r.With(s.RequireAction(authz.ActionBackendRead)).Post("/{id}/test", s.handleTestBackend)
		})
	})
	return r
}

// log returns the configured logger or the default one (unit tests).
func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// toFHIRBackend projects a store row onto the fhirclient config.
func toFHIRBackend(b *store.Backend) fhirclient.Backend {
	return fhirclient.Backend{
		ID:         b.ID.String(),
		BaseURL:    b.BaseURL,
		AuthMethod: b.AuthMethod,
		TokenURL:   b.TokenURL,
		ClientID:   b.ClientID,
		Scopes:     b.Scopes,
		VaultRef:   b.VaultRef,
	}
}
