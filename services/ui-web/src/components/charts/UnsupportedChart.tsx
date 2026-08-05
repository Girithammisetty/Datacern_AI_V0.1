"use client";
import { MapPinned } from "lucide-react";
import { t } from "@/lib/i18n/messages";

/**
 * BRD 72 — the declared-gap state.
 *
 * `geo_map_chart` is a real catalogued type whose data resolves fine, but a map
 * needs GeoJSON basemaps that are not bundled with the app (and cannot be
 * fetched at render time under the deployment's CSP). Rendering it as a bar
 * chart — what happened before — is worse than saying so: it silently presents
 * one visualization as another. This names the gap instead.
 */
export function UnsupportedChart({
  chartType,
  title,
}: {
  chartType?: string | null;
  title?: string;
}) {
  return (
    <div
      role="status"
      aria-label={title ?? "Unsupported chart"}
      data-testid="unsupported-chart"
      className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 py-6 text-center"
    >
      <MapPinned aria-hidden className="size-5 text-muted-foreground" />
      <p className="text-xs font-medium">{t("charts.unsupported.title")}</p>
      <p className="text-[11px] text-muted-foreground">
        {t("charts.unsupported.detail", { chartType: chartType ?? "this chart type" })}
      </p>
    </div>
  );
}
