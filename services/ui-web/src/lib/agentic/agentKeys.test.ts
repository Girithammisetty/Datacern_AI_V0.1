import { describe, it, expect } from "vitest";
import { agentKeyForPath, routeHintForPath, COPILOT_ROUTER_AGENT_KEY } from "./agentKeys";

/** Route → module-specialist mapping (Tier 2b). Keys must stay within the
 * allowlist in src/app/api/copilot/message/route.ts. */
describe("routeHintForPath", () => {
  it("maps /data pages to the onboarding specialist", () => {
    expect(routeHintForPath("/data")).toBe("onboarding");
    expect(routeHintForPath("/data/connections")).toBe("onboarding");
    expect(routeHintForPath("/data/pipelines/runs")).toBe("onboarding");
  });

  it("maps /ml pages to model-training, except the inference pages", () => {
    expect(routeHintForPath("/ml")).toBe("model-training");
    expect(routeHintForPath("/ml/experiments")).toBe("model-training");
    expect(routeHintForPath("/ml/models/m-1")).toBe("model-training");
    expect(routeHintForPath("/ml/inference")).toBe("inference");
    expect(routeHintForPath("/ml/inference/job-1")).toBe("inference");
  });

  it("maps /dashboards pages to dashboard-designer", () => {
    expect(routeHintForPath("/dashboards")).toBe("dashboard-designer");
    expect(routeHintForPath("/dashboards/d-1")).toBe("dashboard-designer");
  });

  it("returns null where the route carries no useful prior", () => {
    expect(routeHintForPath("/")).toBeNull();
    expect(routeHintForPath("/cases/c-1")).toBeNull();
    expect(routeHintForPath("/copilot")).toBeNull();
    expect(routeHintForPath("/admin/agents")).toBeNull();
    // Prefix must match a path segment, not a substring.
    expect(routeHintForPath("/mlx")).toBeNull();
    expect(routeHintForPath("/database")).toBeNull();
  });
});

/** The screen is a HINT now, not the decision.
 *
 * This mapping used to BE the agent the copilot drawer talked to, which meant a
 * dashboard question asked from a case page stayed on whatever agent the route
 * picked, and nothing re-routed mid-thread. The drawer now converses with the
 * meta-router, which re-classifies every turn; this value only breaks ties. */
describe("copilot default agent", () => {
  it("is the router, so intent — not the pathname — picks the specialist", () => {
    expect(COPILOT_ROUTER_AGENT_KEY).toBe("meta-router");
  });

  it("keeps the legacy alias pointing at the hint mapping", () => {
    expect(agentKeyForPath("/dashboards")).toBe(routeHintForPath("/dashboards"));
  });

  it("only ever names agents the copilot API route allows", async () => {
    // Guards the lockstep the module docstring demands: a hint outside the
    // allowlist is silently dropped server-side, so a typo here would look like
    // "the hint just does not help" rather than a broken contract.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/api/copilot/message/route.ts", "utf8"));
    const allowed = new Set(
      [...src.matchAll(/^\s*"([a-z-]+)",$/gm)].map((m) => m[1]));
    for (const p of ["/data", "/ml", "/ml/inference", "/dashboards"]) {
      expect(allowed.has(routeHintForPath(p)!)).toBe(true);
    }
    expect(allowed.has(COPILOT_ROUTER_AGENT_KEY)).toBe(true);
  });
});
