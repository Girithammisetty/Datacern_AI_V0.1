"use client";
import { useState } from "react";
import { Rocket } from "lucide-react";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Badge, Card, CardHeader, CardTitle, CardDescription, CardContent, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_GATES } from "@/lib/authz/registry";
import {
  useAgentRollouts, useStartAgentRollout, usePromoteAgentRollout, useRollbackAgentRollout,
} from "@/lib/graphql/hooks";
import type { AgentRollout } from "@/lib/graphql/types";
import { useToasts } from "@/stores/ui";

const MODES = ["canary", "shadow", "direct"] as const;

function statusVariant(status: string): "default" | "success" | "warning" | "secondary" {
  if (status === "active") return "default";
  if (status === "promoted") return "success";
  if (status === "rolled_back") return "warning";
  return "secondary";
}

/**
 * BRD 14/68: the rollout MANAGEMENT panel of the Control Tower — start a
 * direct/canary/shadow rollout of a candidate version against a baseline,
 * then promote or roll it back. The fleet table's rollout chip already
 * reflects the live state read; this card is the write side. The list needs
 * ai.agent.read downstream; every write is platform-OPERATOR-only downstream
 * (agent-runtime registry.py _require_operator), so the actions are gated on
 * the same UI bar as publishAgentVersion and the API re-checks regardless.
 */
export function AgentRolloutsCard() {
  const query = useAgentRollouts();
  const start = useStartAgentRollout();
  const promote = usePromoteAgentRollout();
  const rollback = useRollbackAgentRollout();
  const push = useToasts((s) => s.push);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<{ action: "promote" | "rollback"; rollout: AgentRollout } | null>(null);
  const rows = query.data ?? [];

  const decide = (action: "promote" | "rollback", rollout: AgentRollout) => {
    const m = action === "promote" ? promote : rollback;
    m.mutate(rollout.rolloutId, {
      onSuccess: (r) => push({ title: `Rollout ${r.status.replace("_", " ")}`, variant: "success" }),
      onError: (e) => push({ title: e.message, variant: "error" }),
    });
  };

  const columns: Column<AgentRollout>[] = [
    { id: "agent", header: "Agent", cell: (r) => <span className="font-mono text-xs font-medium">{r.agentKey}</span> },
    {
      id: "mode", header: "Mode", width: 90,
      cell: (r) => <Badge variant={r.mode === "direct" ? "warning" : "secondary"}>{r.mode}</Badge>,
    },
    {
      id: "pct", header: "Traffic", width: 80,
      cell: (r) => (r.mode === "canary" ? `${r.pct}%` : <span className="text-muted-foreground">—</span>),
    },
    {
      id: "versions", header: "Candidate vs baseline", width: 160,
      cell: (r) => (
        <span className="font-mono text-xs">
          v{r.candidateVersion} <span className="text-muted-foreground">vs</span> v{r.baselineVersion}
        </span>
      ),
    },
    { id: "cell", header: "Cell", width: 90, cell: (r) => r.cell ?? <span className="text-muted-foreground">—</span> },
    {
      id: "status", header: "Status", width: 110,
      cell: (r) => <Badge variant={statusVariant(r.status)}>{r.status.replace("_", " ")}</Badge>,
    },
    {
      id: "actions", header: "", width: 170,
      cell: (r) =>
        r.status === "active" ? (
          <Can gate={FEATURE_GATES.manageAgentRollouts}>
            <span className="flex gap-1">
              <Button
                variant="ghost" size="sm"
                disabled={promote.isPending || rollback.isPending}
                onClick={(e) => { e.stopPropagation(); setConfirming({ action: "promote", rollout: r }); }}
              >
                Promote
              </Button>
              <Button
                variant="ghost" size="sm" className="text-destructive"
                disabled={promote.isPending || rollback.isPending}
                onClick={(e) => { e.stopPropagation(); setConfirming({ action: "rollback", rollout: r }); }}
              >
                Roll back
              </Button>
            </span>
          </Can>
        ) : null,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Rocket className="size-4" aria-hidden /> Rollouts
          </CardTitle>
          <CardDescription>
            Direct, canary and shadow rollouts of agent versions. Starting, promoting and rolling back are platform-operator actions.
          </CardDescription>
        </div>
        <Can gate={FEATURE_GATES.manageAgentRollouts}>
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "Start rollout"}
          </Button>
        </Can>
      </CardHeader>
      <CardContent className="space-y-3">
        {creating && (
          <StartRolloutForm
            pending={start.isPending}
            error={start.error}
            onStart={(input) =>
              start.mutate(input, {
                onSuccess: () => { setCreating(false); push({ title: "Rollout started", variant: "success" }); },
              })
            }
          />
        )}
        <AsyncBoundary
          isLoading={query.isLoading} isError={query.isError} error={query.error}
          isEmpty={rows.length === 0} emptyTitle="No rollouts." onRetry={() => query.refetch()}
        >
          <DataTable
            ariaLabel="Rollouts"
            rows={rows}
            columns={columns}
            rowId={(r) => r.rolloutId}
          />
        </AsyncBoundary>
      </CardContent>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={confirming?.action === "promote" ? "Promote this rollout?" : "Roll this rollout back?"}
        description={
          confirming?.action === "promote"
            ? `The candidate v${confirming?.rollout.candidateVersion} of ${confirming?.rollout.agentKey} becomes the winner.`
            : `Traffic returns to the baseline v${confirming?.rollout.baselineVersion} of ${confirming?.rollout.agentKey}.`
        }
        confirmLabel={confirming?.action === "promote" ? "Promote" : "Roll back"}
        destructive={confirming?.action === "rollback"}
        onConfirm={() => {
          if (confirming) decide(confirming.action, confirming.rollout);
          setConfirming(null);
        }}
      />
    </Card>
  );
}

function StartRolloutForm({
  onStart,
  pending,
  error,
}: {
  onStart: (input: { agentKey: string; mode: string; candidateVersion: number; baselineVersion: number; pct?: number }) => void;
  pending: boolean;
  error: Error | null;
}) {
  const [agentKey, setAgentKey] = useState("");
  const [mode, setMode] = useState<string>(MODES[0]);
  const [candidate, setCandidate] = useState("");
  const [baseline, setBaseline] = useState("");
  const [pct, setPct] = useState("");

  const valid = agentKey.trim() && candidate.trim() && baseline.trim();

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onStart({
          agentKey: agentKey.trim(), mode,
          candidateVersion: Number(candidate), baselineVersion: Number(baseline),
          pct: mode === "canary" && pct.trim() ? Number(pct) : undefined,
        });
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Agent key</span>
        <Input value={agentKey} onChange={(e) => setAgentKey(e.target.value)} aria-label="Agent key" className="h-8 w-40 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Mode</span>
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode" className="h-8 rounded-md border border-input bg-background px-2 text-xs">
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Candidate v</span>
        <Input type="number" min="1" value={candidate} onChange={(e) => setCandidate(e.target.value)} aria-label="Candidate version" className="h-8 w-24 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Baseline v</span>
        <Input type="number" min="1" value={baseline} onChange={(e) => setBaseline(e.target.value)} aria-label="Baseline version" className="h-8 w-24 text-xs" />
      </label>
      {mode === "canary" && (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Traffic %</span>
          <Input type="number" min="0" max="100" value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Traffic percent" className="h-8 w-20 text-xs" />
        </label>
      )}
      <Button type="submit" size="sm" disabled={pending || !valid}>Start rollout</Button>
      {error && <p className="w-full text-xs text-destructive">{error.message}</p>}
    </form>
  );
}
