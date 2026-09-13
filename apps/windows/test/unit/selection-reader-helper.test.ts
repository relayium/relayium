// The helper-backed open path, which Windows uses and this host cannot run.
//
// Written during the Claude single-agent review pass. The Windows walk itself is
// proven on Windows by `internal/winio`; what cannot be proven there is the part
// that lives HERE — that a provider, once supplied, is actually the thing the
// reads come from, that a reopen is bound to what the first open saw, and that a
// handle the helper would not release stays counted as held.
//
// The provider is a fake because the seam is the subject. A real helper would
// prove the walk again and say nothing about this module's accounting.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_OPEN_HANDLES, SelectionReader, examine } from "../../src/main/io/selection-reader.js";
import type {
  NativeSourceHandle,
  NativeSourceProvider,
  SourceIdentity,
} from "../../src/main/io/native-source.js";
import { SourceBindingError } from "../../src/main/io/native-source.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "relayium-selection-helper-"));
});

afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
  root = "";
});

const ID = (n: number): SourceIdentity => ({
  volumeSerial: n.toString(16).padStart(16, "0"),
  fileId: n.toString(16).padStart(32, "0"),
});

/**
 * A provider that serves bytes NOTHING on disk contains.
 *
 * That is the point: if a read returns the file's real contents, the reads did
 * not come through the provider, however green everything else looks.
 */
class FakeProvider implements NativeSourceProvider {
  opens: Array<{ path: string; expected?: SourceIdentity }> = [];
  closes = 0;
  identity = ID(1);
  /** Set to make the next open behave as a reopen onto a different object. */
  rebindFails = false;
  failClose = false;
  sizeOverride: number | null = null;
  constructor(private readonly served: string) {}

  get openCount(): number {
    return 0;
  }

  async open(absolutePath: string, expected?: SourceIdentity): Promise<NativeSourceHandle> {
    this.opens.push({ path: absolutePath, expected });
    if (this.rebindFails && expected !== undefined) throw new SourceBindingError("identity-mismatch");
    const body = Buffer.from(this.served);
    const provider = this;
    return {
      size: this.sizeOverride ?? body.length,
      identity: this.identity,
      async read(offset: number, length: number) {
        const slice = body.subarray(offset, offset + length);
        return { bytes: new Uint8Array(slice), eof: offset + slice.length >= body.length };
      },
      async close() {
        provider.closes += 1;
        return provider.failClose ? "failed-close" : "closed";
      },
    };
  }

  async dispose(): Promise<{ leftover: number; exitCode: number | null }> {
    return { leftover: 0, exitCode: 0 };
  }
}

/** A real file, so the staging checks this module still performs are real. */
const stage = async (name: string, contents: string): Promise<{ file: string; identity: Awaited<ReturnType<typeof examine>> }> => {
  const file = path.join(root, name);
  await writeFile(file, contents);
  return { file, identity: await examine(file) };
};

describe("reading through the helper", () => {
  it("serves the PROVIDER's bytes, not the ones on disk", async () => {
    const { file, identity } = await stage("a.txt", "on-disk");
    expect(identity.kind).toBe("file");
    if (identity.kind !== "file") return;
    // Same length, different content: a reader that quietly fell back to Node
    // would pass every size and range check and still be wrong.
    const provider = new FakeProvider("HELPER!");
    const reader = new SelectionReader(provider);

    const outcome = await reader.read("id-1", file, identity.identity, 0, 7);
    expect(outcome.kind).toBe("bytes");
    if (outcome.kind !== "bytes") return;
    expect(Buffer.from(outcome.bytes).toString()).toBe("HELPER!");
    expect(provider.opens).toHaveLength(1);
    expect(provider.opens[0]?.path).toBe(file);
    // Nothing to rebind against on a FIRST open.
    expect(provider.opens[0]?.expected).toBeUndefined();
    await reader.disposeAll();
  });

  it("replays the first identity when a file is reopened", async () => {
    const { file, identity } = await stage("b.txt", "abcdefg");
    if (identity.kind !== "file") return;
    const provider = new FakeProvider("1234567");
    const reader = new SelectionReader(provider);

    await reader.read("id-1", file, identity.identity, 0, 3);
    // Released, so the next read has to open it again.
    await reader.release("id-1");
    await reader.read("id-1", file, identity.identity, 0, 3);

    expect(provider.opens).toHaveLength(2);
    expect(provider.opens[0]?.expected).toBeUndefined();
    // The reopen carries what the first open reported. Without this a file
    // replaced between the two opens would be read as though it were the one
    // that was staged.
    expect(provider.opens[1]?.expected).toEqual(provider.identity);
    await reader.disposeAll();
  });

  it("refuses a reopen that lands on a different object", async () => {
    const { file, identity } = await stage("c.txt", "abcdefg");
    if (identity.kind !== "file") return;
    const provider = new FakeProvider("1234567");
    const reader = new SelectionReader(provider);

    await reader.read("id-1", file, identity.identity, 0, 3);
    await reader.release("id-1");
    provider.rebindFails = true;

    const outcome = await reader.read("id-1", file, identity.identity, 0, 3);
    // Refused, and refused as a CHANGED file rather than as a transport fault:
    // the helper did what it was asked and the answer was that the name now
    // means something else.
    expect(outcome.kind).toBe("changed");
    await reader.disposeAll();
  });

  it("closes the handle when the opened size is not what was staged", async () => {
    const { file, identity } = await stage("d.txt", "abcdefg");
    if (identity.kind !== "file") return;
    const provider = new FakeProvider("1234567");
    provider.sizeOverride = 99;
    const reader = new SelectionReader(provider);

    const outcome = await reader.read("id-1", file, identity.identity, 0, 3);
    expect(outcome.kind).toBe("changed");
    // The refusal must not leak the descriptor it had already acquired.
    expect(provider.closes).toBe(1);
    expect(reader.openCount).toBe(0);
    await reader.disposeAll();
  });

  it("keeps counting a handle the helper would not release", async () => {
    const { file, identity } = await stage("e.txt", "abcdefg");
    if (identity.kind !== "file") return;
    const provider = new FakeProvider("1234567");
    const reader = new SelectionReader(provider);
    await reader.read("id-1", file, identity.identity, 0, 3);

    provider.failClose = true;
    const { leftover } = await reader.disposeAll(200);
    // `failed-close` is the helper still holding it. Reporting zero here would
    // be claiming a release that did not happen.
    expect(leftover).toBe(1);
  });

  it("still bounds the pool when the helper is the one opening", async () => {
    const files = [];
    for (let i = 0; i < MAX_OPEN_HANDLES + 3; i += 1) {
      files.push(await stage(`f${i}.txt`, "abcdefg"));
    }
    const provider = new FakeProvider("1234567");
    const reader = new SelectionReader(provider);
    let peak = 0;
    for (const [i, staged] of files.entries()) {
      if (staged.identity.kind !== "file") continue;
      const outcome = await reader.read(`id-${i}`, staged.file, staged.identity.identity, 0, 3);
      expect(outcome.kind).toBe("bytes");
      peak = Math.max(peak, reader.openCount);
    }
    expect(peak).toBeLessThanOrEqual(MAX_OPEN_HANDLES);
    await reader.disposeAll();
  });
});
