/**
 * BRD 74 AC-10 — the `search.query` MCP backend facade.
 *
 * tool-plane's mcp-gateway federates a tools/call to the owning service's
 * backend facade. For almost every tool that facade answers out of its OWN
 * store, so the gateway sends attribution only and the facade re-authorizes
 * `obo_sub` against its own OPA sidecar. `search` has no store: the ONLY way it
 * can answer is by asking the eight owning services, exactly as the GraphQL
 * `search()` field does — which is why it lives here and nowhere else.
 *
 * That is possible now because the gateway forwards the caller's VERIFIED token
 * to a facade whose registered tool version DECLARES its downstream actions
 * (tool-plane internal/domain/delegation.go). This module therefore adds NO new
 * authority to the BFF:
 *
 *   - It mints nothing and holds no key. It runs `searchFanOut` over a context
 *     built from the FORWARDED caller token, the same way /graphql does
 *     (BFF-FR-010).
 *   - It decides nothing. Every leg's 403 comes from the owning service and is
 *     reported as `denied` (BFF-FR-011 / BRD 74 AC-8).
 *   - It stores nothing. No DB, no consumer, no cache — the three bans in
 *     eslint.config.js and `db: ~` / `migrate: false` in deploy/services.yaml
 *     hold unchanged.
 *
 * Consequently the answer this route gives a principal is BY CONSTRUCTION the
 * answer `POST /graphql { search(...) }` gives the same principal: one function,
 * one context builder, one set of downstream calls.
 *
 * Two gates guard the route, and both fail closed:
 *
 *  1. Peer identity. bff-graphql is the platform's one publicly-routed pod, so
 *     the facade is DISABLED unless BFF_FACADE_ALLOWED_SPIFFE names the peers
 *     that may call it (mirrors case-service / fhir-bridge). Unset ⇒ 403.
 *  2. Caller identity. The forwarded bearer must verify, and the request's
 *     `tenant` / `obo_sub` must MATCH that token — the facade never takes the
 *     gateway's word for who the caller is. A tenant mismatch is a 404, never a
 *     403 (MASTER-FR-003: a 403 confirms existence).
 *
 * Neither gate can be relaxed into an empty result: a refusal is an error
 * envelope with a reason, so "you may not" is never rendered as "no matches".
 */
import type http from "node:http";
import type { Config } from "../config.js";
import type { JwksResolver } from "../auth/jwt.js";
import type { FetchImpl } from "../clients/base.js";
import { buildContext } from "../context.js";
import {
  searchFanOut,
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchArgs,
} from "../resolvers/search.js";

/** The tool-plane backend-facade route (docs/DATACERN_MCP_CONNECTIVITY.md). */
const FACADE_PATH = "/internal/v1/mcp/invoke";

/** The one tool this facade serves. An unknown tool_id is a 404, not a guess. */
export const SEARCH_TOOL_ID = "search.query";

export interface FacadeDeps {
  cfg: Config;
  jwks: JwksResolver | undefined;
  /** Injectable for unit tests; defaults to the global fetch at call time. */
  fetchImpl?: FetchImpl;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** tool-plane's gateway→backend contract (TPL-FR-012). */
interface FacadeRequest {
  tool_id?: unknown;
  version?: unknown;
  args?: unknown;
  tenant?: unknown;
  obo_sub?: unknown;
  agent_id?: unknown;
}

export function isInternalFacadePath(path: string): boolean {
  return path === FACADE_PATH;
}

function headerVal(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function facadeOutput(res: http.ServerResponse, output: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ output }));
}

/**
 * A refusal, in the shape tool-plane reads (it lifts `output.error` into the
 * caller-visible message and maps 403/404/422 onto PERMISSION_DENIED /
 * NOT_FOUND / VALIDATION_FAILED). Never a 200 with empty results.
 */
function facadeError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ output: { error: message } }));
}

