"use client";
import { RESOURCE_KEYS, type CanvasNode, type ResourceKey } from "@/lib/pipelines/canvas";
import { t, type MessageKey } from "@/lib/i18n/messages";

export interface ResourcePolicy {
  defaults: Record<string, number>;
  floor: Record<string, number>;
  ceiling: Record<string, number>;
}

const LABEL: Record<ResourceKey, MessageKey> = {
  cpus: "pipelines.resources.cpus",
  ram_gb: "pipelines.resources.ramGb",
  timeout_minutes: "pipelines.resources.timeoutMinutes",
};

const STEP: Record<ResourceKey, number> = { cpus: 1, ram_gb: 1, timeout_minutes: 5 };

/**
 * BRD 71 (U1) — the "Resource Parameters" group, deliberately carrying V1's own group
 * name so the concept is recognisable to anyone migrating.
 *
 * Two decisions worth keeping:
 *
 * * **Empty means inherit, not zero.** A blank field is not "0 CPUs" — it is "take
 *   my predecessor's envelope", which is what the orchestrator's `resolve_resources`
 *   does. Clearing a field must therefore delete it, never write a default.
 * * **min/max come from the SERVED policy**, not from constants here. The tenant's
 *   ceiling moves with its quota, and a form that offers a value the compiler will
 *   clamp is a form that lies.
 */
export function ResourceFields({
  node,
  policy,
  effective,
  onChange,
}: {
  node: CanvasNode;
  policy?: ResourcePolicy;
  /** The resolved envelope for this node from the last validate (inherited included). */
  effective?: Record<string, number>;
  onChange: (key: ResourceKey, value: number | undefined) => void;
}) {
  return (
    <fieldset className="space-y-3 rounded-md border p-3" data-testid="resource-fields">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pipelines.resources.legend")}
      </legend>

      {RESOURCE_KEYS.map((key) => {
        const id = `resource-${key}`;
        const value = node.resources?.[key];
        const min = policy?.floor?.[key];
        const max = policy?.ceiling?.[key];
        // Placeholder shows what this node WOULD get if left blank, so the cost of
        // not overriding is visible before the run rather than after it.
        const inherited = effective?.[key] ?? policy?.defaults?.[key];
        return (
          <div key={key} className="space-y-1">
            <label htmlFor={id} className="block text-xs font-medium">
              {t(LABEL[key])}
            </label>
            <input
              id={id}
              type="number"
              inputMode="numeric"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={value ?? ""}
              min={min}
              max={max}
              step={STEP[key]}
              placeholder={
                inherited === undefined
                  ? undefined
                  : t("pipelines.resources.inherited", { value: String(inherited) })
              }
              aria-describedby={`${id}-help`}
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === "") return onChange(key, undefined); // cleared = inherit
                const n = Number(raw);
                if (!Number.isFinite(n)) return;
                // Clamp here as well as server-side: a number input's min/max are
                // advisory for typed values in every browser.
                const clamped = Math.min(max ?? n, Math.max(min ?? n, n));
                onChange(key, clamped);
              }}
            />
            <p id={`${id}-help`} className="text-[11px] text-muted-foreground">
              {min !== undefined && max !== undefined
                ? t("pipelines.resources.range", { min: String(min), max: String(max) })
                : t("pipelines.resources.blankInherits")}
            </p>
          </div>
        );
      })}
    </fieldset>
  );
}
