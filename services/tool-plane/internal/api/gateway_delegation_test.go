package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/go-common/authjwt"
	tpauthz "github.com/datacern-ai/tool-plane/internal/authz"
	"github.com/datacern-ai/tool-plane/internal/domain"
	"github.com/datacern-ai/tool-plane/internal/enforce"
	"github.com/datacern-ai/tool-plane/internal/events"
	"github.com/datacern-ai/tool-plane/internal/mcp"
)

// Gateway → pipeline → backend, for the delegated caller token (BRD 74 AC-10).
// The token asserted at the backend is the one the gateway VERIFIED, so this
// covers the whole hand-off rather than one layer of it.

type gwCatalog struct{ v *domain.ToolVersion }

func (c *gwCatalog) ResolveVersion(context.Context, string, string) (*domain.ToolVersion, error) {
	return c.v, nil
}
func (c *gwCatalog) BackendFor(context.Context, string) (mcp.BackendTarget, error) {
	return mcp.BackendTarget{URL: "http://bff", P95MS: 200}, nil
}

type gwEnablement struct{}

func (gwEnablement) GetTenantSettings(context.Context, uuid.UUID, string) (*domain.TenantToolSettings, error) {
	return &domain.TenantToolSettings{Enabled: true}, nil
}

type gwKill struct{}

func (gwKill) IsKilled(uuid.UUID, string, string) (bool, string) { return false, "" }

type gwOPA struct{}

func (gwOPA) Check(context.Context, tpauthz.Input) (tpauthz.Decision, error) {
	return tpauthz.Decision{Allow: true}, nil
}

type gwRate struct{}

func (gwRate) Allow(context.Context, string, int) (bool, int, error) { return true, 0, nil }

type gwGrants struct{}

func (gwGrants) GrantsFor(context.Context, string, string, []string) ([]string, error) {
	return nil, nil
}

type gwAudit struct{}

func (gwAudit) RecordInvocation(context.Context, *domain.InvocationLog, events.Envelope) error {
	return nil
}
func (gwAudit) InsertAudit(context.Context, events.Envelope) error { return nil }

type gwBackend struct{ got []mcp.Invocation }

func (b *gwBackend) Invoke(_ context.Context, _ mcp.BackendTarget, in mcp.Invocation, _ bool) (*mcp.Result, error) {
	b.got = append(b.got, in)
	return &mcp.Result{Output: map[string]any{"q": in.Args["q"]}}, nil
}

type gwHarness struct {
	router  http.Handler
	key     *rsa.PrivateKey
	backend *gwBackend
}

func newGatewayHarness(t *testing.T, v *domain.ToolVersion) *gwHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	back := &gwBackend{}
	gw := &GatewayServer{
		Pipeline: &enforce.Pipeline{
			Catalog: &gwCatalog{v: v}, Enablement: gwEnablement{}, Kill: gwKill{},
			OPA: gwOPA{}, Rate: gwRate{}, Grants: gwGrants{}, Backend: back, Audit: gwAudit{},
		},
		Verifier: authjwt.NewStatic(&key.PublicKey, testIssuer, testAudience),
		Kill:     enforce.NewKillRegistry(nil),
	}
	return &gwHarness{router: gw.Router(), key: key, backend: back}
}

func (h *gwHarness) mint(t *testing.T, scopes []string) string {
	t.Helper()
	c := authjwt.Claims{
		Sub: "agent:search@v1", TenantID: "00000000-0000-0000-0000-0000000000ff",
		Typ: domain.TypAgentOBO, AgentID: "search", AgentVersion: "1",
		OboSub: "u-1", Scopes: scopes,
	}
	c.Issuer = testIssuer
	c.Audience = jwt.ClaimStrings{testAudience}
	c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(5 * time.Minute))
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, &c)
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (h *gwHarness) call(t *testing.T, bearer string) map[string]any {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search.query","arguments":{"q":"acme"}}}`
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	return out
}

func gwSearchVersion() *domain.ToolVersion {
	return &domain.ToolVersion{
		ToolID: "search.query", Version: "1.0.0", Status: domain.StatusPublished,
		PermissionTier: domain.TierRead, CostWeight: 2, SideEffects: domain.SideEffectNone,
		InputSchema: map[string]any{
			"type": "object", "additionalProperties": false, "required": []any{"q"},
			"properties": map[string]any{"q": map[string]any{"type": "string"}},
		},
		DownstreamActions: []string{"dataset.dataset.list"},
	}
}

