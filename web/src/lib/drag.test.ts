// web/src/lib/drag.test.ts
import { describe, it, expect } from "vitest";
import { hasFiles, dropTarget, pickedFromInput, walkEntry, type FsEntryLike } from "./drag";

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

describe("pickedFromInput", () => {
  const withRel = (name: string, rel: string) =>
    Object.assign(new File([], name), { webkitRelativePath: rel });

  it("keeps a nested webkitRelativePath as the path", () => {
    const picked = pickedFromInput([withRel("a.jpg", "trip/day1/a.jpg")]);
    expect(picked).toEqual([{ file: expect.any(File), path: "trip/day1/a.jpg" }]);
  });
  it("treats a plain multi-file pick (empty relPath) as flat", () => {
    const picked = pickedFromInput([new File([], "a.txt"), new File([], "b.txt")]);
    expect(picked.map((p) => p.path)).toEqual([undefined, undefined]);
  });
});

// Build a fake FileSystemEntry tree so walkEntry's recursion is testable sans DOM.
function fileEntry(fullPath: string): FsEntryLike {
  const name = fullPath.split("/").pop()!;
  return { isFile: true, isDirectory: false, fullPath, file: (ok) => ok(new File([], name)) };
}
function dirEntry(fullPath: string, children: FsEntryLike[]): FsEntryLike {
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader: () => {
      let served = false;
      // First readEntries call returns all children; the second returns [] (done).
      return { readEntries: (ok) => { ok(served ? [] : children); served = true; } };
    },
  };
}

describe("walkEntry", () => {
  it("flattens a directory tree into files with relative paths", async () => {
    const tree = dirEntry("/photos", [
      fileEntry("/photos/a.jpg"),
      dirEntry("/photos/sub", [fileEntry("/photos/sub/b.jpg")]),
    ]);
    const picked = await walkEntry(tree);
    expect(picked.map((p) => p.path)).toEqual(["photos/a.jpg", "photos/sub/b.jpg"]);
  });

  it("treats a top-level dropped file as flat (no path)", async () => {
    const picked = await walkEntry(fileEntry("/loose.txt"));
    expect(picked).toEqual([{ file: expect.any(File), path: undefined }]);
  });
});
