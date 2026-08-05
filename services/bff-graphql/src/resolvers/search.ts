/**
 * BRD 74 D3 — cross-service search, as a STATELESS fan-out.
 *
 * The BRD originally specced a `search_entries` projection table inside this
 * service, fed by Kafka consumers. That design does not survive contact with
 * the code: bff-graphql has no database, no event consumer and no cache **by
 * enforced policy** (see eslint.config.js's three `no-restricted-imports` bans
 * and `db: ~` / `migrate: false` in deploy/services.yaml), and it makes no
 * authorization decision in any resolver — five downstream services do.
 *
 * So this does the thing the BFF is actually for: one call per requested
 * entity type, to the service that OWNS that data, using that service's own
 * text search, with the caller's JWT forwarded verbatim. Consequences that
 * matter and are not accidents:
 *
 *   - Freshness is the source's. There is no projection to fall behind, and
 *     no delete event to miss (which is why AC-6/AC-7 stopped applying).
 *   - Authorization stays downstream. A leg the caller may not read answers
 *     403; that leg reports `denied: true` and contributes nothing. The BFF
 *     decides nothing — it OBSERVES the decision the owning service made.
 *   - One slow or broken service degrades one leg, not the query: every leg
 *     is settled independently and its failure is reported, never swallowed.
 */
import type { GraphQLContext } from "../context.js";
import { DownstreamError, statusToCode, ErrorCode } from "../errors/errors.js";
import { urn } from "../schema/map.js";

export const SEARCH_ENTITY_TYPES = [
  "DATASET",
  "DASHBOARD",
  "CHART",
  "PIPELINE",
  "EXPERIMENT",
  "MODEL",
  "CASE",
  "DECISION_MODEL",
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/** Types chart-service can only answer inside one workspace: `chart.*` grants
 * are workspace-scoped, so its list/search routes require workspace_id. */
const WORKSPACE_REQUIRED: ReadonlySet<SearchEntityType> = new Set(["DASHBOARD", "CHART"]);

export const WORKSPACE_REQUIRED_ERROR = "WORKSPACE_REQUIRED";

export interface SearchHit {
  key: string;
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle: string | null;
  urn: string | null;
  workspaceId: string | null;
  parentId: string | null;
}

export interface SearchTypeResult {
  type: SearchEntityType;
  hits: SearchHit[];
  denied: boolean;
  error: string | null;
}

export interface SearchResults {
  q: string;
  types: SearchTypeResult[];
  hits: SearchHit[];
}

export interface SearchArgs {
  q: string;
  types?: SearchEntityType[] | null;
  workspaceId?: string | null;
  first?: number | null;
}

/** Per-type cap. `first` bounds EACH leg; the aggregate is types × first. */
const DEFAULT_FIRST = 10;
const MAX_FIRST = 50;

function hit(
  type: SearchEntityType,
  id: string,
  title: string,
  extra: {
    subtitle?: string | null;
    urn?: string | null;
    workspaceId?: string | null;
    parentId?: string | null;
  } = {},
): SearchHit {
  return {
    // Ids are only unique per owning service, so the client-side key has to
    // carry the type as well (two services can both mint "1").
    key: `${type}:${id}`,
    id,
    type,
    title,
    subtitle: extra.subtitle ?? null,
    urn: extra.urn ?? null,
    workspaceId: extra.workspaceId ?? null,
    parentId: extra.parentId ?? null,
  };
}

/** Find a DownstreamError anywhere in an error's cause chain (mirrors server.ts). */
function findDownstream(err: unknown): DownstreamError | undefined {
  let cur: any = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof DownstreamError) return cur;
    cur = cur.originalError ?? cur.cause;
  }
  return undefined;
}

/**
 * One leg's downstream call, per entity type. Each returns at most `limit`
 * hits and does exactly ONE downstream request — no nested hydration, because
 * a jump-to list needs a label, not an object graph.
 */
