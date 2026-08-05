"use client";

import { ArrowRight, Check, ScrollText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { GovernanceSpineDiagram } from "@/components/marketing/GovernanceSpineDiagram";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { Button } from "@/components/ui/button";
import { SECURITY_CONTENT as C } from "@/content/marketing/security";

/* Pure renderer: every sentence comes from src/content/marketing/security.ts.
 * Nothing on this page is authored here. */

export default function SecurityContent() {
  return (
    <MarketingShell active="/security">
      {/* hero */}
      <section className="border-b border-border/60">
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <ShieldCheck className="size-3.5" aria-hidden />
            {C.hero.eyebrow}
          </span>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            {C.hero.headline}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            {C.hero.sub}
          </p>
        </div>
      </section>

      {/* the spine diagram */}
      <section className="border-b border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">
            {C.spine.title}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">{C.spine.sub}</p>
          <div className="mt-10">
            <GovernanceSpineDiagram steps={C.spine.steps} />
          </div>
        </div>
      </section>

      {/* pillars */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">{C.pillars.title}</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {C.pillars.items.map(([title, body]) => (
            <div key={title} className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-2">
                <Check className="size-4 text-primary" aria-hidden />
                <h3 className="text-sm font-semibold">{title}</h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* the honesty section — deliberately plain, no decoration */}
      <section className="border-t border-border/60 bg-muted/20">
        <div className="mx-auto max-w-3xl px-6 py-14">
          <div className="flex items-center gap-2">
            <ScrollText className="size-5 text-primary" aria-hidden />
            <h2 className="text-xl font-bold tracking-tight">{C.honesty.title}</h2>
          </div>
          <p className="mt-3 leading-relaxed text-muted-foreground">{C.honesty.body}</p>
        </div>
      </section>

      {/* closing CTA */}
      <section className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h2 className="text-2xl font-bold tracking-tight">{C.cta.title}</h2>
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
