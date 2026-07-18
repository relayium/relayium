// web/src/lib/radar-layout.test.ts
import { describe, it, expect } from "vitest";
import { hashId, blipPos } from "./radar-layout";

const dist = (p: { xPct: number; yPct: number }) =>
  Math.hypot(p.xPct - 50, p.yPct - 50);

describe("radar-layout", () => {
  it("hashId is deterministic and unsigned", () => {
    expect(hashId("abc")).toBe(hashId("abc"));
    expect(hashId("abc")).toBeGreaterThanOrEqual(0);
    expect(hashId("abc")).not.toBe(hashId("abd"));
  });

  it("blipPos is deterministic per id", () => {
    expect(blipPos("peer-1")).toEqual(blipPos("peer-1"));
  });

  it("keeps every blip inside the mid-band, off the center node", () => {
    for (const id of ["a", "b", "peer-xyz", "9f3", "long-device-id-42"]) {
      const d = dist(blipPos(id));
      expect(d).toBeGreaterThanOrEqual(20.9); // >= INNER*50 (21) minus fp slack
      expect(d).toBeLessThanOrEqual(41.1);    // <= OUTER*50 (41) plus fp slack
    }
  });

  it("crowded mode quantizes radius to one of two rings", () => {
    const radii = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        Math.round(dist(blipPos(id, true)) * 100) / 100,
      ),
    );
    expect(radii.size).toBeLessThanOrEqual(2);
  });
});