// The token the facade receives is exactly the token the gateway verified.
func TestGatewayDelegatesTheVerifiedToken(t *testing.T) {
	h := newGatewayHarness(t, gwSearchVersion())
	tok := h.mint(t, []string{"search.query", "dataset.dataset.list"})
	out := h.call(t, tok)
	if out["error"] != nil {
		t.Fatalf("unexpected rpc error: %+v", out["error"])
	}
	if len(h.backend.got) != 1 {
		t.Fatalf("expected one backend invocation, got %d", len(h.backend.got))
	}
	if h.backend.got[0].AuthToken != tok {
		t.Fatal("the facade must receive the exact bearer the gateway verified")
	}
}

// An UNVERIFIABLE bearer never reaches the pipeline, so it can never be
// delegated — the delegated token is always a verified one.
func TestGatewayNeverDelegatesAnUnverifiedToken(t *testing.T) {
	h := newGatewayHarness(t, gwSearchVersion())

	// Signed by a different key: valid-looking, unverifiable here.
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	c := authjwt.Claims{Sub: "agent:evil@v1", TenantID: "00000000-0000-0000-0000-0000000000ff",
		Typ: domain.TypAgentOBO, OboSub: "u-1", Scopes: []string{"search.query", "dataset.dataset.list"}}
	c.Issuer = testIssuer
	c.Audience = jwt.ClaimStrings{testAudience}
	c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(5 * time.Minute))
	forged, err := jwt.NewWithClaims(jwt.SigningMethodRS256, &c).SignedString(other)
	if err != nil {
		t.Fatal(err)
	}

	for _, bearer := range []string{"", "not-a-jwt", forged} {
		h.backend.got = nil
		out := h.call(t, bearer)
		rerr, _ := out["error"].(map[string]any)
		if rerr == nil || rerr["message"] != "TOKEN_INVALID" {
			t.Fatalf("bearer %q: want TOKEN_INVALID, got %+v", bearer, out)
		}
		if len(h.backend.got) != 0 {
			t.Fatalf("bearer %q: an unverified token must never reach the facade", bearer)
		}
	}
}

// A verified token that is broader than the declaration is refused at the
// gateway with SCOPE_NOT_DELEGABLE, and the facade is not reached.
func TestGatewayRefusesBroadTokenForDeclaringTool(t *testing.T) {
	h := newGatewayHarness(t, gwSearchVersion())
	out := h.call(t, h.mint(t, []string{"*"}))
	res, _ := out["result"].(map[string]any)
	if res == nil || res["isError"] != true {
		t.Fatalf("want an isError result, got %+v", out)
	}
	sc, _ := res["structuredContent"].(map[string]any)
	if sc["code"] != domain.CodeScopeNotDelegable {
		t.Fatalf("want SCOPE_NOT_DELEGABLE, got %+v", sc)
	}
	if len(h.backend.got) != 0 {
		t.Fatal("a wildcard token must never be delegated")
	}
}

// tools/list publishes the declaration so a caller can mint the right token, and
// publishes nothing extra for a tool that delegates nothing.
func TestToolListEntryPublishesRequiredScopes(t *testing.T) {
	meta := toolListEntry(gwSearchVersion())["_meta"].(map[string]any)
	got, _ := meta["required_scopes"].([]string)
	want := []string{"search.query", "dataset.dataset.list"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("required_scopes = %v, want %v", got, want)
	}
	if da, _ := meta["downstream_actions"].([]string); len(da) != 1 || da[0] != "dataset.dataset.list" {
		t.Fatalf("downstream_actions = %v", meta["downstream_actions"])
	}

	plain := gwSearchVersion()
	plain.ToolID = "case.get"
	plain.DownstreamActions = nil
	pmeta := toolListEntry(plain)["_meta"].(map[string]any)
	if _, ok := pmeta["required_scopes"]; ok {
		t.Fatal("a tool that delegates nothing must not advertise required_scopes")
	}
	if _, ok := pmeta["downstream_actions"]; ok {
		t.Fatal("a tool that delegates nothing must not advertise downstream_actions")
	}
}
