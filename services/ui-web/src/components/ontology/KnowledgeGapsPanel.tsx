"use client";
/**
 * Knowledge Spine WS5 — the missing-knowledge steward queue.
 *
 * When a human decides an agent proposal they can name the knowledge the agent
 * LACKED (the 4th Agent-in-the-Loop correction signal, PII-redacted at
 * capture). This panel surfaces those signals beside the ontology so a steward
 * can close the loop: pick the domain type the gap belongs to and open a
 * governed four-eyes update proposal carrying the gap as a knowledge note — a
 * DISTINCT admin then reviews it through the WS3 queue. The gap text feeds a
 * proposal; it never mutates the ontology directly.
 */
import { useState } from "react";
import { Lightbulb, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/primitives";
import { useKnowledgeGaps, useProposeOntologyUpdate } from "@/lib/graphql/hooks";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { cap } from "@/lib/authz/registry";
import { useToasts } from "@/stores/ui";
import type { KnowledgeGap, OntologyEntity } from "@/lib/graphql/operations";

const SELECT_CLS = "h-8 rounded-md border border-input bg-background px-2 text-xs";

function GapRow({ gap, entities }: { gap: KnowledgeGap; entities: OntologyEntity[] }) {
  const { can } = useCapabilities();
  const canPropose = can(cap("dataset.ontology.update"));
  const push = useToasts((s) => s.push);
  const propose = useProposeOntologyUpdate();
  const [targetKey, setTargetKey] = useState("");

  const submit = async () => {
    const target = entities.find((e) => e.entityKey === targetKey);
    if (!target) return;
    try {
      // The gap lands as a knowledge note on the type's description — an
      // in_review WS3 proposal a DISTINCT admin must publish (four-eyes).
      const note = `Knowledge gap (${gap.agentKey}, ${gap.decidedBy ?? "unknown"}): ${gap.missingKnowledge}`;
      await propose.mutateAsync({
        workspaceId: target.workspaceId,
        entityKey: target.entityKey,
        description: target.description ? `${target.description}\n${note}` : note,
      });
      push({ title: "Ontology update proposed", description: "Awaiting a second reviewer to publish.", variant: "success" });
    } catch (e) {
      // One-open-proposal-at-a-time 409s surface here honestly.
      push({ title: "Could not propose", description: e instanceof Error ? e.message : String(e), variant: "error" });
    }
  };

  return (
    <li className="space-y-1.5 rounded-md border border-border/60 px-3 py-2" data-testid="knowledge-gap">
      <p className="text-sm">{gap.missingKnowledge}</p>
      <p className="text-xs text-muted-foreground">
        {gap.agentKey} v{gap.agentVersion}
        {gap.adoption && <> · decision: {gap.adoption}</>}
        {gap.decidedBy && <> · by {gap.decidedBy}</>}
        {gap.knowledgeRelevance && (
          <Badge variant="outline" className="ml-1.5 text-[10px]">grounding {gap.knowledgeRelevance}</Badge>
        )}
      </p>
      {canPropose && entities.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            aria-label={`Target type for gap ${gap.transcriptId}`}
            className={SELECT_CLS}
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value)}
          >
            <option value="">Pick a domain type…</option>
            {entities.map((e) => (
              <option key={e.entityKey} value={e.entityKey}>{e.name} ({e.entityKey})</option>
            ))}
          </select>
          <Button size="sm" variant="outline" className="h-8" disabled={!targetKey || propose.isPending} onClick={submit}>
            {propose.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
            Propose update
          </Button>
        </div>
      )}
    </li>
  );
}

export function KnowledgeGapsPanel({ entities }: { entities: OntologyEntity[] }) {
  const q = useKnowledgeGaps();
  const gaps = q.data ?? [];
  // No gaps -> no panel: the queue only appears when there is real signal.
  if (q.isLoading || q.isError || gaps.length === 0) return null;

  return (
    <Card data-testid="knowledge-gaps-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-muted-foreground" aria-hidden />
          Knowledge gaps
          <Badge variant="secondary" className="text-[10px] tabular-nums">{gaps.length}</Badge>
        </CardTitle>
        <CardDescription>
          Knowledge reviewers said agents were missing, recorded at decision time. Turn a gap into a
          governed ontology update — a second admin reviews it before it publishes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {gaps.map((g) => (
            <GapRow key={g.transcriptId} gap={g} entities={entities} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
