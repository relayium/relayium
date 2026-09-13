// The Inbox receive path against the REAL native helper, on a REAL Windows host.
//
// ## What only this suite can say
//
// `inbox-receive.test.ts` injects a destination and `receiver-harness.mjs`
// records what the receiver hands one. Both prove orchestration; neither proves
// that bytes reach a disk. The destination here is `NativeHelperClient` driving
// the CI-built `relayium-io-helper.exe`, so what is asserted is the file that
// exists afterwards — its name, its length and its bytes.
//
// ## Windows-only, and a missing helper is a FAILURE
//
// The block skips off Windows, where the executable cannot run at all. ON
// Windows it does not skip for a missing binary: a suite that quietly passes
// because the thing under test was absent is worse than no suite, and this is
// the only place the disk claim can be made. `RELAYIUM_NATIVE_HELPER_EXE` is a
// TEST-only lookup for the CI build; the client itself has no environment
// override, which `native-helper-client.test.ts` asserts separately.
//
// The ciphertext and the manifest are real, from the built runtime bundle.
import { afterEach, describe, expect, it } from "vitest";

import { captureAccount } from "../../src/main/inbox/account.js";
import { newAtRestKeyBytes } from "../../src/main/inbox/atrest.js";
import { InboxFiles } from "../../src/main/inbox/files.js";
import { TaskJournal } from "../../src/main/inbox/journal.js";
import { MessageVault } from "../../src/main/inbox/vault.js";
import { Receiver, type ReceiveDestination } from "../../src/main/inbox/receiver.js";
import { inboxRuntime, resetInboxRuntimeForTest } from "../../src/main/inbox/runtime.js";
import type { InboxRuntime, RuntimeManifest } from "../../src/main/inbox/runtime-contract.js";
import { NativeHelperClient, type HelperChild } from "../../src/main/io/native-helper-client.js";
import type { WireDelivery } from "../../src/main/inbox/wire.js";

const IS_WINDOWS = process.platform === "win32";
const FAST = { startupMs: 5_000, requestMs: 10_000, publishMs: 10_000, cancelExitMs: 5_000, closeAfterExitMs: 2_000 };

async function realRuntime(): Promise<InboxRuntime> {
  resetInboxRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const artifact = pathToFileURL(resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  return inboxRuntime(() => import(artifact) as Promise<{ default?: unknown }>);
}

/** The CI-built executable. Throws rather than letting the suite skip. */
async function realHelperPath(): Promise<string> {
  const { access } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
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
      "Build it with: go build -o native/build/relayium-io-helper.exe ./native/cmd/relayium-io-helper, " +
      "or set RELAYIUM_NATIVE_HELPER_EXE. This suite must NOT be skipped on Windows.",
  );
}

async function spawnRealHelper(exe: string): Promise<HelperChild> {
  const { spawn } = await import("node:child_process");
  const child = spawn(exe, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onClose: (listener) => {
      child.once("close", () => listener());
    },
    onError: (listener) => {
      child.once("error", listener);
    },
    kill: (signal) => child.kill(signal),
  };
}

interface BuiltDelivery {
  readonly delivery: WireDelivery;
  readonly ciphertext: Uint8Array;
  readonly contentKey: Uint8Array;
  readonly manifest: RuntimeManifest;
}

