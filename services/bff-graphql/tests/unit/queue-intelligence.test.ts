/**
 * Approver queue intelligence (roadmap item 4) through the bff.
 *
 * Two things are worth a test here and the rest is plumbing:
 *
 * 1. NULL PERCENTILES SURVIVE. case-service returns null when nothing resolved
 *    in the window. If the bff coerces that to 0 the panel tells an approver
 *    decisions are instant — the one number in this payload that would actively
 *    mislead rather than merely be wrong.
 * 2. NO WORKSPACE ARGUMENT. The downstream derives the workspace from the
 *    caller's claims. If the bff ever forwarded a client-supplied one, this
 *    aggregate would become a way to count another department's backlog, which
 *    is exactly what the /cases isolation rules withhold.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();
const single = (res: any) => (res.body.kind === "single" ? res.body.singleResult : null);

const PAYLOAD = {
  generated_at: "2026-07-31T22:00:00Z",
  window_days: 7,
  open: { total: 4, unassigned: 2, in_progress: 2 },
  aging: [
    { label: "under_24h", count: 1 },
    { label: "1_to_3d", count: 1 },
    { label: "3_to_7d", count: 1 },
    { label: "over_7d", count: 1 },
  ],
  sla: { breached: 1, due_within_24h: 1 },
  throughput: { opened: 5, resolved: 2, closed: 1 },
  latency: { p50_seconds: 255600, p90_seconds: 330120, sample: 2 },
};

const Q = `query($d: Int) { queueIntelligence(days: $d) {
  windowDays
  open { total unassigned inProgress }
  aging { label count }
  sla { breached dueWithin24h }
  throughput { opened resolved closed }
  latency { p50Seconds p90Seconds sample }
} }`;

function serve(body: any) {
  return mockFetch((req: CapturedRequest) =>
    req.path === "/api/v1/cases/queue-intelligence"
      ? { status: 200, body: { data: body } }
      : { status: 404, body: {} },
  );
}

describe("queueIntelligence", () => {
  it("maps the aggregate through to the panel shape", async () => {
    const { fetchImpl, requests } = serve(PAYLOAD);
    const res = await makeApolloServer(cfg).executeOperation(
      { query: Q, variables: { d: 7 } },
      { contextValue: await makeTestContext(fetchImpl) },
    );
    const q = single(res)?.data?.queueIntelligence as any;
    expect(single(res)?.errors).toBeUndefined();
    expect(q.open).toMatchObject({ total: 4, unassigned: 2, inProgress: 2 });
    expect(q.sla).toMatchObject({ breached: 1, dueWithin24h: 1 });
    expect(q.throughput).toMatchObject({ opened: 5, resolved: 2, closed: 1 });
    expect(q.latency.sample).toBe(2);
    // The buckets must arrive in order — the panel renders them as a timeline
    // and a reordered array would silently mislabel the backlog's shape.
    expect(q.aging.map((b: any) => b.label)).toEqual([
      "under_24h", "1_to_3d", "3_to_7d", "over_7d",
    ]);
    // Optional chain, not requests[0]!: under strict TS an index read is
    // possibly-undefined, and a non-null assertion would hide a genuine "no
    // request was made" as a type-level lie. undefined simply fails the compare.
    expect(requests[0]?.search.get("days")).toBe("7");
  });

  it("keeps null percentiles null instead of coercing them to zero", async () => {
    const { fetchImpl } = serve({
      ...PAYLOAD,
      latency: { p50_seconds: null, p90_seconds: null, sample: 0 },
    });
    const res = await makeApolloServer(cfg).executeOperation(
      { query: Q, variables: { d: 7 } },
      { contextValue: await makeTestContext(fetchImpl) },
    );
    const l = (single(res)?.data?.queueIntelligence as any).latency;
    expect(l.p50Seconds).toBeNull();
    expect(l.p90Seconds).toBeNull();
    expect(l.sample).toBe(0);
    // 0 would render as "instant decisions" — the failure this guards.
    expect(l.p50Seconds).not.toBe(0);
  });

  it("exposes no workspace argument a caller could use to cross departments", async () => {
    const { fetchImpl } = serve(PAYLOAD);
    const res = await makeApolloServer(cfg).executeOperation(
      { query: `query { queueIntelligence(workspaceId: "other-dept") { windowDays } }` },
      { contextValue: await makeTestContext(fetchImpl) },
    );
    // A schema-level refusal, not a runtime filter: the argument does not exist.
    expect(single(res)?.errors?.[0]?.message ?? "").toMatch(/workspaceId/i);
  });
});
