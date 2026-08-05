import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  pushRecent,
  readFavorites,
  readRecent,
  useDashboardFavorites,
  writeFavorites,
} from "./favorites";

beforeEach(() => window.localStorage.clear());

describe("favorites persistence", () => {
  it("persists the starred set per (tenant, user)", () => {
    writeFavorites("t-acme", "u", ["d1", "d2"]);
    expect(readFavorites("t-acme", "u")).toEqual(["d1", "d2"]);
    // Isolated by tenant+user.
    expect(readFavorites("t-other", "u")).toEqual([]);
  });

  it("toggle adds then removes an id and writes through to storage", () => {
    const { result } = renderHook(() => useDashboardFavorites("t-acme", "u"));
    act(() => result.current.toggle("d1"));
    expect(result.current.favoriteIds).toContain("d1");
    expect(readFavorites("t-acme", "u")).toEqual(["d1"]);

    act(() => result.current.toggle("d1"));
    expect(result.current.favoriteIds).not.toContain("d1");
    expect(readFavorites("t-acme", "u")).toEqual([]);
  });

  it("survives corrupt storage without throwing", () => {
    window.localStorage.setItem("datacern.dashboards.favorites.t-acme.u", "{not json");
    expect(readFavorites("t-acme", "u")).toEqual([]);
  });
});

describe("recently-viewed MRU", () => {
  it("moves a re-viewed dashboard to the front and dedupes", () => {
    pushRecent("t-acme", "u", { id: "a", title: "A" });
    pushRecent("t-acme", "u", { id: "b", title: "B" });
    pushRecent("t-acme", "u", { id: "a", title: "A" });
    expect(readRecent("t-acme", "u").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("caps at five entries", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
      pushRecent("t-acme", "u", { id, title: id.toUpperCase() });
    }
    const recent = readRecent("t-acme", "u");
    expect(recent).toHaveLength(5);
    // Most-recent first: g, f, e, d, c.
    expect(recent.map((r) => r.id)).toEqual(["g", "f", "e", "d", "c"]);
  });
});