/** A delivery sealed exactly as a sender seals one. */
async function buildDelivery(
  runtime: InboxRuntime,
  items: readonly { name: string; size: number }[],
  payload: Uint8Array,
  mutate?: (ciphertext: Uint8Array) => Uint8Array,
): Promise<BuiltDelivery> {
  const { randomBytes } = await import("node:crypto");
  const contentKey = new Uint8Array(randomBytes(runtime.constants.contentKeyBytes));
  const storeKey = await runtime.importStoreKey(contentKey);
  const manifest = runtime.fileManifest([...items]);
  const { encodeInboxManifestBytes } = (await import(
    /* @vite-ignore */ new URL("../../../../web/src/lib/inbox-manifest.ts", import.meta.url).href
  )) as { encodeInboxManifestBytes: (m: RuntimeManifest) => Uint8Array };
  const encManifest = await runtime.sealManifestBytes(storeKey, encodeInboxManifestBytes(manifest));

  // One frame chain, per item, exactly as `encryptFiles` produces it.
  const frames: Uint8Array[] = [];
  let seq = 1;
  let at = 0;
  for (const item of items) {
    const piece = payload.subarray(at, at + item.size);
    at += item.size;
    for (let off = 0; off < piece.byteLength; off += runtime.constants.storeChunkSize) {
      const slice = piece.subarray(off, Math.min(off + runtime.constants.storeChunkSize, piece.byteLength));
      const buf = new Uint8Array(slice.byteLength);
      buf.set(slice);
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setUint32(8, seq);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, storeKey, buf));
      const framed = new Uint8Array(4 + ct.byteLength);
      new DataView(framed.buffer).setUint32(0, ct.byteLength);
      framed.set(ct, 4);
      frames.push(framed);
      seq += 1;
    }
  }
  let total = 0;
  for (const f of frames) total += f.byteLength;
  let ciphertext: Uint8Array = new Uint8Array(total);
  let cursor = 0;
  for (const f of frames) {
    ciphertext.set(f, cursor);
    cursor += f.byteLength;
  }
  if (mutate !== undefined) ciphertext = mutate(ciphertext);

  return {
    contentKey,
    ciphertext,
    manifest,
    delivery: {
      ID: `task-${randomBytes(4).toString("hex")}`,
      SourceDeviceID: "dev-sender",
      IdempotencyKey: `idem-${randomBytes(4).toString("hex")}`,
      State: "queued",
      ErrorCode: "",
      CiphertextBytes: ciphertext.byteLength,
      WrapAlgorithm: runtime.constants.keyAlgorithm,
      TargetKeyID: "key-1",
      TargetKeyGeneration: 1,
      CreatedAt: 1,
      ExpiresAt: 9_999_999,
      SavedAt: 0,
      Terminal: false,
      EncManifest: Buffer.from(encManifest).toString("base64"),
      WrappedKey: runtime.encodeKey(contentKey),
      ClaimToken: "claim-1",
    },
  };
}

