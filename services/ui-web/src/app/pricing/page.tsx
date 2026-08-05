import type { Metadata } from "next";
import { PRICING_CONTENT } from "@/content/marketing/pricing";
import PricingContent from "./pricing-content";

/**
 * Public pre-login pricing page (GTM B3). Server shell only — ALL copy lives
 * in src/content/marketing/pricing.ts and the client component renders it.
 *
 * The same discipline as /welcome and /admin/value applies — Rule #1: NO
 * invented numbers. The platform's real prices live in operator-configured,
 * versioned rate cards (there are no seeded public prices in this repo), so
 * this page shows NO dollar figures at all: it explains the levers and the
 * hard budget cap, then asks the visitor to contact us for a quote. The
 * billing math itself stays real and unit-tested (src/lib/pricing/calc.ts).
 */
export const metadata: Metadata = {
  title: PRICING_CONTENT.meta.title,
  description: PRICING_CONTENT.meta.description,
};

export default function PricingPage() {
  return <PricingContent />;
}
