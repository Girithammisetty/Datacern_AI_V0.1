"use client";
/**
 * API explorer (ease-of-use initiative, technical fast lane): a read-only,
 * searchable catalog of every query and mutation the BFF serves, read from the
 * LIVE schema via introspection so it can never drift from the deployment.
 * Each operation shows its signature + the schema's own docstring (the schema
 * is richly documented, honesty notes included) and copies a ready-to-paste
 * skeleton with typed variables.
 *
 * Read-only by design — no execution surface. Introspection is env-gated on
 * the BFF (off in prod by default); that state renders honestly, pointing at
 * the checked-in snapshot instead.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Braces, Check, Copy, Search } from "lucide-react";

import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Input } from "@/components/ui/primitives";
import { graphqlRequest } from "@/lib/graphql/client";
import {
  API_SCHEMA, operationSkeleton, renderTypeRef,
  type ApiSchemaResult, type SchemaField,
} from "@/lib/graphql/introspection";

function OperationRow({ field, kind }: { field: SchemaField; kind: "query" | "mutation" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(operationSkeleton(field, kind));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — nothing to fake.
    }
  };
  return (
    <li className="rounded-md border border-border/60 px-3 py-2" data-testid={`op-${field.name}`}>
      <div className="flex items-start justify-between gap-2">
        <code className="min-w-0 break-words text-sm">
          <span className="font-semibold">{field.name}</span>
          {field.args.length > 0 && (
            <span className="text-muted-foreground">
              ({field.args.map((a) => `${a.name}: ${renderTypeRef(a.type)}`).join(", ")})
            </span>
          )}
          <span className="text-muted-foreground">: {renderTypeRef(field.type)}</span>
        </code>
        <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={copy}
                aria-label={`Copy ${field.name} skeleton`}>
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {field.description && (
        <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{field.description}</p>
      )}
    </li>
  );
}

export default function ApiExplorerPage() {
  const [q, setQ] = useState("");
  const schema = useQuery({
    queryKey: ["platform", "apiSchema"],
    queryFn: () => graphqlRequest<ApiSchemaResult>(API_SCHEMA),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const needle = q.trim().toLowerCase();
  const filter = (fields: SchemaField[] | undefined) =>
    (fields ?? []).filter(
      (f) => !needle
        || f.name.toLowerCase().includes(needle)
        || (f.description ?? "").toLowerCase().includes(needle),
    );
  const queries = useMemo(
    () => filter(schema.data?.__schema.queryType?.fields),
    [schema.data, needle], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const mutations = useMemo(
    () => filter(schema.data?.__schema.mutationType?.fields),
    [schema.data, needle], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="API explorer"
        description="Every query and mutation the platform's GraphQL API serves, read live from the deployment — searchable, documented, and copy-paste ready. Read-only: nothing here executes."
      />

      {schema.isError ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Introspection is disabled on this deployment.</p>
            <p className="mt-1">
              The API schema can&apos;t be read live (the BFF ships with introspection off in
              production). The checked-in snapshot at{" "}
              <code>services/bff-graphql/schema.graphql</code> is the same contract, versioned
              with the code.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="relative max-w-md">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input
              aria-label="Search operations"
              className="pl-8"
              placeholder="Search operations by name or description…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {schema.isLoading && <p className="text-sm text-muted-foreground">Reading the live schema…</p>}

          {!schema.isLoading && (
            <div className="grid gap-6 lg:grid-cols-2">
              {([["Queries", queries, "query"], ["Mutations", mutations, "mutation"]] as const).map(
                ([title, fields, kind]) => (
                  <section key={title} aria-label={title}>
                    <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                      <Braces className="size-4 text-muted-foreground" aria-hidden />
                      {title}
                      <Badge variant="secondary" className="text-[10px] tabular-nums">{fields.length}</Badge>
                    </h2>
                    {fields.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No matches.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {fields.map((f) => (
                          <OperationRow key={f.name} field={f} kind={kind} />
                        ))}
                      </ul>
                    )}
                  </section>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
