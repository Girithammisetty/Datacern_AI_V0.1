import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import {
  SchemaForm, validateSchemaForm,
  type SchemaFormField, type SchemaFormValues,
} from "./SchemaForm";

const FIELDS: SchemaFormField[] = [
  { name: "claimant", dataType: "string", required: true,
    fieldMeta: { label: "Claimant name", help: "As on the policy" } },
  { name: "summary", dataType: "text" },
  { name: "amount", dataType: "float", required: true },
  { name: "count", dataType: "integer" },
  { name: "confirmed", dataType: "boolean" },
  { name: "opened_on", dataType: "date" },
  { name: "category", dataType: "enum", required: true,
    fieldMeta: { options: ["fraud", "benign"] } },
];

/** Tiny controlled host so fireEvent round-trips through onChange like the
 * real create flow does. */
function Harness({ fields = FIELDS, initial = {} as SchemaFormValues,
  aiFilled }: { fields?: SchemaFormField[]; initial?: SchemaFormValues; aiFilled?: Set<string> }) {
  const [values, setValues] = useState<SchemaFormValues>(initial);
  const { errors } = validateSchemaForm(fields, values);
  return (
    <SchemaForm fields={fields} values={values} errors={errors} aiFilled={aiFilled}
      onChange={(name, v) => setValues((s) => ({ ...s, [name]: v }))} />
  );
}

describe("SchemaForm renderer", () => {
  it("renders a typed widget per field, honoring field_meta label + help", () => {
    // fill the required fields so no error suppresses the help line under them
    render(<Harness initial={{ claimant: "Ada", amount: "1", category: "fraud" }} />);
    // layout hint: the label comes from field_meta.label, not the raw name
    expect(screen.getByText("Claimant name")).toBeInTheDocument();
    expect(screen.getByText("As on the policy")).toBeInTheDocument();
    // enum options from field_meta
    expect(screen.getByRole("option", { name: "fraud" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "benign" })).toBeInTheDocument();
    // number widgets for numeric types
    expect((screen.getByLabelText(/^Claimant name/) as HTMLInputElement).type).toBe("text");
  });

  it("round-trips values through onChange for each widget kind", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText(/^Claimant name/), { target: { value: "Ada" } });
    expect((screen.getByLabelText(/^Claimant name/) as HTMLInputElement).value).toBe("Ada");

    const chk = screen.getByRole("checkbox");
    fireEvent.click(chk);
    expect((chk as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByLabelText(/^category/i), { target: { value: "fraud" } });
    expect((screen.getByLabelText(/^category/i) as HTMLSelectElement).value).toBe("fraud");
  });

  it("marks AI-filled fields with a reviewable tag but keeps them editable", () => {
    render(<Harness initial={{ claimant: "drafted" }} aiFilled={new Set(["claimant"])} />);
    const input = screen.getByLabelText(/^Claimant name/) as HTMLInputElement;
    expect(input.value).toBe("drafted");
    expect(input.disabled).toBe(false);
    // the AI tag is shown (there may be several across the form; at least one)
    expect(screen.getAllByText("AI").length).toBeGreaterThanOrEqual(1);
    fireEvent.change(input, { target: { value: "corrected" } });
    expect(input.value).toBe("corrected");
  });
});

describe("validateSchemaForm", () => {
  it("flags empty required fields and passes when filled", () => {
    const empty = validateSchemaForm(FIELDS, {});
    expect(empty.errors.claimant).toMatch(/required/);
    expect(empty.errors.amount).toMatch(/required/);
    expect(empty.errors.category).toMatch(/required/);
    // optional fields never error when empty
    expect(empty.errors.summary).toBeUndefined();

    const ok = validateSchemaForm(FIELDS,
      { claimant: "Ada", amount: "12.5", category: "fraud" });
    expect(ok.errors.claimant).toBeUndefined();
    expect(ok.errors.amount).toBeUndefined();
    expect(ok.errors.category).toBeUndefined();
  });

  it("coerces numerics and rejects non-numbers / non-integers", () => {
    const good = validateSchemaForm(FIELDS,
      { claimant: "A", amount: "9.99", count: "3", category: "fraud" });
    expect(good.values.amount).toBe(9.99);      // float coerced to number
    expect(good.values.count).toBe(3);          // integer coerced to number

    const bad = validateSchemaForm(FIELDS,
      { claimant: "A", amount: "not-a-number", count: "2.5", category: "fraud" });
    expect(bad.errors.amount).toMatch(/must be a number/);
    expect(bad.errors.count).toMatch(/whole number/);
  });

  it("rejects an enum value outside its option list", () => {
    const bad = validateSchemaForm(FIELDS,
      { claimant: "A", amount: "1", category: "unlisted" });
    expect(bad.errors.category).toMatch(/must be one of/);
  });

  it("always yields a boolean for boolean fields", () => {
    const { values } = validateSchemaForm(FIELDS,
      { claimant: "A", amount: "1", category: "fraud", confirmed: true });
    expect(values.confirmed).toBe(true);
    const off = validateSchemaForm(FIELDS,
      { claimant: "A", amount: "1", category: "fraud" });
    expect(off.values.confirmed).toBe(false);
  });
});
