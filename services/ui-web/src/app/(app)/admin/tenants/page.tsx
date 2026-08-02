"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Input, Label } from "@/components/ui/primitives";
import { useTenants, useCreateTenant, usePublishTenant, useSuspendTenant,
  useReactivateTenant, useTenantProvisioning, useRetryTenantProvisioning,
  usePocProgress, useCreateDemoTenant, useResetDemoTenant, useCreatePocTenant,
  useSetPocManualValue, useStartTrial, useConvertTrial } from "@/lib/graphql/hooks";
import { useToasts } from "@/stores/ui";
import type { Tenant } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";

/**
 * Platform-admin only: every tenant on the platform (identity-service
 * GET /tenants, super-admin gated downstream) plus the lifecycle controls —
 * provision, publish, suspend/reactivate, and the provisioning-saga drill-in
 * with retry. Deliberately no drill-in into another tenant's DATA (the RLS
 * wall stands); lifecycle is platform metadata, not tenant content. Destroy
 * (DELETE mode=destroy) is deliberately NOT surfaced — terminal deletion
 * stays a deliberate API act, not a button.
 */
export default function TenantsPage() {
  const tenants = useTenants();
  const rows = tenants.data ?? [];
  const push = useToasts((s) => s.push);
  const publish = usePublishTenant();
  const suspend = useSuspendTenant();
  const reactivate = useReactivateTenant();
  const [creating, setCreating] = useState(false);
  const [sandboxKind, setSandboxKind] = useState<"demo" | "poc" | null>(null);
  const [provisioningOf, setProvisioningOf] = useState<Tenant | null>(null);
  const [pocOf, setPocOf] = useState<Tenant | null>(null);
  const resetDemo = useResetDemoTenant();
  const startTrial = useStartTrial();
  const convertTrial = useConvertTrial();

  const toastErr = (title: string) => (e: unknown) =>
    push({ title, description: e instanceof Error ? e.message : String(e), variant: "error" });

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href="/admin"><ArrowLeft /> Administration</Link>
      </Button>
      <PageHeader
        title="Tenants"
        description="Every tenant on the platform, with lifecycle controls. Platform administration does not cross the tenant data wall."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setSandboxKind(sandboxKind === "demo" ? null : "demo")}>
              {sandboxKind === "demo" ? "Cancel" : "New demo sandbox"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSandboxKind(sandboxKind === "poc" ? null : "poc")}>
              {sandboxKind === "poc" ? "Cancel" : "New POC tenant"}
            </Button>
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              {creating ? "Cancel" : "New tenant"}
            </Button>
          </div>
        }
      />

      {creating && (
        <CreateTenantForm onDone={() => { setCreating(false); tenants.refetch(); }} />
      )}
      {sandboxKind && (
        <SandboxForm kind={sandboxKind} onDone={() => { setSandboxKind(null); tenants.refetch(); }} />
      )}

      <AsyncBoundary
        isLoading={tenants.isLoading}
        isError={tenants.isError}
        error={tenants.error}
        isEmpty={!tenants.isLoading && rows.length === 0}
        emptyTitle="No tenants."
        onRetry={() => tenants.refetch()}
      >
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Tenant</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Tier</th>
                <th className="px-3 py-2 font-semibold">Cloud</th>
                <th className="px-3 py-2 font-semibold">Owner</th>
                <th className="px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b last:border-0" data-testid="tenant-row">
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.displayName || t.name}</div>
                    <div className="text-xs text-muted-foreground">{t.name}</div>
                  </td>
                  <td className="px-3 py-2">{t.status ? <StatusChip status={t.status} /> : "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.tier ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.cloud ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.ownerEmail ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {t.status === "draft" && (
                        <Button size="sm" variant="outline" disabled={publish.isPending}
                          onClick={() => publish.mutate(t.id, {
                            onSuccess: (op) => push({ title: "Provisioning started", description: `operation ${op}`, variant: "success" }),
                            onError: toastErr("Publish failed"),
                          })}>
                          Publish
                        </Button>
                      )}
                      {t.status === "active" && (
                        <Button size="sm" variant="outline" disabled={suspend.isPending}
                          onClick={() => {
                            if (window.confirm(`Suspend ${t.name}? Data stays intact; access is cut immediately.`)) {
                              suspend.mutate(t.id, { onError: toastErr("Suspend failed") });
                            }
                          }}>
                          Suspend
                        </Button>
                      )}
                      {t.status === "suspended" && (
                        <Button size="sm" variant="outline" disabled={reactivate.isPending}
                          onClick={() => reactivate.mutate(t.id, {
                            onSuccess: (r) => {
                              if (r.drift) push({ title: "Reactivated with config drift", description: "Review the drift report before restoring traffic.", variant: "error" });
                            },
                            onError: toastErr("Reactivate failed"),
                          })}>
                          Reactivate
                        </Button>
                      )}
                      {t.tier === "demo" && (
                        <Button size="sm" variant="ghost" disabled={resetDemo.isPending}
                          title="Reset to the post-seed snapshot (idempotent re-seed)"
                          onClick={() => resetDemo.mutate(t.id, {
                            onSuccess: () => push({ title: "Sandbox reset", variant: "success" }),
                            onError: toastErr("Reset failed"),
                          })}>
                          Reset
                        </Button>
                      )}
                      {t.status === "active" && t.tier !== "demo" && (
                        <Button size="sm" variant="ghost" disabled={startTrial.isPending}
                          title="Start a trial (409 if this tenant's commercial state has no edge into trial)"
                          onClick={() => startTrial.mutate({ id: t.id }, {
                            onSuccess: () => push({ title: "Trial started", variant: "success" }),
                            onError: toastErr("Trial start failed"),
                          })}>
                          Trial
                        </Button>
                      )}
                      {t.status === "trial" && (
                        <Button size="sm" variant="ghost" disabled={convertTrial.isPending}
                          onClick={() => convertTrial.mutate(t.id, {
                            onSuccess: () => push({ title: "Converted to paid", variant: "success" }),
                            onError: toastErr("Convert failed"),
                          })}>
                          Convert
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setPocOf(pocOf?.id === t.id ? null : t)}>
                        {pocOf?.id === t.id ? "Hide POC" : "POC"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setProvisioningOf(provisioningOf?.id === t.id ? null : t)}>
                        {provisioningOf?.id === t.id ? "Hide provisioning" : "Provisioning"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{rows.length} tenant{rows.length === 1 ? "" : "s"}</p>
      </AsyncBoundary>

      {provisioningOf && <ProvisioningPanel tenant={provisioningOf} />}
      {pocOf && <PocPanel tenant={pocOf} />}
    </div>
  );
}

