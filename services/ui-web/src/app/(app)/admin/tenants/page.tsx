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
  useReactivateTenant, useTenantProvisioning, useRetryTenantProvisioning } from "@/lib/graphql/hooks";
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
  const [provisioningOf, setProvisioningOf] = useState<Tenant | null>(null);

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
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New tenant"}
          </Button>
        }
      />

      {creating && (
        <CreateTenantForm onDone={() => { setCreating(false); tenants.refetch(); }} />
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
    </div>
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
