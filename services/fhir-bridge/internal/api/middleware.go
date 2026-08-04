package api

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/datacern-ai/go-common/authjwt"
	"github.com/datacern-ai/go-common/httpx"

	"github.com/datacern-ai/fhir-bridge/internal/authz"
)

type ctxKey int

const ctxKeyTraceID ctxKey = iota

// TraceID returns the request trace id (MASTER-FR-028).
func TraceID(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeyTraceID).(string); ok {
		return v
	}
	return ""
}

// TraceMiddleware propagates/creates X-Trace-Id (MASTER-FR-028).
func TraceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trace := r.Header.Get("X-Trace-Id")
		if trace == "" {
			trace = uuid.NewString()
		}
		w.Header().Set("X-Trace-Id", trace)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKeyTraceID, trace)))
	})
}

// RecoverMiddleware converts panics into 500 envelopes.
func RecoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				httpx.WriteError(w, http.StatusInternalServerError, httpx.CodeInternal,
					"internal error", TraceID(r.Context()), nil, 0)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// RequireAction gates a route on an rbac action (MASTER-FR-016) via the local
// OPA sidecar (MASTER-FR-012). Fails closed when no authorizer is wired.
func (s *Server) RequireAction(action string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := authjwt.FromContext(r.Context())
			if !ok {
				httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthenticated,
					"missing claims", TraceID(r.Context()), nil, 0)
				return
			}
			if s.Authz == nil {
				httpx.WriteError(w, http.StatusForbidden, httpx.CodePermission,
					"authorizer not configured", TraceID(r.Context()), nil, 0)
				return
			}
			in := authz.Input{
				Subject: authz.Subject{ID: claims.Sub, Typ: claims.Typ,
					OboSub: claims.OboSub, Scopes: claims.Scopes},
				Action: action,
				Tenant: claims.TenantID,
			}
			if !s.Authz.Allow(r.Context(), in) {
				s.log().Warn("permission denied", "action", action,
					"sub", claims.Sub, "tenant", claims.TenantID, "path", r.URL.Path)
				httpx.WriteError(w, http.StatusForbidden, httpx.CodePermission,
					"not allowed: "+action, TraceID(r.Context()), nil, 0)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
