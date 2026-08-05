"use client";
import { usePathname } from "next/navigation";
import { Breadcrumbs, BackLink } from "./Breadcrumbs";
import { crumbsFor, hasTrail, backTargetFor } from "@/lib/nav/breadcrumbs";

/**
 * The standard page heading — and, because ~all 83 app pages render it, the one
 * place backward navigation had to land. It derives the breadcrumb trail from
 * the live pathname, so every nested route (`/ml/eval/runs/{id}`,
 * `/admin/audit/events/{id}`, …) gets a way back without touching the page.
 *
 * The trail renders only when there is a real ancestor above Home (`hasTrail`),
 * so top-level destinations stay clean, and record pages additionally get a
 * compact "← Parent" link since a trail is easy to miss above a title.
 *
 * `breadcrumbLabel` lets a detail page name the record it is showing (a case
 * title, a dashboard name) when `title` is not that name; `breadcrumbs={false}`
 * opts a page out entirely.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbLabel,
  breadcrumbs,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Human name of the current record, used as the last crumb. Defaults to `title`. */
  breadcrumbLabel?: string;
  /** Pass `false` to suppress the trail and back link on this page. */
  breadcrumbs?: false;
}) {
  // `usePathname()` is null outside an App Router context (e.g. an isolated
  // unit test render) — treat that as "no trail" rather than guessing a route.
  const pathname = usePathname();
  const enabled = breadcrumbs !== false && !!pathname;
  const crumbs = enabled ? crumbsFor(pathname, { currentLabel: breadcrumbLabel ?? title }) : [];
  const showTrail = enabled && hasTrail(crumbs);
  const back = showTrail ? backTargetFor(pathname, crumbs) : undefined;

  return (
    <div className="mb-4">
      {showTrail && <Breadcrumbs crumbs={crumbs} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {back && <BackLink crumb={back} className="mb-0.5" />}
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
