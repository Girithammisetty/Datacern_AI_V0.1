package pipeline_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	gcevent "github.com/datacern-ai/go-common/event"
	"github.com/datacern-ai/notification-service/internal/pipeline"
	"github.com/datacern-ai/notification-service/internal/registry"
)

// x509PEM PKCS1-encodes an RSA private key the way REGISTER_SIGNING_KEY_PEM
// ships in real deploys, so jwt.ParseRSAPrivateKeyFromPEM (used by both
// RBACGroupResolver and internal/register) accepts it unmodified.
func x509PEM(key *rsa.PrivateKey) (string, error) {
	der := x509.MarshalPKCS1PrivateKey(key)
	block := &pem.Block{Type: "RSA PRIVATE KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

// fakeRBACServer stands in for rbac-service's real POST /audience/resolve
// contract (internal/api/handlers_audience.go on the rbac-service side):
// it validates the caller minted a typ=service JWT scoped to the requested
// tenant, then returns the seeded member list for that (role, workspace_id,
// group_id) — proving RBACGroupResolver resolves to REAL recipients rather
// than the empty set the superseded Redis-key resolver always returned.
func fakeRBACServer(t *testing.T, pub *rsa.PublicKey, members map[string][]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/audience/resolve" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		auth := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if len(auth) <= len(prefix) || auth[:len(prefix)] != prefix {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		claims := jwt.MapClaims{}
		tok, err := jwt.ParseWithClaims(auth[len(prefix):], &claims, func(*jwt.Token) (any, error) { return pub, nil })
		if err != nil || !tok.Valid {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if claims["typ"] != "service" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var req struct {
			Tenant      string `json:"tenant"`
			Role        string `json:"role"`
			WorkspaceID string `json:"workspace_id"`
			GroupID     string `json:"group_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if req.Tenant != claims["tenant_id"] {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		key := req.Role
		if req.GroupID != "" {
			key = "group:" + req.GroupID
		} else if req.WorkspaceID != "" {
			key = req.Role + ":" + req.WorkspaceID
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"user_ids": members[key]})
	}))
}

// TestRBACGroupResolver_Role proves Role() resolves to the real recipients
// rbac-service returns, not an empty audience (the bug: nothing ever wrote
// the `notif:audience:*` Redis keys the old resolver read).
func TestRBACGroupResolver_Role(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pem, err := x509PEM(key)
	if err != nil {
		t.Fatal(err)
	}
	tenant := uuid.New().String()
	srv := fakeRBACServer(t, &key.PublicKey, map[string][]string{
		"tenant_admins": {"admin-1", "admin-2"},
	})
	defer srv.Close()

	resolver := pipeline.NewRBACGroupResolver(pipeline.RBACAudienceConfig{
		RBACURL: srv.URL, SigningKeyPEM: pem, Issuer: "datacern-test", Audience: "datacern",
	})
	ids, err := resolver.Role(context.Background(), tenant, "", registry.RoleTenantAdmins)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 recipients, got %d: %v", len(ids), ids)
	}
}

// TestRBACGroupResolver_Group proves Group() resolves a subscription rule's
// group subject to its real members.
func TestRBACGroupResolver_Group(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pem, err := x509PEM(key)
	if err != nil {
		t.Fatal(err)
	}
	tenant := uuid.New().String()
	groupID := uuid.New().String()
	srv := fakeRBACServer(t, &key.PublicKey, map[string][]string{
		"group:" + groupID: {"sub-1", "sub-2", "sub-3"},
	})
	defer srv.Close()

	resolver := pipeline.NewRBACGroupResolver(pipeline.RBACAudienceConfig{
		RBACURL: srv.URL, SigningKeyPEM: pem, Issuer: "datacern-test", Audience: "datacern",
	})
	ids, err := resolver.Group(context.Background(), tenant, groupID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 3 {
		t.Fatalf("expected 3 recipients, got %d: %v", len(ids), ids)
	}
}

// TestRBACGroupResolver_Unconfigured_ErrorsRatherThanEmpty: with no RBAC_URL
// configured, a call must fail loudly, never silently succeed with zero
// recipients (the exact regression this fix closes).
func TestRBACGroupResolver_Unconfigured_ErrorsRatherThanEmpty(t *testing.T) {
	resolver := pipeline.NewRBACGroupResolver(pipeline.RBACAudienceConfig{})
	_, err := resolver.Role(context.Background(), uuid.New().String(), "", registry.RoleTenantAdmins)
	if err == nil {
		t.Fatal("expected an error when RBAC_URL is unconfigured, got nil")
	}
}

// TestPipeline_RoleAudience_DeliversToRealRecipients runs a role-addressed
// event (usage.budget.exhausted → tenant admins, NOTIF-FR-013) through the
// FULL pipeline with the real RBACGroupResolver wired to a fake rbac
// endpoint, proving delivery reaches the resolved recipients end to end
// instead of silently reaching nobody.
func TestPipeline_RoleAudience_DeliversToRealRecipients(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pem, err := x509PEM(key)
	if err != nil {
		t.Fatal(err)
	}
	tenant := uuid.New()
	srv := fakeRBACServer(t, &key.PublicKey, map[string][]string{
		"tenant_admins": {"admin-1", "admin-2"},
	})
	defer srv.Close()

	fs, rt, cap := newFakeStore(), &fakeRealtime{}, &captureProvider{}
	pl := newPipeline(fs, rt, cap, true)
	pl.Groups = pipeline.NewRBACGroupResolver(pipeline.RBACAudienceConfig{
		RBACURL: srv.URL, SigningKeyPEM: pem, Issuer: "datacern-test", Audience: "datacern",
	})

	ev := gcevent.New("usage.budget.exhausted", tenant, gcevent.Actor{Type: "service", ID: "usage-service"},
		"wr:t:usage:budget/1", "tr", map[string]any{"budget_name": "AI spend"})
	if err := pl.Process(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if len(fs.notifs) != 2 {
		t.Fatalf("expected 2 in-app notifications (one per tenant admin), got %d: %+v", len(fs.notifs), fs.notifs)
	}
	got := map[string]bool{}
	for _, n := range fs.notifs {
		got[n.UserID] = true
	}
	if !got["admin-1"] || !got["admin-2"] {
		t.Fatalf("expected admin-1 and admin-2 to receive notifications, got %v", got)
	}
	if len(cap.msgs) != 2 {
		t.Fatalf("expected 2 emails (usage.budget.exhausted is in-app+email), got %d", len(cap.msgs))
	}
}
