"use client";

import { ArrowRight, Check, Layers, Library, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { PackHubDiagram } from "@/components/marketing/PackHubDiagram";
import { Button } from "@/components/ui/button";
import {
  MARKETING_PACKS,
  PACK_INDUSTRIES,
  SOLUTION_PACK_COUNT,
} from "@/content/marketing/packs.gen";
import { SOLUTIONS_CONTENT as C } from "@/content/marketing/solutions";

/* Pure renderer: every sentence comes from src/content/marketing/solutions.ts
 * and every catalog entry from packs.gen.ts (generated from the shipped pack
 * manifests). Nothing on this page is authored here. */

const REG_LABELS: Record<string, string> = {
  // A few regulator tags whose raw slugs would read poorly; anything unmapped
  // renders as its slug in uppercase, which is honest if less pretty.
  reg_e: "Reg E", reg_z: "Reg Z", cfpb: "CFPB", fcra: "FCRA", hipaa: "HIPAA",
  sox_icfr: "SOX", ofac_sanctions: "OFAC", bsa_aml: "BSA/AML", coso: "COSO",
};

function regChip(tag: string): string {
  return REG_LABELS[tag] ?? tag.replace(/_/g, " ").toUpperCase();
}

export default function SolutionsContent() {
  const solutions = MARKETING_PACKS.filter((p) => p.kind === "solution");
  const libraries = MARKETING_PACKS.filter((p) => p.kind === "library");
  const spokes = PACK_INDUSTRIES.map((ind) => ({
    label: ind,
    count: solutions.filter((p) => p.industry === ind).length,
  })).filter((s) => s.count > 0);

  return (
    <MarketingShell active="/solutions">
      {/* hero */}
      <section className="border-b border-border/60">
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <Sparkles className="size-3.5" aria-hidden />
            {C.hero.eyebrow}
          </span>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            {C.hero.headline.replace("{count}", String(SOLUTION_PACK_COUNT))}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            {C.hero.sub}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href={C.hero.ctaPrimary.href}>
                {C.hero.ctaPrimary.label} <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={C.hero.ctaSecondary.href}>{C.hero.ctaSecondary.label}</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* the hub diagram — one engine, many queues */}
      <section className="border-b border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">
            {C.engine.title}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            {C.engine.sub}
          </p>
          <div className="mt-10">
            <PackHubDiagram
              spokes={spokes}
              hubTitle="The governed decision engine"
              hubStages={C.engine.spokes}
            />
          </div>
        </div>
      </section>

      {/* what a pack installs */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">{C.howPacksWork.title}</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">{C.howPacksWork.body}</p>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {C.howPacksWork.items.map(([title, body]) => (
            <div key={title} className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-2">
                <Check className="size-4 text-primary" aria-hidden />
                <h3 className="text-sm font-semibold">{title}</h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/[0.04] p-4 text-sm leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span>{C.howPacksWork.note}</span>
        </p>
      </section>

      {/* the catalog, grouped by industry */}
      <section className="border-t border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">{C.catalog.title}</h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">{C.catalog.sub}</p>

          {PACK_INDUSTRIES.map((ind) => {
            const packs = solutions.filter((p) => p.industry === ind);
            if (packs.length === 0) return null;
            return (
              <div key={ind} className="mt-10">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-lg font-semibold">{ind}</h3>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {packs.length} {packs.length === 1 ? "pack" : "packs"}
                  </span>
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {packs.map((p) => (
                    <article
                      key={p.slug}
                      className="flex h-full flex-col rounded-xl border border-border/60 bg-card p-5 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="text-sm font-semibold leading-snug">{p.title}</h4>
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                          v{p.version}
                        </span>
                      </div>
                      <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                        {p.blurb}.
                      </p>
                      {p.regulatory.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {p.regulatory.slice(0, 4).map((r) => (
                            <span
                              key={r}
                              className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                            >
                              {regChip(r)}
                            </span>
                          ))}
                          {p.regulatory.length > 4 && (
                            <span className="px-1 text-[10px] text-muted-foreground">
                              +{p.regulatory.length - 4}
                            </span>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            );
          })}

          {libraries.length > 0 && (
            <div className="mt-12">
              <div className="flex items-center gap-2">
                <Library className="size-4 text-muted-foreground" aria-hidden />
                <h3 className="text-lg font-semibold">Foundations</h3>
              </div>
              <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
                {C.catalog.libraryNote}
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {libraries.map((p) => (
                  <article
                    key={p.slug}
                    className="flex h-full flex-col rounded-xl border border-dashed border-border/70 bg-card/60 p-5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-sm font-semibold leading-snug">{p.title}</h4>
                      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                        v{p.version}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.blurb}.</p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* closing CTA */}
      <section className="mx-auto max-w-3xl px-6 py-16 text-center">
        <Layers className="mx-auto size-8 text-primary" aria-hidden />
        <h2 className="mt-4 text-2xl font-bold tracking-tight">{C.cta.title}</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{C.cta.body}</p>
        <Button asChild size="lg" className="mt-6">
          <Link href={C.cta.action.href}>
            {C.cta.action.label} <ArrowRight className="size-4" />
          </Link>
        </Button>
      </section>
    </MarketingShell>
  );
}
