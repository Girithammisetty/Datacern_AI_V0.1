// Package demoseed is the production domain.DemoSeedRunner: it shells out to
// packs/demo_seed_runner.py (BRD 70 §2.3 option (a)) rather than
// reimplementing the real-API-driving logic deploy/local/seed_claims_demo.py
// and deploy/e2e/driver.py already prove works. This is the "identity-
// service's server process needs a sanctioned way to invoke a sandboxed
// subprocess with network access to other services" operational cost the
// design flags explicitly (§2.3) -- not hidden here.
package demoseed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// SubprocessRunner invokes a Python interpreter against demo_seed_runner.py,
// passing the tenant + bundle as a JSON document on stdin and capturing
// combined stdout/stderr for the ProvisioningStep error field on failure
// (engine_steps.go's SeedDemoContent.Run propagates whatever this returns).
type SubprocessRunner struct {
	// PythonBin is the interpreter (defaults to "python3").
	PythonBin string
	// ScriptPath is packs/demo_seed_runner.py's location on this host/image.
	ScriptPath string
	// BaseURLs threads the same service-URL env vars deploy/e2e/lib/
	// common.py already reads (e.g. CASE_URL, DATASET_URL) so the runner
	// targets this deployment's real services -- nil/empty inherits the
	// current process environment unchanged.
	Env []string
	// Timeout bounds one Seed() invocation (DSP-NFR-001's ≤10 min creation
	// budget includes seeding, so this must stay comfortably under it).
	Timeout time.Duration
	// Issuer mints the real, short-lived bearer token the subprocess drives
	// every downstream API call with -- identity-service already holds the
	// platform's real signing authority in-process (keys.Issuer), so no
	// separate credential-minting hop is needed. nil is honestly refused
	// (EInternal below) rather than seeding with no credential at all.
	//
	// KNOWN GAP (flagged, not hidden): the token is minted with a broad
	// service-typed scope set (the same wildcard pattern deploy/e2e's
	// harness already uses for its own seed/admin operations) rather than
	// the tightest per-call scope each downstream service would ideally
	// check. This has NOT been verified against a live stack (no Docker in
	// this build environment) -- see docs/initiatives/
	// demo-sandbox-poc-mode.md §3 honest gaps.
	Issuer domain.TokenIssuer
}

// seedInput is the JSON contract packs/demo_seed_runner.py reads on stdin.
type seedInput struct {
	TenantID    string               `json:"tenant_id"`
	TenantName  string               `json:"tenant_name"`
	OwnerEmail  string               `json:"owner_email"`
	Pack        string               `json:"pack"`
	PackVersion string               `json:"pack_version"`
	BundleVer   string               `json:"bundle_version"`
	Datasets    []datasetInput       `json:"datasets"`
	Personas    []domain.DemoPersona `json:"personas"`
	Cases       []domain.DemoCase    `json:"cases"`
}

type datasetInput struct {
	Identity string `json:"identity"`
	CSVPath  string `json:"csv_path"`
}

func (r *SubprocessRunner) Seed(ctx context.Context, t *domain.Tenant, bundle *domain.DemoBundle) error {
	if r.Issuer == nil {
		return domain.EInternal("demo seeding is not configured: no TokenIssuer to mint the subprocess's bearer credential")
	}
	pyBin := r.PythonBin
	if pyBin == "" {
		pyBin = "python3"
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = 8 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// A real, short-lived (TokenTTL, 5 min per MASTER-FR-010) service-typed
	// credential scoped to the tenant, minted the same way every other
	// service-to-service call on this platform is -- never a fake/shared
	// secret. Passed via env (DEMO_SEED_BEARER_TOKEN), never argv, so it
	// never lands in a process listing.
	tok, _, err := r.Issuer.Issue(domain.Claims{
		Subject: "svc:demo-seed-runner", TenantID: t.ID, Typ: domain.TypService,
		Scopes: []string{"*"}, // mirrors deploy/e2e's own harness seed/admin scope pattern
	})
	if err != nil {
		return fmt.Errorf("mint demo seed bearer token: %w", err)
	}

	datasets := make([]datasetInput, 0, len(bundle.Datasets))
	for _, d := range bundle.Datasets {
		datasets = append(datasets, datasetInput{Identity: d.Identity, CSVPath: d.CSVPath})
	}
	payload, err := json.Marshal(seedInput{
		TenantID: t.ID.String(), TenantName: t.Name, OwnerEmail: t.OwnerEmail,
		Pack: bundle.Pack, PackVersion: bundle.PackVersion, BundleVer: bundle.Version,
		Datasets: datasets, Personas: bundle.Personas, Cases: bundle.Cases,
	})
	if err != nil {
		return domain.EInternal("demo seed input encode: " + err.Error())
	}

	cmd := exec.CommandContext(runCtx, pyBin, r.ScriptPath)
	cmd.Stdin = bytes.NewReader(payload)
	cmd.Env = append(os.Environ(), "DEMO_SEED_BEARER_TOKEN="+tok)
	if len(r.Env) > 0 {
		cmd.Env = append(cmd.Env, r.Env...)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("demo_seed_runner.py failed for tenant %s pack %s: %w\n%s",
			t.ID, bundle.Pack, err, truncate(out.String(), 4000))
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "... (truncated)"
}
