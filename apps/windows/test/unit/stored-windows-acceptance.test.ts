// The combined path, on real Windows: shared crypto in, published files out.
//
// ## Why this exists next to the component suites
//
// `stored-runtime.test.ts` proves the bundle opens frozen cross-platform
// ciphertext. `stored-native-destination.test.ts` proves the receive
// orchestration drives the real `NativeHelperClient` over a fake child. Neither
// proves the thing a user cares about: that a stored link's bytes end up on
// disk, under the right names, byte-for-byte — and that a tampered or truncated
// one puts NOTHING there.
//
// So this drives `receiveStoredLink` with real ciphertext from the shared
// encoder, into the REAL helper executable, writing into a temp root this suite
// owns, and then reads the files back and hashes them.
//
// ## Skipped on this developer's machine, and honestly
//
// The helper is a Windows binary: `native/internal/winio` is `_windows.go` and
// there is no POSIX implementation. On macOS this whole block is skipped and
// says so — it is not "passing" here.
//
// On WINDOWS a missing executable is a FAILURE, never a skip: the workflow
// builds `native/build/relayium-io-helper.exe` before `npm test`, so an absent
// binary means the build step regressed, and turning that into a green skip is
// how a CI lane comes to prove nothing at all.
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  NativeHelperClient,
  type HelperChild,
} from "../../src/main/io/native-helper-client.js";
import { CleanupRegistry } from "../../src/main/stored/cleanup.js";
import type { DestinationAuthority, DestinationGrant } from "../../src/main/stored/receive.js";
import { receiveStoredLink } from "../../src/main/stored/receive.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";
import { resetStoredRuntimeForTest, storedRuntime } from "../../src/main/stored/runtime.js";
import type { StoredBlobBody, StoredObjectMeta, StoredObjectSource } from "../../src/main/stored/transport.js";
import { encodeKey, encryptFiles, encryptManifest, generateStoreKey } from "../../../../web/src/lib/store-crypto";

const IS_WINDOWS = process.platform === "win32";
const ARTIFACT = new URL("../../dist/main/stored-runtime.js", import.meta.url);

let runtime: StoredRuntime;

beforeAll(async () => {
  resetStoredRuntimeForTest();
  runtime = await storedRuntime(async () => (await import(ARTIFACT.href)) as { default?: unknown });
});

/**
 * The real executable.
 *
 * `RELAYIUM_NATIVE_HELPER_EXE` is a TEST-only lookup for a CI-built binary and
 * is read only inside this file — the client itself has no environment override
 * of any kind, which its own layout tests assert.
 */
async function realHelperPath(): Promise<string> {
  const candidates = [
    process.env["RELAYIUM_NATIVE_HELPER_EXE"],
    resolve(process.cwd(), "native", "build", "relayium-io-helper.exe"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next
    }
  }
  throw new Error(
    `the real helper executable was not found. Looked at:\n  ${candidates.join("\n  ")}\n` +
      "The workflow builds it before `npm test`; build it locally with: " +
      "go build -o native/build/relayium-io-helper.exe ./native/cmd/relayium-io-helper, " +
      "or set RELAYIUM_NATIVE_HELPER_EXE.",
  );
}

interface SpawnedChild {
  readonly child: HelperChild;
  exited: boolean;
}

const spawned: SpawnedChild[] = [];

/** Wrap a real child process in the client's transport shape, and record it so
 *  the hook below can prove it ended. */
