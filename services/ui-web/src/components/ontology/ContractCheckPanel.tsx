"use client";
/**
 * WS4 data-contract runner. For one ontology entity type: pick a dataset, map
 * the type's attributes to that dataset's REAL columns, and run the contract
 * check — the engine enforces `required` (mapped + non-blank) and `enum`
 * (values in the allowed set) against actual rows and reports violations with
 * bounded worst-offender examples.
 *
 * Honesty rules mirror the engine's: a required attribute left unmapped is
 * itself a violation (the contract can't be satisfied invisibly), an unmapped
 * optional attribute is simply not checked, and the result always names how
 * many rows were read. The check is read-only — nothing is written anywhere.
 */
import { useState } from "react";
import { ShieldCheck, ShieldAlert, Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import {
  useDatasets, flatten, useDatasetSchema, useCheckOntologyContract,
} from "@/lib/graphql/hooks";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { cap } from "@/lib/authz/registry";
import type { OntologyEntity, OntologyContractResult } from "@/lib/graphql/operations";

const SELECT_CLS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

/** Human sentence per violation kind — same vocabulary the engine uses. */
const KIND_TEXT: Record<string, string> = {
  required_unmapped: "required, but not mapped to any column",
  column_missing: "mapped to a column this dataset does not have",
  nulls_in_required: "blank values in a required attribute",
  value_not_in_enum: "values outside the allowed set",
};

function ResultView({ result }: { result: OntologyContractResult }) {
  if (result.passed) {
    return (
      <p className="flex items-center gap-1.5 text-sm" data-testid="contract-passed">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
        Contract holds — {result.checkedRows.toLocaleString()} rows checked across{" "}
        {result.checkedAttributes.length} mapped attribute{result.checkedAttributes.length === 1 ? "" : "s"}.
      </p>
    );
  }
  return (
    <div className="space-y-1.5" data-testid="contract-violations">
      <p className="flex items-center gap-1.5 text-sm">
        <ShieldAlert className="size-4 shrink-0 text-destructive" aria-hidden />
        {result.violations.length} violation{result.violations.length === 1 ? "" : "s"} in{" "}
        {result.checkedRows.toLocaleString()} rows.
      </p>
      <ul className="space-y-1">
        {result.violations.map((v, i) => (
          <li key={i} className="rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs">
            <span className="font-medium">{v.attribute}</span>
            {v.column && <code className="ml-1 opacity-70">→ {v.column}</code>}
            <span className="ml-1 text-muted-foreground">
              {KIND_TEXT[v.kind] ?? v.kind}
              {v.count != null && <> ({v.count.toLocaleString()})</>}
            </span>
            {v.examples.length > 0 && (
              <span className="ml-1">
                {v.examples.map((ex) => (
                  <code key={ex} className="ml-1 rounded bg-muted px-1">{ex}</code>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContractCheckPanel({ entity }: { entity: OntologyEntity }) {
  const { can } = useCapabilities();
  const [open, setOpen] = useState(false);

  // The check reads real rows, so it needs the same capability the data browser
  // does; a type with no attributes has no constraints to enforce.
  if (entity.attributes.length === 0 || !can(cap("dataset.dataset.read"))) return null;

  return (
    <div className="border-t pt-2">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ShieldCheck className="size-3.5" aria-hidden />
        Data contract
        {open ? " —" : " +"}
      </button>
      {/* The body (and its dataset queries) only exists while open — a page of
          N closed panels fetches nothing. */}
      {open && <PanelBody entity={entity} />}
    </div>
  );
}

function PanelBody({ entity }: { entity: OntologyEntity }) {
  const [datasetId, setDatasetId] = useState("");
  const [map, setMap] = useState<Record<string, string>>({});

  // Same query key as every other dataset picker — react-query dedupes across
  // simultaneously open panels.
  const datasetsQuery = useDatasets();
  const datasets = flatten(datasetsQuery.data?.pages ?? []);
  const schemaQuery = useDatasetSchema(datasetId, undefined, { enabled: !!datasetId });
  const columns = schemaQuery.data ?? [];
  const check = useCheckOntologyContract();

  const pickDataset = (id: string) => {
    setDatasetId(id);
    check.reset();
    setMap({});
  };

  // Convenience only: once columns arrive, offer name matches for attributes
  // the user hasn't mapped. Never silently — the pickers show what got matched.
  const autoMap = () => {
    const byLower = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]));
    const next = { ...map };
    for (const a of entity.attributes) {
      if (!next[a.name]) {
        const hit = byLower.get(a.name.toLowerCase());
        if (hit) next[a.name] = hit;
      }
    }
    setMap(next);
  };

  const setAttr = (attr: string, col: string) => {
    const next = { ...map };
    if (col) next[attr] = col;
    else delete next[attr];
    setMap(next);
  };

  const run = () => {
    check.mutate({
      workspaceId: entity.workspaceId,
      entityKey: entity.entityKey,
      datasetId,
      attributeMap: Object.keys(map).length > 0 ? map : undefined,
    });
  };

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <label htmlFor={`contract-ds-${entity.entityKey}`} className="text-xs font-medium">
                Check against dataset
              </label>
              <select
                id={`contract-ds-${entity.entityKey}`}
                className={SELECT_CLS}
                value={datasetId}
                onChange={(e) => pickDataset(e.target.value)}
              >
                <option value="">Pick a dataset…</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            {datasetId && columns.length > 0 && (
              <Button type="button" size="sm" variant="outline" className="h-9" onClick={autoMap}>
                Match by name
              </Button>
            )}
          </div>

          {datasetId && schemaQuery.isLoading && (
            <p className="text-xs text-muted-foreground">Reading dataset columns…</p>
          )}
          {datasetId && schemaQuery.isError && (
            <p role="alert" className="text-xs text-destructive">
              Could not read this dataset&apos;s columns —{" "}
              {schemaQuery.error instanceof Error ? schemaQuery.error.message : "unknown error"}
            </p>
          )}

          {datasetId && columns.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {entity.attributes.map((a) => (
                <div key={a.name} className="flex items-center gap-2">
                  <code
                    className="w-28 shrink-0 truncate text-xs"
                    title={a.required ? `${a.name} (required — must be mapped)` : a.name}
                  >
                    {a.name}
                    {a.required && <span className="text-destructive" aria-label="required">*</span>}
                    {a.enumValues.length > 0 && (
                      <span className="ml-1 opacity-60">enum({a.enumValues.length})</span>
                    )}
                  </code>
                  <select
                    aria-label={`Map attribute ${a.name}`}
                    className={SELECT_CLS}
                    value={map[a.name] ?? ""}
                    onChange={(e) => setAttr(a.name, e.target.value)}
                  >
                    <option value="">Not mapped</option>
                    {columns.map((c) => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}

          {datasetId && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={run} disabled={check.isPending}>
                {check.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                Run check
              </Button>
              <Badge variant="outline" className="text-[10px]">read-only</Badge>
            </div>
          )}

      {check.isError && (
        <p role="alert" className="text-xs text-destructive">
          Check failed — {check.error instanceof Error ? check.error.message : "unknown error"}
        </p>
      )}
      {check.data && <ResultView result={check.data} />}
    </div>
  );
}
