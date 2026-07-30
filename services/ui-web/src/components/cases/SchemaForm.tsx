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
   * placeholder, and — for enum — the option list. Unknown keys are ignored. */
  fieldMeta?: {
    label?: string;
    help?: string;
    placeholder?: string;
    options?: string[];
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

export function SchemaForm({
  fields, values, onChange, errors, aiFilled, disabled,
}: SchemaFormProps) {
  const rows = useMemo(() => fields, [fields]);

  return (
    <div className="space-y-3">
      {rows.map((f) => {
        const id = `sf-${f.name}`;
        const err = errors?.[f.name];
        const v = values[f.name];
        const ai = aiFilled?.has(f.name);
        const common = {
          id,
          disabled,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": err ? `${id}-err` : undefined,
        };
        return (
          <div key={f.name} className="space-y-1">
            {f.dataType !== "boolean" && (
              <Label htmlFor={id} className="flex items-center gap-1.5">
                {labelFor(f)}
                {f.required && <span className="text-destructive">*</span>}
                {ai && (
                  <span className="rounded bg-primary/10 px-1 text-[0.625rem] font-semibold uppercase text-primary">
                    AI
                  </span>
                )}
              </Label>
            )}

            {f.dataType === "text" ? (
              <Textarea {...common} rows={3} value={String(v ?? "")}
                placeholder={f.fieldMeta?.placeholder}
                onChange={(e) => onChange(f.name, e.target.value)} />
            ) : f.dataType === "boolean" ? (
              <label className="flex items-center gap-2 text-sm">
                <input id={id} type="checkbox" disabled={disabled}
                  checked={Boolean(v)}
                  onChange={(e) => onChange(f.name, e.target.checked)} />
                {labelFor(f)}
                {ai && (
                  <span className="rounded bg-primary/10 px-1 text-[0.625rem] font-semibold uppercase text-primary">
                    AI
                  </span>
                )}
              </label>
            ) : f.dataType === "enum" ? (
              <select {...common} className={selectCls} value={String(v ?? "")}
                onChange={(e) => onChange(f.name, e.target.value)}>
                <option value="">Select…</option>
                {(f.fieldMeta?.options ?? []).map((o) => (
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
      })}
    </div>
  );
}
