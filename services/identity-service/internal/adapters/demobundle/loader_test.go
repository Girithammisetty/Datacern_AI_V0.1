package demobundle_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/datacern-ai/identity-service/internal/adapters/demobundle"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFSLoader_LoadsWellFormedBundle(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sample-pack")
	writeFile(t, filepath.Join(dir, "demo.yaml"), `
demo_manifest: 1
pack: sample-pack
pack_version: 1.0.0
version: 1.0.0
provenance: "synthetic, no real PII"
`)
	writeFile(t, filepath.Join(dir, "personas.yaml"), `
- email_local_part: admin
  role: Admin
  display_name: Demo Admin
`)
	writeFile(t, filepath.Join(dir, "cases.yaml"), `
- dataset: widgets
  row_pk: W-1
  severity: high
  display_projection: {name: "Widget One"}
  note: "evidence-rich note"
`)
	writeFile(t, filepath.Join(dir, "data", "widgets.csv"), "id,name\nW-1,Widget One\n")
	writeFile(t, filepath.Join(dir, "walkthrough.yaml"), `
- title: "Worklist"
  target_route: /cases
  narration: "Every pending request lands here."
`)

	l := &demobundle.FSLoader{Root: root}
	b, err := l.Load("sample-pack")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if b.Pack != "sample-pack" || b.Version != "1.0.0" {
		t.Fatalf("unexpected bundle: %+v", b)
	}
	if len(b.Datasets) != 1 || b.Datasets[0].Identity != "widgets" {
		t.Fatalf("datasets = %+v", b.Datasets)
	}
	if len(b.Personas) != 1 || b.Personas[0].Role != "Admin" {
		t.Fatalf("personas = %+v", b.Personas)
	}
	if len(b.Cases) != 1 || b.Cases[0].RowPK != "W-1" {
		t.Fatalf("cases = %+v", b.Cases)
	}
	if len(b.Walkthrough) != 1 || b.Walkthrough[0].TargetRoute != "/cases" {
		t.Fatalf("walkthrough = %+v", b.Walkthrough)
	}
}

func TestFSLoader_MissingWalkthroughYieldsEmptySlice(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "no-walkthrough-pack")
	writeFile(t, filepath.Join(dir, "demo.yaml"), `
demo_manifest: 1
pack: no-walkthrough-pack
pack_version: 1.0.0
version: 1.0.0
provenance: "synthetic, no real PII"
`)
	writeFile(t, filepath.Join(dir, "personas.yaml"), `[]`)
	writeFile(t, filepath.Join(dir, "data", "widgets.csv"), "id\nW-1\n")

	l := &demobundle.FSLoader{Root: root}
	b, err := l.Load("no-walkthrough-pack")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if b.Walkthrough == nil || len(b.Walkthrough) != 0 {
		t.Fatalf("walkthrough = %+v, want empty non-nil slice", b.Walkthrough)
	}
}

func TestFSLoader_MissingProvenanceRejected(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "bad-pack")
	writeFile(t, filepath.Join(dir, "demo.yaml"), `
demo_manifest: 1
pack: bad-pack
pack_version: 1.0.0
version: 1.0.0
`)
	writeFile(t, filepath.Join(dir, "personas.yaml"), `[]`)
	writeFile(t, filepath.Join(dir, "data", "widgets.csv"), "id\nW-1\n")

	l := &demobundle.FSLoader{Root: root}
	if _, err := l.Load("bad-pack"); err == nil {
		t.Fatal("expected an error for a demo.yaml with no provenance attestation")
	}
}

func TestFSLoader_UnknownPackRejected(t *testing.T) {
	l := &demobundle.FSLoader{Root: t.TempDir()}
	if _, err := l.Load("does-not-exist"); err == nil {
		t.Fatal("expected an error for an unknown pack")
	}
}

// repoRoot locates the repo root from this test file's own source location
// (stable across machines/CI, unlike a cwd-relative path) --
// services/identity-service/internal/adapters/demobundle/ is 5 levels below
// the repo root.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..")
}

// TestFSLoader_LoadsTheShippedInsuranceClaimsPayerBundle validates the ACTUAL
// bundle this initiative ships (deploy/demo/insurance-claims-payer/) parses
// cleanly end to end -- not just a synthetic fixture. If this test ever
// fails, the shipped bundle itself is broken, not just the loader.
func TestFSLoader_LoadsTheShippedInsuranceClaimsPayerBundle(t *testing.T) {
	root := filepath.Join(repoRoot(t), "deploy", "demo")
	if _, err := os.Stat(filepath.Join(root, "insurance-claims-payer", "demo.yaml")); err != nil {
		t.Skipf("shipped bundle not found at %s (unexpected repo layout): %v", root, err)
	}
	l := &demobundle.FSLoader{Root: root}
	b, err := l.Load("insurance-claims-payer")
	if err != nil {
		t.Fatalf("Load(insurance-claims-payer): %v", err)
	}
	if b.PackVersion == "" {
		t.Error("pack_version is empty")
	}
	wantDatasets := map[string]bool{
		"payer_claims": false, "payer_denials": false, "payer_appeals": false, "prior_auth_requests": false,
	}
	for _, d := range b.Datasets {
		if _, ok := wantDatasets[d.Identity]; ok {
			wantDatasets[d.Identity] = true
		}
		if _, err := os.Stat(d.CSVPath); err != nil {
			t.Errorf("dataset %s CSV missing on disk: %v", d.Identity, err)
		}
	}
	for id, found := range wantDatasets {
		if !found {
			t.Errorf("bundle is missing expected dataset %q", id)
		}
	}
	if len(b.Personas) != 4 {
		t.Errorf("personas = %d, want 4", len(b.Personas))
	}
	if len(b.Cases) != 5 {
		t.Errorf("cases = %d, want 5", len(b.Cases))
	}
	for _, c := range b.Cases {
		if c.Dataset != "prior_auth_requests" {
			t.Errorf("case %s dataset = %s, want prior_auth_requests", c.RowPK, c.Dataset)
		}
	}
	if len(b.Walkthrough) != 5 {
		t.Errorf("walkthrough = %d steps, want 5", len(b.Walkthrough))
	}
	for _, ws := range b.Walkthrough {
		if ws.Title == "" || ws.TargetRoute == "" || ws.Narration == "" {
			t.Errorf("walkthrough step missing a field: %+v", ws)
		}
	}
}
