package billing

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/datacern-ai/usage-service/internal/domain"
	"github.com/datacern-ai/usage-service/internal/valueexport"
)

// Billing-artifact rendering (value-metering-billing-export design §2.7). The
// file/CSV export is the source of truth for a closed period (VMB-FR-022/AC-6);
// this builds it. Both files are deterministic functions of the (already
// meter-sorted) BillingPeriod, so re-rendering the same (tenant, period,
// version) yields byte-identical artifacts and identical SHA-256 checksums —
// the property that makes a correction's new version comparable and a replay a
// no-op (VMB-FR-021).

// BillingArtifacts is a closed period's exported form: the detail JSONL, the
// invoice-line summary CSV, their object-store keys and SHA-256 checksums.
type BillingArtifacts struct {
	Prefix      string
	JSONLKey    string
	JSONL       []byte
	JSONLSHA256 string
	CSVKey      string
	CSV         []byte
	CSVSHA256   string
}

// ArtifactPrefix is the versioned object-store prefix for a period's files:
// billing/<tenant>/<period>/<version> (design §2.7). Version N's keys are never
// overwritten — a correction writes N+1 under a new prefix.
func ArtifactPrefix(p domain.BillingPeriod) string {
	return fmt.Sprintf("billing/%s/%s/%d", p.TenantID.String(), p.Period, p.Version)
}

// jsonlLine is one JSONL record: a period-stamped billing line. Field order is
// fixed by the struct so json.Marshal is deterministic across runs.
type jsonlLine struct {
	TenantID        string  `json:"tenant_id"`
	Period          string  `json:"period"`
	Version         int     `json:"version"`
	MeterKey        string  `json:"meter_key"`
	Unit            string  `json:"unit"`
	Quantity        float64 `json:"quantity"`
	PricePerUnitUSD float64 `json:"price_per_unit_usd"`
	GrossUSD        float64 `json:"gross_usd"`
	RateCardID      string  `json:"rate_card_id"`
	RateCardVersion int     `json:"rate_card_version"`
}

// BuildArtifacts renders a closed period into JSONL + CSV + checksums.
//
// JSONL (billing/.../meters.jsonl): one line per billing line, the same shape
// as a usage_monthly query result so the file is the detail, not a
// re-derivation. CSV (billing/.../summary.csv): the invoice-line summary, RFC
// 4180 with disclosure header comments, matching valueexport's CSV convention.
//
// Note (honest scope): BillingPeriod.Lines is aggregated per meter_key by
// NewBillingPeriod, so both files are per-meter here. The design's per-
// dimension JSONL detail (workspace_id/agent_id/pack_name/decision breakdown)
// arrives when slice 3's close job passes dimensioned rollup rows through; the
// allowance-drawdown CSV columns (included_qty/overage) need the entitlement
// snapshot the close job reads (§2.6) and are likewise deferred — this renders
// only what a BillingPeriod carries today, never a fabricated 0.
func BuildArtifacts(p domain.BillingPeriod) (BillingArtifacts, error) {
	prefix := ArtifactPrefix(p)

	// --- JSONL ---
	var jb bytes.Buffer
	enc := json.NewEncoder(&jb)
	enc.SetEscapeHTML(false)
	for _, ln := range p.Lines {
		if err := enc.Encode(jsonlLine{
			TenantID:        p.TenantID.String(),
			Period:          p.Period,
			Version:         p.Version,
			MeterKey:        ln.MeterKey,
			Unit:            ln.Unit,
			Quantity:        ln.Quantity,
			PricePerUnitUSD: ln.PricePerUnitUSD,
			GrossUSD:        ln.GrossUSD,
			RateCardID:      p.RateCardID.String(),
			RateCardVersion: p.RateCardVersion,
		}); err != nil {
			return BillingArtifacts{}, err
		}
	}
	jsonl := jb.Bytes()

	// --- CSV (invoice-line summary) ---
	comments := []string{
		fmt.Sprintf("Datacern billing summary — tenant %s period %s version %d", p.TenantID.String(), p.Period, p.Version),
		fmt.Sprintf("rate_card_id %s (v%d) — gross_usd %s", p.RateCardID.String(), p.RateCardVersion, formatUSD(p.GrossUSD)),
		"Gross is rate-card priced; a provider (Stripe) may price the same quantities independently. Detail: meters.jsonl.",
	}
	columns := []string{"meter_key", "unit", "quantity", "price_per_unit_usd", "gross_usd"}
	rows := make([][]any, 0, len(p.Lines))
	for _, ln := range p.Lines {
		rows = append(rows, []any{ln.MeterKey, ln.Unit, ln.Quantity, ln.PricePerUnitUSD, ln.GrossUSD})
	}
	csv, err := valueexport.WriteCSV(comments, columns, rows)
	if err != nil {
		return BillingArtifacts{}, err
	}

	return BillingArtifacts{
		Prefix:      prefix,
		JSONLKey:    prefix + "/meters.jsonl",
		JSONL:       jsonl,
		JSONLSHA256: valueexport.SHA256Hex(jsonl),
		CSVKey:      prefix + "/summary.csv",
		CSV:         csv,
		CSVSHA256:   valueexport.SHA256Hex(csv),
	}, nil
}

// formatUSD renders a dollar figure to 2dp for the CSV disclosure comment.
func formatUSD(v float64) string {
	return fmt.Sprintf("%.2f", v)
}
