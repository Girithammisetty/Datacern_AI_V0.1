import { describe, expect, it } from "vitest";

import { MARKETING_PACKS, PACK_INDUSTRIES, SOLUTION_PACK_COUNT } from "./packs.gen";

/** Shape guarantees for the GENERATED catalog. The generator's --check in CI
 * catches drift against the manifests; these tests catch a generator bug that
 * would render a broken /solutions page (empty groups, duplicate slugs, blurbs
 * that are whole manifest paragraphs). */

describe("generated marketing pack catalog", () => {
  it("carries every pack exactly once", () => {
    const slugs = MARKETING_PACKS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // 27 solution packs + the investigation-framework library ship today; more
    // may be added, never silently fewer.
    expect(SOLUTION_PACK_COUNT).toBeGreaterThanOrEqual(27);
    expect(MARKETING_PACKS.length).toBeGreaterThanOrEqual(28);
  });

  it("every solution pack belongs to a listed industry", () => {
    for (const p of MARKETING_PACKS.filter((x) => x.kind === "solution")) {
      expect(PACK_INDUSTRIES, `industry of ${p.slug}`).toContain(p.industry);
    }
  });

  it("every industry in the display order is non-empty", () => {
    for (const ind of PACK_INDUSTRIES) {
      expect(
        MARKETING_PACKS.some((p) => p.industry === ind),
        `industry ${ind} has no packs`,
      ).toBe(true);
    }
  });

  it("blurbs are headlines, not manifest paragraphs", () => {
    for (const p of MARKETING_PACKS) {
      expect(p.blurb.length, `blurb of ${p.slug}`).toBeGreaterThan(20);
      expect(p.blurb.length, `blurb of ${p.slug}`).toBeLessThanOrEqual(180);
      expect(p.title.length, `title of ${p.slug}`).toBeGreaterThan(2);
      expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