async function fetchLeg(
  type: SearchEntityType,
  ctx: GraphQLContext,
  q: string,
  limit: number,
  workspaceId: string | undefined,
): Promise<SearchHit[]> {
  switch (type) {
    case "DATASET": {
      // dataset-service Postgres FTS with ts_rank.
      const page = await ctx.clients.dataset.datasets({ q, limit });
      return (page.data ?? []).map((d) =>
        hit("DATASET", d.id, d.name, {
          subtitle: d.description ?? null,
          urn: urn(ctx, "dataset", "dataset", d.id),
          workspaceId: d.workspace_id ?? null,
        }),
      );
    }
    case "DASHBOARD": {
      // chart-service GET /dashboards?q= (BRD 74 D3 added `q`).
      const page = await ctx.clients.chart.dashboards(workspaceId!, limit, undefined, false, q);
      return (page.data ?? []).map((d) =>
        hit("DASHBOARD", d.id, d.title ?? d.name ?? d.id, {
          subtitle: d.module ?? null,
          urn: urn(ctx, "chart", "dashboard", d.id),
          workspaceId: d.workspace_id ?? workspaceId ?? null,
        }),
      );
    }
    case "CHART": {
      // chart-service GET /charts (BRD 74 D2).
      const page = await ctx.clients.chart.searchCharts({ workspaceId: workspaceId!, q, limit });
      return (page.data ?? []).map((c) =>
        hit("CHART", c.id, c.name ?? c.id, {
          // The dashboard is the actionable part of a chart hit.
          subtitle: c.dashboard_name ?? null,
          urn: urn(ctx, "chart", "chart", c.id),
          workspaceId: workspaceId ?? null,
          // A chart is not independently addressable in the UI — you open the
          // dashboard it lives on. That id IS the answer to "where is it".
          parentId: c.dashboard_id ?? null,
        }),
      );
    }
    case "PIPELINE": {
      // pipeline-orchestrator GET /pipelines?filter[name]= (a real ILIKE).
      const page = await ctx.clients.pipelines.pipelines({ name: q, limit });
      return (page.data ?? []).map((t) =>
        hit("PIPELINE", t.id, t.name, {
          subtitle: t.pipeline_type ?? null,
          urn: urn(ctx, "pipeline", "template", t.id),
          workspaceId: t.workspace_id ?? null,
        }),
      );
    }
    case "EXPERIMENT": {
      // experiment-service GET /experiments?q= (BRD 74 D3 added `q`).
      const page = await ctx.clients.experiment.experiments(limit, undefined, q);
      return (page.data ?? []).map((e) =>
        hit("EXPERIMENT", e.id, e.name ?? e.id, {
          subtitle: e.description ?? null,
          urn: urn(ctx, "experiment", "experiment", e.id),
        }),
      );
    }
    case "MODEL": {
      // experiment-service GET /models?q= (BRD 74 D3 added `q`).
      const page = await ctx.clients.experiment.models({ q, limit });
      return (page.data ?? []).map((m) =>
        hit("MODEL", m.id, m.name ?? m.id, {
          subtitle: m.model_type ?? null,
          urn: m.urn ?? urn(ctx, "experiment", "model", m.id),
        }),
      );
    }
    case "CASE": {
      // case-service OpenSearch.
      const page = await ctx.clients.case.search({ q, limit });
      return (page.data ?? []).map((c) =>
        hit("CASE", c.id, c.title ?? (c.case_number != null ? `Case #${c.case_number}` : c.id), {
          subtitle: c.status ?? null,
          urn: urn(ctx, "case", "case", c.id),
          workspaceId: c.workspace_id ?? null,
        }),
      );
    }
    case "DECISION_MODEL": {
      // agent-runtime GET /decision-models?q= (BRD 74 D3 added `q` + paging).
      const page = await ctx.clients.agent.decisionModels({ q, limit });
      return (page.data ?? []).map((m) =>
        hit("DECISION_MODEL", m.id, m.name, {
          subtitle: `v${m.version}${m.status ? ` · ${m.status}` : ""}`,
          workspaceId: m.workspace_id ?? null,
        }),
      );
    }
  }
}

/**
 * Run the fan-out. Every leg is settled independently: a leg that throws is
 * classified (PERMISSION_DENIED → `denied`, anything else → its stable error
 * code) and reported, so a caller can always distinguish "no matches" from
 * "you may not read this" from "that service is down".
 */
export async function searchFanOut(ctx: GraphQLContext, args: SearchArgs): Promise<SearchResults> {
  const q = (args.q ?? "").trim();
  const requested: SearchEntityType[] =
    args.types && args.types.length > 0
      ? SEARCH_ENTITY_TYPES.filter((t) => args.types!.includes(t))
      : [...SEARCH_ENTITY_TYPES];

  const limit = Math.min(Math.max(args.first ?? DEFAULT_FIRST, 1), MAX_FIRST);
  const workspaceId = args.workspaceId ?? undefined;

  // An empty term is not an error and is not "match everything": every leg
  // reports zero hits, and no downstream is called at all.
  if (q === "") {
    const types = requested.map<SearchTypeResult>((type) => ({
      type, hits: [], denied: false, error: null,
    }));
    return { q, types, hits: [] };
  }

  const settled = await Promise.all(
    requested.map(async (type): Promise<SearchTypeResult> => {
      if (WORKSPACE_REQUIRED.has(type) && !workspaceId) {
        return { type, hits: [], denied: false, error: WORKSPACE_REQUIRED_ERROR };
      }
      try {
        return { type, hits: await fetchLeg(type, ctx, q, limit, workspaceId), denied: false, error: null };
      } catch (e) {
        const ds = findDownstream(e);
        const code = ds ? statusToCode(ds.httpStatus, ds.downstreamCode) : ErrorCode.INTERNAL;
        return {
          type,
          hits: [],
          denied: code === ErrorCode.PERMISSION_DENIED,
          error: code === ErrorCode.PERMISSION_DENIED ? null : code,
        };
      }
    }),
  );

  return { q, types: settled, hits: settled.flatMap((r) => r.hits) };
}
