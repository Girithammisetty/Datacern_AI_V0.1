// Package demobundle is the production domain.DemoBundleLoader: it reads a
// deploy/demo/<pack>/ bundle off the filesystem (BRD 70 §2.2). Bundles are
// git-versioned YAML/CSV, never a database row (§2.2 Option C, rejected for
// v1) -- this loader is intentionally a thin, pure filesystem+YAML parser
// with no network calls, mirroring packs/packctl/manifest.py's load_manifest
// on the Python side (packctl's demo-lint reuses the same bundle shape, see
// packs/packctl/demo_manifest.py).
package demobundle

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// FSLoader implements domain.DemoBundleLoader against deploy/demo/<pack>/.
type FSLoader struct {
	// Root is the deploy/demo directory (e.g. "/app/deploy/demo" in a
	// container image, or a repo-relative path in local dev/tests).
	Root string
}

type demoManifestYAML struct {
	DemoManifest int    `yaml:"demo_manifest"`
	Pack         string `yaml:"pack"`
	PackVersion  string `yaml:"pack_version"`
	Version      string `yaml:"version"`
	Provenance   string `yaml:"provenance"`
}

type demoPersonaYAML struct {
	EmailLocalPart string `yaml:"email_local_part"`
	Role           string `yaml:"role"`
	DisplayName    string `yaml:"display_name"`
}

type demoCaseYAML struct {
	Dataset           string         `yaml:"dataset"`
	RowPK             string         `yaml:"row_pk"`
	Severity          string         `yaml:"severity"`
	DisplayProjection map[string]any `yaml:"display_projection"`
	Note              string         `yaml:"note"`
}

type demoWalkthroughStepYAML struct {
	Title       string `yaml:"title"`
	TargetRoute string `yaml:"target_route"`
	Narration   string `yaml:"narration"`
}

// Load reads and parses deploy/demo/<pack>/{demo.yaml,personas.yaml,
// cases.yaml,data/*.csv}. Every field packctl's demo-lint already validates
// offline (packs/packctl/demo_lint.py) is re-validated here defensively
// (fail loud rather than seed a malformed bundle), but this loader does NOT
// re-implement the PII deny-list scan -- that is a CI-time author gate, not
// a runtime concern.
func (l *FSLoader) Load(pack string) (*domain.DemoBundle, error) {
	if strings.TrimSpace(pack) == "" {
		return nil, domain.EValidation("pack is required", domain.FieldError{Field: "pack", Message: "required"})
	}
	dir := filepath.Join(l.Root, pack)
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return nil, domain.EValidation("unknown demo pack",
			domain.FieldError{Field: "pack", Message: fmt.Sprintf("no bundle at %s", dir)})
	}

	var manifest demoManifestYAML
	if err := readYAML(filepath.Join(dir, "demo.yaml"), &manifest); err != nil {
		return nil, fmt.Errorf("demo.yaml: %w", err)
	}
	if manifest.DemoManifest != 1 {
		return nil, domain.EValidation("demo.yaml: demo_manifest must be 1", domain.FieldError{Field: "demo_manifest"})
	}
	if strings.TrimSpace(manifest.Provenance) == "" {
		return nil, domain.EValidation("demo.yaml: provenance attestation is required (DSP-NFR-004)",
			domain.FieldError{Field: "provenance"})
	}

	var personasYAML []demoPersonaYAML
	if err := readYAML(filepath.Join(dir, "personas.yaml"), &personasYAML); err != nil {
		return nil, fmt.Errorf("personas.yaml: %w", err)
	}
	personas := make([]domain.DemoPersona, 0, len(personasYAML))
	for _, p := range personasYAML {
		personas = append(personas, domain.DemoPersona{
			EmailLocalPart: p.EmailLocalPart, Role: p.Role, DisplayName: p.DisplayName,
		})
	}

	var casesYAML []demoCaseYAML
	// cases.yaml is optional -- a bundle whose pack has no case-triage
	// surface (e.g. an analytics-only vertical) legitimately ships none.
	if _, err := os.Stat(filepath.Join(dir, "cases.yaml")); err == nil {
		if err := readYAML(filepath.Join(dir, "cases.yaml"), &casesYAML); err != nil {
			return nil, fmt.Errorf("cases.yaml: %w", err)
		}
	}
	cases := make([]domain.DemoCase, 0, len(casesYAML))
	for _, c := range casesYAML {
		cases = append(cases, domain.DemoCase{
			Dataset: c.Dataset, RowPK: c.RowPK, Severity: c.Severity,
			DisplayProjection: c.DisplayProjection, Note: c.Note,
		})
	}

	var walkthroughYAML []demoWalkthroughStepYAML
	// walkthrough.yaml is optional (Should, DSP-FR-015) -- same "absent file
	// = empty slice, not an error" contract as cases.yaml above.
	if _, err := os.Stat(filepath.Join(dir, "walkthrough.yaml")); err == nil {
		if err := readYAML(filepath.Join(dir, "walkthrough.yaml"), &walkthroughYAML); err != nil {
			return nil, fmt.Errorf("walkthrough.yaml: %w", err)
		}
	}
	walkthrough := make([]domain.WalkthroughStep, 0, len(walkthroughYAML))
	for _, s := range walkthroughYAML {
		walkthrough = append(walkthrough, domain.WalkthroughStep{
			Title: s.Title, TargetRoute: s.TargetRoute, Narration: s.Narration,
		})
	}

	dataDir := filepath.Join(dir, "data")
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return nil, fmt.Errorf("data/: %w", err)
	}
	var datasets []domain.DemoDataset
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".csv") {
			continue
		}
		identity := strings.TrimSuffix(e.Name(), ".csv")
		datasets = append(datasets, domain.DemoDataset{Identity: identity, CSVPath: filepath.Join(dataDir, e.Name())})
	}
	if len(datasets) == 0 {
		return nil, domain.EValidation("demo bundle ships no data/*.csv datasets",
			domain.FieldError{Field: "data", Message: dataDir})
	}

	return &domain.DemoBundle{
		Pack: manifest.Pack, PackVersion: manifest.PackVersion, Version: manifest.Version,
		Provenance: manifest.Provenance, Datasets: datasets, Personas: personas, Cases: cases,
		Walkthrough: walkthrough,
	}, nil
}

func readYAML(path string, out any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return yaml.Unmarshal(b, out)
}
