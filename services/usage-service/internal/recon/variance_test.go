package recon

import (
	"strings"
	"testing"

	"github.com/datacern-ai/usage-service/internal/domain"
)

func TestComputeLLMThreshold(t *testing.T) {
	metered := map[string]float64{domain.MeterLLMInputTokens: 1_000_000, domain.MeterQueryBytesScanned: 1000}
	billed := map[string]float64{domain.MeterLLMInputTokens: 1_080_000, domain.MeterQueryBytesScanned: 1050}
	lines, blocking := Compute(metered, billed)
	if !blocking {
		t.Fatal("expected blocking: 8% LLM variance > 5%")
	}
	found := false
	for _, l := range lines {
		if l.MeterKey == domain.MeterLLMInputTokens {
			found = true
			if !l.Blocking {
				t.Fatal("LLM meter should be blocking")
			}
		}
		if l.MeterKey == domain.MeterQueryBytesScanned && l.Blocking {
			t.Fatal("5% infra variance should not block (10% threshold)")
		}
	}
	if !found {
		t.Fatal("llm meter missing")
	}
}

func TestParseBillCSV(t *testing.T) {
	csv := "meter_key,billed_quantity\nllm_input_tokens,1080000\napi_calls,42\n"
	m, err := ParseBillCSV(strings.NewReader(csv))
	if err != nil {
		t.Fatal(err)
	}
	if m[domain.MeterLLMInputTokens] != 1_080_000 {
		t.Fatalf("llm=%v", m[domain.MeterLLMInputTokens])
	}
	if m[domain.MeterAPICalls] != 42 {
		t.Fatalf("api=%v", m[domain.MeterAPICalls])
	}
}

func TestParseBillKey(t *testing.T) {
	cases := []struct {
		prefix, key, wantProvider, wantMonth string
		wantOK                               bool
	}{
		{"bills/", "bills/openai/2026-05.csv", "openai", "2026-05", true},
		{"bills", "bills/anthropic/2026-06.csv", "anthropic", "2026-06", true},
		{"bills/", "bills/openai/not-a-month.csv", "", "", false},
		{"bills/", "bills/openai/2026-05.txt", "", "", false},
		{"bills/", "bills/2026-05.csv", "", "", false},
		{"bills/", "bills/openai/sub/2026-05.csv", "", "", false},
	}
	for _, c := range cases {
		p, m, ok := ParseBillKey(c.prefix, c.key)
		if ok != c.wantOK || p != c.wantProvider || m != c.wantMonth {
			t.Fatalf("ParseBillKey(%q,%q) = (%q,%q,%v), want (%q,%q,%v)",
				c.prefix, c.key, p, m, ok, c.wantProvider, c.wantMonth, c.wantOK)
		}
	}
}
