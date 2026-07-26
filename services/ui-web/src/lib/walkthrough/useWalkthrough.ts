"use client";
import { useQuery } from "@tanstack/react-query";
import type { WalkthroughResponse, WalkthroughStep } from "./types";

/**
 * Fetches the caller tenant's guided-walkthrough steps (DSP-FR-015) through
 * the same-origin proxy (src/app/api/tenant-walkthrough/route.ts), which
 * forwards to identity-service GET /tenants/self/walkthrough. Deliberately
 * NOT a graphqlRequest call (src/lib/graphql/client.ts) — this is a plain
 * REST endpoint on identity-service, not bff-graphql, so it gets its own
 * small fetcher rather than forcing a GraphQL field onto the schema for one
 * Should-have, tenant-scoped, admin-free read.
 *
 * `enabled` should be gated on `session.profile === "demo"` by the caller
 * (mirrors DemoWatermarkBanner's own gate) so non-demo tenants never issue
 * the request at all, even though the endpoint itself is safe to call
 * unconditionally (it 200s with `{steps: []}` for a non-demo tenant too).
 */
export function useWalkthrough(enabled: boolean) {
  return useQuery({
    queryKey: ["demo", "walkthrough"] as const,
    queryFn: async (): Promise<WalkthroughStep[]> => {
      const res = await fetch("/api/tenant-walkthrough");
      if (!res.ok) throw new Error(`walkthrough fetch failed: ${res.status}`);
      const body = (await res.json()) as WalkthroughResponse;
      return body.steps ?? [];
    },
    enabled,
    staleTime: 5 * 60_000,
    // A missing/broken walkthrough is never worth retrying aggressively or
    // surfacing an error UI for — it's a Should-have tour, not core function.
    retry: 1,
  });
}
