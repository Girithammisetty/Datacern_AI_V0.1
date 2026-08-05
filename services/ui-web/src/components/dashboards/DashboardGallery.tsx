"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, LayoutDashboard, Plus, Search, Star, Upload } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Can } from "@/components/authz/Can";
import { Card, CardHeader, CardTitle, Badge, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { CreateDashboardDialog } from "@/components/charts/CreateDashboardDialog";
import { ImportDashboardDialog } from "@/components/charts/ImportDashboardDialog";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useDashboards } from "@/lib/graphql/hooks";
import { useSession } from "@/lib/session/SessionContext";
import type { Dashboard } from "@/lib/graphql/types";
import {
  pushRecent,
  readRecent,
  useDashboardFavorites,
  type RecentDashboard,
} from "@/lib/dashboards/favorites";
import { t } from "@/lib/i18n/messages";

type SortId = "nameAsc" | "nameDesc" | "recent";

/**
 * Dashboard index with client-side, personal viewer affordances over the same
 * flat list: a name search, a sort control, per-user favorites (a pinned
 * "Favorites" section) and a recently-viewed MRU section. All localStorage per
 * (tenant, user) — honest and personal; the list data itself is unchanged.
 *
 * Note: the dashboards list exposes no updatedAt, so a server "recently updated"
 * sort has nothing to sort on. The recency offered here is this user's own view
 * history (MRU), which is real client-side data rather than a fabricated stamp.
 */
export function DashboardGallery() {
  const { workspaceId, tenantId, userId } = useSession();
  const router = useRouter();
  const query = useDashboards(workspaceId);
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.nodes) ?? [], [query.data]);

  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortId>("nameAsc");

  const { isFavorite, toggle } = useDashboardFavorites(tenantId, userId);

  // Recently-viewed MRU is localStorage — load post-mount so SSR output matches.
  const [recent, setRecent] = useState<RecentDashboard[]>([]);
  useEffect(() => {
    setRecent(readRecent(tenantId, userId));
  }, [tenantId, userId]);

  const recentOrder = useMemo(() => new Map(recent.map((r, i) => [r.id, i])), [recent]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q ? items.filter((d) => (d.title ?? "").toLowerCase().includes(q)) : items;
    const sorted = [...matched];
    sorted.sort((a, b) => {
      if (sort === "recent") {
        const ra = recentOrder.has(a.id) ? recentOrder.get(a.id)! : Number.POSITIVE_INFINITY;
        const rb = recentOrder.has(b.id) ? recentOrder.get(b.id)! : Number.POSITIVE_INFINITY;
        if (ra !== rb) return ra - rb;
        return (a.title ?? "").localeCompare(b.title ?? "");
      }
      const cmp = (a.title ?? "").localeCompare(b.title ?? "");
      return sort === "nameDesc" ? -cmp : cmp;
    });
    return sorted;
  }, [items, search, sort, recentOrder]);

  const favorites = useMemo(() => items.filter((d) => isFavorite(d.id)), [items, isFavorite]);
  const recentItems = useMemo(() => {
    const byId = new Map(items.map((d) => [d.id, d]));
    return recent.map((r) => byId.get(r.id)).filter((d): d is Dashboard => d != null);
  }, [items, recent]);

  const onOpen = (d: Dashboard) => setRecent(pushRecent(tenantId, userId, { id: d.id, title: d.title }));

  const card = (d: Dashboard) => (
    <DashboardCard
      key={d.id}
      dashboard={d}
      favorite={isFavorite(d.id)}
      onToggleFavorite={() => toggle(d.id)}
      onOpen={() => onOpen(d)}
    />
  );

  return (
    <div>
      <PageHeader
        title={t("dashboards.title")}
        description={t("dashboards.subtitle")}
        actions={
          <>
            <Can gate={FEATURE_GATES.importDashboard}>
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Upload /> Import
              </Button>
            </Can>
            <Can gate={FEATURE_GATES.createDashboard}>
              <Button onClick={() => setCreating(true)}>
                <Plus /> {t("dashboards.create")}
              </Button>
            </Can>
          </>
        }
      />

      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={items.length === 0}
        emptyTitle={t("dashboards.empty")}
        emptyCta={
          <Can gate={FEATURE_GATES.createDashboard}>
            <Button className="mt-2" onClick={() => setCreating(true)}>
              <Plus /> {t("dashboards.create")}
            </Button>
          </Can>
        }
        onRetry={() => query.refetch()}
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("dashboards.searchPlaceholder")}
              aria-label={t("dashboards.search")}
              className="h-9 w-64 pl-8"
            />
          </div>
          <label className="sr-only" htmlFor="dashboard-sort">
            {t("dashboards.sort")}
          </label>
          <select
            id="dashboard-sort"
            aria-label={t("dashboards.sort")}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="nameAsc">{t("dashboards.sort.nameAsc")}</option>
            <option value="nameDesc">{t("dashboards.sort.nameDesc")}</option>
            <option value="recent">{t("dashboards.sort.recent")}</option>
          </select>
        </div>

        {favorites.length > 0 && (
          <section className="mb-6" aria-label={t("dashboards.favorites")}>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <Star className="size-4 fill-current" aria-hidden /> {t("dashboards.favorites")}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{favorites.map(card)}</div>
          </section>
        )}

        {recentItems.length > 0 && (
          <section className="mb-6" aria-label={t("dashboards.recentlyViewed")}>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <Clock className="size-4" aria-hidden /> {t("dashboards.recentlyViewed")}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{recentItems.map(card)}</div>
          </section>
        )}

        <section aria-label={t("dashboards.allDashboards")}>
          {(favorites.length > 0 || recentItems.length > 0) && (
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">{t("dashboards.allDashboards")}</h2>
          )}
          {filtered.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t("dashboards.noSearchMatch", { q: search })}
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{filtered.map(card)}</div>
          )}
        </section>
      </AsyncBoundary>

      <CreateDashboardDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(cid) => {
          setCreating(false);
          router.push(`/dashboards/${cid}`);
        }}
      />
      <ImportDashboardDialog
        open={importing}
        onOpenChange={setImporting}
        onImported={(iid) => {
          setImporting(false);
          router.push(`/dashboards/${iid}`);
        }}
      />
    </div>
  );
}

function DashboardCard({
  dashboard,
  favorite,
  onToggleFavorite,
  onOpen,
}: {
  dashboard: Dashboard;
  favorite: boolean;
  onToggleFavorite: () => void;
  onOpen: () => void;
}) {
  return (
    <Card className="relative h-full transition-colors hover:bg-accent/40">
      {/* Stretched link: the whole card navigates; the star sits above it. */}
      <Link
        href={`/dashboards/${dashboard.id}`}
        aria-label={dashboard.title}
        onClick={onOpen}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />
      <CardHeader>
        <div className="flex items-center gap-2 text-muted-foreground">
          <LayoutDashboard className="size-4" aria-hidden />
          {dashboard.module && <Badge variant="secondary">{dashboard.module}</Badge>}
        </div>
        <CardTitle className="text-base">{dashboard.title}</CardTitle>
      </CardHeader>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleFavorite();
        }}
        aria-pressed={favorite}
        aria-label={favorite ? t("dashboards.removeFavorite") : t("dashboards.addFavorite")}
        title={favorite ? t("dashboards.removeFavorite") : t("dashboards.addFavorite")}
        className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Star className={favorite ? "size-4 fill-current text-amber-500" : "size-4"} aria-hidden />
      </button>
    </Card>
  );
}
