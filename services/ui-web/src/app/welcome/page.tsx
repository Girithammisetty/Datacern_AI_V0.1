import WelcomeContent from "./welcome-content";

/**
 * Public pre-login marketing page (the front door for signed-out visitors).
 * Server shell: owns metadata, renders the interactive client showcase.
 *
 * GTM framing that leads with the AI capabilities. Rule #1 — NO invented
 * numbers: no fabricated stats, customer counts, logos, percentages, ROI,
 * uptime claims, certifications or testimonials. Every claim is a qualitative
 * statement about what the product does; mock UI is clearly illustrative.
 */
export const metadata = {
  title: "Datacern AI — AI does the work, a named human signs it",
  description:
    "Datacern works your regulated back-office queues — card disputes, health claims, financial-crime alerts, insurance losses, supplier invoices. Agents read the file, apply your rules and draft the recommendation. Nothing takes effect until a named person approves it, no one can approve their own work, and every action leaves a receipt an examiner can follow.",
};

export default function WelcomePage() {
  return <WelcomeContent />;
}
