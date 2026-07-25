"use client";

import { FlaskConical } from "lucide-react";
import { useSession } from "@/lib/session/SessionContext";

/**
 * Persistent "DEMO — synthetic data" watermark (BRD 70 DSP-FR-014, §2.6).
 * Renders purely from the session claim (`session.profile === "demo"`) —
 * NO GraphQL round-trip, NO tenant lookup, satisfying DSP-FR-014's "from
 * session claim, not tenant lookup" literally. Self-contained by design
 * (no new bff-graphql field, no FEATURE_GATES entry, no i18n message key)
 * so it never needs coordination with any other in-flight change to those
 * shared files — the text is hardcoded here rather than routed through
 * lib/i18n/messages.ts.
 *
 * Mounted once in AppShell's ShellInner, between TopBar and <main> (the
 * insertion point the design identifies, §2.6).
 */
export function DemoWatermarkBanner() {
  const session = useSession();
  if (session.profile !== "demo") return null;

  return (
    <div
      role="status"
      aria-label="Demo sandbox: synthetic data"
      className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>DEMO — synthetic data. Nothing in this tenant is real; it is reset and reaped automatically.</span>
    </div>
  );
}
