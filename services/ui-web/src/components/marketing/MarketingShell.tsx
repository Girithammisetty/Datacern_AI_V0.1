"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { DatacernLogo } from "@/components/brand/DatacernLogo";
import { Button } from "@/components/ui/button";
import { MARKETING_SHELL, type MarketingNavHref } from "@/content/marketing/shell";

/** Shared chrome + design system for every pre-login marketing page
 * (/welcome, /solutions, /security, /pricing, /welcome/walkthrough).
 *
 * The shell owns:
 *  - header/footer rendered from MARKETING_SHELL config (never per-page),
 *  - the page-wide backdrop (grid + drifting aurora, all drawn from the app's
 *    theme tokens so light AND dark mode work),
 *  - the mk- animation/effect CSS (reveal, float, marquee, glass cards,
 *    gradient ring, gradient text) that pages compose for a rich, consistent
 *    look. prefers-reduced-motion disables every animation.
 */

export function MarketingShell({
  active,
  children,
}: {
  active: MarketingNavHref;
  children: React.ReactNode;
}) {
  return (
    <main className="relative isolate min-h-screen bg-background text-foreground">
      <style>{MK_CSS}</style>

      {/* page-wide backdrop: gradient wash + subtle grid + drifting aurora */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(80rem_50rem_at_50%_-10%,hsl(var(--primary)/0.10),transparent_60%)]" />
        <div className="mk-grid absolute inset-0" />
        <div className="mk-aurora absolute -top-40 left-1/2 h-[34rem] w-[64rem] -translate-x-1/2 rounded-full opacity-50" />
      </div>

      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/welcome" className="flex items-center gap-2">
            <DatacernLogo className="size-6" />
            <span className="text-sm font-semibold">{MARKETING_SHELL.product}</span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            {MARKETING_SHELL.nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.href === active ? "page" : undefined}
                className={`rounded-md px-2 py-1 text-sm transition-colors ${
                  n.href === active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {n.label}
              </Link>
            ))}
            <Link
              href={MARKETING_SHELL.signIn.href}
              className="hidden rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              {MARKETING_SHELL.signIn.label}
            </Link>
            <Button asChild size="sm" className="ml-2">
              <Link href={MARKETING_SHELL.liveDemoCta.href}>
                {MARKETING_SHELL.liveDemoCta.label} <ArrowRight className="size-4" />
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      {children}

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>{MARKETING_SHELL.footer.left}</span>
          <span>{MARKETING_SHELL.footer.right}</span>
        </div>
      </footer>
    </main>
  );
}

/* Shared marketing effects. Everything is drawn from theme tokens
 * (hsl(var(--primary)) etc.) so the same CSS works in light and dark mode —
 * no per-page palette overrides. mk- prefix avoids collisions with app CSS. */
const MK_CSS = `
.mk-reveal{opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease;}
.mk-in{opacity:1;transform:none;}
.mk-float{animation:mk-float 6s ease-in-out infinite;}
@keyframes mk-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.mk-pulse{animation:mk-pulse 1.8s ease-in-out infinite;}
@keyframes mk-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.mk-grow{width:0;animation:mk-grow 1.4s .3s cubic-bezier(.2,.8,.2,1) forwards;}
@keyframes mk-grow{to{width:82%}}
.mk-swap{animation:mk-swap .5s ease;}
@keyframes mk-swap{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.mk-rise{transform-origin:bottom;animation:mk-rise .9s cubic-bezier(.2,.8,.2,1) both;}
@keyframes mk-rise{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.mk-marquee-wrap{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);}
.mk-marquee{width:max-content;animation:mk-marquee 26s linear infinite;}
@keyframes mk-marquee{to{transform:translateX(-50%)}}
.mk-mesh{background:
  radial-gradient(55rem 42rem at 10% -12%, hsl(var(--primary) / 0.16), transparent 60%),
  radial-gradient(46rem 40rem at 92% -8%, hsl(var(--primary) / 0.10), transparent 58%),
  radial-gradient(50rem 44rem at 58% 6%, hsl(var(--primary) / 0.08), transparent 62%);}
.mk-grid{background-image:
  linear-gradient(hsl(var(--primary) / 0.05) 1px, transparent 1px),
  linear-gradient(90deg, hsl(var(--primary) / 0.05) 1px, transparent 1px);
  background-size:54px 54px;
  -webkit-mask-image:radial-gradient(120% 90% at 50% -5%, #000, transparent 72%);
  mask-image:radial-gradient(120% 90% at 50% -5%, #000, transparent 72%);}
.mk-aurora{background:linear-gradient(115deg,
  hsl(var(--primary) / 0.35), hsl(var(--primary) / 0.18), hsl(var(--primary) / 0.28), hsl(var(--primary) / 0.35));
  background-size:300% 300%;filter:blur(64px);animation:mk-aurora 20s ease infinite;}
@keyframes mk-aurora{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.mk-glass{background:hsl(var(--card));border:1px solid hsl(var(--primary) / 0.14);}
.mk-glow{box-shadow:0 1px 2px hsl(var(--foreground) / 0.04), 0 24px 70px -28px hsl(var(--primary) / 0.28);}
.mk-ring{position:relative;}
.mk-ring::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(140deg, hsl(var(--primary) / 0.35), transparent 45%, hsl(var(--primary) / 0.25));
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}
.mk-grad{background-image:linear-gradient(100deg, hsl(var(--primary)), hsl(var(--primary) / 0.75), hsl(var(--primary)));
  background-clip:text;-webkit-background-clip:text;color:transparent;}
@media (prefers-reduced-motion: reduce){
  .mk-float,.mk-pulse,.mk-grow,.mk-marquee,.mk-swap,.mk-aurora,.mk-rise{animation:none!important;}
  .mk-reveal{opacity:1!important;transform:none!important;}
  .mk-grow{width:82%;}
}
`;
