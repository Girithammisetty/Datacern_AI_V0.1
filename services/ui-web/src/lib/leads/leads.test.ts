import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fileLeadStore } from "./fileStore";
import {
  captureLead, dedupeKey, validateLead, type Lead, type LeadStore,
} from "./leads";

const AT = "2026-08-02T00:00:00.000Z";

function lead(over: Partial<Lead> = {}): Lead {
  return {
    name: "Alice", email: "alice@acme.com", company: "Acme",
    teamSize: null, message: null, source: "welcome", receivedAt: AT,
    dedupeKey: "alice@acme.com", ...over,
  };
}

describe("validateLead", () => {
  it("normalizes a valid submission and sets the dedupe key", () => {
    const r = validateLead({ name: " Alice ", email: "Alice@Acme.com ", company: "Acme" }, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.name).toBe("Alice");
    expect(r.lead.email).toBe("Alice@Acme.com");        // preserved as entered
    expect(r.lead.dedupeKey).toBe("alice@acme.com");    // normalized for dedupe
    expect(r.lead.source).toBe("welcome");
  });

  it("drops a honeypot submission benignly", () => {
    const r = validateLead({ name: "Bot", email: "b@b.com", company: "X", website: "spam" }, AT);
    expect(r).toEqual({ ok: false, reason: "honeypot" });
  });

  it("reports every missing/invalid field", () => {
    const r = validateLead({ name: "A", email: "nope", company: "" }, AT);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "validation") throw new Error("expected validation");
    expect(r.fields.sort()).toEqual(["company", "email", "name"]);
  });

  it("dedupeKey is case- and whitespace-insensitive", () => {
    expect(dedupeKey("  Bob@X.COM ")).toBe("bob@x.com");
  });
});

describe("captureLead", () => {
  function memStore(seed: string[] = []): LeadStore & { rows: Lead[] } {
    const keys = new Set(seed);
    const rows: Lead[] = [];
    return {
      rows,
      async has(k) { return keys.has(k); },
      async append(l) { keys.add(l.dedupeKey); rows.push(l); },
    };
  }

  it("persists a new lead and forwards it", async () => {
    const store = memStore();
    let forwarded: Lead | null = null;
    const r = await captureLead(lead(), {
      store,
      webhook: async (l) => { forwarded = l; return true; },
    });
    expect(r).toMatchObject({ captured: true, duplicate: false, persisted: true, forwarded: true });
    expect(store.rows).toHaveLength(1);
    expect(forwarded).not.toBeNull();
  });

  it("dedupes a repeat email — no re-persist, no re-forward", async () => {
    const store = memStore(["alice@acme.com"]);
    let forwards = 0;
    const r = await captureLead(lead(), { store, webhook: async () => { forwards++; return true; } });
    expect(r).toMatchObject({ captured: true, duplicate: true, persisted: false, forwarded: false });
    expect(store.rows).toHaveLength(0);
    expect(forwards).toBe(0);
  });

  it("a broken store still lets the webhook capture the lead", async () => {
    const brokenStore: LeadStore = {
      async has() { throw new Error("disk gone"); },
      async append() { throw new Error("disk gone"); },
    };
    const r = await captureLead(lead(), { store: brokenStore, webhook: async () => true });
    expect(r.captured).toBe(true);      // not lost
    expect(r.persisted).toBe(false);
    expect(r.forwarded).toBe(true);
  });

  it("a broken webhook never blocks persistence", async () => {
    const store = memStore();
    const r = await captureLead(lead(), { store, webhook: async () => { throw new Error("502"); } });
    expect(r.persisted).toBe(true);
    expect(r.captured).toBe(true);
    expect(r.forwarded).toBe(false);
  });

  it("with NOTHING configured, the lead is reported as not-captured", async () => {
    const r = await captureLead(lead(), {});
    expect(r.captured).toBe(false);     // the honest signal an operator needs
  });

  it("runs the confirmation sink when configured", async () => {
    let confirmedTo: string | null = null;
    const r = await captureLead(lead(), {
      store: memStore(),
      confirm: async (l) => { confirmedTo = l.email; return true; },
    });
    expect(r.confirmed).toBe(true);
    expect(confirmedTo).toBe("alice@acme.com".replace("alice", "alice")); // alice@acme.com
  });
});

describe("fileLeadStore", () => {
  it("persists + dedupes across instances (JSONL survives)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const path = join(dir, "leads.jsonl");
    process.env.LEAD_STORE_PATH = path;
    try {
      const s1 = fileLeadStore()!;
      expect(await s1.has("alice@acme.com")).toBe(false);
      await s1.append(lead());
      // A FRESH instance sees the persisted lead (durable, not in-memory).
      const s2 = fileLeadStore()!;
      expect(await s2.has("alice@acme.com")).toBe(true);
      const onDisk = readFileSync(path, "utf8").trim().split("\n");
      expect(onDisk).toHaveLength(1);
      expect(JSON.parse(onDisk[0]).email).toBe("alice@acme.com");
    } finally {
      delete process.env.LEAD_STORE_PATH;
    }
  });

  it("returns null when LEAD_STORE_PATH is unset", () => {
    delete process.env.LEAD_STORE_PATH;
    expect(fileLeadStore()).toBeNull();
  });
});