/** Peers permitted to reach the facade. Empty ⇒ the facade is off. */
function allowedSpiffe(env: NodeJS.ProcessEnv): string[] {
  return (env.BFF_FACADE_ALLOWED_SPIFFE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validate + narrow the tool arguments. Returns the reason on rejection. */
export function parseSearchArgs(raw: unknown): { args: SearchArgs } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "args must be an object" };
  }
  const a = raw as Record<string, unknown>;
  if (typeof a.q !== "string") return { error: "args.q must be a string" };

  let types: SearchEntityType[] | null = null;
  if (a.types !== undefined && a.types !== null) {
    if (!Array.isArray(a.types)) return { error: "args.types must be an array" };
    for (const t of a.types) {
      if (typeof t !== "string" || !(SEARCH_ENTITY_TYPES as readonly string[]).includes(t)) {
        return { error: `args.types contains an unknown entity type: ${String(t)}` };
      }
    }
    types = a.types as SearchEntityType[];
  }

  let workspaceId: string | null = null;
  if (a.workspace_id !== undefined && a.workspace_id !== null) {
    if (typeof a.workspace_id !== "string") return { error: "args.workspace_id must be a string" };
    workspaceId = a.workspace_id;
  }

  let first: number | null = null;
  if (a.first !== undefined && a.first !== null) {
    if (typeof a.first !== "number" || !Number.isInteger(a.first)) {
      return { error: "args.first must be an integer" };
    }
    first = a.first;
  }

  return { args: { q: a.q, types, workspaceId, first } };
}

/**
 * Handle one facade invocation. `bodyText` is the already-read POST body.
 * Resolves once the response has been written.
 */
export async function handleInternalFacade(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyText: string,
  deps: FacadeDeps,
): Promise<void> {
  if (req.method !== "POST") {
    return facadeError(res, 405, "POST only");
  }

  // Gate 1 — mesh peer identity. bff-graphql is publicly routed, so an
  // unconfigured allowlist means "nothing may call this", never "anyone may".
  const allowed = allowedSpiffe(deps.env ?? process.env);
  if (allowed.length === 0) {
    return facadeError(res, 403, "facade disabled: BFF_FACADE_ALLOWED_SPIFFE is not configured");
  }
  // tool-plane sends the identity under both platform names.
  const spiffe =
    headerVal(req.headers["x-spiffe-id"]) ?? headerVal(req.headers["x-client-spiffe-id"]) ?? "";
  if (!allowed.includes(spiffe)) {
    return facadeError(res, 403, "facade requires an allowed SPIFFE peer identity");
  }

  let body: FacadeRequest;
  try {
    body = JSON.parse(bodyText || "{}") as FacadeRequest;
  } catch {
    return facadeError(res, 400, "invalid JSON body");
  }
  if (body.tool_id !== SEARCH_TOOL_ID) {
    return facadeError(res, 404, "unknown tool_id");
  }

  // Gate 2 — the caller's own token. Without it there is nothing to authorize
  // the downstream reads with, and answering "no results" would be a lie.
  const authorization = headerVal(req.headers["authorization"]);
  if (!authorization) {
    return facadeError(
      res,
      403,
      "no caller token was forwarded; search cannot be served without the caller's own authority",
    );
  }

  let ctx;
  try {
    ctx = await buildContext(
      { config: deps.cfg, jwks: deps.jwks, fetchImpl: deps.fetchImpl },
      {
        authorization,
        traceparent: headerVal(req.headers["traceparent"]),
        "x-trace-id": headerVal(req.headers["x-trace-id"]),
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unauthenticated";
    return facadeError(res, 403, `forwarded caller token is not valid: ${message}`);
  }

  // The gateway's attribution must MATCH the forwarded token. Anything else
  // would let the caller of this route pick a victim: read as another tenant by
  // claiming their id, or as another human by claiming their sub.
  const claims = ctx.identity.claims;
  if (typeof body.tenant === "string" && body.tenant !== "" && body.tenant !== claims.tenant_id) {
    // 404, not 403 — a 403 would confirm the other tenant exists (MASTER-FR-003).
    return facadeError(res, 404, "not found");
  }
  const effectiveUser = claims.obo_sub ?? claims.sub;
  if (typeof body.obo_sub === "string" && body.obo_sub !== "" && body.obo_sub !== effectiveUser) {
    return facadeError(res, 403, "obo_sub does not match the forwarded caller token");
  }

  const parsed = parseSearchArgs(body.args ?? {});
  if ("error" in parsed) {
    return facadeError(res, 422, parsed.error);
  }

  // Same function the GraphQL resolver calls, same context, same downstreams —
  // that identity IS the acceptance criterion.
  //
  // searchFanOut settles each leg and reports its own failure, so a throw here
  // means the fan-out ITSELF broke. That is surfaced as a 502 carrying the real
  // message (the gateway records TOOL_BACKEND_ERROR) — never as a 200 with an
  // empty hit list, which would be indistinguishable from "nothing matched".
  try {
    const results = await searchFanOut(ctx, parsed.args);
    return facadeOutput(res, results);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return facadeError(res, 502, `search fan-out failed: ${message}`);
  }
}
