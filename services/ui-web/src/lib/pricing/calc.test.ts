import { describe, expect, it } from "vitest";

import { computeEstimate, type PricingInput, type Rates } from "./calc";

const RATES: Rates = {
  platformFloorUsd: 1000,
  perDecisionUsd: 0.5,
  perSeatUsd: 100,
  perPackUsd: 250,
};

function input(over: Partial<PricingInput> = {}): PricingInput {
  return {
    decisionsPerMonth: 10_000,
    seats: 5,
    packs: [],
    budgetCapUsd: null,
    ...over,
  };
}

describe("computeEstimate — components", () => {
  it("sums floor + seats + packs + usage with no cap", () => {
    const e = computeEstimate(input({ packs: ["disputes", "claims"] }), RATES);
    expect(e.platformFloorUsd).toBe(1000);
    expect(e.seatCostUsd).toBe(500); // 5 * 100
    expect(e.packCostUsd).toBe(500); // 2 * 250
    expect(e.usageCostUsd).toBe(5000); // 10_000 * 0.5
    expect(e.uncappedTotalUsd).toBe(7000);
    expect(e.committedTotalUsd).toBe(7000);
    expect(e.capReached).toBe(false);
    expect(e.decisionsWithinCap).toBe(10_000);
  });

  it("blends fixed + usage into effective cost per decision", () => {
    const e = computeEstimate(input({ packs: [] }), RATES);
    // (1000 floor + 500 seats + 0 packs + 5000 usage) / 10_000 = 0.65
    expect(e.uncappedTotalUsd).toBe(6500);
    expect(e.effectiveCostPerDecisionUsd).toBe(0.65);
  });
});

describe("computeEstimate — the hard budget cap", () => {
  it("caps the committed total and defers decisions beyond the ceiling", () => {
    // Uncapped would be 6500; cap at 4000. Fixed = 1500, so usage budget = 2500,
    // at 0.5/decision => 5000 decisions fit; the other 5000 defer.
    const e = computeEstimate(input({ budgetCapUsd: 4000 }), RATES);
    expect(e.capReached).toBe(true);
    expect(e.committedTotalUsd).toBe(4000); // structurally cannot exceed this
    expect(e.decisionsWithinCap).toBe(5000);
    // Effective cost is over decisions actually served, against the capped bill.
    expect(e.effectiveCostPerDecisionUsd).toBe(0.8); // 4000 / 5000
  });

  it("a cap above projected spend does not bind", () => {
    const e = computeEstimate(input({ budgetCapUsd: 100_000 }), RATES);
    expect(e.capReached).toBe(false);
    expect(e.committedTotalUsd).toBe(6500);
    expect(e.decisionsWithinCap).toBe(10_000);
  });

  it("a cap below the fixed floor serves zero decisions (fixed costs still commit)", () => {
    // Fixed = 1500; cap = 1000 < fixed => no usage budget, 0 decisions served.
    const e = computeEstimate(input({ budgetCapUsd: 1000 }), RATES);
    expect(e.capReached).toBe(true);
    expect(e.committedTotalUsd).toBe(1000);
    expect(e.decisionsWithinCap).toBe(0);
    expect(e.effectiveCostPerDecisionUsd).toBe(0); // nothing served
  });
});

describe("computeEstimate — hardening", () => {
  it("floors fractional/negative counts and ignores non-finite rates", () => {
    const e = computeEstimate(
      input({ decisionsPerMonth: 10.9, seats: -3, packs: [] }),
      { platformFloorUsd: NaN, perDecisionUsd: 1, perSeatUsd: 50, perPackUsd: 10 },
    );
    expect(e.platformFloorUsd).toBe(0); // NaN -> 0
    expect(e.seatCostUsd).toBe(0); // negative seats -> 0
    expect(e.usageCostUsd).toBe(10); // floor(10.9) * 1
  });

  it("zero decisions yields a zero effective cost, not a divide-by-zero", () => {
    const e = computeEstimate(input({ decisionsPerMonth: 0, packs: [] }), RATES);
    expect(e.usageCostUsd).toBe(0);
    expect(e.effectiveCostPerDecisionUsd).toBe(0);
    expect(Number.isFinite(e.effectiveCostPerDecisionUsd)).toBe(true);
  });

  it("rounds money to cents (no float dust)", () => {
    const e = computeEstimate(
      input({ decisionsPerMonth: 3, seats: 0, packs: [] }),
      { platformFloorUsd: 0, perDecisionUsd: 0.1, perSeatUsd: 0, perPackUsd: 0 },
    );
    expect(e.usageCostUsd).toBe(0.3); // 3 * 0.1, not 0.30000000000000004
  });
});