/** Provision a demo sandbox (pack bundle required) or a POC tenant. */
function SandboxForm({ kind, onDone }: { kind: "demo" | "poc"; onDone: () => void }) {
  const push = useToasts((s) => s.push);
  const demo = useCreateDemoTenant();
  const poc = useCreatePocTenant();
  const [name, setName] = useState("");
  const [pack, setPack] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const pending = demo.isPending || poc.isPending;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>{kind === "demo" ? "New demo sandbox" : "New POC tenant"}</CardTitle>
        <CardDescription>
          {kind === "demo"
            ? "Seeded from a deploy/demo pack bundle; TTL-reaped and excluded from billing (DSP-FR-001/002)."
            : "A POC tenant with agreed success criteria and a live progress dashboard (DSP-FR-020)."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || pending) return;
            const done = {
              onSuccess: (r: { operationId: string | null }) => {
                push({ title: "Provisioning started", description: r.operationId ? `operation ${r.operationId}` : undefined, variant: "success" as const });
                onDone();
              },
              onError: (err: unknown) => push({ title: "Create failed", description: err instanceof Error ? err.message : String(err), variant: "error" }),
            };
            if (kind === "demo") {
              if (!pack.trim()) return;
              demo.mutate({ name: name.trim(), pack: pack.trim(), ownerEmail: ownerEmail.trim() || undefined }, done);
            } else {
              poc.mutate({ name: name.trim(), pack: pack.trim() || undefined, ownerEmail: ownerEmail.trim() || undefined }, done);
            }
          }}
        >
          <div>
            <Label htmlFor="sb-name">Name (slug)</Label>
            <Input id="sb-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" />
          </div>
          <div>
            <Label htmlFor="sb-pack">Pack bundle{kind === "poc" ? " (optional)" : ""}</Label>
            <Input id="sb-pack" value={pack} onChange={(e) => setPack(e.target.value)}
              placeholder="e.g. insurance-claims-payer" className="font-mono text-xs" />
          </div>
          <div>
            <Label htmlFor="sb-owner">Owner email</Label>
            <Input id="sb-owner" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={!name.trim() || (kind === "demo" && !pack.trim()) || pending}>
            {pending ? "Provisioning…" : "Create"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** The live POC success dashboard (BRD 70 US-5): actual-vs-target per agreed
 * criterion from real BRD 69 value data — inconclusive when data is genuinely
 * absent, never fabricated. Manual criteria are sponsor-updatable here. */
function PocPanel({ tenant }: { tenant: Tenant }) {
  const progress = usePocProgress(tenant.id);
  const setManual = useSetPocManualValue();
  const push = useToasts((s) => s.push);

  return (
    <Card className="mt-4" data-testid="poc-panel">
      <CardHeader>
        <CardTitle>POC progress — {tenant.displayName || tenant.name}</CardTitle>
        <CardDescription>
          {progress.data?.windowStart && progress.data?.windowEnd
            ? `Window ${formatLocal(progress.data.windowStart)} → ${formatLocal(progress.data.windowEnd)}`
            : "Agreed success criteria vs live value data."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={progress.isLoading}
          isError={progress.isError}
          error={progress.error}
          isEmpty={!progress.isLoading && (progress.data?.criteria.length ?? 0) === 0}
          emptyTitle="No POC criteria agreed for this tenant."
          onRetry={() => progress.refetch()}
        >
          <ul className="space-y-1 text-sm">
            {(progress.data?.criteria ?? []).map((c) => (
              <li key={c.key} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
                <span className="font-mono text-xs">{c.key}</span>
                {c.description && <span className="text-xs text-muted-foreground">{c.description}</span>}
                <span className="text-xs tabular-nums">
                  target {c.direction === "lte" ? "≤" : "≥"} {c.target ?? "—"} ·
                  actual {c.actualValue ?? "—"}
                </span>
                <StatusChip status={c.outcome ?? "inconclusive"} />
                {c.dataSource && <span className="text-xs text-muted-foreground">({c.dataSource})</span>}
                {c.metricRef === "manual" && (
                  <form
                    className="ml-auto flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = Number((new FormData(e.currentTarget)).get("mv"));
                      if (Number.isFinite(v)) {
                        setManual.mutate({ tenantId: tenant.id, key: c.key, value: v }, {
                          onSuccess: () => push({ title: "Value recorded", variant: "success" }),
                          onError: (err) => push({ title: "Record failed", description: err instanceof Error ? err.message : String(err), variant: "error" }),
                        });
                      }
                    }}
                  >
                    <Input name="mv" type="number" step="any" defaultValue={c.manualValue ?? undefined}
                      aria-label={`Manual value for ${c.key}`} className="h-7 w-24 text-xs" />
                    <Button type="submit" size="sm" variant="outline" disabled={setManual.isPending}>Record</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

/** Provision a new tenant; publish=true starts the 7-step saga immediately. */
function CreateTenantForm({ onDone }: { onDone: () => void }) {
  const create = useCreateTenant();
  const push = useToasts((s) => s.push);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [publishNow, setPublishNow] = useState(true);

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>New tenant</CardTitle>
        <CardDescription>Provisioning runs the compensable 7-step saga; failures are retryable from the provisioning panel.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || create.isPending) return;
            create.mutate(
              { name: name.trim(), displayName: displayName.trim() || undefined, ownerEmail: ownerEmail.trim() || undefined, publish: publishNow },
              {
                onSuccess: (r) => {
                  push({
                    title: r.operationId ? "Tenant created — provisioning started" : "Tenant created (draft)",
                    description: r.operationId ? `operation ${r.operationId}` : undefined,
                    variant: "success",
                  });
                  onDone();
                },
                onError: (err) => push({ title: "Create failed", description: err instanceof Error ? err.message : String(err), variant: "error" }),
              },
            );
          }}
        >
          <div>
            <Label htmlFor="nt-name">Name (slug)</Label>
            <Input id="nt-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" />
          </div>
          <div>
            <Label htmlFor="nt-display">Display name</Label>
            <Input id="nt-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nt-owner">Owner email</Label>
            <Input id="nt-owner" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />
            Provision immediately
          </label>
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** The provisioning saga's real step state, with retry on failure. */
function ProvisioningPanel({ tenant }: { tenant: Tenant }) {
  const steps = useTenantProvisioning(tenant.id);
  const retry = useRetryTenantProvisioning();
  const push = useToasts((s) => s.push);
  const hasFailure = (steps.data ?? []).some((st) => st.status === "failed");

  return (
    <Card className="mt-4" data-testid="provisioning-panel">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Provisioning — {tenant.displayName || tenant.name}</CardTitle>
          <CardDescription>The compensable saga&apos;s per-step state; a recorded compensation means the rollback path ran.</CardDescription>
        </div>
        {hasFailure && (
          <Button size="sm" variant="outline" disabled={retry.isPending}
            onClick={() => retry.mutate(tenant.id, {
              onSuccess: (op) => push({ title: "Retry started", description: `operation ${op}`, variant: "success" }),
              onError: (e) => push({ title: "Retry failed", description: e instanceof Error ? e.message : String(e), variant: "error" }),
            })}>
            {retry.isPending ? "Retrying…" : "Retry provisioning"}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={steps.isLoading}
          isError={steps.isError}
          error={steps.error}
          isEmpty={!steps.isLoading && (steps.data?.length ?? 0) === 0}
          emptyTitle="No provisioning history for this tenant."
          onRetry={() => steps.refetch()}
        >
          <ol className="space-y-1 text-sm">
            {(steps.data ?? []).map((st) => (
              <li key={st.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
                <span className="w-6 text-xs tabular-nums text-muted-foreground">{st.stepIndex + 1}.</span>
                <span className="font-mono text-xs">{st.stepName}</span>
                <StatusChip status={st.status} />
                {typeof st.attempt === "number" && st.attempt > 1 && (
                  <span className="text-xs text-muted-foreground">attempt {st.attempt}</span>
                )}
                {st.compensation && (
                  <span className="text-xs text-amber-700 dark:text-amber-400">compensated via {st.compensation}</span>
                )}
                {st.error && <span className="text-xs text-destructive">{st.error}</span>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {st.completedAt ? formatLocal(st.completedAt) : st.startedAt ? formatLocal(st.startedAt) : ""}
                </span>
              </li>
            ))}
          </ol>
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}
