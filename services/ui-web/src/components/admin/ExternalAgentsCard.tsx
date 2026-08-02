"use client";
import { useState } from "react";
import { KeyRound, Plus, Satellite, X } from "lucide-react";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Badge, Card, CardHeader, CardTitle, CardDescription, CardContent, Input, Label } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useExternalAgents, useRegisterExternalAgent, useRevokeExternalAgent } from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";
import type { ExternalAgent } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";

/**
 * BRD 60 WS2 — external-agent governance console. A tenant admin registers a
 * customer's OWN agent (mints its wr_xa_ credential, shown once), sees the
 * tool/action allow-list each key is ceiling-limited to, and revokes keys.
 * Every exchanged token enters the governed external-intent ingress
 * (propose-only, four-eyes), so auto-execute is permanently denied for
 * external agents (BRD 68 ACT-FR-003) — the badge is a constant, not a state.
 */
export function ExternalAgentsCard() {
  const query = useExternalAgents();
  const revoke = useRevokeExternalAgent();
  const [registering, setRegistering] = useState(false);
  // The one-time key lives ONLY in this transient state — shown once via the
  // SecretBanner idiom (see /admin/service-accounts), never cached/persisted.
  const [issuedKey, setIssuedKey] = useState<{ agentId: string; apiKey: string } | null>(null);
  const [revoking, setRevoking] = useState<ExternalAgent | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const rows = query.data ?? [];

  const fail = (e: Error) => {
    const trace = e instanceof GraphQLRequestError && e.traceId ? ` (trace: ${e.traceId})` : "";
    setActionError(`${e.message}${trace}`);
  };

  const columns: Column<ExternalAgent>[] = [
    {
      id: "agent", header: "Agent",
      cell: (a) => (
        <span className="font-medium">
          {a.agentId}
          {a.agentVersion ? <span className="text-muted-foreground"> v{a.agentVersion}</span> : null}
        </span>
      ),
    },
    { id: "label", header: "Label", cell: (a) => a.label || <span className="text-muted-foreground">—</span> },
    {
      id: "scopes", header: "Tool allow-list",
      cell: (a) => a.scopes.length
        ? (
          <span className="flex flex-wrap gap-1">
            {a.scopes.slice(0, 4).map((s) => <Badge key={s} variant="secondary">{s}</Badge>)}
            {a.scopes.length > 4 ? <Badge variant="secondary">+{a.scopes.length - 4}</Badge> : null}
          </span>
        )
        : <span className="text-muted-foreground">—</span>,
    },
    {
      // ACT-FR-003 (BRD 68): external agents are propose-only by construction —
      // this badge is permanent and identical for every row, never a toggle.
      id: "autonomy", header: "Autonomy", width: 160,
      cell: () => <Badge variant="warning">auto-execute: denied</Badge>,
    },
    {
      id: "state", header: "State", width: 100,
      cell: (a) => a.active
        ? <Badge variant="success">active</Badge>
        : <Badge variant="destructive">revoked</Badge>,
    },
    { id: "lastUsed", header: "Last used", width: 170, cell: (a) => formatLocal(a.lastUsedAt) },
    {
      id: "actions", header: "", width: 100,
      // Revoke is hidden for already-revoked keys (irreversible).
      cell: (a) => a.active ? (
        <Can gate={FEATURE_GATES.manageExternalAgents}>
          <Button variant="ghost" size="sm" className="text-destructive"
            onClick={(e) => { e.stopPropagation(); setRevoking(a); }}>
            Revoke
          </Button>
        </Can>
      ) : null,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Satellite className="size-4" aria-hidden /> External agents
            <Badge variant="warning">auto-execute: denied</Badge>
          </CardTitle>
          <CardDescription className="mt-1">
            Credentials for your own agents (BRD 60). Every external agent is propose-only:
            its actions always enter the governed intent ingress and can never auto-execute.
          </CardDescription>
        </div>
        <Can gate={FEATURE_GATES.manageExternalAgents}>
          <Button size="sm" onClick={() => setRegistering((v) => !v)}>
            {registering ? "Cancel" : <><Plus /> Register agent</>}
          </Button>
        </Can>
      </CardHeader>
      <CardContent className="space-y-3">
        {issuedKey && (
          <SecretBanner
            label={`API key for ${issuedKey.agentId} — shown once, store it now`}
            secret={issuedKey.apiKey}
            onDismiss={() => setIssuedKey(null)}
          />
        )}
        {actionError && (
          <p role="alert" className="text-xs text-destructive" data-testid="xa-action-error">{actionError}</p>
        )}
        {registering && (
          <RegisterExternalAgentForm
            onRegistered={(agentId, apiKey) => {
              setRegistering(false);
              setActionError(null);
              setIssuedKey({ agentId, apiKey });
            }}
          />
        )}
        <AsyncBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyTitle="No external agents registered."
          onRetry={() => query.refetch()}
        >
          <DataTable
            ariaLabel="External agents"
            rows={rows}
            columns={columns}
            rowId={(a) => a.id}
          />
        </AsyncBoundary>
      </CardContent>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke external-agent key"
        description={`Revoke the credential for "${revoking?.agentId}"? The key stops exchanging for tokens immediately. This is irreversible — register a new key to restore access.`}
        confirmLabel="Revoke"
        confirmPhrase={revoking?.agentId}
        destructive
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => setActionError(null),
            onError: fail,
            onSettled: () => setRevoking(null),
          });
        }}
      />
    </Card>
  );
}

