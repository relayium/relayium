import { describe, it, expect } from "vitest";
import { splitExtension, nextAvailableName } from "./filesink";

describe("splitExtension", () => {
  it("splits a normal name", () => {
    expect(splitExtension("photo.jpg")).toEqual({ base: "photo", ext: ".jpg" });
  });
  it("keeps only the final extension", () => {
    expect(splitExtension("archive.tar.gz")).toEqual({ base: "archive.tar", ext: ".gz" });
  });
  it("treats a name with no dot as all-base", () => {
    expect(splitExtension("README")).toEqual({ base: "README", ext: "" });
  });
  it("treats a leading-dot dotfile as all-base", () => {
    expect(splitExtension(".gitignore")).toEqual({ base: ".gitignore", ext: "" });
  });
});

describe("nextAvailableName", () => {
  it("returns the name unchanged when free", () => {
    expect(nextAvailableName("a.txt", () => false)).toBe("a.txt");
  });
  it("appends ' (1)' before the extension on first collision", () => {
    const taken = new Set(["a.txt"]);
    expect(nextAvailableName("a.txt", (n) => taken.has(n))).toBe("a (1).txt");
  });
  it("increments past a run of collisions", () => {
    const taken = new Set(["a.txt", "a (1).txt", "a (2).txt"]);
    expect(nextAvailableName("a.txt", (n) => taken.has(n))).toBe("a (3).txt");
  });
  it("dedupes extension-less names", () => {
    const taken = new Set(["README"]);
    expect(nextAvailableName("README", (n) => taken.has(n))).toBe("README (1)");
  });
  it("simulates batch dedupe of repeated arrivals", () => {
    const claimed = new Set<string>();
    const names = ["dup.bin", "dup.bin", "dup.bin"];
    const out = names.map((n) => {
      const u = nextAvailableName(n, (x) => claimed.has(x));
      claimed.add(u);
      return u;
    });
    expect(out).toEqual(["dup.bin", "dup (1).bin", "dup (2).bin"]);
  });
});
