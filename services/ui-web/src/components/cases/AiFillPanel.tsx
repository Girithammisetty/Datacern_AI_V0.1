"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { useDraftCaseFields } from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";
import type { SchemaFormField } from "@/components/cases/SchemaForm";
import type { DraftedField } from "@/lib/graphql/types";

/**
 * AI autofill for schema-driven case forms (schema-driven-forms-addon, slice 3).
 *
 * The panel is a SUGGESTION surface, and its design says so at every step:
 *  - the material sent to the model is the text in this box, visible and
 *    editable — nothing hidden is attached;
 *  - drafted values land in the form marked "AI" and fully editable; the human's
 *    submit is still the signed action, and this panel never submits;
 *  - fields the model declined are named back ("left blank"), so an incomplete
 *    draft reads as incomplete instead of looking like a finished form.
 *
 * The call runs through ai-gateway on the caller's tenant, so a draft is
 * budgeted, guardrailed and metered like any other model call. When the
 * deployment has no gateway key configured, the server's message is shown
 * verbatim rather than an empty draft that would read as "found nothing".
 */
export function AiFillPanel({
  fields,
  caseId,
  queryUrn,
  seedText,
  onApply,
  disabled,
}: {
  /** The fields on the form — only these names are offered to the model, and
   * only these are accepted back. */
  fields: SchemaFormField[];
  /** Draft from an existing case's context (description + row + evidence names). */
  caseId?: string;
  queryUrn?: string;
  /** Optional starting material (e.g. the selected row rendered as text), shown
   * in the box so the user sees exactly what will be sent. */
  seedText?: string;
  onApply: (values: Record<string, unknown>, names: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(seedText ?? "");
  const [drafted, setDrafted] = useState<DraftedField[] | null>(null);
  const [unfilled, setUnfilled] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ model?: string | null; evidenceUsed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = useDraftCaseFields();

  const canDraft = Boolean(caseId) || text.trim().length > 0;

  const run = () => {
    setError(null);
    setDrafted(null);
    draft.mutate(
      {
        caseId,
        queryUrn,
        evidenceText: text.trim() || undefined,
        fieldNames: fields.map((f) => f.name),
      },
      {
        onSuccess: (d) => {
          setDrafted(d.fields);
          setUnfilled(d.unfilled);
          setMeta({ model: d.model, evidenceUsed: d.evidenceUsed });
          // Applied straight into the form — marked AI, editable, not submitted.
          const values: Record<string, unknown> = {};
          for (const f of d.fields) values[f.name] = f.value;
          onApply(values, d.fields.map((f) => f.name));
        },
        onError: (e) => {
          setError(
            e instanceof GraphQLRequestError ? e.message : "Could not draft these fields.",
          );
        },
      },
    );
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
      >
        Draft with AI
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Draft with AI</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted-foreground hover:underline"
        >
          Close
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Paste the note, email or document to read. Suggestions are filled in below for you to
        check and edit — nothing is submitted until you create the case{caseId ? "" : "s"}.
      </p>
      <Textarea
        aria-label="Material to draft from"
        rows={4}
        value={text}
        disabled={draft.isPending || disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          caseId
            ? "Optional — the case's own details are read either way."
            : "Paste the adjuster note, email thread or claim summary…"
        }
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={run}
          disabled={!canDraft || draft.isPending || disabled}
        >
          {draft.isPending ? "Reading…" : "Draft fields"}
        </Button>
        {!canDraft && (
          <span className="text-xs text-muted-foreground">Add some text to read first.</span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {drafted && (
        <div className="space-y-1 rounded-md bg-muted/40 p-2 text-xs">
          {drafted.length === 0 ? (
            <p className="text-muted-foreground">
              Nothing could be drawn from this material — every field was left for you.
            </p>
          ) : (
            <>
              <p className="font-medium text-foreground">
                {drafted.length} field{drafted.length === 1 ? "" : "s"} drafted — review before
                creating.
              </p>
              <ul className="space-y-0.5 text-muted-foreground">
                {drafted.map((f) => (
                  <li key={f.name}>
                    <span className="text-foreground">{f.name}</span>
                    {f.sourceRef ? ` — from ${f.sourceRef}` : " — source not attributed"}
                    {typeof f.confidence === "number" &&
                      ` (${Math.round(f.confidence * 100)}% confident)`}
                  </li>
                ))}
              </ul>
            </>
          )}
          {unfilled.length > 0 && (
            <p className="text-muted-foreground">Left blank: {unfilled.join(", ")}</p>
          )}
          {meta?.evidenceUsed.length ? (
            <p className="text-muted-foreground">Read: {meta.evidenceUsed.join(", ")}</p>
          ) : null}
          {meta?.model && <p className="text-muted-foreground">Model: {meta.model}</p>}
        </div>
      )}
    </div>
  );
}
