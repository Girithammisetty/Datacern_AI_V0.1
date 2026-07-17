"use client";
/**
 * Subscribe a screen to a set of realtime-hub topics. Events are routed through
 * the EventBridge (dispatchEvent → patchers) into the shared QueryClient; the
 * hook returns nothing to render — status appears through the patched caches
 * (UI-FR-012, no polling). Degradation flips the global "live paused" flag (BR-5),
 * and a reconnect invalidates active queries so nothing shows a stale "running".
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openHubStream, type HubStream } from "./connection";
import { dispatchEvent } from "./patchers";
import { useRealtimeHealth } from "@/stores/ui";

export function useHubTopics(topics: string[], enabled = true) {
  const client = useQueryClient();
  const setDegraded = useRealtimeHealth((s) => s.setDegraded);
  const streamRef = useRef<HubStream | null>(null);
  const key = topics.slice().sort().join("|");

  useEffect(() => {
    if (!enabled || topics.length === 0) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    const stream = openHubStream({
      topics,
      handlers: {
        // Bridge the hub wire frame → the EventBridge patcher contract. The hub
        // names each SSE frame by its *subscription topic* (e.g.
        // "run-status:<urn>") and delivers ClientBody data
        // `{event_type, payload, resource_urn, occurred_at}` (see realtime-hub
        // events.ClientBody + TestAC01). Patchers, however, key on the
        // *event_type* prefix ("case.", "dataset.", …) and read a flat payload.
        // Before this translation the subscription-topic was passed straight
        // through, so no patcher's `match` ever fired on a real frame — the
        // whole SSE→cache patch path was dead post the task-#78 grammar fix
        // (which correctly moved subscriptions to run-status:<urn> but left the
        // match layer on the old event-type topics). Task #81 restores it here.
        onEvent: (_subTopic, frame) => {
          if (!frame || typeof frame !== "object") return;
          const f = frame as { event_type?: string; payload?: Record<string, unknown>; resource_urn?: string };
          const eventType = f.event_type;
          if (!eventType) return; // chat / non-status frames aren't patcher events
          const payload = (f.payload ?? {}) as Record<string, unknown>;
          // Most producers key their resource by the URN, not a payload id; the
          // trailing "…/<id>" segment is the stable resource id the patchers
          // look up (case id, dataset id, job id, …).
          const urnId =
            typeof f.resource_urn === "string" ? f.resource_urn.split("/").pop() : undefined;
          const data = { ...payload, event_type: eventType, resource_urn: f.resource_urn } as Record<string, unknown>;
          if (data.id == null && urnId) data.id = urnId;
          dispatchEvent(client, { topic: eventType, data });
        },
        onState: (state) => setDegraded(state === "degraded"),
        onReconnect: () => {
          // Recovery guard: refetch everything active so no stale frame lingers.
          void client.invalidateQueries();
          setDegraded(false);
        },
      },
    });
    streamRef.current = stream;
    return () => {
      stream.close();
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
}
