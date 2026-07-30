package entitlements

import (
	"context"
	"errors"
	"testing"
)

type fakeGetter struct {
	val   string
	found bool
	err   error
}

func (f fakeGetter) Get(_ context.Context, _ string) (string, bool, error) {
	return f.val, f.found, f.err
}

const flatWithFeature = `{"v":3,"entitlements":[
	{"kind":"pack_sku","key":"card-disputes"},
	{"kind":"feature","key":"realtime_case_streams"},
	{"kind":"meter_allowance","key":"seats","value":{"included_qty":25}}]}`

const flatWithoutFeature = `{"v":3,"entitlements":[
	{"kind":"pack_sku","key":"card-disputes"},
	{"kind":"feature","key":"some_other_feature"}]}`

func TestCheckFeatureEntitled(t *testing.T) {
	st := CheckFeature(context.Background(), fakeGetter{val: flatWithFeature, found: true},
		"t-1", FeatureRealtimeCaseStreams)
	if st != Entitled {
		t.Fatalf("want Entitled, got %v", st)
	}
}

func TestCheckFeatureBlockedIsDistinctFromUnavailable(t *testing.T) {
	// A present projection without the grant is the legitimate "not entitled"
	// outcome — it must NOT be reported as "could not check".
	st := CheckFeature(context.Background(), fakeGetter{val: flatWithoutFeature, found: true},
		"t-1", FeatureRealtimeCaseStreams)
	if st != Blocked {
		t.Fatalf("want Blocked, got %v", st)
	}
}

func TestCheckFeatureOtherKindWithSameKeyDoesNotCount(t *testing.T) {
	// kind matters: a pack_sku or meter that happens to share the key string
	// must not unlock the feature.
	doc := `{"entitlements":[{"kind":"pack_sku","key":"realtime_case_streams"}]}`
	if st := CheckFeature(context.Background(), fakeGetter{val: doc, found: true},
		"t-1", FeatureRealtimeCaseStreams); st != Blocked {
		t.Fatalf("want Blocked, got %v", st)
	}
}

func TestCheckFeatureFailsClosed(t *testing.T) {
	// Every way the projection can be unreadable maps to Unavailable — never
	// to Entitled, and never to the softer Blocked.
	cases := map[string]Getter{
		"nil getter":   nil,
		"redis error":  fakeGetter{err: errors.New("conn refused")},
		"missing key":  fakeGetter{found: false},
		"empty blob":   fakeGetter{val: "", found: true},
		"corrupt json": fakeGetter{val: "{nope", found: true},
	}
	for name, g := range cases {
		if st := CheckFeature(context.Background(), g, "t-1", FeatureRealtimeCaseStreams); st != Unavailable {
			t.Fatalf("%s: want Unavailable, got %v", name, st)
		}
	}
}
