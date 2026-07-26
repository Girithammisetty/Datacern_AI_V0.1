package pipeline

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/datacern-ai/notification-service/internal/registry"
)

// GroupResolver expands role audiences and group subjects into user ids
// against rbac-service's real membership data (NOTIF-FR-013); a fake is used
// in unit tests.
type GroupResolver interface {
	// Role returns the user ids for a derived audience role in a tenant/ws.
	Role(ctx context.Context, tenant, workspaceID string, role registry.AudienceRole) ([]string, error)
	// Group returns the member user ids of a group subject.
	Group(ctx context.Context, tenant, groupID string) ([]string, error)
}

// MaxAudience caps recipients per event (NOTIF-FR-013).
const MaxAudience = 500

// RBACAudienceConfig carries rbac-service's endpoint and the platform signing
// key used to mint the short-lived service JWT POST /audience/resolve
// requires. No fallback exists: an unset RBACURL/SigningKeyPEM makes every
// Role()/Group() call return an error rather than an empty audience passed
// off as "resolved" — see cmd/server/main.go's REQUIRE_REAL_ADAPTERS gate for
// the boot-time enforcement.
type RBACAudienceConfig struct {
	RBACURL       string
	SigningKeyPEM string
	SigningKID    string
	Issuer        string
	Audience      string
}

// RBACGroupResolver resolves audience roles and group subjects against
// rbac-service's POST /audience/resolve (NOTIF-FR-013), which reads the real
// members/group_roles/roles/workspace_groups tables — replacing the
// RedisGroupResolver this superseded, which read `notif:audience:*`/
// `notif:group:*` Redis keys nothing in the platform ever wrote, so every
// role/group-addressed alert silently resolved to zero recipients.
type RBACGroupResolver struct {
	cfg    RBACAudienceConfig
	client *http.Client

	mu     sync.Mutex
	tokens map[string]cachedToken // tenant -> minted service token
}

type cachedToken struct {
	value string
	exp   time.Time
}

// NewRBACGroupResolver builds the real resolver. cfg fields may be empty in
// dev without REQUIRE_REAL_ADAPTERS=true; every call then fails with a clear
// error instead of silently returning no recipients.
func NewRBACGroupResolver(cfg RBACAudienceConfig) *RBACGroupResolver {
	return &RBACGroupResolver{cfg: cfg, client: &http.Client{Timeout: 5 * time.Second}, tokens: map[string]cachedToken{}}
}

// Role resolves a derived audience role (tenant admins, workspace managers,
// workspace subscribers), optionally workspace-scoped.
func (g *RBACGroupResolver) Role(ctx context.Context, tenant, workspaceID string, role registry.AudienceRole) ([]string, error) {
	return g.resolve(ctx, audienceRequest{Tenant: tenant, Role: string(role), WorkspaceID: workspaceID})
}

// Group resolves an arbitrary subscription-rule group subject to its members.
func (g *RBACGroupResolver) Group(ctx context.Context, tenant, groupID string) ([]string, error) {
	return g.resolve(ctx, audienceRequest{Tenant: tenant, Role: "group", GroupID: groupID})
}

// audienceRequest/audienceResponse mirror rbac-service's
// POST /api/v1/audience/resolve contract (internal/api/handlers_audience.go).
type audienceRequest struct {
	Tenant      string `json:"tenant"`
	Role        string `json:"role"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	GroupID     string `json:"group_id,omitempty"`
}

type audienceResponse struct {
	UserIDs []string `json:"user_ids"`
}

func (g *RBACGroupResolver) resolve(ctx context.Context, req audienceRequest) ([]string, error) {
	if g.cfg.RBACURL == "" {
		return nil, fmt.Errorf("rbac audience resolver: RBAC_URL is not configured")
	}
	tok, err := g.token(req.Tenant)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, g.cfg.RBACURL+"/api/v1/audience/resolve", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+tok)
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := g.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("rbac audience resolve: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rbac audience resolve status %d: %s", resp.StatusCode, string(raw))
	}
	var out audienceResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("rbac audience resolve: decode: %w", err)
	}
	return out.UserIDs, nil
}

// token returns a cached, still-valid service JWT for tenant or mints a new
// one. Tokens are minted per-tenant (not shared) because rbac-service binds
// every /audience/resolve call's requested tenant to the caller's own
// verified token tenant claim (MASTER-FR-002); a static token could not
// serve every tenant this multi-tenant pipeline processes events for.
func (g *RBACGroupResolver) token(tenant string) (string, error) {
	g.mu.Lock()
	if t, ok := g.tokens[tenant]; ok && time.Now().Before(t.exp) {
		g.mu.Unlock()
		return t.value, nil
	}
	g.mu.Unlock()

	if g.cfg.SigningKeyPEM == "" {
		return "", fmt.Errorf("rbac audience resolver: REGISTER_SIGNING_KEY_PEM is not configured")
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(g.cfg.SigningKeyPEM))
	if err != nil {
		return "", fmt.Errorf("rbac audience resolver: parse signing key: %w", err)
	}
	tok, exp, err := mintAudienceServiceToken(key, g.cfg, tenant)
	if err != nil {
		return "", err
	}
	g.mu.Lock()
	g.tokens[tenant] = cachedToken{value: tok, exp: exp}
	g.mu.Unlock()
	return tok, nil
}

// mintAudienceServiceToken mints a 5-minute typ=service JWT scoped to tenant,
// signed with the same shared platform signing key notification-service
// already uses to register its action manifest with rbac-service
// (internal/register.mintServiceToken) — the real key backing this
// deployment's live JWKS, not a bypass.
func mintAudienceServiceToken(key *rsa.PrivateKey, cfg RBACAudienceConfig, tenant string) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(5 * time.Minute)
	claims := jwt.MapClaims{
		"sub":       "svc:notification-service",
		"typ":       "service",
		"tenant_id": tenant,
		"iss":       cfg.Issuer,
		"aud":       cfg.Audience,
		"iat":       now.Unix(),
		"exp":       exp.Unix(),
		"jti":       fmt.Sprintf("notif-audience-%d", now.UnixNano()),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	if cfg.SigningKID != "" {
		tok.Header["kid"] = cfg.SigningKID
	}
	// Refresh 30s before actual expiry so an in-flight request never races an
	// expiring token.
	signed, err := tok.SignedString(key)
	return signed, exp.Add(-30 * time.Second), err
}
