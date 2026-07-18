"use client";
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Input, Label } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session/SessionContext";
import { useAgentCeilings, useSetAgentCeilings } from "@/lib/graphql/hooks";
import { useToasts } from "@/stores/ui";
import { GraphQLRequestError } from "@/lib/graphql/client";

/**
 * BRD 53 inc3 — the platform-ceiling operator console. Operator-only: these are
 * the maximums that clamp EVERY tenant custom agent's guardrail envelope (BR-8),
 * so no tenant setting can raise autonomy/budget above the operator's bar. The
 * card renders only for platform operators; the API re-checks the scope.
 */
export function OperatorCeilingsCard() {
  const { scopes } = useSession();
  const isOperator = scopes.includes("operator") || scopes.includes("platform.admin");
  const query = useAgentCeilings(isOperator);
  const setCeilings = useSetAgentCeilings();
  const push = useToasts((s) => s.push);
  const [budget, setBudget] = useState("");

  useEffect(() => {
    if (query.data) setBudget(String(query.data.maxBudgetTokens));
  }, [query.data]);

  if (!isOperator) return null; // not an operator — nothing to govern here

  const submit = () => {
    const n = Number(budget);
    if (!Number.isInteger(n) || n < 128) {
      push({ title: "Budget ceiling must be a whole number of at least 128", variant: "error" });
      return;
    }
    setCeilings.mutate(
      { maxBudgetTokens: n, maxTier: query.data?.maxTier ?? "write-proposal" },
      { onSuccess: () => push({ title: "Platform ceilings updated", variant: "success" }) },
    );
  };

  const error = setCeilings.error instanceof GraphQLRequestError ? setCeilings.error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="size-4" aria-hidden /> Platform agent ceilings
        </CardTitle>
        <CardDescription>
          Operator maximums that clamp every tenant custom agent. No tenant setting can exceed these.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => query.refetch()}
        >
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ceiling-budget">Max tokens per session</Label>
              <Input
                id="ceiling-budget"
                type="number"
                min={128}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Max autonomy</Label>
              <p className="flex h-9 items-center text-sm text-muted-foreground">
                {query.data?.maxTier ?? "write-proposal"} (custom-agent hard cap)
              </p>
            </div>
            <Button size="sm" onClick={submit} disabled={setCeilings.isPending}>
              {setCeilings.isPending ? "Saving…" : "Save ceilings"}
            </Button>
          </div>
          {query.data?.updatedBy && (
            <p className="mt-2 text-xs text-muted-foreground">Last set by {query.data.updatedBy}.</p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">{error.message}</p>
          )}
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}
