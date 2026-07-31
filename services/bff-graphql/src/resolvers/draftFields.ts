/**
 * AI field drafting for schema-driven case forms (slice 3).
 *
 * The governed shape: this returns SUGGESTIONS and writes nothing. The values
 * land in the form AI-marked and editable; the human's submit is the signed
 * action. The call runs through ai-gateway on the CALLER's tenant (virtual key
 * as the bearer, caller JWT as X-Datacern-JWT), so a draft is budgeted,
 * guardrailed and metered exactly like any other model call — there is no
 * side-door LLM path in the bff.
 *
 * Deployment limit, stated plainly: ai-gateway's data plane authenticates with a
 * virtual key AND requires the key's tenant to equal the caller JWT's tenant
 * (services/ai-gateway/app/api/middleware.py::_data_plane). So a single
 * configured AI_GATEWAY_VIRTUAL_KEY makes drafting work for exactly ONE tenant —
 * the key's owner. This matches how eval-service's LLM judge is wired today
 * (EVAL_AI_GATEWAY_VIRTUAL_KEY), and it is fine for single-tenant and
 * demo/POC deployments. Multi-tenant SaaS needs per-tenant key brokering (the
 * SPIFFE mint path agent-runtime uses, AIG-FR-032) — until that exists, a
 * caller from another tenant gets a NAMED refusal here rather than a raw 401.
 *
 * Scope limit, stated plainly: drafting reads the case's STRUCTURED context
 * (display projection + description) and any caller-supplied `evidenceText`.
 * It does NOT download and parse evidence blobs — the bff has no evidence-byte
 * route, and pretending otherwise would put invented values in front of a human
 * who is about to sign them. Attached evidence is listed by filename so the
 * model can attribute a suggestion, and so the UI can show what was available.
 */
import type { GraphQLContext } from "../context.js";
import type { CaseFormFieldDTO } from "../clients/case.js";

export interface DraftCaseFieldsArgs {
  caseId?: string;
  evidenceText?: string;
  queryUrn?: string;
  fieldNames?: string[];
}

export interface DraftedFieldOut {
  name: string;
  value: unknown;
  confidence: number | null;
  sourceRef: string | null;
}

const MAX_EVIDENCE_CHARS = 12_000;

/** The model is told exactly which fields exist and what each accepts, and is
 * told to OMIT anything it cannot support from the material. "Leave it out" is
 * a first-class answer — a fabricated value is worse than a blank box. */
function buildPrompt(fields: CaseFormFieldDTO[], context: string) {
  const spec = fields.map((f) => {
    const meta = (f.field_meta ?? {}) as Record<string, unknown>;
    const parts = [`"${f.name}" (${f.data_type ?? "string"}`];
    if (Array.isArray(meta.options) && meta.options.length > 0) {
      parts.push(`; one of: ${(meta.options as string[]).join(" | ")}`);
    }
    if (f.required) parts.push("; required");
    parts.push(")");
    const label = typeof meta.label === "string" ? ` — ${meta.label}` : "";
    const help = typeof meta.help === "string" ? ` (${meta.help})` : "";
    return `- ${parts.join("")}${label}${help}`;
  }).join("\n");

  const system =
    "You extract structured field values for a case-management form. " +
    "Reply with a SINGLE JSON object and nothing else, shaped " +
    '{"fields":[{"name":"...","value":...,"confidence":0.0-1.0,"source_ref":"..."}]}. ' +
    "Only use field names from the provided list. OMIT any field the material " +
    "does not clearly support — never guess, never invent. Match the declared " +
    "type: numbers as JSON numbers, booleans as true/false, enums exactly as " +
    "one of the listed options. source_ref names the part of the material the " +
    "value came from.";

  const user = `Fields to fill:\n${spec}\n\nMaterial:\n${context}`;
  return { system, user };
}

/** Defensive parse: models wrap JSON in prose or fences often enough that a
 * strict JSON.parse of the whole body is not a safe contract. */
function parseDraft(content: string): { name: string; value: unknown; confidence?: number; source_ref?: string }[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? content).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(body.slice(start, end + 1));
    const rows = Array.isArray(obj?.fields) ? obj.fields : [];
    return rows.filter((r: unknown) => typeof (r as { name?: unknown } | null)?.name === "string");
  } catch {
    return [];
  }
}

/** Coerce a suggestion to the field's declared type, or reject it. A value that
 * cannot be coerced is DROPPED (and the field reported unfilled) rather than
 * shipped as a string into a typed catalog the server would then 422. */
