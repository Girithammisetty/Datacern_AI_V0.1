"use client";
/**
 * Ontology versioning + four-eyes review (Knowledge Spine WS3). For one entity
 * type: propose a governed update (author), and review the in-flight proposal +
 * revision history — approve/reject as a DISTINCT reviewer (author≠approver is
 * enforced downstream; a self-approve returns a real 403, surfaced honestly).
 *
 * The live type never changes on a proposal or a rejection — only an approval
 * publishes the new definition, which is exactly what the history shows.
 */
import { useState } from "react";
import { GitBranch, Check, X, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Label, Badge } from "@/components/ui/primitives";
import {
  useOntologyVersions, useProposeOntologyUpdate, useApproveOntologyUpdate, useRejectOntologyUpdate,
} from "@/lib/graphql/hooks";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { cap } from "@/lib/authz/registry";
import { useToasts } from "@/stores/ui";
import type { OntologyEntity, OntologyEntityVersion } from "@/lib/graphql/operations";

const STATUS_VARIANT: Record<string, "outline" | "secondary" | "default"> = {
  in_review: "default",
  published: "secondary",
  superseded: "outline",
  rejected: "outline",
};

/** Compact human summary of the machine diff a published version carries. */
function diffSummary(diff: Record<string, unknown> | null): string[] {
  if (!diff) return [];
  const out: string[] = [];
  if (diff.name_changed) out.push("name changed");
  if (diff.description_changed) out.push("description changed");
  for (const kind of ["attributes", "relationships"] as const) {
    const d = diff[kind] as { added?: string[]; removed?: string[]; changed?: string[] } | undefined;
    if (!d) continue;
    if (d.added?.length) out.push(`+${d.added.length} ${kind}`);
    if (d.removed?.length) out.push(`−${d.removed.length} ${kind}`);
    if (d.changed?.length) out.push(`~${d.changed.length} ${kind}`);
  }
  return out;
}

function VersionRow({ v, entity }: { v: OntologyEntityVersion; entity: OntologyEntity }) {
  const { can } = useCapabilities();
  const canApprove = can(cap("dataset.ontology.approve"));
  const push = useToasts((s) => s.push);
  const approve = useApproveOntologyUpdate();
  const reject = useRejectOntologyUpdate();
  const busy = approve.isPending || reject.isPending;

  const decide = async (kind: "approve" | "reject") => {
    const mut = kind === "approve" ? approve : reject;
    try {
      await mut.mutateAsync({ entityKey: entity.entityKey, workspaceId: entity.workspaceId, versionNo: v.versionNo });
      push({ title: kind === "approve" ? "Update published" : "Proposal rejected", variant: "success" });
    } catch (e) {
      // A self-approve is a real 403 downstream (author≠approver) — say so.
      push({ title: `Could not ${kind}`, description: e instanceof Error ? e.message : String(e), variant: "error" });
    }
  };

  const summary = diffSummary(v.diff);
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums">v{v.versionNo}</span>
          <Badge variant={STATUS_VARIANT[v.status] ?? "outline"} className="text-[10px]">
            {v.status.replace("_", " ")}
          </Badge>
          <span className="truncate text-xs text-muted-foreground">{v.name}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          by {v.submittedBy}
          {v.approvedBy && v.approvedBy !== v.submittedBy && <> · decided by {v.approvedBy}</>}
          {summary.length > 0 && <> · {summary.join(", ")}</>}
        </p>
      </div>
      {v.status === "in_review" && canApprove && (
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => decide("approve")}>
            {approve.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Approve
          </Button>
          <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => decide("reject")}>
            {reject.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

export function OntologyVersionPanel({ entity }: { entity: OntologyEntity }) {
  const { can } = useCapabilities();
  const canUpdate = can(cap("dataset.ontology.update"));
  const [open, setOpen] = useState(false);
  const q = useOntologyVersions(entity.entityKey, entity.workspaceId, open);

  const [proposing, setProposing] = useState(false);
  const [form, setForm] = useState({ name: entity.name, description: entity.description });
  const propose = useProposeOntologyUpdate();
  const push = useToasts((s) => s.push);

  const submit = async () => {
    try {
      await propose.mutateAsync({
        workspaceId: entity.workspaceId, entityKey: entity.entityKey,
        name: form.name.trim(), description: form.description.trim(),
      });
      push({ title: "Update proposed", description: "Awaiting a second reviewer to publish.", variant: "success" });
      setProposing(false);
    } catch (e) {
      // One-open-at-a-time is a 409 downstream — surfaced, not swallowed.
      push({ title: "Could not propose", description: e instanceof Error ? e.message : String(e), variant: "error" });
    }
  };

  const versions = q.data ?? [];
  const openProposal = versions.find((v) => v.status === "in_review");

  return (
    <div className="space-y-2 border-t border-border/50 pt-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <GitBranch className="size-3.5" />
          {open ? "Hide" : "History & review"}
          {openProposal && (
            <Badge variant="default" className="ml-1 text-[10px]">1 in review</Badge>
          )}
        </button>
        {canUpdate && open && !proposing && (
          <Button size="sm" variant="outline" className="h-7" onClick={() => setProposing(true)}>
            Propose update
          </Button>
        )}
      </div>

      {open && proposing && (
        <div className="space-y-2 rounded-md border border-border/60 p-3">
          <div className="space-y-1">
            <Label htmlFor={`prop-name-${entity.entityKey}`}>Name</Label>
            <Input
              id={`prop-name-${entity.entityKey}`}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`prop-desc-${entity.entityKey}`}>Description</Label>
            <Input
              id={`prop-desc-${entity.entityKey}`}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            This opens a proposal for a second reviewer to publish — the live type is unchanged until then.
          </p>
          <div className="flex gap-2">
            <Button size="sm" className="h-7" disabled={propose.isPending} onClick={submit}>
              {propose.isPending ? "Proposing…" : "Submit proposal"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setProposing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {open && (
        <>
          {q.isLoading && <p className="text-xs text-muted-foreground">Loading history…</p>}
          {q.isError && <p className="text-xs text-destructive">Couldn&apos;t load version history.</p>}
          {!q.isLoading && !q.isError && versions.length === 0 && (
            <p className="text-xs text-muted-foreground">No versions recorded.</p>
          )}
          {versions.length > 0 && (
            <ul className="space-y-1.5">
              {versions.map((v) => (
                <VersionRow key={v.versionNo} v={v} entity={entity} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
