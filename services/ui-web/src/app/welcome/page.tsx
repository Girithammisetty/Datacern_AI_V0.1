import type { Metadata } from "next";
import { WELCOME_CONTENT } from "@/content/marketing/welcome";
import WelcomeContent from "./welcome-content";

/**
 * Public pre-login marketing page (the front door for signed-out visitors).
 * Server shell only — ALL copy lives in src/content/marketing/welcome.ts and
 * the client component is a pure renderer of it.
 *
 * GTM framing that leads with the AI capabilities. Rule #1 — NO invented
 * numbers: no fabricated stats, customer counts, logos, percentages, ROI,
 * uptime claims, certifications or testimonials. Every claim is a qualitative
 * statement about what the product does; mock UI is clearly illustrative.
 */
export const metadata: Metadata = {
  title: WELCOME_CONTENT.meta.title,
  description: WELCOME_CONTENT.meta.description,
};

export default function WelcomePage() {
  return <WelcomeContent />;
}
