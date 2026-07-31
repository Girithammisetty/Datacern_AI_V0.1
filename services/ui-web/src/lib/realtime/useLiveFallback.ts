"use client";
/**
 * Poll only when the live spine is NOT carrying the data.
 *
 * The spine already exists and is well adopted: eleven screens subscribe via
 * useHubTopics, events are patched into the shared QueryClient, and there is no
 * raw EventSource anywhere outside lib/realtime. What was left was polling that
 * ran REGARDLESS — `useIngestions` refetched every 5s while the same screen was
 * already receiving ingestion.* pushes, with a comment calling the poll "a
 * fallback to the realtime topics". A fallback that runs when the primary is
 * healthy is not a fallback; it is a second data path, and the cost is real:
 * every subscriber pays a request every 5s forever, and the two paths can
 * disagree about what the truth is mid-flight.
 *
 * useRealtimeHealth already carries the answer. connection.ts flips `degraded`
 * when the stream drops and clears it on reconnect (UI-FR-012 / BR-5), and
 * useHubTopics invalidates queries on reconnect so nothing stays stale. So the
 * honest rule is: while the stream is healthy, do not poll at all; when it
 * degrades, fall back to the interval the screen would have used anyway.
 *
 * WHAT THIS IS NOT FOR. Data with no hub topic — the notification unread count
 * has no push channel — must keep its unconditional interval. Passing that
 * through here would silently stop refreshing it the moment the hub looked
 * healthy, which is the opposite of the intent. Only use this where a topic
 * genuinely covers the same data.
 */
import { useRealtimeHealth } from "@/stores/ui";

/**
 * @param fallbackMs interval to use while the stream is degraded.
 * @returns `false` when the spine is healthy (React Query treats that as "do
 *          not poll"), otherwise `fallbackMs`.
 */
export function useLiveFallbackInterval(fallbackMs: number): number | false {
  const degraded = useRealtimeHealth((s) => s.degraded);
  return degraded ? fallbackMs : false;
}
