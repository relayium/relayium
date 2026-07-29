import { describe, it, expect } from "vitest";
import { RELATED } from "./content/related-map.mjs";
import { articles } from "../gen-pages.mjs";

const slugs = articles.map((a) => a.slug);
const slugSet = new Set(slugs);

describe("curated related-article map", () => {
  it("covers every article", () => {
    const missing = slugs.filter((s) => !RELATED[s]);
    expect(missing).toEqual([]);
  });

  it("has no entry for an article that does not exist", () => {
    const stale = Object.keys(RELATED).filter((s) => !slugSet.has(s));
    expect(stale).toEqual([]);
  });

  it("points every link at a real article", () => {
    const dead = [];
    for (const [from, targets] of Object.entries(RELATED)) {
      for (const t of targets) if (!slugSet.has(t)) dead.push(`${from} -> ${t}`);
    }
    expect(dead).toEqual([]);
  });

  it("never links an article to itself", () => {
    const self = Object.entries(RELATED)
      .filter(([from, targets]) => targets.includes(from))
      .map(([from]) => from);
    expect(self).toEqual([]);
  });

  it("lists no duplicates within one article's block", () => {
    const dupes = Object.entries(RELATED)
      .filter(([, targets]) => new Set(targets).size !== targets.length)
      .map(([from]) => from);
    expect(dupes).toEqual([]);
  });

  it("keeps each block small enough to read as a recommendation", () => {
    // The whole point of the curation: a wall of links is not a recommendation.
    // 3-5 keeps the CTA above it as the page's single obvious next step.
    const wrongSize = Object.entries(RELATED)
      .filter(([, t]) => t.length < 3 || t.length > 5)
      .map(([from, t]) => `${from} (${t.length})`);
    expect(wrongSize).toEqual([]);
  });

  it("reaches every article from at least one other article", () => {
    // Trimming to 4 links each must not strand an article with the /guides/ hub
    // as its only inbound link — that is the "Discovered - currently not
    // indexed" shape.
    const linked = new Set(Object.values(RELATED).flat());
    expect(slugs.filter((s) => !linked.has(s))).toEqual([]);
  });

  it("does not collapse into three disconnected category islands", () => {
    // A compare page whose every recommendation is another compare page tells
    // Google the three groups are unrelated. Each block should leave its own
    // category at least once.
    const siloed = Object.entries(RELATED)
      .filter(([from, targets]) => {
        const cat = from.split("/")[0];
        return targets.every((t) => t.split("/")[0] === cat);
      })
      .map(([from]) => from);
    expect(siloed).toEqual([]);
  });
});
