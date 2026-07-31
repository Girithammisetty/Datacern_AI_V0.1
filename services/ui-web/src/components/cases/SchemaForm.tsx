"use client";
import { useMemo } from "react";
import { Input, Label, Textarea } from "@/components/ui/primitives";

/**
 * Schema-driven case form renderer (schema-driven-forms-addon, slice 1).
 *
 * A PURE, controlled renderer: given a case type's field set it draws one typed
 * widget per field and reports value changes — no data fetching, so both the
 * typed-create flow (slice 2) and the AI-autofill panel (slice 3) reuse it. The
 * autofill path just calls `onChange` with drafted values; the human edits from
 * there and submits, which is the signed action. Customization is
 * configuration: the case type + its fields (authored in settings) drive what
 * renders, and `field_meta` layout hints shape it — no code surface.
 */

export type SchemaFieldType =
  | "string" | "text" | "integer" | "float" | "boolean" | "date" | "enum";

/** Normalized field the renderer consumes — mapped from a CaseSchemaField or a
 * custom CaseField upstream so this component never depends on either shape. */
export interface SchemaFormField {
  name: string;
  dataType: SchemaFieldType;
  required?: boolean;
  /** Layout/behavior hints (from the field's `field_meta`): label, help text,
   * placeholder, and — for enum — the option list. Unknown keys are ignored.
   *
   * `group` / `order` / `widget` are the LAYOUT hints (slice 4): a pack or a
   * tenant authors them in `cases/fields.yaml` and the form re-arranges itself
   * with no code change. Only widgets listed in `widget` are honored; an
   * unrecognised one falls back to the type's default rather than rendering
   * nothing. */
  fieldMeta?: {
    label?: string;
    help?: string;
    placeholder?: string;
    options?: string[];
    /** Section heading to render this field under. Ungrouped fields stay in a
     * leading, unlabeled section. */
    group?: string;
    /** Sort weight within (and across) groups; lower first. Ties keep the
     * catalog's own order, so authoring order is the default layout. */
    order?: number;
    /** Override the type's default widget: 'textarea' for a long string,
     * 'radio' for a short enum. */
    widget?: "textarea" | "radio";
  } | null;
}

export type SchemaFormValues = Record<string, unknown>;
export type SchemaFormErrors = Record<string, string>;

const selectCls =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function labelFor(f: SchemaFormField): string {
  return f.fieldMeta?.label?.trim() || f.name;
}

/**
 * validateSchemaForm enforces `required` and coerces numerics — the same rules
 * the renderer shows inline, exposed as a pure function so a submit handler can
 * gate on it. Returns `{ errors, values }`: `values` carries numeric fields
 * coerced to numbers (strings elsewhere), ready to send as `custom_fields`.
 */
export function validateSchemaForm(
  fields: SchemaFormField[],
  raw: SchemaFormValues,
): { errors: SchemaFormErrors; values: SchemaFormValues } {
  const errors: SchemaFormErrors = {};
  const values: SchemaFormValues = {};
  for (const f of fields) {
    const v = raw[f.name];
    const isEmpty =
      v === undefined || v === null || (typeof v === "string" && v.trim() === "");

    if (f.dataType === "boolean") {
      values[f.name] = Boolean(v);
      continue;
    }
    if (isEmpty) {
      if (f.required) errors[f.name] = `${labelFor(f)} is required`;
      continue;
    }
    if (f.dataType === "integer" || f.dataType === "float") {
      const n = Number(v);
      if (Number.isNaN(n)) {
        errors[f.name] = `${labelFor(f)} must be a number`;
      } else if (f.dataType === "integer" && !Number.isInteger(n)) {
        errors[f.name] = `${labelFor(f)} must be a whole number`;
      } else {
        values[f.name] = n;
      }
      continue;
    }
    if (f.dataType === "enum") {
      const opts = f.fieldMeta?.options ?? [];
      if (opts.length && !opts.includes(String(v))) {
        errors[f.name] = `${labelFor(f)} must be one of: ${opts.join(", ")}`;
      } else {
        values[f.name] = v;
      }
      continue;
    }
    values[f.name] = v;
  }
  return { errors, values };
}

export interface SchemaFormProps {
  fields: SchemaFormField[];
  values: SchemaFormValues;
  onChange: (name: string, value: unknown) => void;
  errors?: SchemaFormErrors;
  /** Marks fields the AI drafted (slice 3) so the human sees what to review.
   * Rendered as a small "AI" tag beside the label; never blocks editing. */
  aiFilled?: Set<string>;
  disabled?: boolean;
}

/** Group + order the fields for layout (slice 4). Ungrouped fields lead in an
 * unlabeled section; groups follow, ordered by their lowest `order`. Ties keep
 * the catalog's own order, so authoring order IS the default layout and a pack
 * that sets no hints renders exactly as before. */
