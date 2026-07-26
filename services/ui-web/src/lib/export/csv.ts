/**
 * Small RFC 4180 CSV writer for client-side (browser) exports. ui-web had no
 * existing TS CSV helper — the only prior art in the repo is usage-service's
 * Go writer (services/usage-service/internal/valueexport/export.go), whose
 * conventions this mirrors: a UTF-8 BOM (Excel-friendly), `# `-prefixed
 * leading comment/provenance lines, and CRLF line endings for every record
 * including the last. Kept generic (no Agent Control Tower knowledge) so any
 * future ui-web export can reuse it; see lib/export/agentInventory.ts for the
 * domain-specific column mapping that uses it.
 */

const CRLF = "\r\n";

/** True if a field requires quoting per RFC 4180 §2.6: contains the
 * delimiter, a double quote, or a line break (CR or LF). */
function needsQuoting(field: string): boolean {
  return /[",\r\n]/.test(field);
}

/** Quote a single field per RFC 4180 §2.5/2.7: wrap in double quotes and
 * double any embedded double quote. Fields that don't need quoting are
 * returned as-is. */
export function escapeCsvField(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Join already-stringified cells into one RFC 4180 record (no trailing line
 * break — callers join records with CRLF via `buildCsv`). */
export function toCsvRow(fields: string[]): string {
  return fields.map(escapeCsvField).join(",");
}

/**
 * Build a full RFC 4180 CSV document: optional `#`-prefixed leading comment
 * lines (provenance/disclosure — not part of the tabular data, but a
 * cheap, universally-readable way to disclose export context even in a flat
 * CSV), a header row, and data rows. CRLF line endings throughout, including
 * after the final row (matches the Go writer's behavior).
 */
export function buildCsv(opts: {
  leadingComments?: string[];
  header: string[];
  rows: string[][];
}): string {
  const lines: string[] = [];
  for (const c of opts.leadingComments ?? []) lines.push(`# ${c}`);
  lines.push(toCsvRow(opts.header));
  for (const row of opts.rows) lines.push(toCsvRow(row));
  return lines.join(CRLF) + CRLF;
}

/** UTF-8 BOM, prepended so Excel (which otherwise guesses the wrong
 * encoding for non-ASCII content) opens the file correctly — same rationale
 * as the Go writer. */
const UTF8_BOM = "﻿";

/**
 * Trigger a browser download of `content` as a CSV file. Client-only (uses
 * Blob/URL/DOM APIs) — callers must be "use client" components. Mirrors the
 * existing Blob-download convention in
 * components/inbox/EvidencePackPanel.tsx (JSON there, CSV here).
 */
export function downloadCsv(filename: string, content: string, withBom = true): void {
  const blob = new Blob([withBom ? UTF8_BOM + content : content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