/** One-time secret display (same idiom as /admin/service-accounts): copy +
 * dismiss; never persisted. */
function SecretBanner({ label, secret, onDismiss }: { label: string; secret: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-xs">
      <KeyRound className="size-4" aria-hidden />
      <span className="font-medium">{label}</span>
      <code data-testid="xa-api-key" className="rounded bg-background px-2 py-1 font-mono">{secret}</code>
      <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</Button>
      <Button variant="ghost" size="icon" aria-label="Dismiss API key" onClick={onDismiss}><X className="size-4" /></Button>
    </div>
  );
}

function RegisterExternalAgentForm({
  onRegistered,
}: {
  onRegistered: (agentId: string, apiKey: string) => void;
}) {
  const [agentId, setAgentId] = useState("");
  const [label, setLabel] = useState("");
  const [scopesRaw, setScopesRaw] = useState("");
  const register = useRegisterExternalAgent();
  const error = register.error instanceof GraphQLRequestError ? register.error : null;

  const submit = () => {
    if (!agentId.trim()) return;
    // Allow-list: comma- or whitespace-separated action names → array.
    const scopes = scopesRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    register.mutate(
      {
        agentId: agentId.trim(),
        label: label.trim() || undefined,
        scopes: scopes.length ? scopes : undefined,
      },
      {
        onSuccess: (r) => onRegistered(r.externalAgent.agentId, r.apiKey),
      },
    );
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border p-3"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="xa-agent-id">Agent name</Label>
        <Input id="xa-agent-id" value={agentId} autoFocus onChange={(e) => setAgentId(e.target.value)}
          placeholder="acme-procurement-bot" className="h-8 w-52 text-xs" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="xa-label">Label (optional)</Label>
        <Input id="xa-label" value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder="Prod key" className="h-8 w-40 text-xs" />
      </div>
      <div className="min-w-64 flex-1 space-y-1.5">
        <Label htmlFor="xa-scopes">Tool allow-list (comma or space separated, optional)</Label>
        <Input id="xa-scopes" value={scopesRaw} onChange={(e) => setScopesRaw(e.target.value)}
          placeholder="dataset.dataset.read, case.case.propose" className="h-8 text-xs" />
      </div>
      <Button type="submit" size="sm" disabled={!agentId.trim() || register.isPending}>
        {register.isPending ? "Registering…" : "Register"}
      </Button>
      <p className="w-full text-xs text-muted-foreground">
        The key is returned once on registration and can never be retrieved again —
        copy it from the banner immediately. Registered agents are always propose-only.
      </p>
      {register.error && (
        <p role="alert" className="w-full text-xs text-destructive" data-testid="mutation-error">
          {register.error.message}{error?.traceId ? ` (trace: ${error.traceId})` : ""}
        </p>
      )}
    </form>
  );
}
