import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRealtimeHealth } from "@/stores/ui";
import { useLiveFallbackInterval } from "./useLiveFallback";

/**
 * A fallback that runs while the primary is healthy is not a fallback — it is a
 * second data path. useIngestions polled every 5s with a comment calling itself
 * "a fallback to the ingestion.* realtime topics" while the same screen was
 * already receiving those pushes: every viewer paid a request every 5s forever,
 * and the two paths could disagree mid-flight.
 */
describe("useLiveFallbackInterval", () => {
  beforeEach(() => useRealtimeHealth.setState({ degraded: false }));

  it("does not poll while the stream is healthy", () => {
    const { result } = renderHook(() => useLiveFallbackInterval(5_000));
    // false is React Query's "do not poll" — not 0, which would poll as fast as
    // it can and is the easy mistake here.
    expect(result.current).toBe(false);
    expect(result.current).not.toBe(0);
  });

  it("falls back to the interval when the stream degrades", () => {
    useRealtimeHealth.setState({ degraded: true });
    const { result } = renderHook(() => useLiveFallbackInterval(5_000));
    expect(result.current).toBe(5_000);
  });

  it("tracks the flag both ways, so recovery stops the polling again", () => {
    const { result, rerender } = renderHook(() => useLiveFallbackInterval(5_000));
    expect(result.current).toBe(false);
    useRealtimeHealth.setState({ degraded: true });
    rerender();
    expect(result.current).toBe(5_000);
    // Reconnect must END the fallback; a poll that never stops after one blip
    // is how "temporary" degradation becomes permanent load.
    useRealtimeHealth.setState({ degraded: false });
    rerender();
    expect(result.current).toBe(false);
  });
});
