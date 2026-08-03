"use client";
/**
 * Knowledge Spine WS5 — the missing-knowledge steward queue.
 *
 * When a human decides an agent proposal they can name the knowledge the agent
 * LACKED (the 4th Agent-in-the-Loop correction signal, PII-redacted at
 * capture). This panel surfaces those signals beside the ontology so a steward
 * can close the loop in the shape the gap actually calls for:
 *
 * - **Knowledge note** — the gap lands on a type's description as a WS3
 *   four-eyes proposal a DISTINCT admin must publish.
 * - **New attribute** — the gap becomes a proposed attribute on a type; the
 *   proposal re-sends the type's existing attributes UNCHANGED (constraints
 *   included) plus the new one, so the WS3 diff shows exactly one addition.
 * - **New type** — the gap seeds a whole new entity type. Registry creation is
 *   immediate (create has never been four-eyes — same as the page's "New
 *   entity type" button), so this path is gated on dataset.ontology.create
 *   and says "created", never "proposed".
 */
import { useState } from "react";
import { Lightbulb, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, CardDescription, Input } from "@/components/ui/primitives";
import { useKnowledgeGaps, useProposeOntologyUpdate, useCreateOntologyEntity } from "@/lib/graphql/hooks";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { cap } from "@/lib/authz/registry";
import { useToasts } from "@/stores/ui";
import type { KnowledgeGap, OntologyEntity } from "@/lib/graphql/operations";

const SELECT_CLS = "h-8 rounded-md border border-input bg-background px-2 text-xs";
const INPUT_CLS = "h-8 w-36 text-xs";

/** The registry's restricted name shape for entity keys and attribute names. */
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Small closed list matching the XSD-mappable data types the export/contract
 * layers understand; free-typing is deliberately not offered here. */
const DATA_TYPES = ["string", "integer", "decimal", "boolean", "date", "datetime"];

function GapRow({ gap, entities }: { gap: KnowledgeGap; entities: OntologyEntity[] }) {
  const { can } = useCapabilities();
  const canPropose = can(cap("dataset.ontology.update"));
  const canCreate = can(cap("dataset.ontology.create"));
  const push = useToasts((s) => s.push);
  const propose = useProposeOntologyUpdate();
  const create = useCreateOntologyEntity();

  const [shape, setShape] = useState<"note" | "attribute" | "newtype">("note");
  const [targetKey, setTargetKey] = useState("");
  const [attrName, setAttrName] = useState("");
  const [attrType, setAttrType] = useState("");
  const [typeKey, setTypeKey] = useState("");
  const [typeName, setTypeName] = useState("");

  const busy = propose.isPending || create.isPending;
  const note = `Knowledge gap (${gap.agentKey}, ${gap.decidedBy ?? "unknown"}): ${gap.missingKnowledge}`;
  const target = entities.find((e) => e.entityKey === targetKey);

  const fail = (title: string, e: unknown) =>
    // One-open-proposal-at-a-time 409s and duplicate keys surface here honestly.
    push({ title, description: e instanceof Error ? e.message : String(e), variant: "error" });

  const submitNote = async () => {
    if (!target) return;
    try {
      await propose.mutateAsync({
        workspaceId: target.workspaceId,
        entityKey: target.entityKey,
        description: target.description ? `${target.description}\n${note}` : note,
      });
      push({ title: "Ontology update proposed", description: "Awaiting a second reviewer to publish.", variant: "success" });
    } catch (e) {
      fail("Could not propose", e);
    }
  };

  const submitAttribute = async () => {
    if (!target) return;
    const name = attrName.trim();
    if (!KEY_RE.test(name)) {
      push({ title: "Attribute name must be a lowercase slug", description: "e.g. payer_id", variant: "error" });
      return;
    }
    if (target.attributes.some((a) => a.name === name)) {
      push({ title: `"${name}" already exists on ${target.name}`, variant: "error" });
      return;
    }
    try {
      await propose.mutateAsync({
        workspaceId: target.workspaceId,
        entityKey: target.entityKey,
        // Overlay semantics replace the list — re-send the existing attributes
        // byte-for-byte (constraints included) so the diff is exactly +1.
        attributes: [
          ...target.attributes.map((a) => ({
            name: a.name,
            dataType: a.dataType ?? undefined,
            required: a.required,
            enumValues: a.enumValues.length > 0 ? a.enumValues : undefined,
          })),
          { name, dataType: attrType || undefined },
        ],
        description: target.description ? `${target.description}\n${note}` : note,
      });
      push({ title: `Attribute "${name}" proposed`, description: "Awaiting a second reviewer to publish.", variant: "success" });
    } catch (e) {
      fail("Could not propose", e);
    }
  };

  const submitNewType = async () => {
    const key = typeKey.trim();
    const name = typeName.trim();
    if (!KEY_RE.test(key) || !name) {
      push({ title: "New type needs a slug key and a name", description: "e.g. payer / Payer", variant: "error" });
      return;
    }
    const ws = entities[0]?.workspaceId;
    if (!ws) return;
    try {
      await create.mutateAsync({ workspaceId: ws, entityKey: key, name, description: note });
      push({ title: `Entity type "${name}" created`, description: "Creation is immediate — the registry's create path is not four-eyes.", variant: "success" });
    } catch (e) {
      fail("Could not create", e);
    }
  };

  const submit = shape === "note" ? submitNote : shape === "attribute" ? submitAttribute : submitNewType;
  const ready =
    shape === "newtype" ? typeKey.trim() !== "" && typeName.trim() !== ""
    : shape === "attribute" ? !!target && attrName.trim() !== ""
    : !!target;

  // Which shapes this viewer can act in: proposals need update, creation needs create.
  const shapes = [
    ...(canPropose ? [["note", "Knowledge note"], ["attribute", "New attribute"]] as const : []),
    ...(canCreate ? [["newtype", "New type"]] as const : []),
  ];

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
      {shapes.length > 0 && entities.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Proposal shape for gap ${gap.transcriptId}`}
            className={SELECT_CLS}
            value={shape}
            onChange={(e) => setShape(e.target.value as typeof shape)}
          >
            {shapes.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>

          {shape !== "newtype" && (
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
          )}

          {shape === "attribute" && (
            <>
              <Input
                aria-label={`Attribute name for gap ${gap.transcriptId}`}
                className={INPUT_CLS}
                placeholder="payer_id"
                value={attrName}
                onChange={(e) => setAttrName(e.target.value)}
              />
              <select
                aria-label={`Attribute data type for gap ${gap.transcriptId}`}
                className={SELECT_CLS}
                value={attrType}
                onChange={(e) => setAttrType(e.target.value)}
              >
                <option value="">no data type</option>
                {DATA_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </>
          )}

          {shape === "newtype" && (
            <>
              <Input
                aria-label={`New type key for gap ${gap.transcriptId}`}
                className={INPUT_CLS}
                placeholder="payer"
                value={typeKey}
                onChange={(e) => setTypeKey(e.target.value)}
              />
              <Input
                aria-label={`New type name for gap ${gap.transcriptId}`}
                className={INPUT_CLS}
                placeholder="Payer"
                value={typeName}
                onChange={(e) => setTypeName(e.target.value)}
              />
            </>
          )}

          <Button size="sm" variant="outline" className="h-8" disabled={!ready || busy} onClick={submit}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
            {shape === "newtype" ? "Create type" : "Propose update"}
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
