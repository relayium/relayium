// A dropped folder arrives whole, or it does not arrive.
//
// `walk` had two ways to fail that looked like success. A file whose `.file()`
// errored resolved to null and was left out of the batch. A directory page whose
// `readEntries` errored resolved to `[]` — and an empty batch is how that API
// signals END OF DIRECTORY, so a read error truncated the folder and was
// indistinguishable from having read all of it.
//
// Either one sends a person's folder minus the parts that could not be read,
// with nothing on screen to say so. macOS states the rule outright: "A batch is
// admitted whole or not at all."
//
// None of this was tested at all — including the pagination the walk's own
// comment describes, which is why that is asserted here too.

import { describe, expect, it } from "vitest";
import { pickedFromDrop } from "../../src/renderer/send/picked-files.js";

/** A file entry that hands over a File, or fails the way Chromium fails. */
function fileEntry(name: string, ok = true): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (f: File) => void, reject: (e: unknown) => void) =>
      ok ? resolve(new File([name], name)) : reject(new Error("unreadable")),
  } as unknown as FileSystemEntry;
}

/**
 * A directory that yields its children in PAGES, like the real reader.
 *
 * `pages` is what each successive `readEntries` produces; `null` means that
 * call errors, which is the case the old code read as "no more files".
 */
function dirEntry(name: string, pages: (FileSystemEntry[] | null)[]): FileSystemEntry {
  let at = 0;
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (resolve: (e: FileSystemEntry[]) => void, reject: (e: unknown) => void) => {
        const page = at < pages.length ? pages[at++] : [];
        if (page === null) reject(new Error("unreadable"));
        else resolve(page!);
      },
    }),
  } as unknown as FileSystemEntry;
}

function drop(entries: FileSystemEntry[]): DataTransfer {
  return {
    items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
    files: [],
  } as unknown as DataTransfer;
}

describe("a drop that can be read", () => {
  it("keeps each file's path inside the folder it came from", async () => {
    const result = await pickedFromDrop(
      drop([dirEntry("docs", [[fileEntry("note.txt"), dirEntry("sub", [[fileEntry("deep.txt")], []])], []])]),
    );
    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(result.files.map((f) => f.path)).toEqual(["docs/note.txt", "docs/sub/deep.txt"]);
  });

  // The walk's own comment: "Reading once is the bug that makes a large dropped
  // folder arrive with exactly its first hundred files."
  it("reads every PAGE of a directory, not just the first", async () => {
    const result = await pickedFromDrop(
      drop([dirEntry("many", [[fileEntry("a")], [fileEntry("b")], [fileEntry("c")], []])]),
    );
    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(result.files.map((f) => f.path)).toEqual(["many/a", "many/b", "many/c"]);
  });

  it("takes a plain file drop with no directory entries", async () => {
    const transfer = { items: [], files: [new File(["x"], "x.txt")] } as unknown as DataTransfer;
    const result = await pickedFromDrop(transfer);
    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(result.files.map((f) => f.path)).toEqual(["x.txt"]);
  });
});

describe("a drop that cannot be read whole", () => {
  it("offers nothing when one file in the tree cannot be handed over", async () => {
    const result = await pickedFromDrop(
      drop([dirEntry("docs", [[fileEntry("fine.txt"), fileEntry("locked.txt", false)], []])]),
    );
    // Not "two files minus one". Nothing.
    expect(result.complete).toBe(false);
  });

  // The worse of the two, because the old code could not tell this from success:
  // an errored page resolved to `[]`, which means end-of-directory.
  it("offers nothing when a directory page errors, rather than stopping early", async () => {
    const result = await pickedFromDrop(
      drop([dirEntry("big", [[fileEntry("first")], null, [fileEntry("third")]])]),
    );
    expect(result.complete).toBe(false);
  });

  it("refuses the WHOLE drop, not just the folder that failed", async () => {
    // Two roots, one good. A caller offered the good one would send half of
    // what the person dropped and say nothing about the rest.
    const result = await pickedFromDrop(
      drop([dirEntry("good", [[fileEntry("a")], []]), dirEntry("bad", [null])]),
    );
    expect(result.complete).toBe(false);
  });
});

describe("a drop with nothing in it", () => {
  it("is complete and empty, which is not the same as refused", async () => {
    const result = await pickedFromDrop(null);
    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(result.files).toEqual([]);
  });
});
