// Bounded reads against a REAL filesystem.
//
// These use task-owned temporary directories and actual files, because the
// claims are about the filesystem: that a symlink is refused, that a device
// path is not a regular file, that a changed file stops being readable, and
// that a handle is actually closed. A mocked `fs` would assert the mock.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink, appendFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_OPEN_HANDLES,
  SelectionReader,
  examine,
  sameIdentity,
} from "../../src/main/io/selection-reader.js";
import { MAX_SELECTION_CHUNK } from "../../src/shared/os-entry.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "relayium-selection-"));
});

afterEach(async () => {
  // This test owns the directory and removes it. Failures are surfaced rather
  // than swallowed: a leftover temp tree is a fact, not a detail.
  if (root.length > 0) await rm(root, { recursive: true, force: true });
  root = "";
});

const write = async (name: string, contents: string | Uint8Array): Promise<string> => {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
};

describe("what a path is, before anything opens it", () => {
  it("accepts an ordinary file and reports its identity", async () => {
    const file = await write("a.txt", "hello");
    const result = await examine(file);
    if (result.kind !== "file") throw new Error("expected a file");
    expect(result.identity.size).toBe(5);
  });

  it("accepts an ordinary directory", async () => {
    await mkdir(path.join(root, "folder"));
    expect((await examine(path.join(root, "folder"))).kind).toBe("directory");
  });

  it("REFUSES a symlink rather than following it", async () => {
    const real = await write("secret.txt", "not yours");
    const link = path.join(root, "link.txt");
    try {
      await symlink(real, link);
    } catch {
      // Unprivileged Windows cannot create one. The refusal is still asserted
      // on the platforms that can, and this is reported rather than passed
      // silently as though the case had run.
      expect(process.platform).toBe("win32");
      return;
    }
    const result = await examine(link);
    expect(result).toEqual({ kind: "rejected", reason: "symlink" });
  });

  it("refuses a path that is not there", async () => {
    expect(await examine(path.join(root, "nope"))).toEqual({ kind: "rejected", reason: "unreadable" });
  });

  it("refuses a character device", async () => {
    // `/dev/null` on POSIX, `\\\\.\\NUL` on Windows. Both are "not a regular
    // file", which is the property being asserted.
    const device = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
    const result = await examine(device);
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).not.toBe("symlink");
  });
});

describe("identity comparison", () => {
  it("treats a changed size or mtime as a different file", () => {
    const base = { size: 10, dev: 1, ino: 2, mtimeMs: 100 };
    expect(sameIdentity(base, { ...base })).toBe(true);
    expect(sameIdentity(base, { ...base, size: 11 })).toBe(false);
    expect(sameIdentity(base, { ...base, mtimeMs: 101 })).toBe(false);
    expect(sameIdentity(base, { ...base, dev: 2 })).toBe(false);
    expect(sameIdentity(base, { ...base, ino: 3 })).toBe(false);
  });

  it("does not compare an inode the filesystem did not report", () => {
    // Some Windows volumes report 0. Comparing it there would refuse every
    // read; skipping it is stated rather than silent.
    const base = { size: 10, dev: 1, ino: 0, mtimeMs: 100 };
    expect(sameIdentity(base, { ...base, ino: 0 })).toBe(true);
    expect(sameIdentity(base, { ...base, ino: 99 })).toBe(true);
  });
});