export function layoutSections(
  fields: SchemaFormField[],
): { group: string | null; fields: SchemaFormField[] }[] {
  const indexed = fields.map((f, i) => ({ f, i }));
  const groups = new Map<string | null, { f: SchemaFormField; i: number }[]>();
  for (const row of indexed) {
    const g = row.f.fieldMeta?.group?.trim() || null;
    const bucket = groups.get(g);
    if (bucket) bucket.push(row);
    else groups.set(g, [row]);
  }
  const weight = (rows: { f: SchemaFormField; i: number }[]) =>
    Math.min(...rows.map((r) => r.f.fieldMeta?.order ?? Number.MAX_SAFE_INTEGER));
  const byOrder = (a: { f: SchemaFormField; i: number }, b: { f: SchemaFormField; i: number }) => {
    const ao = a.f.fieldMeta?.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.f.fieldMeta?.order ?? Number.MAX_SAFE_INTEGER;
    return ao === bo ? a.i - b.i : ao - bo;
  };

  const ungrouped = groups.get(null);
  groups.delete(null);
  const named = [...groups.entries()]
    .map(([group, rows], seq) => ({ group, rows, seq }))
    // an unweighted group keeps its first appearance in the catalog
    .sort((a, b) => {
      const aw = weight(a.rows);
      const bw = weight(b.rows);
      return aw === bw ? a.seq - b.seq : aw - bw;
    });

  const out: { group: string | null; fields: SchemaFormField[] }[] = [];
  if (ungrouped?.length) {
    out.push({ group: null, fields: [...ungrouped].sort(byOrder).map((r) => r.f) });
  }
  for (const g of named) {
    out.push({ group: g.group, fields: [...g.rows].sort(byOrder).map((r) => r.f) });
  }
  return out;
}

const AI_TAG = (
  <span className="rounded bg-primary/10 px-1 text-[0.625rem] font-semibold uppercase text-primary">
    AI
  </span>
);

export function SchemaForm({
  fields, values, onChange, errors, aiFilled, disabled,
}: SchemaFormProps) {
  const sections = useMemo(() => layoutSections(fields), [fields]);

  const renderField = (f: SchemaFormField) => {
    const id = `sf-${f.name}`;
    const err = errors?.[f.name];
    const v = values[f.name];
    const ai = aiFilled?.has(f.name);
    const widget = f.fieldMeta?.widget;
    const common = {
      id,
      disabled,
      "aria-invalid": err ? true : undefined,
      "aria-describedby": err ? `${id}-err` : undefined,
    };
    const options = f.fieldMeta?.options ?? [];
    // `widget` only ever REPLACES the default with another real widget; an
    // unrecognised hint falls through to the type's own control rather than
    // rendering nothing.
    const asTextarea = f.dataType === "text" || (f.dataType === "string" && widget === "textarea");
    const asRadio = f.dataType === "enum" && widget === "radio" && options.length > 0;

    return (
      <div key={f.name} className="space-y-1">
        {/* A radiogroup labels itself via aria-label, so a <label for> would
            point at nothing — render the caption as text in that one case. */}
        {f.dataType !== "boolean" && (
          asRadio ? (
            <p className="flex items-center gap-1.5 text-sm font-medium">
              {labelFor(f)}
              {f.required && <span className="text-destructive">*</span>}
              {ai && AI_TAG}
            </p>
          ) : (
            <Label htmlFor={id} className="flex items-center gap-1.5">
              {labelFor(f)}
              {f.required && <span className="text-destructive">*</span>}
              {ai && AI_TAG}
            </Label>
          )
        )}

        {asTextarea ? (
          <Textarea {...common} rows={3} value={String(v ?? "")}
            placeholder={f.fieldMeta?.placeholder}
            onChange={(e) => onChange(f.name, e.target.value)} />
        ) : f.dataType === "boolean" ? (
          <label className="flex items-center gap-2 text-sm">
            <input id={id} type="checkbox" disabled={disabled}
              checked={Boolean(v)}
              onChange={(e) => onChange(f.name, e.target.checked)} />
            {labelFor(f)}
            {ai && AI_TAG}
          </label>
        ) : asRadio ? (
          <div role="radiogroup" aria-label={labelFor(f)} className="flex flex-wrap gap-3">
            {options.map((o) => (
              <label key={o} className="flex items-center gap-1.5 text-sm">
                <input type="radio" name={id} value={o} disabled={disabled}
                  checked={String(v ?? "") === o}
                  onChange={() => onChange(f.name, o)} />
                {o}
              </label>
            ))}
          </div>
        ) : f.dataType === "enum" ? (
          <select {...common} className={selectCls} value={String(v ?? "")}
            onChange={(e) => onChange(f.name, e.target.value)}>
            <option value="">Select…</option>
            {options.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        ) : (
          <Input {...common}
            type={f.dataType === "integer" || f.dataType === "float"
              ? "number" : f.dataType === "date" ? "date" : "text"}
            step={f.dataType === "float" ? "any" : undefined}
            value={String(v ?? "")}
            placeholder={f.fieldMeta?.placeholder}
            onChange={(e) => onChange(f.name, e.target.value)} />
        )}

        {f.fieldMeta?.help && !err && (
          <p className="text-xs text-muted-foreground">{f.fieldMeta.help}</p>
        )}
        {err && (
          <p id={`${id}-err`} role="alert" className="text-xs text-destructive">
            {err}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {sections.map((sec) => (
        <div key={sec.group ?? "__ungrouped"} className="space-y-3">
          {sec.group && (
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {sec.group}
            </p>
          )}
          {sec.fields.map(renderField)}
        </div>
      ))}
    </div>
  );
}
