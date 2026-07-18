"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { Button } from "@/components/ui/button";
import { useTenants } from "@/lib/graphql/hooks";

/**
 * Platform-admin only: a read-only list of EVERY tenant on the platform
 * (identity-service GET /tenants, super-admin gated). This is the extent of the
 * cross-tenant "see everything" surface — there is deliberately no drill-in into
 * another tenant's data (the RLS wall stands). The route is platformGate'd in
 * the authz registry, so a tenant admin can't reach it.
 */
export default function TenantsPage() {
  const tenants = useTenants();
  const rows = tenants.data ?? [];

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href="/admin"><ArrowLeft /> Administration</Link>
      </Button>
      <PageHeader
        title="Tenants"
        description="Every tenant on the platform. Read-only — platform administration does not cross the tenant data wall."
      />
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{rows.length} tenant{rows.length === 1 ? "" : "s"}</p>
      </AsyncBoundary>
    </div>
  );
}
