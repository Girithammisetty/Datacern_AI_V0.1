"use client";
import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Can } from "@/components/authz/Can";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Input, Label } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useQueryLimits, useSetQueryLimits } from "@/lib/graphql/hooks";
import type { QueryCeilings } from "@/lib/graphql/types";
import { formatBytes, formatNumber } from "@/lib/utils";
import { useToasts } from "@/stores/ui";

/**
 * Tenant query-governance panel (query-service GET/PUT /limits,
 * QRY-FR-042/044): the effective per-caller execution ceilings plus the
 * tenant-admin override form. Overrides may only LOWER the platform maxima —
 * a higher value gets a real 422 from the service, surfaced inline.
 */
export function QueryLimitsCard() {
  const query = useQueryLimits();
  const setLimits = useSetQueryLimits();
  const push = useToasts((s) => s.push);
  const limits = query.data;

  // Override inputs, hydrated from the stored overrides (empty = platform default).
  const [maxScanBytes, setMaxScanBytes] = useState("");
  const [maxRuntimeS, setMaxRuntimeS] = useState("");
  const [maxResultRows, setMaxResultRows] = useState("");
  const [concurrentSlots, setConcurrentSlots] = useState("");

  useEffect(() => {
    if (!limits) return;
    setMaxScanBytes(limits.overrides.maxScanBytes != null ? String(limits.overrides.maxScanBytes) : "");
    setMaxRuntimeS(limits.overrides.maxRuntimeS != null ? String(limits.overrides.maxRuntimeS) : "");
    setMaxResultRows(limits.overrides.maxResultRows != null ? String(limits.overrides.maxResultRows) : "");
    setConcurrentSlots(
      limits.overrides.concurrentSlots != null ? String(limits.overrides.concurrentSlots) : "",
    );
  }, [limits]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
    setLimits.mutate(
      {
        maxScanBytes: num(maxScanBytes),
        maxRuntimeS: num(maxRuntimeS),
        maxResultRows: num(maxResultRows),
        concurrentSlots: num(concurrentSlots),
      },
      { onSuccess: () => push({ title: "Query limits updated", variant: "success" }) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="size-4" aria-hidden /> Query limits
        </CardTitle>
        <CardDescription>
          Per-tenant query concurrency and cost ceilings (scan bytes, runtime, result size).
          Overrides may only lower the platform maxima.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <AsyncBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => query.refetch()}
        >
          {limits && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <CeilingsList label="Effective (users)" ceilings={limits.effectiveUser} />
                <CeilingsList label="Effective (agents)" ceilings={limits.effectiveAgent} />
                <CeilingsList label="Platform maxima" ceilings={limits.platformMaxima} />
              </div>
              <p className="text-xs text-muted-foreground">
                Concurrency: {limits.overrides.concurrentSlots != null
                  ? `${limits.overrides.concurrentSlots} slots (override)`
                  : "platform default"}
                {limits.overrides.updatedBy && ` · last set by ${limits.overrides.updatedBy}`}
              </p>
              <Can gate={FEATURE_GATES.updateQueryLimits}>
                <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
                  <div className="space-y-1.5">
                    <Label htmlFor="ql-scan">Max scan (bytes)</Label>
                    <Input id="ql-scan" type="number" min={1} value={maxScanBytes}
                      onChange={(e) => setMaxScanBytes(e.target.value)} className="h-8 w-40 text-xs"
                      placeholder="platform default" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ql-runtime">Max runtime (s)</Label>
                    <Input id="ql-runtime" type="number" min={1} value={maxRuntimeS}
                      onChange={(e) => setMaxRuntimeS(e.target.value)} className="h-8 w-28 text-xs"
                      placeholder="default" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ql-rows">Max result rows</Label>
                    <Input id="ql-rows" type="number" min={1} value={maxResultRows}
                      onChange={(e) => setMaxResultRows(e.target.value)} className="h-8 w-32 text-xs"
                      placeholder="default" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ql-slots">Concurrent slots</Label>
                    <Input id="ql-slots" type="number" min={1} value={concurrentSlots}
                      onChange={(e) => setConcurrentSlots(e.target.value)} className="h-8 w-28 text-xs"
                      placeholder="default" />
                  </div>
                  <Button type="submit" size="sm" disabled={setLimits.isPending}>
                    {setLimits.isPending ? "Saving…" : "Save limits"}
                  </Button>
                  {setLimits.error && (
                    <p role="alert" className="w-full text-xs text-destructive">
                      {(setLimits.error as Error).message}
                    </p>
                  )}
                </form>
              </Can>
            </>
          )}
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

function CeilingsList({ label, ceilings }: { label: string; ceilings: QueryCeilings }) {
  return (
    <div className="rounded-md border bg-muted/30 p-2">
      <p className="mb-1 text-xs font-medium">{label}</p>
      <dl className="space-y-0.5 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <dt>Scan</dt>
          <dd className="tabular-nums">{formatBytes(ceilings.maxScanBytes)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Runtime</dt>
          <dd className="tabular-nums">{ceilings.maxRuntimeS != null ? `${ceilings.maxRuntimeS}s` : "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Result</dt>
          <dd className="tabular-nums">{formatBytes(ceilings.maxResultBytes)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Rows</dt>
          <dd className="tabular-nums">{formatNumber(ceilings.maxResultRows)}</dd>
        </div>
      </dl>
    </div>
  );
}
