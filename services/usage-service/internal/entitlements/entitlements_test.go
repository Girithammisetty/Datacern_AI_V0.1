package entitlements

import "testing"

func TestMeterAllowancesExtractsContractedRows(t *testing.T) {
	flat, err := ParseFlat([]byte(`{"v":7,"entitlements":[
		{"kind":"seat_cap","key":"seats","value":{"n":25}},
		{"kind":"meter_allowance","key":"governed_decision","value":{"included_qty":10000,"period":"calendar_month"}},
		{"kind":"meter_allowance","key":"llm_tokens_in","value":{"included_qty":2500000,"period":"calendar_month"}}
	]}`))
	if err != nil {
		t.Fatalf("ParseFlat: %v", err)
	}
	got := flat.MeterAllowances()
	if len(got) != 2 {
		t.Fatalf("got %d allowances, want 2 (seat_cap must not be picked up): %+v", len(got), got)
	}
	if got[0].MeterKey != "governed_decision" || got[0].IncludedQty != 10000 || got[0].Period != "calendar_month" {
		t.Errorf("first allowance = %+v", got[0])
	}
}

func TestMeterAllowancesSkipsRowsItCannotTrust(t *testing.T) {
	// A contract row with no usable included_qty must be DROPPED, not reported
	// as zero: "0 included" is a factual claim about what the customer bought,
	// and it would be the wrong one.
	flat, err := ParseFlat([]byte(`{"v":1,"entitlements":[
		{"kind":"meter_allowance","key":"no_qty","value":{"period":"calendar_month"}},
		{"kind":"meter_allowance","key":"bad_qty","value":{"included_qty":"lots"}},
		{"kind":"meter_allowance","key":"","value":{"included_qty":5}},
		{"kind":"meter_allowance","key":"ok","value":{"included_qty":5}}
	]}`))
	if err != nil {
		t.Fatalf("ParseFlat: %v", err)
	}
	got := flat.MeterAllowances()
	if len(got) != 1 || got[0].MeterKey != "ok" {
		t.Fatalf("got %+v, want only the well-formed 'ok' row", got)
	}
}

func TestMeterAllowancesToleratesMissingPeriod(t *testing.T) {
	// Period is reported verbatim; an absent one is empty, not invented.
	flat, _ := ParseFlat([]byte(`{"entitlements":[{"kind":"meter_allowance","key":"m","value":{"included_qty":1}}]}`))
	got := flat.MeterAllowances()
	if len(got) != 1 || got[0].Period != "" {
		t.Fatalf("got %+v, want one row with an empty period", got)
	}
}

func TestNilReaderReportsProjectionUnavailable(t *testing.T) {
	// A deployment without Redis must degrade to "unknown" rather than panic,
	// and must NOT look like "this tenant has no allowances".
	var r *Reader
	if got, ok := r.Allowances(t.Context(), "tenant-1"); ok || got != nil {
		t.Fatalf("Allowances = (%+v, %v), want (nil, false)", got, ok)
	}
	if got, ok := NewReader(nil).Allowances(t.Context(), "tenant-1"); ok || got != nil {
		t.Fatalf("Allowances over nil client = (%+v, %v), want (nil, false)", got, ok)
	}
}

func TestParseFlatRejectsCorruptPayload(t *testing.T) {
	if _, err := ParseFlat([]byte(`{not json`)); err == nil {
		t.Fatal("ParseFlat accepted a corrupt payload")
	}
}

func TestKeyMatchesProjectionContract(t *testing.T) {
	if got := Key("t-9"); got != "ent:t-9:flat" {
		t.Fatalf("Key = %q, want ent:t-9:flat (identity-service's projection key)", got)
	}
}
