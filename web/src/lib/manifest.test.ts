import { describe, expect, it } from "vitest";
import { MAX_FILES, manifestTotal, validateManifestFiles } from "./manifest";

describe("manifest validation", () => {
  it("accepts a bounded non-empty manifest and returns its exact total", () => {
    const files = [{ name: "a", size: 2 }, { name: "b", size: 3 }];
    expect(validateManifestFiles(files)).toBe(files);
    expect(manifestTotal(files)).toBe(5);
  });

  const malformed: unknown[] = [
    [],
    [{ name: "", size: 1 }],
    [{ name: "a", size: -1 }],
    [{ name: "a", size: 1.5 }],
    [{ name: "a", size: Number.MAX_SAFE_INTEGER }, { name: "b", size: 1 }],
  ];

  it.each(malformed)("rejects malformed files %#", (files) => {
    expect(() => validateManifestFiles(files)).toThrow();
  });

  it("rejects an entry count above the protocol cap", () => {
    expect(() => validateManifestFiles(Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `${i}`, size: 0 })))).toThrow();
  });
});
