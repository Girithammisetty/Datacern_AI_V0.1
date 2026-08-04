package api

// Unit-tier doubles for the Server's ports (BackendStore / FHIRProxy /
// SecretWriter). They live in *_test.go only and are never reachable from
// cmd/ — the runtime wires the real Postgres store, the real fhirclient and
// the real Vault client.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/datacern-ai/fhir-bridge/internal/fhirclient"
	"github.com/datacern-ai/fhir-bridge/internal/store"
)

type fakeStore struct {
	rows map[uuid.UUID]*store.Backend
}

func newFakeStore() *fakeStore { return &fakeStore{rows: map[uuid.UUID]*store.Backend{}} }

func (f *fakeStore) Create(_ context.Context, b *store.Backend) error {
	for _, r := range f.rows {
		if r.TenantID == b.TenantID && r.Name == b.Name {
			return store.ErrNameConflict
		}
	}
	cp := *b
	f.rows[b.ID] = &cp
	return nil
}

func (f *fakeStore) List(_ context.Context, tenant uuid.UUID) ([]store.Backend, error) {
	var out []store.Backend
	for _, r := range f.rows {
		if r.TenantID == tenant {
			out = append(out, *r)
		}
	}
	return out, nil
}

func (f *fakeStore) Get(_ context.Context, tenant, id uuid.UUID) (*store.Backend, error) {
	r, ok := f.rows[id]
	if !ok || r.TenantID != tenant { // RLS: cross-tenant is the same not-found
		return nil, store.ErrNotFound
	}
	cp := *r
	return &cp, nil
}

func (f *fakeStore) Update(_ context.Context, b *store.Backend) error {
	if _, ok := f.rows[b.ID]; !ok {
		return store.ErrNotFound
	}
	cp := *b
	f.rows[b.ID] = &cp
	return nil
}

func (f *fakeStore) Delete(_ context.Context, tenant, id uuid.UUID) error {
	r, ok := f.rows[id]
	if !ok || r.TenantID != tenant {
		return store.ErrNotFound
	}
	delete(f.rows, id)
	return nil
}

type fakeVault struct {
	data map[string]map[string]string
	errs bool
}

func newFakeVault() *fakeVault { return &fakeVault{data: map[string]map[string]string{}} }

func (f *fakeVault) Put(_ context.Context, path string, data map[string]string) error {
	if f.errs {
		return errors.New("vault down")
	}
	f.data[path] = data
	return nil
}

func (f *fakeVault) Delete(_ context.Context, path string) error {
	if f.errs {
		return errors.New("vault down")
	}
	delete(f.data, path)
	return nil
}

// fakeFHIR records the last call and plays back a canned response.
type fakeFHIR struct {
	lastOp       string
	lastBackend  fhirclient.Backend
	lastType     string
	lastID       string
	lastParams   map[string]string
	lastResource []byte
	resp         *fhirclient.Response
	err          error
}

func (f *fakeFHIR) Read(_ context.Context, be fhirclient.Backend, rt, id string) (*fhirclient.Response, error) {
	f.lastOp, f.lastBackend, f.lastType, f.lastID = "read", be, rt, id
	return f.resp, f.err
}

func (f *fakeFHIR) Search(_ context.Context, be fhirclient.Backend, rt string, params map[string]string) (*fhirclient.Response, error) {
	f.lastOp, f.lastBackend, f.lastType, f.lastParams = "search", be, rt, params
	return f.resp, f.err
}

func (f *fakeFHIR) Create(_ context.Context, be fhirclient.Backend, rt string, resource []byte) (*fhirclient.Response, error) {
	f.lastOp, f.lastBackend, f.lastType, f.lastResource = "create", be, rt, resource
	return f.resp, f.err
}

func (f *fakeFHIR) Update(_ context.Context, be fhirclient.Backend, rt, id string, resource []byte) (*fhirclient.Response, error) {
	f.lastOp, f.lastBackend, f.lastType, f.lastID, f.lastResource = "update", be, rt, id, resource
	return f.resp, f.err
}

func (f *fakeFHIR) Metadata(_ context.Context, be fhirclient.Backend) (*fhirclient.Response, error) {
	f.lastOp, f.lastBackend = "metadata", be
	return f.resp, f.err
}

func mustBackend(f *fakeStore, tenant uuid.UUID, name, status string) *store.Backend {
	b := &store.Backend{
		ID: uuid.New(), TenantID: tenant, Name: name,
		BaseURL: "http://fhir.example.internal", AuthMethod: "none", Status: status,
	}
	if err := f.Create(context.Background(), b); err != nil {
		panic(fmt.Sprintf("seed backend: %v", err))
	}
	return b
}
