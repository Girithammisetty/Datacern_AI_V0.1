//go:build integration

// Package integration holds the fhir-bridge integration tier (real Postgres +
// Vault + OPA via deploy/docker-compose.dev.yml). The tier is currently a
// placeholder: the unit tier (httptest fakes, in-memory store doubles) covers
// the proxy, auth-attachment, facade and CRUD contracts, and the live-stack
// pass rides `make e2e` at the platform level.
package integration
