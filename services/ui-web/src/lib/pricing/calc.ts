/**
 * Pricing calculator core for the public /pricing page (GTM B3).
 *
 * The platform's real prices live in operator-configured, versioned rate cards
 * (usage-service `RateCard.Items`: meter_key -> price_per_unit_usd). There are
 * NO seeded public prices in this repo, and the marketing surface follows the
 * same no-invented-numbers discipline as /welcome and /admin/value: this module
 * ships *illustrative* default rates, clearly labelled as such, that an operator
 * replaces with published pricing. The MATH here is real and unit-tested; only
 * the default numbers are placeholders.
 *
 * The headline differentiator this calculator exists to make legible is the
 * HARD BUDGET CAP: unlike usage-metered agentic products that can run away, a
 * Datacern plan can be given a monthly ceiling the platform structurally cannot
 * exceed (the commercial gate suspends value-delivering writes at the cap). So
 * every estimate returns both an uncapped projection AND what the cap does to
 * it — the number a buyer actually commits to.
 */

/** A pricing input. All counts are per calendar month. */
export interface PricingInput {
  /** Governed decisions expected per month (the primary usage meter). */
  decisionsPerMonth: number;
  /** Named human approvers / operators with seats. */
  seats: number;
  /** Optional add-on packs enabled (domain packs, connectors). */
  packs: string[];
  /**
   * Optional hard monthly budget cap in USD. When set, the platform refuses
   * further value-delivering writes once reached — so the *committed* spend can
   * never exceed this, at the cost of decisions beyond the cap deferring to the
   * next cycle. Null means uncapped (pay for what you use).
   */
  budgetCapUsd: number | null;
}

/** The rates used for a calculation. Illustrative defaults; operator-editable. */
export interface Rates {
  /** Platform floor billed every month regardless of usage. */
  platformFloorUsd: number;
  /** Price per governed decision. */
  perDecisionUsd: number;
  /** Price per seat / month. */
  perSeatUsd: number;
  /** Price per enabled pack / month. */
  perPackUsd: number;
}

export interface PricingEstimate {
  /** Fixed platform floor for the month. */
  platformFloorUsd: number;
  /** seats * perSeatUsd. */
  seatCostUsd: number;
  /** packs.length * perPackUsd. */
  packCostUsd: number;
  /** decisionsPerMonth * perDecisionUsd (uncapped). */
  usageCostUsd: number;
  /** floor + seats + packs + usage, before any cap. */
  uncappedTotalUsd: number;
  /**
   * What the buyer actually commits to: min(uncappedTotal, budgetCap) when a
   * cap is set, else the uncapped total. This is the number the hard cap makes
   * a promise about.
   */
  committedTotalUsd: number;
  /** True when the cap bit — i.e. projected usage would exceed the ceiling. */
  capReached: boolean;
  /**
   * Decisions that fit under the cap in-month. Equals decisionsPerMonth when the
   * cap did not bind (or is unset). Below it, work defers to the next cycle
   * rather than overspending.
   */
  decisionsWithinCap: number;
  /**
   * Blended cost per governed decision across the whole bill (fixed + usage),
   * over the decisions actually served this month. 0 when no decisions serve.
   */
  effectiveCostPerDecisionUsd: number;
}

/**
 * ILLUSTRATIVE default rates — placeholders, NOT Datacern's published pricing.
 * The /pricing page renders these behind an explicit "illustrative" disclosure
 * and an operator overrides them from the active rate card. Chosen only to make
 * the calculator's shape legible; deliberately round so no one mistakes them
 * for a real quote.
 */
export const ILLUSTRATIVE_RATES: Rates = {
  platformFloorUsd: 0,
  perDecisionUsd: 0,
  perSeatUsd: 0,
  perPackUsd: 0,
};

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Round to cents so displayed money never shows float dust. */
function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute a pricing estimate. Pure and deterministic — no I/O, no clock. The
 * cap is applied to the *usage* component only: fixed costs (floor + seats +
 * packs) are committed the moment a plan is active, so the cap governs how much
 * variable, decision-driven spend can accrue on top of them before the platform
 * stops serving new value-delivering writes for the cycle.
 */
export function computeEstimate(input: PricingInput, rates: Rates): PricingEstimate {
  const decisions = Math.floor(nonNegative(input.decisionsPerMonth));
  const seats = Math.floor(nonNegative(input.seats));
  const packCount = Array.isArray(input.packs) ? input.packs.length : 0;

  const platformFloorUsd = money(nonNegative(rates.platformFloorUsd));
  const seatCostUsd = money(seats * nonNegative(rates.perSeatUsd));
  const packCostUsd = money(packCount * nonNegative(rates.perPackUsd));
  const perDecision = nonNegative(rates.perDecisionUsd);
  const usageCostUsd = money(decisions * perDecision);

  const fixedUsd = money(platformFloorUsd + seatCostUsd + packCostUsd);
  const uncappedTotalUsd = money(fixedUsd + usageCostUsd);

  const cap = input.budgetCapUsd;
  let committedTotalUsd = uncappedTotalUsd;
  let capReached = false;
  let decisionsWithinCap = decisions;

  if (cap != null && Number.isFinite(cap)) {
    const capUsd = money(nonNegative(cap));
    if (uncappedTotalUsd > capUsd) {
      capReached = true;
      committedTotalUsd = capUsd;
      // How many decisions fit in the usage budget left after fixed costs.
      const usageBudget = Math.max(0, capUsd - fixedUsd);
      decisionsWithinCap = perDecision > 0 ? Math.floor(usageBudget / perDecision) : decisions;
    }
  }

  const served = capReached ? decisionsWithinCap : decisions;
  const billForServed = capReached ? committedTotalUsd : uncappedTotalUsd;
  const effectiveCostPerDecisionUsd = served > 0 ? money(billForServed / served) : 0;

  return {
    platformFloorUsd,
    seatCostUsd,
    packCostUsd,
    usageCostUsd,
    uncappedTotalUsd,
    committedTotalUsd,
    capReached,
    decisionsWithinCap,
    effectiveCostPerDecisionUsd,
  };
}