function coerce(value: unknown, field: CaseFormFieldDTO): unknown | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const meta = (field.field_meta ?? {}) as Record<string, unknown>;
  switch (field.data_type) {
    case "integer":
    case "float": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[, ]/g, ""));
      if (!Number.isFinite(n)) return undefined;
      if (field.data_type === "integer" && !Number.isInteger(n)) return undefined;
      return n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (["true", "yes", "1"].includes(String(value).toLowerCase())) return true;
      if (["false", "no", "0"].includes(String(value).toLowerCase())) return false;
      return undefined;
    case "enum": {
      const options = Array.isArray(meta.options) ? (meta.options as string[]) : [];
      const s = String(value);
      if (options.length === 0) return s;
      // exact first, then case-insensitive — never a fuzzy match
      return options.includes(s)
        ? s
        : options.find((o) => o.toLowerCase() === s.toLowerCase());
    }
    case "date": {
      const s = String(value).trim();
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
    }
    default:
      return String(value);
  }
}

export async function draftCaseFields(
  args: DraftCaseFieldsArgs,
  ctx: GraphQLContext,
): Promise<{
  fields: DraftedFieldOut[];
  unfilled: string[];
  model: string | null;
  evidenceUsed: string[];
}> {
  const vkey = ctx.config.aiVirtualKey;
  if (!vkey) {
    // Fail loudly and specifically: an operator who has not configured the
    // gateway key should see that, not an empty draft that looks like "the AI
    // found nothing".
    throw new Error(
      "AI drafting is not configured on this deployment (AI_GATEWAY_VIRTUAL_KEY unset)",
    );
  }

  // ---- the field schema to fill (the workspace's own catalog) --------------
  const form = await ctx.clients.case.caseForm("create", args.queryUrn);
  let fields = form.custom_fields ?? [];
  if (args.fieldNames?.length) {
    const want = new Set(args.fieldNames);
    fields = fields.filter((f) => f.name && want.has(f.name));
  }
  if (fields.length === 0) {
    return { fields: [], unfilled: [], model: null, evidenceUsed: [] };
  }

  // ---- the material to draft from ------------------------------------------
  const parts: string[] = [];
  const evidenceUsed: string[] = [];
  if (args.caseId) {
    const c = await ctx.clients.case.case(args.caseId);
    if (c.description) parts.push(`Case description: ${c.description}`);
    const proj = c.display_projection ?? {};
    const projLines = Object.entries(proj).map(([k, v]) => `  ${k}: ${v}`);
    if (projLines.length) parts.push(`Case row:\n${projLines.join("\n")}`);
    // Evidence FILENAMES only — the bytes are not read (see the module note).
    const ev = await ctx.clients.case.listEvidence(args.caseId).catch(() => []);
    for (const e of ev) {
      if (e.filename) evidenceUsed.push(e.filename);
    }
    if (evidenceUsed.length) {
      parts.push(`Attached evidence (names only, contents not read): ${evidenceUsed.join(", ")}`);
    }
  }
  if (args.evidenceText) {
    parts.push(`Provided document:\n${args.evidenceText.slice(0, MAX_EVIDENCE_CHARS)}`);
    evidenceUsed.push("provided text");
  }
  if (parts.length === 0) {
    throw new Error("draftCaseFields needs caseId or evidenceText to draft from");
  }

  // ---- the governed model call ---------------------------------------------
  const { system, user } = buildPrompt(fields, parts.join("\n\n"));
  let res: { content: string; model?: string };
  try {
    res = await ctx.clients.aiGateway.draftJson({
      virtualKey: vkey,
      model: ctx.config.aiDraftModel,
      system,
      user,
    });
  } catch (e) {
    // ai-gateway rejects a key whose tenant is not the caller's tenant with the
    // same KEY_INVALID it uses for a revoked key (no resource-existence leak).
    // Say which of the two it is in operator terms instead of leaking a bare 401.
    const err = e as { httpStatus?: number; downstreamCode?: string };
    if (err?.httpStatus === 401 || err?.downstreamCode === "KEY_INVALID") {
      throw new Error(
        "AI drafting is unavailable for this tenant: the configured gateway key " +
        "is invalid, revoked, or belongs to a different tenant. This deployment " +
        "uses a single AI_GATEWAY_VIRTUAL_KEY, which serves one tenant only.",
      );
    }
    throw e;
  }

  const byName = new Map(fields.map((f) => [f.name ?? "", f]));
  const out: DraftedFieldOut[] = [];
  for (const row of parseDraft(res.content)) {
    const field = byName.get(row.name);
    if (!field) continue; // a name outside the catalog is discarded outright
    const value = coerce(row.value, field);
    if (value === undefined) continue;
    out.push({
      name: row.name,
      value,
      confidence: typeof row.confidence === "number" ? row.confidence : null,
      sourceRef: typeof row.source_ref === "string" ? row.source_ref : null,
    });
  }
  const filled = new Set(out.map((f) => f.name));
  const unfilled = fields.map((f) => f.name ?? "").filter((n) => n && !filled.has(n));

  return { fields: out, unfilled, model: res.model ?? null, evidenceUsed };
}
