import { describe, expect, it } from "vitest";

import { needsSelection, operationSkeleton, renderTypeRef, type SchemaField } from "./introspection";

const NAMED = (name: string, kind = "OBJECT") => ({ kind, name, ofType: null });
const NON_NULL = (ofType: object) => ({ kind: "NON_NULL", name: null, ofType });
const LIST = (ofType: object) => ({ kind: "LIST", name: null, ofType });

describe("renderTypeRef", () => {
  it("renders the worst real shape [CaseView!]!", () => {
    const t = NON_NULL(LIST(NON_NULL(NAMED("CaseView"))));
    expect(renderTypeRef(t as never)).toBe("[CaseView!]!");
  });
  it("renders plain named + nullable list", () => {
    expect(renderTypeRef(NAMED("String", "SCALAR") as never)).toBe("String");
    expect(renderTypeRef(LIST(NAMED("Int", "SCALAR")) as never)).toBe("[Int]");
  });
});

describe("needsSelection", () => {
  it("objects need a selection set; scalars and enums don't", () => {
    expect(needsSelection(NON_NULL(LIST(NON_NULL(NAMED("CaseView")))) as never)).toBe(true);
    expect(needsSelection(NON_NULL(NAMED("Boolean", "SCALAR")) as never)).toBe(false);
    expect(needsSelection(NAMED("ReportDomain", "ENUM") as never)).toBe(false);
  });
});

describe("operationSkeleton", () => {
  it("lifts every arg to a typed variable and adds a selection placeholder", () => {
    const field: SchemaField = {
      name: "caseSearch",
      description: null,
      args: [
        { name: "q", type: NAMED("String", "SCALAR") as never },
        { name: "first", type: NON_NULL(NAMED("Int", "SCALAR")) as never },
      ],
      type: NON_NULL(LIST(NON_NULL(NAMED("CaseView")))) as never,
    };
    expect(operationSkeleton(field, "query")).toBe(
      "query CaseSearch($q: String, $first: Int!) {\n" +
      "  caseSearch(q: $q, first: $first) {\n" +
      "    # select fields\n" +
      "  }\n" +
      "}",
    );
  });

  it("a scalar-returning mutation gets no selection block and no arg parens when empty", () => {
    const field: SchemaField = {
      name: "deleteOntologyEntity",
      description: null,
      args: [],
      type: NON_NULL(NAMED("Boolean", "SCALAR")) as never,
    };
    expect(operationSkeleton(field, "mutation")).toBe(
      "mutation DeleteOntologyEntity {\n  deleteOntologyEntity\n}",
    );
  });
});
