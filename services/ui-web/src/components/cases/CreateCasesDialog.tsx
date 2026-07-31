"use client";
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Input, Label, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useAssignableUsers, useCaseForm, useCreateCases } from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";
import {
  SchemaForm, validateSchemaForm,
  type SchemaFieldType, type SchemaFormErrors,
} from "@/components/cases/SchemaForm";
import type { CaseRowInput } from "@/lib/graphql/types";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

/** Field types SchemaForm can draw (and case-service validates). A field of any
 * other type is omitted from the form rather than rendered as a guess. */
const RENDERABLE = new Set(["string", "text", "integer", "float", "boolean", "date", "enum"]);

/**
 * Create a worklist of cases from selected rows (case worklist model: each row
 * becomes one case anchored to (datasetUrn, rowPk), dedup-keyed so re-running
 * records a recurrence rather than a duplicate). `provenance` records where the
 * rows came from — a saved query (`queryUrn`) or a dashboard (`dashboardUrn`).
 * The backend's real 422/403 is surfaced verbatim.
 */
export function CreateCasesDialog({
  open,
  onOpenChange,
  datasetUrn,
  datasetVersion,
  queryUrn,
  dashboardUrn,
  rows,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  datasetUrn: string;
  datasetVersion?: string;
  queryUrn?: string;
  dashboardUrn?: string;
  /** The selected rows, already shaped as case rows (rowPk + projection). */
  rows: CaseRowInput[];
  onCreated?: (created: number, deduplicated: number) => void;
}) {
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("medium");
  const [dueDate, setDueDate] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [description, setDescription] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; deduplicated: number } | null>(null);
  // The workspace's own intake fields, drawn from the server's form model —
  // a tenant adds a field in Case settings and it appears here, no code change.
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<SchemaFormErrors>({});
  const formQ = useCaseForm("create", queryUrn);
  // Normalize the server's form model onto the renderer's field shape. Only
  // types SchemaForm draws are kept; anything else is dropped here rather than
  // rendered as a guess (case-service would reject values for it anyway).
  const customFields = useMemo(
    () =>
      (formQ.data?.customFields ?? [])
        .filter((f) => RENDERABLE.has(String(f.dataType)))
        .map((f) => ({
          name: f.name,
          dataType: f.dataType as SchemaFieldType,
          required: f.required ?? false,
          fieldMeta: f.fieldMeta ?? null,
        })),
    [formQ.data],
  );
  const createMutation = useCreateCases();

  // Member-safe assignable-analyst directory (needs case.case.assign, not admin
  // scope) so a manager can route the whole batch to one analyst by name.
  const assignableQ = useAssignableUsers();
  const analysts = useMemo(
    () => (assignableQ.data?.pages ?? []).flatMap((p) => p.nodes),
    [assignableQ.data],
  );

  useEffect(() => {
    if (open) {
      setSeverity("medium");
      // default due date: 14 days out (must be in the future — backend BR-12)
      const d = new Date();
      d.setDate(d.getDate() + 14);
      setDueDate(d.toISOString().slice(0, 10));
      setAssignedToId("");
      setDescription("");
      setCustomValues({});
      setFieldErrors({});
      setBanner(null);
      setResult(null);
    }
  }, [open]);

  const submit = () => {
    setBanner(null);
    if (rows.length === 0) {
      setBanner("Select at least one row.");
      return;
    }
    if (!dueDate) {
      setBanner("A due date is required.");
      return;
    }
    // Same gate the renderer shows inline: required + numeric coercion. The
    // coerced `values` are what we send, so a numeric field never ships as a
    // string. case-service re-validates every key regardless.
    const { errors, values: cleaned } = validateSchemaForm(customFields, customValues);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setBanner("Fix the highlighted fields.");
      return;
    }
    createMutation.mutate(
      {
        input: {
          datasetUrn,
          datasetVersion,
          queryUrn,
          dashboardUrn,
          // send an end-of-day UTC timestamp so "today" still reads as future
          dueDate: `${dueDate}T23:59:59Z`,
          severity,
          assignedToId: assignedToId.trim() || undefined,
          description: description.trim() || undefined,
          customFields: Object.keys(cleaned).length > 0 ? cleaned : undefined,
          rows,
        },
      },
      {
        onSuccess: (r) => {
          setResult({ created: r.created.length, deduplicated: r.deduplicated.length });
          onCreated?.(r.created.length, r.deduplicated.length);
        },
        onError: (e) => {
          setBanner(
            e instanceof GraphQLRequestError ? e.message : "Could not create cases.",
          );
        },
      },
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">Create cases</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            {rows.length} row{rows.length === 1 ? "" : "s"} → {rows.length} case
            {rows.length === 1 ? "" : "s"}. Rows already tracked by a case are recorded as a
            recurrence, not duplicated.
          </Dialog.Description>

          {result ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p>
                  <span className="font-medium text-foreground">{result.created}</span> case
                  {result.created === 1 ? "" : "s"} created
                  {result.deduplicated > 0 && (
                    <>
                      {" · "}
                      <span className="font-medium text-foreground">{result.deduplicated}</span>{" "}
                      already tracked (recurrence)
                    </>
                  )}
                  .
                </p>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="cc-severity">Severity</Label>
                  <select
                    id="cc-severity"
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as (typeof SEVERITIES)[number])}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cc-due">Due date</Label>
                  <Input
                    id="cc-due"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cc-assignee">Assign all to</Label>
                <select
                  id="cc-assignee"
                  value={assignedToId}
                  onChange={(e) => setAssignedToId(e.target.value)}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">Unassigned queue</option>
                  {analysts.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName || u.email}
                    </option>
                  ))}
                </select>
                {assignableQ.hasNextPage && (
                  <button
                    type="button"
                    onClick={() => assignableQ.fetchNextPage()}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Load more people
                  </button>
                )}
              </div>
              {customFields.length > 0 && (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {formQ.data?.mode === "create" ? "Intake details" : "Case details"}
                  </p>
                  <SchemaForm
                    fields={customFields}
                    values={customValues}
                    errors={fieldErrors}
                    disabled={createMutation.isPending}
                    onChange={(name, value) =>
                      setCustomValues((prev) => ({ ...prev, [name]: value }))
                    }
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="cc-desc">Description (optional)</Label>
                <Textarea
                  id="cc-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="e.g. Q2 denied-claims review"
                />
              </div>

              {banner && (
                <p role="alert" className="text-sm text-destructive">
                  {banner}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={submit} disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating…" : `Create ${rows.length} case${rows.length === 1 ? "" : "s"}`}
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
