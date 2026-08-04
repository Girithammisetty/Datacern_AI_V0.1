package api

import (
	"crypto/rand"
	"crypto/rsa"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/go-common/authjwt"
)

// staticVerifier mints an RS256 test verifier + a valid user token for tenant.
func staticVerifier(t *testing.T, tenant uuid.UUID) (*authjwt.Verifier, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	claims := jwt.MapClaims{
		"sub":       "admin-1",
		"tenant_id": tenant.String(),
		"typ":       "user",
		"exp":       time.Now().Add(time.Hour).Unix(),
		"iat":       time.Now().Unix(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return authjwt.NewStatic(&key.PublicKey, "", ""), token
}
