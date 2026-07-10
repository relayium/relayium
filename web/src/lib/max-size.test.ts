import { describe, it, expect } from "vitest";
import { maxSizeHint } from "./max-size";

describe("maxSizeHint", () => {
  it("formats a positive max", () => {
    expect(maxSizeHint(200 * 1024 * 1024)).not.toBe("");
    expect(maxSizeHint(200 * 1024 * 1024)).toContain("MB");
  });
  it("returns empty for 0/negative", () => {
    expect(maxSizeHint(0)).toBe("");
    expect(maxSizeHint(-5)).toBe("");
  });
});
