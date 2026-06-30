// web/src/lib/drag.test.ts
import { describe, it, expect } from "vitest";
import { hasFiles, dropTarget } from "./drag";

describe("hasFiles", () => {
  it("true when the drag types include Files", () => {
    expect(hasFiles(["Files"])).toBe(true);
    expect(hasFiles(["text/plain", "Files"])).toBe(true);
  });
  it("false for non-file drags, empty, or undefined", () => {
    expect(hasFiles(["text/plain"])).toBe(false);
    expect(hasFiles([])).toBe(false);
    expect(hasFiles(undefined)).toBe(false);
  });
});

describe("dropTarget", () => {
  it("off when busy regardless of peer count", () => {
    expect(dropTarget(1, true)).toBe("off");
    expect(dropTarget(3, true)).toBe("off");
  });
  it("off when there are no peers", () => {
    expect(dropTarget(0, false)).toBe("off");
  });
  it("send for exactly one peer", () => {
    expect(dropTarget(1, false)).toBe("send");
  });
  it("pick for multiple peers", () => {
    expect(dropTarget(2, false)).toBe("pick");
    expect(dropTarget(5, false)).toBe("pick");
  });
});
