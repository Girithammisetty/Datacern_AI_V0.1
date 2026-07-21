/**
 * BRD 57 BR-1: the approver must see the EXACT bytes that will transmit, not
 * a re-derived summary — ingestion-service renders X12 at propose time for
 * exactly this reason (`x12_out.py::render_for_writeback`). Segments are
 * terminated with "~" for every interchange Datacern renders (the default
 * delimiter set `render_837`/`render_276` use when the caller supplies none,
 * which the writeback path always does), so splitting on it here is safe for
 * our own outbound renders specifically — not a general X12 parser.
 *
 * Kept out of page.tsx: Next.js's typed-routes codegen only allows a fixed
 * set of named exports (default, metadata, ...) from a `page.tsx` file.
 */
export function x12Segments(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const rendered = (payload as Record<string, unknown>).x12_rendered;
  if (typeof rendered !== "string" || !rendered) return null;
  return rendered.split("~").map((s) => s.trim()).filter(Boolean);
}

export function X12Preview({ payload }: { payload: unknown }) {
  const segments = x12Segments(payload);
  if (!segments) return null;
  const checksum = (payload as Record<string, unknown>).x12_checksum;
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs text-muted-foreground">
        Exact X12 interchange to be transmitted ({segments.length} segments)
        {typeof checksum === "string" && (
          <span className="ml-1 font-mono" title="SHA-256 of the rendered bytes, re-verified at delivery">
            · sha256:{checksum.slice(0, 12)}…
          </span>
        )}
      </p>
      <pre className="max-h-64 overflow-y-auto rounded bg-muted p-2 font-mono text-xs leading-relaxed">
        {segments.join("\n")}
      </pre>
    </div>
  );
}
