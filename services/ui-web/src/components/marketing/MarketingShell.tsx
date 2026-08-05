"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { DatacernLogo } from "@/components/brand/DatacernLogo";
import { Button } from "@/components/ui/button";

/** Shared header/footer for the secondary marketing pages (/solutions,
 * /security). /welcome and /pricing keep their bespoke shells; this exists so
 * new pages get consistent chrome without duplicating it per page. Links are
 * config, not hard-coded per page. */

const NAV: Array<{ label: string; href: string }> = [
  { label: "Overview", href: "/welcome" },
  { label: "Solutions", href: "/solutions" },
  { label: "Security", href: "/security" },
  { label: "Pricing", href: "/pricing" },
];

export function MarketingShell({
  active,
  children,
}: {
  active: "/solutions" | "/security";
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/welcome" className="flex items-center gap-2">
            <DatacernLogo className="size-6" />
            <span className="text-sm font-semibold">Datacern AI</span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            {NAV.map((n) => (
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
            <Button asChild size="sm" className="ml-2">
              <Link href="/live-demo">
                Live demo <ArrowRight className="size-4" />
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      {children}

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>Datacern AI — governed AI for regulated operations</span>
          <span>AI proposes. A named person approves. The platform remembers.</span>
        </div>
      </footer>
    </main>
  );
}
