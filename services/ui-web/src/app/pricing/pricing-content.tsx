"use client";

import { ArrowRight, Check, Gauge, Layers, MessageSquareText, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";

import { MarketingShell } from "@/components/marketing/MarketingShell";
import { Button } from "@/components/ui/button";
import { PRICING_CONTENT as C } from "@/content/marketing/pricing";

/* Pure renderer: every sentence comes from src/content/marketing/pricing.ts.
 * NO prices are rendered anywhere on this page — the levers and the hard
 * budget cap are explained, and the visitor is asked to contact us for a
 * quote. (The real billing math stays unit-tested in src/lib/pricing/calc.ts;
 * it just isn't previewed here with placeholder rates anymore.) */

const LEVER_ICONS = [Gauge, Users, Layers] as const;

export default function PricingContent() {
  return (
    <MarketingShell active="/pricing">
      {/* hero — lead with the budget-cap differentiator */}
      <section className="border-b border-border/60">
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            <ShieldCheck className="size-3.5" aria-hidden /> {C.hero.eyebrow}
          </span>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            {C.hero.headline}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            {C.hero.sub}
          </p>
        </div>
      </section>

      {/* the levers — what drives cost, with no rates attached */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-center text-2xl font-bold tracking-tight">{C.levers.title}</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">{C.levers.sub}</p>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          {C.levers.items.map(([title, body], i) => {
            const Icon = LEVER_ICONS[i] ?? Gauge;
            return (
              <div key={title} className="rounded-xl border border-border/60 bg-card p-5">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="mt-3 text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            );
          })}
        </div>
        {/* the differentiator */}
        <div className="mt-5 rounded-xl border border-primary/30 bg-primary/[0.03] p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-primary" aria-hidden />
            {C.levers.cap.title}
          </h3>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{C.levers.cap.body}</p>
        </div>
      </section>

      {/* contact-first — no rate card, a quote from your volumes */}
      <section className="border-t border-border/60 bg-card/40">
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <MessageSquareText className="size-5" aria-hidden />
          </span>
          <h2 className="mt-4 text-2xl font-bold tracking-tight md:text-3xl">{C.contact.title}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
            {C.contact.body}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href={C.contact.action.href}>
                {C.contact.action.label} <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={C.contact.secondary.href}>{C.contact.secondary.label}</Link>
            </Button>
          </div>
          <p className="mx-auto mt-5 max-w-xl text-xs text-muted-foreground">{C.contact.note}</p>
        </div>
      </section>

      {/* what's always included */}
      <section className="border-t border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold tracking-tight">{C.included.title}</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {C.included.items.map(([title, body]) => (
              <div key={title} className="rounded-xl border border-border/60 bg-card p-5">
                <div className="flex items-center gap-2">
                  <Check className="size-4 text-primary" aria-hidden />
                  <h3 className="text-sm font-semibold">{title}</h3>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* pricing FAQ */}
      <section className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-center text-2xl font-bold tracking-tight">{C.faq.title}</h2>
        <div className="mt-8 space-y-4">
          {C.faq.items.map(([q, a]) => (
            <div key={q} className="rounded-xl border border-border/60 bg-card p-5">
              <h3 className="text-sm font-semibold">{q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{a}</p>
            </div>
          ))}
        </div>
      </section>
    </MarketingShell>
  );
}
