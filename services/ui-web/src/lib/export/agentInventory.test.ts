import { describe, it, expect } from "vitest";
import type { AgentFleetRow } from "@/lib/graphql/types";
import { AGENT_INVENTORY_CSV_HEADER, UNAVAILABLE_MARKER, agentInventoryFilename, buildAgentInventoryCsv } from "./agentInventory";

const HEALTHY_ROW: AgentFleetRow = {
  key: "case-triage",
  kind: "PLATFORM",
  display: "Case Triage",
  lifecycle: "ACTIVE",
  activeVersion: { id: 1, graphDigest: "sha256:aaa", rollout: "UNKNOWN" },
  guardrails: { dataScope: { workspaces: ["ws-1"] }, tokenBudget: 5000, piiEgress: "blocked", ruleOfTwo: true },
  toolset: ["tool.read_case", "tool.write_note"],
  evalGate: { status: "PASS", lastRunAt: "2026-07-24T00:05:00Z", suiteKey: "suite-core", unavailable: false },
  killSwitch: { id: null, state: "active", updatedAt: null, actor: null },
  spend: { periodUsd: 12.5, trend7dPct: 25, unavailable: false },
  decisions: { proposed: 4, approved: 3, edited: 1, rejected: 0, period: "2026-06-25/2026-07-25", unavailable: false },
  lastIncidentAt: null,
  external: null,
  liveUpdates: { hubUrl: "http://localhost:9020", topics: ["list:agent"] },
};

const DEGRADED_ROW: AgentFleetRow = {
  ...HEALTHY_ROW,
  key: "acme-custom-1",
  kind: "CUSTOM",
  display: "Acme Custom",
  guardrails: { dataScope: null, tokenBudget: null, piiEgress: null, ruleOfTwo: true },
  toolset: [],
  activeVersion: { id: 2, graphDigest: null, rollout: "PINNED" },
  evalGate: { status: "NONE", lastRunAt: null, suiteKey: null, unavailable: true },
  killSwitch: { id: "k-1", state: "killed", updatedAt: "2026-07-20T00:00:00Z", actor: "user:u-9" },
  spend: { periodUsd: null, trend7dPct: null, unavailable: true },
  decisions: { proposed: null, approved: null, edited: null, rejected: null, period: "2026-06-25/2026-07-25", unavailable: true },
};

describe("buildAgentInventoryCsv: healthy row (no degradation)", () => {
  const csv = buildAgentInventoryCsv([HEALTHY_ROW], { includeSpend: true, generatedAt: "2026-07-26T12:00:00.000Z" });
  const lines = csv.split("\r\n");

  it("emits leading `#` provenance comments naming Datacern, the period, and the generation time", () => {
    expect(lines[0]).toContain("Datacern AI system inventory export");
    expect(lines[0].startsWith("# ")).toBe(true);
    expect(lines.some((l) => l.includes("2026-07-26T12:00:00.000Z"))).toBe(true);
    expect(lines.some((l) => l.includes("2026-06-25 to 2026-07-25"))).toBe(true);
  });

  it("emits the documented header row exactly", () => {
    const headerLineIndex = lines.findIndex((l) => l.startsWith("Agent key,"));
    expect(headerLineIndex).toBeGreaterThan(-1);
    expect(lines[headerLineIndex].split(",")).toEqual(AGENT_INVENTORY_CSV_HEADER);
  });

  it("renders real values for every non-degraded field, including a real spend figure and real decision counts", () => {
    const dataLine = lines.find((l) => l.startsWith("case-triage,"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain("Case Triage");
    expect(dataLine).toContain("PLATFORM");
    expect(dataLine).toContain("ACTIVE");
    expect(dataLine).toContain("v1");
    expect(dataLine).toContain("sha256:aaa");
    expect(dataLine).toContain("tool.read_case; tool.write_note");
    expect(dataLine).toContain("PASS");
    expect(dataLine).toContain("12.50"); // spend
    expect(dataLine).toContain("25.0"); // trend
    expect(dataLine).toContain(",4,3,1,0,"); // decisions proposed/approved/edited/rejected
    expect(dataLine).not.toContain(UNAVAILABLE_MARKER);
  });

  it("ends every record (including the last) with CRLF", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.includes("\r\n\r\n")).toBe(false); // no stray blank lines
  });
});

describe("buildAgentInventoryCsv: degraded row (unavailable fields, per resolver's degradation pattern)", () => {
  const csv = buildAgentInventoryCsv([DEGRADED_ROW], { includeSpend: true, generatedAt: "2026-07-26T12:00:00.000Z" });
  const dataLine = csv.split("\r\n").find((l) => l.startsWith("acme-custom-1,"))!;

  it("marks evalGate, spend, and all four decision counts UNAVAILABLE — never blank or zero", () => {
    const cells = dataLine.split(",");
    // header index: eval gate status=9, eval gate last run=10, spend usd=14, spend trend=15,
    // decisions proposed/approved/edited/rejected = 16..19 (0-indexed).
    expect(cells[9]).toBe(UNAVAILABLE_MARKER); // eval gate status
    expect(cells[10]).toBe(UNAVAILABLE_MARKER); // eval gate last run
    expect(cells[14]).toBe(UNAVAILABLE_MARKER); // spend usd
    expect(cells[15]).toBe(UNAVAILABLE_MARKER); // spend trend
    expect(cells[16]).toBe(UNAVAILABLE_MARKER); // proposed
    expect(cells[17]).toBe(UNAVAILABLE_MARKER); // approved
    expect(cells[18]).toBe(UNAVAILABLE_MARKER); // edited
    expect(cells[19]).toBe(UNAVAILABLE_MARKER); // rejected
    // None of these render as an empty string (a blank cell reading as a fact).
    expect(cells[9]).not.toBe("");
    expect(cells[14]).not.toBe("");
  });

  it("renders genuinely-not-set fields (no unavailable sibling) with the not-set marker, not UNAVAILABLE", () => {
    const cells = dataLine.split(",");
    expect(cells[5]).toBe("—"); // version digest: null, no unavailable sibling on activeVersion
    expect(cells[5]).not.toBe(UNAVAILABLE_MARKER);
  });

  it("renders real kill-switch state even though other groups on the same row are degraded", () => {
    expect(dataLine).toContain("killed");
    expect(dataLine).toContain("user:u-9");
  });
});

describe("buildAgentInventoryCsv: spend omitted entirely for a viewer without the capability", () => {
  it("marks spend UNAVAILABLE (never a fabricated $0) when includeSpend is false, even for a row whose spend group is populated", () => {
    const csv = buildAgentInventoryCsv([HEALTHY_ROW], { includeSpend: false, generatedAt: "2026-07-26T12:00:00.000Z" });
    const dataLine = csv.split("\r\n").find((l) => l.startsWith("case-triage,"))!;
    const cells = dataLine.split(",");
    expect(cells[14]).toBe(UNAVAILABLE_MARKER);
    expect(cells[15]).toBe(UNAVAILABLE_MARKER);
  });
});

describe("agentInventoryFilename", () => {
  it("embeds the resolved period bounds so re-exports of a different window don't collide", () => {
    expect(agentInventoryFilename([HEALTHY_ROW])).toBe("datacern-agent-inventory_2026-06-25_2026-07-25.csv");
  });

  it("degrades to the unavailable marker in the filename when there are no rows to derive a period from", () => {
    expect(agentInventoryFilename([])).toBe(`datacern-agent-inventory_${UNAVAILABLE_MARKER}_${UNAVAILABLE_MARKER}.csv`);
  });
});
