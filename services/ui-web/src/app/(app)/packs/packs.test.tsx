import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

/**
 * Capability Packs surface (BRD 23). Verifies the catalog render, the dry-run
 * plan (create | exists | deferred), and the install → ledger flow, plus the
 * installed-packs section + uninstall.
 */
let handler: (doc: string, vars: any) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return { ...actual, graphqlRequest: async (doc: string, vars: any) => handler(doc, vars) };
});

import PacksPage from "./page";

const me = {
  me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

function pack() {
  return {
    name: "card-disputes", version: "1.0.0", description: "Card dispute adjudication.",
    publisherName: "Windrose Inc.", categories: ["banking", "cards"], regulatory: ["reg_e"],
    components: [{ kind: "dispositions", count: 5 }, { kind: "roles", count: 5 }],
    deferredKinds: ["guardrails", "case_schemas"],
  };
}

function base(doc: string): any {
  if (doc.includes("query Me")) return me;
  if (doc.includes("query PackInstalls")) return { packInstalls: [] };
  if (doc.includes("query Packs")) return { packs: [pack()] };
  if (doc.includes("query PackDetail")) return { pack: { ...pack(), deferred: [{ kind: "guardrails", reason: "OPA policy materialization not exposed yet." }] } };
  return {};
}

beforeEach(() => { handler = base; });

describe("PacksPage (BRD 23 capability packs)", () => {
  it("renders the catalog with a pack card", async () => {
    renderWithProviders(<PacksPage />);
    const card = await screen.findByTestId("pack-card");
    expect(within(card).getByText("card-disputes")).toBeInTheDocument();
    expect(within(card).getByText(/10 components · 2 deferred kinds/)).toBeInTheDocument();
  });

  it("runs a dry-run plan showing create/exists/deferred", async () => {
    handler = (doc: string, vars: any) => {
      if (doc.includes("mutation PlanPackInstall")) {
        expect(vars.pack).toBe("card-disputes");
        return { planPackInstall: { pack: "card-disputes", version: "1.0.0", workspaceId: "ws",
          plan: [
            { kind: "dispositions", identity: "d", name: "file_chargeback", action: "create", detail: null },
            { kind: "semantic_models", identity: "s", action: "deferred", detail: "needs approver" },
          ] } };
      }
      return base(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<PacksPage />);
    const card = await screen.findByTestId("pack-card");
    await user.click(within(card).getByRole("button", { name: /Details & install/i }));
    await user.click(await within(card).findByRole("button", { name: /Dry-run plan/i }));
    const plan = await within(card).findByTestId("pack-plan");
    expect(within(plan).getByText(/1 create · 0 already present · 1 deferred/)).toBeInTheDocument();
  });

  it("installs and shows the materialization ledger", async () => {
    handler = (doc: string) => {
      if (doc.includes("mutation InstallPack")) {
        return { installPack: { id: "i-1", pack: "card-disputes", version: "1.0.0", workspaceId: "ws",
          status: "installed", summary: { created: 10 },
          ledger: [
            { id: "l1", kind: "roles", identity: "AP Analyst", action: "create", reversible: true, tombstoned: false, origin: "pack:card-disputes@1.0.0:roles/x", detail: null, targetUrn: null, targetId: "r1" },
            { id: "l2", kind: "dispositions", identity: "file_chargeback", action: "create", reversible: false, tombstoned: false, origin: "o", detail: null, targetUrn: null, targetId: null },
          ] } };
      }
      return base(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<PacksPage />);
    const card = await screen.findByTestId("pack-card");
    await user.click(within(card).getByRole("button", { name: /Details & install/i }));
    await user.click(await within(card).findByRole("button", { name: /Install into this workspace/i }));
    const ledger = await within(card).findByTestId("pack-ledger");
    expect(within(ledger).getByText(/2 objects materialized \(1 reversible\)/)).toBeInTheDocument();
  });

  it("shows installed packs with an uninstall control", async () => {
    handler = (doc: string) => {
      if (doc.includes("query PackInstalls")) {
        return { packInstalls: [{ id: "i-1", pack: "card-disputes", version: "1.0.0", workspaceId: "ws",
          status: "installed", summary: { created: 10, deferred: 11 }, createdBy: "u", createdAt: null }] };
      }
      return base(doc);
    };
    renderWithProviders(<PacksPage />);
    const row = await screen.findByTestId("pack-install-row");
    expect(within(row).getByText("card-disputes")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Uninstall/i })).toBeInTheDocument();
  });

  const installedRow = {
    packInstalls: [{ id: "i-1", pack: "card-disputes", version: "1.0.0", workspaceId: "ws",
      status: "installed", summary: { created: 10 }, createdBy: "u", createdAt: null }],
  };

  it("checks drift and shows the summary", async () => {
    handler = (doc: string) => {
      if (doc.includes("query PackInstalls")) return installedRow;
      if (doc.includes("query PackDrift")) return { packDrift: {
        id: "i-1", pack: "card-disputes", version: "1.0.0", workspaceId: "ws",
        superseded: false, drifted: 2, inSync: false,
        summary: { objects: 9, modified: 1, missing: 1, unverified: 0 }, objects: [] } };
      return base(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<PacksPage />);
    const row = await screen.findByTestId("pack-install-row");
    await user.click(within(row).getByRole("button", { name: /Check drift/i }));
    const res = await within(row).findByTestId("pack-drift-result");
    expect(within(res).getByText(/2 objects drifted/)).toBeInTheDocument();
  });

  it("previews an upgrade diff, then executes only on confirm", async () => {
    const calls: any[] = [];
    handler = (doc: string, vars: any) => {
      if (doc.includes("query PackInstalls")) return installedRow;
      if (doc.includes("mutation UpgradePack")) {
        calls.push(vars);
        return { upgradePack: {
          id: vars.dryRun ? null : "i-2", pack: "card-disputes", operation: "upgrade",
          fromVersion: "1.0.0", toVersion: "1.1.0", dryRun: vars.dryRun,
          status: vars.dryRun ? null : "installed", supersedes: vars.dryRun ? null : "i-1",
          diff: { added: 3, removed: 1, retained: 7 } } };
      }
      return base(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<PacksPage />);
    const row = await screen.findByTestId("pack-install-row");
    await user.click(within(row).getByRole("button", { name: /^Upgrade$/i }));
    const preview = await within(row).findByTestId("pack-transition-preview");
    expect(within(preview).getByText(/1\.0\.0 → 1\.1\.0/)).toBeInTheDocument();
    expect(within(preview).getByText(/3 added · 1 removed · 7 unchanged/)).toBeInTheDocument();
    expect(calls[0].dryRun).toBe(true);           // preview did NOT execute
    await user.click(within(preview).getByRole("button", { name: /Confirm upgrade/i }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].dryRun).toBe(false);          // confirm executed
  });
});
