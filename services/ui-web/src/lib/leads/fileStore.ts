/**
 * Durable append-only lead store backed by a JSONL file (GTM B4).
 *
 * Configured via LEAD_STORE_PATH. When set, every captured lead is appended as
 * one JSON line and dedupe reads the file for an existing key — so a lead
 * survives a webhook being unset or down, and a resubmission from the same
 * email is a no-op. When LEAD_STORE_PATH is unset, `fileLeadStore()` returns
 * null and the caller relies on the webhook (and logs the unconfigured state).
 *
 * JSONL (not a DB) is deliberate: the self-host posture means the marketing
 * intake must work with zero extra infra, and an append-only file is the
 * simplest thing that is durable and greppable. For a hosted/multi-pod motion,
 * swap this adapter for a shared store behind the same LeadStore interface.
 */
import { appendFile, readFile } from "node:fs/promises";

import type { Lead, LeadStore } from "./leads";

class FileLeadStore implements LeadStore {
  constructor(private readonly path: string) {}

  async has(key: string): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // no file yet
      throw e;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        if ((JSON.parse(line) as { dedupeKey?: string }).dedupeKey === key) return true;
      } catch {
        // A corrupt line never blocks capture — skip it.
      }
    }
    return false;
  }

  async append(lead: Lead): Promise<void> {
    await appendFile(this.path, JSON.stringify(lead) + "\n", "utf8");
  }
}

/** The configured durable store, or null when LEAD_STORE_PATH is unset. */
export function fileLeadStore(): LeadStore | null {
  const path = process.env.LEAD_STORE_PATH;
  return path ? new FileLeadStore(path) : null;
}