describe.skipIf(!IS_WINDOWS)("Inbox receive on real Windows", () => {
  // Owned roots and clients, released after every test. A failing cleanup is
  // collected and thrown rather than swallowed: a run that left a helper alive
  // or a staging directory behind must not report success.
  const ownedRoots: string[] = [];
  const ownedClients: NativeHelperClient[] = [];

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    const failures: Error[] = [];
    for (const client of ownedClients.splice(0)) {
      try {
        await client.cancel();
      } catch (error) {
        // A residue-reporting teardown is a real finding, not noise — but a
        // client already published and closed rejects here too, so only an
        // unexpected shape is collected.
        const code = (error as { code?: unknown }).code;
        if (code !== "busy" && code !== "cancelled" && code !== "helper-unavailable") {
          failures.push(error as Error);
        }
      }
    }
    for (const root of ownedRoots.splice(0)) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error as Error);
      }
    }
    if (failures.length > 0) {
      throw new Error(`owned cleanup failed: ${failures.map((f) => f.message).join("; ")}`);
    }
  });

  async function ownedRoot(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "inbox-win-"));
    ownedRoots.push(root);
    return root;
  }

  /** A receiver whose destination is the REAL helper. */
  async function receiverFor(
    runtime: InboxRuntime,
    built: BuiltDelivery,
    receiveDir: string,
    profile: string,
  ): Promise<{ receiver: Receiver; journal: TaskJournal }> {
    const exe = await realHelperPath();
    const context = captureAccount({
      accountID: "windows-acceptance@example.invalid",
      deviceID: "dev-1",
      epoch: 1,
      inboxRoot: profile,
    });
    const files = new InboxFiles(context);
    const atRest = newAtRestKeyBytes();
    const journal = new TaskJournal(context, files, () => Promise.resolve(atRest));
    const vault = new MessageVault(context, files, () => Promise.resolve(atRest));
    const receiver = new Receiver({
      context,
      runtime,
      api: {
        report: (_t, _c, state) => Promise.resolve({ State: state, Terminal: state === "saved", SavedAt: 1 }),
        blob: (_t, _c, offset) =>
          Promise.resolve({
            partial: offset > 0,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(built.ciphertext.subarray(offset));
                controller.close();
              },
            }),
          }),
      },
      keys: { openSealedContentKey: () => Promise.resolve(built.contentKey.slice()) },
      journal,
      vault,
      destinationFor: async (manifest: RuntimeManifest): Promise<ReceiveDestination> => {
        // `open` is the PRODUCTION factory: it waits for the helper's `ready`
        // frame, so a launch failure or an architecture mismatch settles here
        // instead of hanging on a request that will never be answered.
        const client = await NativeHelperClient.open({
          authorityId: "windows-acceptance",
          rootPath: receiveDir,
          manifest: manifest.items.map((item) => ({ name: item.name ?? "", size: item.size })),
          spawnHelper: () => spawnRealHelper(exe),
          deadlines: FAST,
        });
        ownedClients.push(client);
        return client;
      },
      currentAccount: () => context,
      now: () => Date.now(),
    });
    return { receiver, journal };
  }

  it("writes nested and empty files to a real disk, byte for byte", async () => {
    const { randomBytes } = await import("node:crypto");
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const runtime = await realRuntime();
    const root = await ownedRoot();
    const receiveDir = join(root, "received");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(receiveDir, { recursive: true });

    const first = new Uint8Array(randomBytes(200 * 1024));
    const last = new Uint8Array(randomBytes(7));
    const payload = new Uint8Array(first.byteLength + last.byteLength);
    payload.set(first, 0);
    payload.set(last, first.byteLength);
    const items = [
      { name: "holiday/2026/big.bin", size: first.byteLength },
      // A zero-byte entry between two real ones: it produces no frames at all.
      { name: "holiday/2026/empty.bin", size: 0 },
      { name: "holiday/notes.txt", size: last.byteLength },
    ];
    const built = await buildDelivery(runtime, items, payload);
    const { receiver, journal } = await receiverFor(runtime, built, receiveDir, join(root, "profile"));

    const receipt = await receiver.receive(built.delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved", total: 3 });

    // The disk claim. Names, lengths and bytes.
    expect(await readFile(join(receiveDir, "holiday", "2026", "big.bin"))).toEqual(Buffer.from(first));
    expect(await readFile(join(receiveDir, "holiday", "2026", "empty.bin"))).toEqual(Buffer.alloc(0));
    expect(await readFile(join(receiveDir, "holiday", "notes.txt"))).toEqual(Buffer.from(last));
    expect((await journal.find(built.delivery.ID))?.phase).toBe("acked");
  });

  it("publishes NOTHING when a frame is tampered with", async () => {
    const { randomBytes } = await import("node:crypto");
    const { readdir, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const runtime = await realRuntime();
    const root = await ownedRoot();
    const receiveDir = join(root, "received");
    await mkdir(receiveDir, { recursive: true });

    const payload = new Uint8Array(randomBytes(64 * 1024));
    const built = await buildDelivery(runtime, [{ name: "tampered.bin", size: payload.byteLength }], payload, (ct) => {
      const copy = ct.slice();
      copy[copy.byteLength - 1] ^= 0x01;
      return copy;
    });
    const { receiver } = await receiverFor(runtime, built, receiveDir, join(root, "profile"));

    const receipt = await receiver.receive(built.delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    // Nothing left the staging area. The user's folder is untouched.
    expect(await readdir(receiveDir)).toEqual([]);
  });

  it("publishes NOTHING when the stream is truncated on a frame boundary", async () => {
    const { randomBytes } = await import("node:crypto");
    const { readdir, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const runtime = await realRuntime();
    const root = await ownedRoot();
    const receiveDir = join(root, "received");
    await mkdir(receiveDir, { recursive: true });

    // Two frames; the second is dropped entirely, so the stream ends cleanly on
    // a boundary and only the declared total detects it.
    const payload = new Uint8Array(randomBytes(runtime.constants.storeChunkSize + 1_000));
    const whole = await buildDelivery(runtime, [{ name: "short.bin", size: payload.byteLength }], payload);
    const firstFrameLength = 4 + new DataView(whole.ciphertext.buffer, whole.ciphertext.byteOffset).getUint32(0);
    const truncated = whole.ciphertext.subarray(0, firstFrameLength);
    const built: BuiltDelivery = {
      ...whole,
      ciphertext: truncated,
      delivery: { ...whole.delivery, CiphertextBytes: truncated.byteLength },
    };
    const { receiver } = await receiverFor(runtime, built, receiveDir, join(root, "profile"));

    const receipt = await receiver.receive(built.delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    expect(await readdir(receiveDir)).toEqual([]);
  });

  it("reports a publish receipt whose counts match the manifest", async () => {
    const { randomBytes } = await import("node:crypto");
    const { mkdir, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const runtime = await realRuntime();
    const root = await ownedRoot();
    const receiveDir = join(root, "received");
    await mkdir(receiveDir, { recursive: true });

    const payload = new Uint8Array(randomBytes(3));
    const built = await buildDelivery(runtime, [{ name: "one.bin", size: payload.byteLength }], payload);
    const { receiver } = await receiverFor(runtime, built, receiveDir, join(root, "profile"));

    const receipt = await receiver.receive(built.delivery, new AbortController().signal);
    // The helper's own receipt, this side's count and the manifest total all
    // agree, and the residue verdict is the helper's rather than an assumption.
    expect(receipt).toMatchObject({ kind: "saved", total: 1, residue: "none" });
    if (receipt.kind === "saved") expect(receipt.journalRecorded).toBe(true);
    expect(await readdir(receiveDir)).toEqual(["one.bin"]);
  });
});
