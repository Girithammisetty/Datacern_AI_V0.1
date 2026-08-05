"use client";

import { Cog } from "lucide-react";

/** "One engine, many queues" — the /solutions hub drawing.
 *
 * A ring of industry chips around the governed core, with the engine's loop
 * stages listed inside the hub. Pure SVG for the ring geometry, but every
 * label is real DOM text positioned over it (foreignObject-free, so it renders
 * identically across browsers and stays selectable/translatable). Colors ride
 * the theme tokens (currentColor + hsl(var(--primary))), so light/dark both
 * work without a second drawing.
 *
 * All content arrives as props from the page — the component draws, the
 * config speaks.
 */

export interface HubSpoke {
  label: string;
  count: number;
}

export function PackHubDiagram({
  spokes,
  hubTitle,
  hubStages,
}: {
  spokes: HubSpoke[];
  hubTitle: string;
  hubStages: readonly string[];
}) {
  return (
    <div className="grid items-center gap-8 lg:grid-cols-[1fr_auto_1fr]">
      {/* left spokes */}
      <ul className="order-2 m-0 flex list-none flex-col gap-3 p-0 lg:order-1">
        {spokes.filter((_, i) => i % 2 === 0).map((s) => (
          <Spoke key={s.label} spoke={s} side="left" />
        ))}
      </ul>

      {/* the hub */}
      <div className="order-1 justify-self-center lg:order-2">
        <div className="relative flex size-64 flex-col items-center justify-center rounded-full border-2 border-primary/30 bg-primary/[0.04] p-6 text-center shadow-[0_0_80px_-20px_hsl(var(--primary)/0.5)] sm:size-72">
          {/* orbit ring */}
          <div
            aria-hidden
            className="absolute -inset-3 rounded-full border border-dashed border-primary/20"
          />
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Cog className="size-5" aria-hidden />
          </span>
          <p className="mt-2 text-sm font-bold leading-tight">{hubTitle}</p>
          <ul className="mt-3 list-none space-y-1 p-0 text-[11px] leading-tight text-muted-foreground">
            {hubStages.map((st) => (
              <li key={st} className="flex items-center justify-center gap-1.5">
                <span aria-hidden className="size-1 shrink-0 rounded-full bg-primary/60" />
                {st}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* right spokes */}
      <ul className="order-3 m-0 flex list-none flex-col gap-3 p-0">
        {spokes.filter((_, i) => i % 2 === 1).map((s) => (
          <Spoke key={s.label} spoke={s} side="right" />
        ))}
      </ul>
    </div>
  );
}

function Spoke({ spoke, side }: { spoke: HubSpoke; side: "left" | "right" }) {
  return (
    <li
      className={`flex items-center gap-2 ${side === "left" ? "lg:flex-row-reverse lg:text-right" : ""}`}
    >
      {/* connector toward the hub — desktop only, decorative */}
      <span
        aria-hidden
        className={`hidden h-px w-6 shrink-0 bg-primary/25 lg:block`}
      />
      <span className="flex min-w-0 items-center gap-2 rounded-full border border-border/70 bg-card px-3.5 py-2 shadow-sm">
        <span className="truncate text-sm font-medium">{spoke.label}</span>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">
          {spoke.count}
        </span>
      </span>
    </li>
  );
}
