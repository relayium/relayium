import { describe, expect, it } from "vitest";
import { progressPercent } from "./progress-percent";

describe("progressPercent", () => {
  it("never shows 100 before the result is confirmed", () => {
    expect(progressPercent(100, 100, false)).toBe(99);
    expect(progressPercent(999_999, 1_000_000, false)).toBe(99); // rounds to 100
    expect(progressPercent(120, 100, false)).toBe(99); // over-reported bytes
  });

  it("shows 100 once confirmed", () => {
    expect(progressPercent(100, 100, true)).toBe(100);
    expect(progressPercent(0, 0, true)).toBe(100);
  });

  it("reports ordinary progress unchanged", () => {
    expect(progressPercent(0, 100, false)).toBe(0);
    expect(progressPercent(50, 100, false)).toBe(50);
    expect(progressPercent(0, 0, false)).toBe(0);
    expect(progressPercent(40, 100, true)).toBe(40); // a confirmed failure stays where it stopped
  });
});
