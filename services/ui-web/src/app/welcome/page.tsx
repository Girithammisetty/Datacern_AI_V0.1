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
  title: "Datacern AI — AI agents that decide, with your experts in command",
  description:
    "Datacern AI puts a team of specialist AI agents to work on your highest-stakes decisions — claims, authorizations, alerts, investigations. Agents draft, a copilot assists, your experts decide, and every correction trains the next model. Governed end to end.",
};

export default function WelcomePage() {
  return <WelcomeContent />;
}