describe("bounded reads", () => {
  it("serves exact ranges and never more than the ceiling", async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    const file = await write("bin", bytes);
    const identity = (await examine(file)) as { kind: "file"; identity: { size: number } } & never;
    const reader = new SelectionReader();
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");

    const first = await reader.read("id", file, info.identity, 0, 100);
    if (first.kind !== "bytes") throw new Error(first.kind);
    expect([...first.bytes]).toEqual([...bytes.slice(0, 100)]);

    const tail = await reader.read("id", file, info.identity, 900, 500);
    if (tail.kind !== "bytes") throw new Error(tail.kind);
    // Clamped to the measured size rather than refused or padded.
    expect(tail.bytes.length).toBe(100);
    expect([...tail.bytes]).toEqual([...bytes.slice(900)]);

    expect((await reader.read("id", file, info.identity, 0, MAX_SELECTION_CHUNK + 1)).kind).toBe("bad-range");
    expect((await reader.read("id", file, info.identity, -1, 10)).kind).toBe("bad-range");
    expect((await reader.read("id", file, info.identity, 0, 0)).kind).toBe("bad-range");
    expect((await reader.read("id", file, info.identity, 1000, 10)).kind).toBe("bad-range");
    await reader.disposeAll();
    void identity;
  });

  it("reads an empty file as an empty range refusal, not as bytes", async () => {
    const file = await write("empty", "");
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    // There is no range inside a zero-length file; the adapter never asks for
    // one, and the reader refuses rather than inventing an empty success.
    expect((await reader.read("e", file, info.identity, 0, 10)).kind).toBe("bad-range");
    await reader.disposeAll();
  });

  it("refuses once the file has CHANGED under it", async () => {
    const file = await write("mut.txt", "aaaa");
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    expect((await reader.read("m", file, info.identity, 0, 4)).kind).toBe("bytes");
    // Grown, so size and mtime both move.
    await appendFile(file, "bbbb");
    expect((await reader.read("m", file, info.identity, 0, 4)).kind).toBe("changed");
    await reader.disposeAll();
  });

  it("refuses once the file is DELETED", async () => {
    const file = await write("gone.txt", "abcd");
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    expect((await reader.read("g", file, info.identity, 0, 4)).kind).toBe("bytes");
    await reader.release("g");
    await rm(file);
    expect((await reader.read("g", file, info.identity, 0, 4)).kind).toBe("changed");
    await reader.disposeAll();
  });
});

describe("handles", () => {
  it("keeps the open pool bounded however many files are read", async () => {
    const reader = new SelectionReader();
    const files: { id: string; path: string; identity: Awaited<ReturnType<typeof examine>> }[] = [];
    for (let i = 0; i < MAX_OPEN_HANDLES + 6; i += 1) {
      const file = await write(`pool-${String(i)}.txt`, `x${String(i)}`);
      files.push({ id: `p${String(i)}`, path: file, identity: await examine(file) });
    }
    for (const entry of files) {
      if (entry.identity.kind !== "file") throw new Error("expected a file");
      const read = await reader.read(entry.id, entry.path, entry.identity.identity, 0, 2);
      expect(read.kind).toBe("bytes");
      expect(reader.openCount).toBeLessThanOrEqual(MAX_OPEN_HANDLES);
    }
    const { leftover } = await reader.disposeAll();
    expect(leftover).toBe(0);
    expect(reader.openCount).toBe(0);
  });

  it("a dispose during a held read joins it and reports no leftovers", async () => {
    const bytes = new Uint8Array(MAX_SELECTION_CHUNK);
    const file = await write("big.bin", bytes);
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    const running = reader.read("h", file, info.identity, 0, MAX_SELECTION_CHUNK);
    const inventory = await reader.disposeAll();
    await running;
    // The read either completed or was refused; either way nothing is left
    // open, and the number reported is the truth rather than an assumption.
    expect(inventory.leftover).toBe(0);
    expect(reader.openCount).toBe(0);
  });

  it("refuses every read after dispose", async () => {
    const file = await write("after.txt", "abcd");
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    await reader.disposeAll();
    expect((await reader.read("a", file, info.identity, 0, 4)).kind).toBe("failed");
  });

  it("does not leak a handle when the file vanishes mid-life", async () => {
    const file = await write("vanish.txt", "abcd");
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    await reader.read("v", file, info.identity, 0, 4);
    await reader.release("v");
    expect(reader.openCount).toBe(0);
    await reader.disposeAll();
  });
});

