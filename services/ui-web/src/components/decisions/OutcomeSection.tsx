"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { useDecisionOutcome, useMarkDecisionOutcome } from "@/lib/graphql/hooks";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { cap } from "@/lib/authz/registry";
import type { ProposalStatus } from "@/lib/graphql/types";

/** Statuses on which recording an outcome makes sense: the decision happened. */
const DECIDED: ProposalStatus[] = ["APPROVED", "REJECTED", "EDITED_APPROVED"];

/**
 * Realized-outcome section for a DECIDED proposal (BRD 55, OM-FR-010): show the
 * recorded outcome if one exists, else let a permitted user record what
 * actually happened (the chargeback was won, the SAR was substantiated…). The
 * label annotates the decision — it never mutates it — and feeds the
 * decision-effectiveness KPIs on the Decision Tables page.
 */
export function OutcomeSection({ proposalId, status }: { proposalId: string; status?: ProposalStatus | null }) {
  const decided = !!status && DECIDED.includes(status);
  const { can } = useCapabilities();
  const canRecord = can(cap("case.case.update"));
  const outcome = useDecisionOutcome(proposalId, decided);
  const mark = useMarkDecisionOutcome();
  const [realized, setRealized] = useState("");
  const [note, setNote] = useState("");

  if (!decided) return null;

  const label = outcome.data;
  return (
    <section data-testid="outcome-section">
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Realized outcome</h3>
      {outcome.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : label ? (
        <div className="space-y-0.5 text-sm">
          <p>
            <span className="font-mono text-xs">{label.realizedOutcome}</span>
            {label.correct != null && (
              <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                label.correct
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-destructive/15 text-destructive"
              }`}>
                {label.correct ? "matched the decision" : "differed from the decision"}
              </span>
            )}
          </p>
          {label.note && <p className="text-xs text-muted-foreground">{label.note}</p>}
          {label.labeledBy && (
            <p className="text-xs text-muted-foreground">recorded by {label.labeledBy}</p>
          )}
        </div>
      ) : canRecord ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = realized.trim();
            if (!v || mark.isPending) return;
            mark.mutate({ decisionRef: proposalId, input: { realizedOutcome: v, note: note.trim() || undefined } });
          }}
        >
          <div>
            <Label htmlFor={`outcome-${proposalId}`}>What actually happened?</Label>
            <Input
              id={`outcome-${proposalId}`}
              value={realized}
              onChange={(e) => setRealized(e.target.value)}
              placeholder="e.g. chargeback_won"
              className="font-mono text-xs"
            />
          </div>
          <div className="grow">
            <Label htmlFor={`outcome-note-${proposalId}`}>Note (optional)</Label>
            <Input
              id={`outcome-note-${proposalId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!realized.trim() || mark.isPending}>
            {mark.isPending ? "Recording…" : "Record outcome"}
          </Button>
          {mark.isError && (
            <p className="w-full text-xs text-destructive">
              {mark.error instanceof Error ? mark.error.message : "Failed to record outcome"}
            </p>
          )}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">No outcome recorded yet.</p>
      )}
    </section>
  );
}
