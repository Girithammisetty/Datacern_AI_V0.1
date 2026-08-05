"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n/messages";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import type { Crumb } from "@/lib/nav/breadcrumbs";

/**
 * The breadcrumb trail rendered above a page title (`Home / Group / Section /
 * Current`). Purely presentational: `crumbsFor()` decides what the steps are,
 * this decides how they look.
 *
 * Two rules it owns:
 *  - the LAST crumb is never a link and carries `aria-current="page"`;
 *  - a crumb the viewer's capabilities do not unlock degrades to plain text
 *    rather than offering a link into a route the guard would bounce them from.
 *    Fail-closed like the Sidebar: until `useCapabilities()` resolves, gated
 *    crumbs read as text.
 */
export function Breadcrumbs({ crumbs, className }: { crumbs: Crumb[]; className?: string }) {
  const { can } = useCapabilities();
  if (crumbs.length === 0) return null;

  return (
    <nav aria-label={t("breadcrumb.ariaLabel")} className={cn("mb-1", className)}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          const linked = !!crumb.href && !last && !crumb.current && (!crumb.gate || can(crumb.gate));
          return (
            <li key={crumb.key} className="flex min-w-0 items-center gap-x-1.5">
              {i > 0 && (
                <span aria-hidden className="select-none opacity-50">
                  /
                </span>
              )}
              {linked ? (
                <Link
                  href={crumb.href as string}
                  title={crumb.label}
                  data-crumb={crumb.key}
                  className="max-w-[14rem] truncate rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  title={crumb.label}
                  data-crumb={crumb.key}
                  aria-current={last ? "page" : undefined}
                  className={cn("max-w-[14rem] truncate", last && "font-medium text-foreground")}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * A single compact "← Parent" link for record pages, where the trail alone is
 * easy to miss. Rendered by `PageHeader` only when the route's final segment is
 * a runtime id (see `backTargetFor`), and hidden entirely when the viewer's
 * capabilities do not unlock the parent — same fail-closed rule as the trail.
 */
export function BackLink({ crumb, className }: { crumb: Crumb; className?: string }) {
  const { can } = useCapabilities();
  if (!crumb.href || (crumb.gate && !can(crumb.gate))) return null;

  return (
    <Link
      href={crumb.href}
      data-back-link
      aria-label={t("breadcrumb.backTo", { label: crumb.label })}
      className={cn(
        "inline-flex max-w-full items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{crumb.label}</span>
    </Link>
  );
}
