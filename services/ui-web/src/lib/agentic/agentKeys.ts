/**
 * Per-module copilot specialist routing (Tier 2b).
 *
 * Maps the current route to the published agent-runtime specialist that best
 * matches the screen. The keys MUST stay within the allowlist in
 * src/app/api/copilot/message/route.ts (which itself mirrors agent-runtime's
 * catalog, app/agents/catalog.py) — an unknown key silently falls back to the
 * default agent server-side, so keep both lists in lockstep.
 *
 * A HINT, NOT A BINDING. This used to be the agent the drawer actually talked
 * to, which meant the screen decided the specialist and the user's intent never
 * got a vote: asking a dashboard question from a case page kept you on the
 * agent the route picked, and asking an analytics question on /dashboards went
 * to dashboard-designer. The drawer now converses with `meta-router`, which
 * classifies each turn and delegates, and this value rides along as a
 * tie-breaker for requests the text alone leaves ambiguous ("run it again").
 * Returning null means the route carries no useful prior.
 */
export function routeHintForPath(pathname: string): string | null {
  // Longest-prefix first: batch scoring lives under /ml but has its own agent.
  if (pathname === "/ml/inference" || pathname.startsWith("/ml/inference/")) return "inference";
  if (pathname === "/ml" || pathname.startsWith("/ml/")) return "model-training";
  if (pathname === "/dashboards" || pathname.startsWith("/dashboards/")) return "dashboard-designer";
  if (pathname === "/data" || pathname.startsWith("/data/")) return "onboarding";
  return null;
}

/**
 * The agent the copilot drawer converses with by default. The router re-decides
 * on EVERY turn, which is what makes mid-thread re-routing work: turn 1 can land
 * on analytics and turn 2 on dashboard-designer without the user doing anything.
 * Its documented fallback is `analytics` (the only read-only candidate), so an
 * unclassifiable message can never manufacture a write intent.
 */
export const COPILOT_ROUTER_AGENT_KEY = "meta-router";

/** @deprecated Use {@link routeHintForPath}. Kept so an explicit specialist
 * override (the drawer's `agentKey` prop) can still name the route's agent. */
export const agentKeyForPath = routeHintForPath;
