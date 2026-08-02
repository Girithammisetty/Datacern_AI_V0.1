import PricingContent from "./pricing-content";

/**
 * Public pre-login pricing page (GTM B3). Server shell: owns metadata, renders
 * the interactive client calculator.
 *
 * The same discipline as /welcome and /admin/value applies — Rule #1: NO
 * invented numbers. The platform's real prices live in operator-configured,
 * versioned rate cards (there are no seeded public prices in this repo), so the
 * calculator ships *illustrative* default rates, explicitly labelled as such,
 * that an operator replaces with published pricing. The calculator MATH is real
 * and unit-tested (src/lib/pricing/calc.ts); only the default numbers are
 * placeholders, disclosed on the page.
 */
export const metadata = {
  title: "Datacern AI — Pricing you can put a ceiling on",
  description:
    "Estimate your Datacern cost from the levers that actually drive it — governed decisions, seats and packs — and see what a hard monthly budget cap does to the number you commit to. Most agentic-AI spend can run away; a Datacern plan can be given a ceiling the platform structurally will not cross.",
};

export default function PricingPage() {
  return <PricingContent />;
}
