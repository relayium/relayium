import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiveLease, ReceiveLeaseError, MAX_CHUNK_BYTES } from "../../src/main/io/receive-lease.js";

let root = "";
const AUTHORITY = "account-1";

const bytes = (n: number, fill = 0x61): Uint8Array => new Uint8Array(n).fill(fill);

async function openLease(manifest: { name: string; size: number }[], rootPath = root) {
  return ReceiveLease.open({ id: "lease-1", authorityId: AUTHORITY, rootPath, manifest });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relayium-lease-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("staging containment", () => {
  it("writes nothing under a manifest-supplied name while streaming", async () => {
    const lease = await openLease([{ name: "sub/dir/report.txt", size: 4 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(4));
    await lease.finishFile(0);

    // The only thing in the chosen folder is the lease's own staging directory.
    // No `sub/`, so nothing a hostile manifest names has touched the filesystem.
    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.startsWith(".relayium-incoming-")).toBe(true);
    await expect(stat(join(root, "sub"))).rejects.toThrow();
    await lease.cancel();
  });

  it("refuses a manifest before creating any staging directory", async () => {
    await expect(openLease([{ name: "../escape", size: 1 }])).rejects.toMatchObject({
      code: "manifest-refused",
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a root that is not a directory", async () => {
    const file = join(root, "not-a-dir");
    await writeFile(file, "x");
    await expect(openLease([{ name: "a.txt", size: 1 }], file)).rejects.toMatchObject({
      code: "root-not-directory",
    });
  });
});

describe("exact declared length", () => {
  // Root's case 1. `FileHandle.write` may take fewer bytes than offered; if the
  // counter advances by the REQUESTED length the file passes the exact-length
  // check while being short on disk, and a short file is committed as complete.
  it("saves all 4 bytes when the OS accepts only part of a write", async () => {
    const probe = await open(join(root, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as { write: (...a: unknown[]) => unknown };
    const original = proto.write;
    await probe.close();

    let firstCall = true;
    proto.write = async function patched(this: unknown, ...args: unknown[]) {
      if (firstCall) {
        firstCall = false;
        // Accept exactly one byte of whatever was offered.
        const [buffer, offset] = args as [Uint8Array, number];
        return (original as (...a: unknown[]) => Promise<{ bytesWritten: number }>).call(
          this, buffer, offset, 1,
        );
      }
      return (original as (...a: unknown[]) => Promise<{ bytesWritten: number }>).apply(this, args);
    } as never;

    try {
      const lease = await openLease([{ name: "a.bin", size: 4 }]);
      await lease.beginFile(0);
      await lease.writeChunk(0, bytes(4, 0x7a));
      await lease.finishFile(0);
      const staged = await lease.close();
      expect(staged).toHaveLength(1);
      const written = await readFile(staged[0]!.stagedPath);
      expect(written).toHaveLength(4);
      expect([...written]).toEqual([0x7a, 0x7a, 0x7a, 0x7a]);
    } finally {
      proto.write = original as never;
    }
  });

  it("refuses a stream longer than declared, before the bytes reach disk", async () => {
    const lease = await openLease([{ name: "a.bin", size: 4 }]);
    await lease.beginFile(0);
    await expect(lease.writeChunk(0, bytes(5))).rejects.toMatchObject({ code: "length-exceeded" });
    await lease.cancel();
  });

  it("refuses to finish a short file and removes what it staged", async () => {
    const lease = await openLease([{ name: "a.bin", size: 8 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(3));
    await expect(lease.finishFile(0)).rejects.toMatchObject({ code: "length-short" });
    expect(lease.stagedFiles).toHaveLength(0);
  });

  it("bounds a single chunk", async () => {
    const lease = await openLease([{ name: "a.bin", size: MAX_CHUNK_BYTES + 1 }]);
    await lease.beginFile(0);
    await expect(lease.writeChunk(0, bytes(MAX_CHUNK_BYTES + 1))).rejects.toMatchObject({
      code: "chunk-too-large",
    });
    await lease.cancel();
  });
});

describe("ordering and exclusivity", () => {
  it("refuses a file out of plan order", async () => {
    const lease = await openLease([{ name: "a", size: 1 }, { name: "b", size: 1 }]);
    await expect(lease.beginFile(1)).rejects.toMatchObject({ code: "out-of-order" });
    await lease.cancel();
  });

  it("refuses a chunk for a file that is not open", async () => {
    const lease = await openLease([{ name: "a", size: 1 }]);
    await expect(lease.writeChunk(0, bytes(1))).rejects.toMatchObject({ code: "no-open-file" });
    await lease.cancel();
  });

  // Two concurrent writes could each see enough remaining length and together
  // exceed it. Overlap is refused rather than silently serialised.
  it("refuses overlapping operations instead of interleaving them", async () => {
    const lease = await openLease([{ name: "a.bin", size: 8 }]);
    await lease.beginFile(0);
    const first = lease.writeChunk(0, bytes(4));
    const second = lease.writeChunk(0, bytes(4));
    await expect(second).rejects.toMatchObject({ code: "busy" });
    await first;
    await lease.cancel();
  });

  it("fences on the account the lease was opened under", async () => {
    const lease = await openLease([{ name: "a", size: 1 }]);
    expect(() => lease.assertAuthority("account-2")).toThrow(ReceiveLeaseError);
    expect(() => lease.assertAuthority(AUTHORITY)).not.toThrow();
    await lease.cancel();
  });
});

describe("cancel", () => {
  // Root's case 2.
  it("leaves no partial when cancelled with a file open and bytes written", async () => {
    const lease = await openLease([{ name: "a.bin", size: 1024 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(512));
    const staging = lease.staging;
    await lease.cancel();
    await expect(stat(staging)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  // Root's case 3.
  it("removes the directories it created", async () => {
    const lease = await openLease([{ name: "deep/nested/a.bin", size: 4 }]);
    const staging = lease.staging;
    await lease.beginFile(0);
    await lease.cancel();
    await expect(stat(staging)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses further work immediately and is safe to call twice", async () => {
    const lease = await openLease([{ name: "a.bin", size: 4 }]);
    await lease.cancel();
    await lease.cancel();
    await expect(lease.beginFile(0)).rejects.toMatchObject({ code: "lease-closed" });
  });

  // A second caller must wait for the CLEANUP, not merely for the in-flight
  // operation to unwind, or "is the directory gone?" depends on which caller
  // you happened to await.
  it("makes every concurrent caller wait for the teardown to finish", async () => {
    const lease = await openLease([{ name: "a.bin", size: 1024 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(256));
    const staging = lease.staging;
    const [, ,] = await Promise.all([lease.cancel(), lease.cancel(), lease.cancel()]);
    await expect(stat(staging)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses to report completion after a cancel deleted the bytes", async () => {
    const lease = await openLease([{ name: "a", size: 1 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(1));
    await lease.finishFile(0);
    // Everything is staged, so a bare length check would call this complete.
    await lease.cancel();
    await expect(lease.close()).rejects.toMatchObject({ code: "lease-closed" });
    await expect(lease.publish()).rejects.toMatchObject({ code: "lease-closed" });
  });

  it("does not adopt a pre-existing staging directory", async () => {
    // Two leases in one folder must not share staging; each mkdir is exclusive.
    const a = await openLease([{ name: "x", size: 1 }]);
    const b = await openLease([{ name: "x", size: 1 }]);
    expect(a.staging).not.toEqual(b.staging);
    await a.cancel();
    await b.cancel();
  });
});

describe("completion", () => {
  // Root's case 4.
  it("refuses to report success when fewer files were staged than planned", async () => {
    const lease = await openLease([{ name: "a", size: 1 }, { name: "b", size: 1 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(1));
    await lease.finishFile(0);
    await expect(lease.close()).rejects.toMatchObject({ code: "incomplete" });
    // A refused completion also tears down: nothing is left half-delivered.
    expect(await readdir(root)).toEqual([]);
  });

  it("succeeds only when every planned file is staged", async () => {
    const lease = await openLease([{ name: "a", size: 1 }, { name: "b", size: 2 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(1));
    await lease.finishFile(0);
    await lease.beginFile(1);
    await lease.writeChunk(1, bytes(2));
    await lease.finishFile(1);
    const staged = await lease.close();
    expect(staged.map((f) => f.segments.join("/"))).toEqual(["a", "b"]);
  });

  // Publish needs no-replace, containment-checked Win32 primitives that Node
  // does not expose. It refuses rather than shipping `fs.rename`'s overwrite.
  it("refuses to publish without a native publisher", async () => {
    const lease = await openLease([{ name: "a", size: 1 }]);
    await lease.beginFile(0);
    await lease.writeChunk(0, bytes(1));
    await lease.finishFile(0);
    await expect(lease.publish()).rejects.toMatchObject({ code: "publish-unsupported" });
    await lease.cancel();
  });
});