async function spawnRealHelper(exe: string): Promise<HelperChild> {
  const { spawn } = await import("node:child_process");
  const process_ = spawn(exe, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const record: SpawnedChild = {
    exited: false,
    child: {
      stdin: process_.stdin,
      stdout: process_.stdout,
      stderr: process_.stderr,
      onExit: (listener) => {
        process_.once("exit", listener);
      },
      onClose: (listener) => {
        process_.once("close", () => listener());
      },
      onError: (listener) => {
        process_.once("error", listener);
      },
      kill: (signal) => process_.kill(signal),
    },
  };
  process_.once("exit", () => {
    record.exited = true;
  });
  spawned.push(record);
  return record.child;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

interface Picked {
  readonly path: string;
  readonly data: Uint8Array;
}

interface Sealed {
  readonly link: string;
  readonly meta: StoredObjectMeta;
  readonly stream: Uint8Array;
}

async function seal(picked: readonly Picked[]): Promise<Sealed> {
  const key = await generateStoreKey();
  const sealedManifest = await encryptManifest(key.key, {
    files: picked.map((entry) => ({ name: entry.path, size: entry.data.byteLength })),
  });
  const frames: Uint8Array[] = [];
  for await (const frame of encryptFiles(
    picked.map((entry) => new File([entry.data as BlobPart], entry.path)),
    key.key,
  )) {
    frames.push(frame);
  }
  const total = frames.reduce((n, frame) => n + frame.byteLength, 0);
  const stream = new Uint8Array(total);
  let at = 0;
  for (const frame of frames) {
    stream.set(frame, at);
    at += frame.byteLength;
  }
  return {
    link: `relayium://d/winacc1#k=${encodeKey(key.raw)}`,
    meta: {
      encManifest: Buffer.from(sealedManifest).toString("base64"),
      size: total,
      burnAfterRead: false,
      expiresAt: 2_000_000_000,
    },
    stream,
  };
}

/** A source that serves one sealed object from memory. */
function sourceFor(object: Sealed, stream = object.stream): StoredObjectSource {
  return {
    meta: async (): Promise<StoredObjectMeta> => object.meta,
    blob: async (): Promise<StoredBlobBody> => {
      let sent = false;
      return {
        read: async () => {
          if (sent) return null;
          sent = true;
          return stream;
        },
        close: async () => undefined,
      };
    },
  };
}

describe.skipIf(!IS_WINDOWS)("real Windows helper, end to end from a stored link", () => {
  // ## Owned resources, released after every test
  //
  // Each test creates a temp root and at least one live child process. Only
  // what these tests created is removed: each root is recorded when it is made,
  // and nothing else is ever touched.
  const ownedRoots: string[] = [];

  async function root(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), "relayium-stored-acc-"));
    ownedRoots.push(created);
    return created;
  }

  // A discarded cleanup failure is a false green: a run in which a helper
  // survived would otherwise report success, which is the precise residue this
  // whole path exists to prevent. So every failure is collected and thrown
  // together, after every cleanup has been ATTEMPTED.
  afterEach(async () => {
    const failures: Error[] = [];
    for (const record of spawned.splice(0)) {
      if (!record.exited) {
        record.child.kill();
        failures.push(new Error("a helper child was still running after the test"));
      }
    }
    for (const dir of ownedRoots.splice(0)) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        failures.push(error as Error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "owned cleanup failed");
  });

  const authority = (grant: DestinationGrant): DestinationAuthority => ({
    grant: async () => grant,
  });

  async function receive(object: Sealed, destinationRoot: string, stream?: Uint8Array) {
    const exe = await realHelperPath();
    return receiveStoredLink({
      link: object.link,
      authority: authority({ rootPath: destinationRoot, authorityId: "win-acc-1" }),
      transport: sourceFor(object, stream),
      runtime: async () => runtime,
      cleanups: new CleanupRegistry(),
      destination: async (request) =>
        NativeHelperClient.open({
          authorityId: request.authorityId,
          rootPath: request.rootPath,
          manifest: request.manifest,
          spawnHelper: () => spawnRealHelper(exe),
        }),
    });
  }

  it("publishes a nested tree and an empty file, byte for byte", async () => {
    const picked: Picked[] = [
      { path: "hello.txt", data: bytes("hello world") },
      { path: "trip/day1/photo.bin", data: new Uint8Array([1, 2, 3, 4, 250, 251]) },
      { path: "empty.txt", data: new Uint8Array(0) },
      { path: "trip/day2/notes.txt", data: bytes("second day") },
    ];
    const object = await seal(picked);
    const destination = await root();
    const report = await receive(object, destination);

    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.publishedCount).toBe(4);
    expect(report.residue).toBe(false);
    expect(report.cleanupTicket).toBeNull();

    // Every file, at its declared path, with its exact bytes.
    for (const entry of picked) {
      const written = await readFile(join(destination, ...entry.path.split("/")));
      expect(sha256(new Uint8Array(written)), entry.path).toBe(sha256(entry.data));
      expect(written.byteLength, entry.path).toBe(entry.data.byteLength);
    }
    // And nothing else: the staging directory is gone, so the root holds only
    // the published tree.
    expect((await readdir(destination)).sort()).toEqual(["empty.txt", "hello.txt", "trip"]);
    expect((await readdir(join(destination, "trip"))).sort()).toEqual(["day1", "day2"]);
  });

  it("keeps the published prefix when one name already exists", async () => {
    const picked: Picked[] = [
      { path: "first.txt", data: bytes("aaa") },
      { path: "second.txt", data: bytes("bbb") },
    ];
    const object = await seal(picked);
    const destination = await root();
    // The helper publishes in manifest order and stops at the first conflict,
    // so file 0 lands and file 1 cannot.
    await writeFile(join(destination, "second.txt"), "already here", "utf8");

    const report = await receive(object, destination);
    expect(report.status).toBe("partially-saved");
    if (report.status !== "partially-saved") return;
    expect(report.publishedCount).toBe(1);
    expect(report.total).toBe(2);
    expect(report.failedIndex).toBe(1);

    // The prefix is real, and the pre-existing file was NOT overwritten.
    expect(sha256(new Uint8Array(await readFile(join(destination, "first.txt"))))).toBe(
      sha256(bytes("aaa")),
    );
    expect(await readFile(join(destination, "second.txt"), "utf8")).toBe("already here");
  });

  it("publishes nothing from a tampered stream", async () => {
    const picked: Picked[] = [{ path: "hello.txt", data: bytes("hello world") }];
    const object = await seal(picked);
    const destination = await root();
    const tampered = object.stream.slice();
    tampered[6] = (tampered[6] ?? 0) ^ 0x01;

    const report = await receive(object, destination, tampered);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    expect(report.failure.residue).toBe(false);
    // Staging was torn down by the helper, so the user's folder is untouched.
    expect(await readdir(destination)).toEqual([]);
  });

  it("publishes nothing from a stream truncated on a frame boundary", async () => {
    const picked: Picked[] = [
      { path: "one.txt", data: bytes("hello world") },
      { path: "two.txt", data: bytes("xyz") },
    ];
    const object = await seal(picked);
    const destination = await root();
    // The first frame only: no dangling bytes, so only the expected plaintext
    // total can tell this from a clean end.
    const cut = object.stream.subarray(0, 4 + 11 + 16);

    const report = await receive(object, destination, cut);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    expect(await readdir(destination)).toEqual([]);
  });
});

describe.skipIf(IS_WINDOWS)("real Windows helper acceptance", () => {
  it("is skipped on this platform, and is not evidence here", () => {
    // Stated rather than silent: `native/internal/winio` is Windows-only, so
    // this suite can only run in the Windows lane. It is not passing on macOS.
    expect(IS_WINDOWS).toBe(false);
  });
});
