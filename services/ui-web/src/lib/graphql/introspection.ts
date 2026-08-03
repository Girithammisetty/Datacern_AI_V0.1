/**
 * API explorer (ease-of-use initiative, technical fast lane) — introspection
 * helpers.
 *
 * The explorer reads the LIVE schema via standard GraphQL introspection, so it
 * can never drift from the deployed BFF (unlike bundling the schema.graphql
 * snapshot into the UI). Introspection is env-gated on the BFF (off in prod by
 * default) — the page shows that state honestly instead of an error.
 */

/** Nested deep enough for the worst real shape: [Type!]! (4 levels). */
const TYPE_REF = /* GraphQL */ `
  kind name ofType { kind name ofType { kind name ofType { kind name } } }
`;

export const API_SCHEMA = /* GraphQL */ `
  query ApiSchema {
    __schema {
      queryType {
        fields {
          name description
          args { name description type { ${TYPE_REF} } }
          type { ${TYPE_REF} }
        }
      }
      mutationType {
        fields {
          name description
          args { name description type { ${TYPE_REF} } }
          type { ${TYPE_REF} }
        }
      }
    }
  }
`;

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}

export interface SchemaArg {
  name: string;
  description?: string | null;
  type: TypeRef;
}

export interface SchemaField {
  name: string;
  description?: string | null;
  args: SchemaArg[];
  type: TypeRef;
}

export interface ApiSchemaResult {
  __schema: {
    queryType: { fields: SchemaField[] } | null;
    mutationType: { fields: SchemaField[] } | null;
  };
}

/** "[CaseView!]!" from a nested introspection type ref. */
export function renderTypeRef(t: TypeRef | null | undefined): string {
  if (!t) return "";
  if (t.kind === "NON_NULL") return `${renderTypeRef(t.ofType)}!`;
  if (t.kind === "LIST") return `[${renderTypeRef(t.ofType)}]`;
  return t.name ?? "";
}

/** The innermost named type (to know whether a selection set is needed). */
function unwrap(t: TypeRef | null | undefined): TypeRef | null {
  let cur = t ?? null;
  while (cur?.ofType) cur = cur.ofType;
  return cur;
}

/** Whether the field's return type needs a `{ … }` selection set. */
export function needsSelection(t: TypeRef): boolean {
  const inner = unwrap(t);
  return inner?.kind === "OBJECT" || inner?.kind === "INTERFACE" || inner?.kind === "UNION";
}

/**
 * A ready-to-paste operation skeleton with every argument lifted to a typed
 * variable — the copy-paste fast lane for engineers:
 *
 *   query CaseSearch($q: String, $first: Int!) {
 *     caseSearch(q: $q, first: $first) {
 *       # select fields
 *     }
 *   }
 */
export function operationSkeleton(field: SchemaField, kind: "query" | "mutation"): string {
  const opName = field.name.charAt(0).toUpperCase() + field.name.slice(1);
  const varDefs = field.args.map((a) => `$${a.name}: ${renderTypeRef(a.type)}`).join(", ");
  const argList = field.args.map((a) => `${a.name}: $${a.name}`).join(", ");
  const head = `${kind} ${opName}${varDefs ? `(${varDefs})` : ""}`;
  const call = `${field.name}${argList ? `(${argList})` : ""}`;
  if (!needsSelection(field.type)) return `${head} {\n  ${call}\n}`;
  return `${head} {\n  ${call} {\n    # select fields\n  }\n}`;
}