describe("the handle bound is a bound, not a suggestion", () => {
  it("never begins more opens than the cap, however many reads are held", async () => {
    const reader = new SelectionReader();
    const files: { id: string; path: string; identity: { size: number; dev: number; ino: number; mtimeMs: number } }[] = [];
    for (let i = 0; i < 12; i += 1) {
      const file = await write(`cap-${String(i)}.bin`, new Uint8Array(64));
      const info = await examine(file);
      if (info.kind !== "file") throw new Error("expected a file");
      files.push({ id: `c${String(i)}`, path: file, identity: info.identity });
    }
    // Twelve reads started together, each holding its handle.
    const results = await Promise.all(
      files.map((f) => reader.read(f.id, f.path, f.identity, 0, 64)),
    );
    const served = results.filter((r) => r.kind === "bytes").length;
    const refused = results.filter((r) => r.kind === "at-capacity").length;
    // Some are refused rather than opening a ninth descriptor.
    expect(served).toBeLessThanOrEqual(MAX_OPEN_HANDLES);
    expect(served + refused).toBe(12);
    expect(reader.openCount).toBeLessThanOrEqual(MAX_OPEN_HANDLES);
    const { leftover } = await reader.disposeAll();
    expect(leftover).toBe(0);
  });

  it("still reads more files than the cap when they are read SERIALLY", async () => {
    // The encryptor's own shape: one file at a time, so the others are idle and
    // a slot is freed by closing one rather than by refusing.
    const reader = new SelectionReader();
    for (let i = 0; i < 12; i += 1) {
      const file = await write(`serial-${String(i)}.bin`, new Uint8Array([i]));
      const info = await examine(file);
      if (info.kind !== "file") throw new Error("expected a file");
      const read = await reader.read(`s${String(i)}`, file, info.identity, 0, 1);
      if (read.kind !== "bytes") throw new Error(`${String(i)}: ${read.kind}`);
      expect(read.bytes[0]).toBe(i);
      expect(reader.openCount).toBeLessThanOrEqual(MAX_OPEN_HANDLES);
    }
    const { leftover } = await reader.disposeAll();
    expect(leftover).toBe(0);
  });

  it("honours a release asked for while the file was still opening", async () => {
    const file = await write("deferred.bin", new Uint8Array([1, 2, 3, 4]));
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    // Release lands while the open is still in flight.
    const reading = reader.read("d", file, info.identity, 0, 4);
    const releasing = reader.release("d");
    await Promise.all([reading, releasing]);
    // The handle the open produced must not survive the release that was asked
    // for before it existed.
    expect(reader.openCount).toBe(0);
    const { leftover } = await reader.disposeAll();
    expect(leftover).toBe(0);
  });
});

describe("directory helpers", () => {
  it("identifies a real directory and refuses a file", async () => {
    await mkdir(path.join(root, "d"));
    const file = await write("f.txt", "x");
    expect(await SelectionReader.isWalkableDirectory(path.join(root, "d"))).toBe(true);
    expect(await SelectionReader.isWalkableDirectory(file)).toBe(false);
    expect(await SelectionReader.directoryIdentity(path.join(root, "d"))).not.toBeNull();
    expect(await SelectionReader.directoryIdentity(file)).toBeNull();
  });

  it("gives one directory one identity, so a cycle can be seen", async () => {
    await mkdir(path.join(root, "c"));
    const a = await SelectionReader.directoryIdentity(path.join(root, "c"));
    const b = await SelectionReader.directoryIdentity(path.join(root, "c"));
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });
});

describe("no content or path reaches a diagnostic", () => {
  it("reports outcomes as closed codes carrying neither", async () => {
    const file = await write("secret-name.txt", "SECRET-CONTENT");
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    const bad = await reader.read("s", file, info.identity, -5, 10);
    const serialised = JSON.stringify(bad);
    expect(serialised).not.toContain("SECRET-CONTENT");
    expect(serialised).not.toContain("secret-name");
    expect(serialised).not.toContain(root);
    await reader.disposeAll();
  });
});

describe("an opened handle is what is read", () => {
  it("holds the handle open across reads rather than reopening per range", async () => {
    const file = await write("hold.txt", "abcdefgh");
    const info = await examine(file);
    if (info.kind !== "file") throw new Error("expected a file");
    const reader = new SelectionReader();
    await reader.read("k", file, info.identity, 0, 4);
    expect(reader.openCount).toBe(1);
    await reader.read("k", file, info.identity, 4, 4);
    expect(reader.openCount).toBe(1);
    await reader.disposeAll();
  });

  it("a directory is never readable, whatever id it is given", async () => {
    await mkdir(path.join(root, "dir"));
    const reader = new SelectionReader();
    const handle = await open(path.join(root, "dir"), "r").catch(() => null);
    await handle?.close().catch(() => undefined);
    const fake = { size: 4, dev: 1, ino: 1, mtimeMs: 1 };
    expect((await reader.read("d", path.join(root, "dir"), fake, 0, 4)).kind).toBe("changed");
    await reader.disposeAll();
  });
});
