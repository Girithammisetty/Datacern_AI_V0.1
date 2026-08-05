"use client";

import { Bot, FileSignature, KeyRound, ScrollText, UserCheck } from "lucide-react";

/** The governance spine, drawn as the request path it actually is.
 *
 * Same construction discipline as DecisionLoopDiagram: real text in flex cards
 * with CSS connectors (legible, translatable, screen-readable, reflows on a
 * phone) rather than one opaque SVG. The human gate is the only elevated card
 * — the claim is "a person stands between AI and execution", so the eye must
 * land on the person. Content arrives as props from the page's content config;
 * this component owns only the drawing.
 */

export interface SpineStep {
  kicker: string;
  title: string;
  body: string;
}

const ICONS = [Bot, UserCheck, FileSignature, KeyRound, ScrollText];
/** index of the human gate — the visually elevated station */
const GATE = 1;

export function GovernanceSpineDiagram({ steps }: { steps: readonly SpineStep[] }) {
  return (
    <figure className="m-0">
      <ol className="flex list-none flex-col gap-5 p-0 lg:flex-row lg:gap-4">
        {steps.map((s, i) => {
          const Icon = ICONS[i % ICONS.length];
          const isGate = i === GATE;
          return (
            <li key={s.kicker} className="relative flex-1">
              <div
                className={`flex h-full flex-col rounded-2xl border p-5 ${
                  isGate
                    ? "border-primary/40 bg-primary/[0.05] shadow-[0_18px_50px_-24px_hsl(var(--primary)/0.55)] lg:-mt-2 lg:pb-7 lg:pt-7"
                    : "border-border/60 bg-card shadow-sm"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ${
                      isGate
                        ? "bg-primary text-primary-foreground ring-primary/30"
                        : "bg-primary/10 text-primary ring-primary/20"
                    }`}
                  >
                    <Icon className="size-[18px]" aria-hidden />
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.kicker}
                  </span>
                </div>
                <h3 className="mt-3 text-[15px] font-semibold leading-snug">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                {isGate && (
                  <p className="mt-3 border-t border-primary/15 pt-3 text-[13px] font-medium text-primary">
                    No self-approval. Four-eyes on sensitive actions.
                  </p>
                )}
              </div>
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  className="absolute -right-4 top-1/2 hidden h-px w-4 -translate-y-1/2 bg-primary/25 lg:block"
                >
                  <span className="absolute -right-px -top-[3px] size-[7px] rotate-45 border-r border-t border-primary/40" />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <figcaption className="mt-6 text-center text-sm text-muted-foreground">
        There is no second path: agents hold no credentials to your systems — execution
        exists only on the far side of an approval and its signed grant.
      </figcaption>
    </figure>
  );
}
