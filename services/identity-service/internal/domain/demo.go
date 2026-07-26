// Demo-sandbox domain types and ports (BRD 70 slice 1/2, DSP-FR-010..013).
// See docs/initiatives/demo-sandbox-poc-mode.md §2.2/§2.3 for the bundle
// layout and the "saga step, not operator job" decision this file implements.
package domain

import (
	"context"
)

// DefaultDemoTTLDays is DSP-FR-001's default (operator-overridable at create).
const DefaultDemoTTLDays = 14

// DemoBundle is the parsed form of a deploy/demo/<pack>/ bundle (§2.2):
// demo.yaml + personas.yaml + cases.yaml + walkthrough.yaml, resolved
// against the target pack's dataset identities. Walkthrough is optional
// (Should, DSP-FR-015) -- a bundle with no walkthrough.yaml yields an empty
// slice, not an error, mirroring cases.yaml's optionality.
type DemoBundle struct {
	Pack        string // target product pack name (packs/<pack>/)
	PackVersion string // pins the installed pack version (§2.2)
	Version     string // bundle version, independent of PackVersion
	Provenance  string // no-real-PII attestation note (DSP-NFR-004)
	// Datasets lists the identity -> CSV path the bundle ships under data/,
	// resolved to an absolute filesystem path by the loader.
	Datasets    []DemoDataset
	Personas    []DemoPersona
	Cases       []DemoCase
	Walkthrough []WalkthroughStep
}

// DemoDataset is one data/<identity>.csv entry.
type DemoDataset struct {
	Identity string
	CSVPath  string
}

// DemoPersona mirrors packs/MULTITENANT_LOGINS.md's per-pack role rows as a
// seedable object (§2.2): one real, invited user per pack role.
type DemoPersona struct {
	EmailLocalPart string `json:"email_local_part" yaml:"email_local_part"`
	Role           string `json:"role" yaml:"role"`
	DisplayName    string `json:"display_name" yaml:"display_name"`
}

// DemoCase is one open-row seed case (§2.2), same shape as a pack's
// cases/queue.yaml but legal here because a demo bundle's entire purpose is
// shipping seed data.
type DemoCase struct {
	Dataset           string         `json:"dataset" yaml:"dataset"`
	RowPK             string         `json:"row_pk" yaml:"row_pk"`
	Severity          string         `json:"severity" yaml:"severity"`
	DisplayProjection map[string]any `json:"display_projection" yaml:"display_projection"`
	Note              string         `json:"note" yaml:"note"`
}

// WalkthroughStep is one ordered step of a bundle's walkthrough.yaml
// (§2.2, DSP-FR-015): a guided-tour script an SE (or, once ui-web wires it
// up, the in-product overlay) walks a demo tenant through. TargetRoute is
// an app route (e.g. "/cases"), not a DOM selector -- the overlay
// navigates the viewer to the route and shows Narration alongside it,
// matching the granularity the shipped bundle actually authors at
// (deploy/demo/insurance-claims-payer/walkthrough.yaml).
type WalkthroughStep struct {
	Title       string `json:"title" yaml:"title"`
	TargetRoute string `json:"target_route" yaml:"target_route"`
	Narration   string `json:"narration" yaml:"narration"`
}

// DemoBundleLoader resolves a pack name to its deploy/demo/<pack>/ bundle
// (§2.2). The production adapter (internal/adapters/demobundle) reads the
// filesystem; tests inject a fake or an in-memory fixture.
type DemoBundleLoader interface {
	Load(pack string) (*DemoBundle, error)
}

// DemoSeedRunner drives a demo bundle's content into a tenant through real
// APIs (§2.3): dataset ingestion, persona provisioning, case-queue seeding.
// The production adapter (internal/adapters/demoseed) shells out to
// packs/demo_seed_runner.py -- a generalization of deploy/local/
// seed_claims_demo.py's real-API-driving patterns, parameterized by the
// bundle instead of hardcoded claims logic (§2.3 option (a)). Idempotent:
// re-running for the same tenant/bundle must converge, not duplicate --
// both the SeedDemoContent provisioning step's own retry loop and the
// reset endpoint (§2.4) depend on this.
type DemoSeedRunner interface {
	Seed(ctx context.Context, t *Tenant, bundle *DemoBundle) error
}
