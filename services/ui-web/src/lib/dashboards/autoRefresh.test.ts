import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  formatAgo,
  readRefreshInterval,
  refreshMs,
  useRefreshInterval,
  writeRefreshInterval,
} from "./autoRefresh";

beforeEach(() => window.localStorage.clear());

describe("refreshMs", () => {
  it("maps interval ids to milliseconds, off => false", () => {
    expect(refreshMs("off")).toBe(false);
    expect(refreshMs("30s")).toBe(30_000);
    expect(refreshMs("1m")).toBe(60_000);
    expect(refreshMs("5m")).toBe(300_000);
  });
});

describe("auto-refresh interval selection (persisted per dashboard)", () => {
  it("defaults to off and persists a chosen interval", () => {
    expect(readRefreshInterval("dash-1")).toBe("off");
    const { result } = renderHook(() => useRefreshInterval("dash-1"));
    expect(result.current.interval).toBe("off");

    act(() => result.current.setInterval("1m"));
    expect(result.current.interval).toBe("1m");
    // Persisted per dashboard id, not globally.
    expect(readRefreshInterval("dash-1")).toBe("1m");
    expect(readRefreshInterval("dash-2")).toBe("off");
  });

  it("ignores a corrupt stored value", () => {
    writeRefreshInterval("dash-1", "5m");
    window.localStorage.setItem("datacern.dashboards.refresh.dash-1", "banana");
    expect(readRefreshInterval("dash-1")).toBe("off");
  });
});

describe("formatAgo", () => {
  const now = 1_000_000_000_000;
  it("renders coarse relative units", () => {
    expect(formatAgo(now, now)).toBe("0s");
    expect(formatAgo(now - 5_000, now)).toBe("5s");
    expect(formatAgo(now - 120_000, now)).toBe("2m");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h");
  });
  it("returns null when there is no timestamp", () => {
    expect(formatAgo(null, now)).toBeNull();
  });
});
