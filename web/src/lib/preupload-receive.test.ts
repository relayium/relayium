// The receiver half of pre-upload, driven against REAL ciphertext.
//
// The objects here are built with the same encryptManifest/encryptFiles the
// sender uses, and served through a fake `fetch` that speaks the same two
// endpoints the anonymous download path speaks. A stubbed decryptor would let
// this file pass while the real key handling, the real manifest boundaries or
// the real 410 were wrong — and those are the three things that decide whether a
// receiver gets its files or is quietly told it did.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStoredReceiver } from "./preupload-receive.svelte";
import { encryptFiles, encryptManifest, generateStoreKey, encodeKey, decodeKey, type StoredManifest } from "./store-crypto";
import { SaveCancelledError, type FileMetaLite, type SaveTarget } from "./filesink";
import type { HandoffItem } from "./preupload-handoff";

interface MemoryTarget extends SaveTarget {
  output: Map<string, Uint8Array>;
  opened: string[];
  doneCalls: number;
}

/**
 * Suspend one sink operation, so a cancellation can land while it is PENDING.
 *
 * The gates on the server hold a request or a stream read — everything on the
 * way IN. These hold the way OUT: the awaits on the save target itself, which
 * are the ones that decide whether a file is committed (`close`) and whether the
 * next one is created (`file`). A test that can only suspend a network read
 * cannot see a continuation that resumes into a closed room and goes on
 * committing files from there.
 */
interface SinkGates {
  /** Hold the write of `name` open. */
  gateWrite?(name: string): Promise<void> | undefined;
  /** Hold the close (the COMMIT) of `name` open. */
  gateClose?(name: string): Promise<void> | undefined;
  /** Hold the open of `name` — a directory target creates the entry here. */
  gateOpen?(name: string): Promise<void> | undefined;
}

function memoryTarget(gates: SinkGates = {}): MemoryTarget {
  const output = new Map<string, Uint8Array>();
  const opened: string[] = [];
  const t: MemoryTarget = {
    label: "memory",
    output,
    opened,
    doneCalls: 0,
    async file(name: string, _size: number, path?: string) {
      const keyName = path ?? name;
      opened.push(keyName);
      await gates.gateOpen?.(keyName);
      const chunks: Uint8Array[] = [];
      return {
        async write(chunk: Uint8Array) { await gates.gateWrite?.(keyName); chunks.push(chunk.slice()); },
        async close() {
          await gates.gateClose?.(keyName);
          const size = chunks.reduce((n, c) => n + c.length, 0);
          const joined = new Uint8Array(size);
          let off = 0;
          for (const c of chunks) { joined.set(c, off); off += c.length; }
          output.set(keyName, joined);
        },
      };
    },
    async done() { t.doneCalls++; },
  };
  return t;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** One stored object as the server would hold it: an encrypted manifest and a
 *  ciphertext stream, plus the base64url key the handoff carries. */
async function makeObject(id: string, files: { name: string; body: string }[]) {
  const sk = await generateStoreKey();
  const manifest: StoredManifest = { files: files.map((f) => ({ name: f.name, size: utf8(f.body).length })) };
  const encManifest = toB64(await encryptManifest(sk.key, manifest));
  const parts: Uint8Array[] = [];
  for await (const c of encryptFiles(files.map((f) => new File([f.body], f.name)), sk.key)) parts.push(c);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const blob = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { blob.set(p, off); off += p.length; }
  // `frames` is the SAME ciphertext as `blob`, kept unjoined. A frame is the
  // smallest unit the decryptor can turn into plaintext, so serving one per read
  // is what makes "the reset landed between two writes of one live stream" a
  // thing a test can actually arrange — see ServerOpts.frameByFrame.
  return { id, item: { id, key: encodeKey(sk.raw) } as HandoffItem, encManifest, blob, frames: parts, manifest };
}

type Obj = Awaited<ReturnType<typeof makeObject>>;

/** Seal an arbitrary manifest under an object's key, bypassing encryptManifest's
 *  own validation — the point is to produce something only a hostile or broken
 *  sender could, and watch the receiver refuse it. */
async function encryptManifestRaw(o: Obj, m: unknown): Promise<Uint8Array> {
  const raw = decodeKey(o.item.key);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(m)));
  return new Uint8Array(ct);
}

interface ServerOpts {
  metaStatus?: Record<string, number>;
  blobStatus?: Record<string, number>;
  /** Corrupt the manifest so the key genuinely fails to open it. */
  corruptManifest?: string[];
  networkFail?: string[];
  /** Hold a request open until the returned promise settles. The lever every
   *  race case below needs: a reset or a reject has to land while a request is
   *  genuinely in flight, not merely between two of them. */
  gate?(url: string): Promise<void> | undefined;
  /** Serve these objects' ciphertext one FRAME per read instead of handing the
   *  whole thing over in a single one. `gate` can only hold a request open
   *  BEFORE any of it is delivered; this is what puts a suspendable boundary
   *  in the MIDDLE of a stream that is already writing files. */
  frameByFrame?: string[];
  /** Hold one read of a frame-by-frame body open. `index` counts from 0, and
   *  the index one past the last frame is the read that reports `done`. */
  gateRead?(id: string, index: number): Promise<void> | undefined;
}

/** Mutable server options, so a case can HEAL a failure the way a real transient
 *  one heals and then watch the retry actually succeed. */
function installServer(objects: Obj[], opts: ServerOpts = {}) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const calls: string[] = [];
  /** The AbortSignal each request was issued with, in call order. A request made
   *  with none records `undefined` — which is exactly the regression these cases
   *  are here to catch, so it must be recorded rather than skipped. */
  const signals: (AbortSignal | undefined)[] = [];
  /** Ids whose ciphertext stream was cancelled instead of read to the end. */
  const cancels: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    signals.push(init?.signal ?? undefined);
    const m = /^\/api\/files\/([^/]+)\/(meta|blob)$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const id = decodeURIComponent(m[1]);
    await opts.gate?.(url);
    if (opts.networkFail?.includes(id)) throw new TypeError("Failed to fetch");
    const o = byId.get(id);
    if (!o) return { ok: false, status: 404 } as unknown as Response;
    if (m[2] === "meta") {
      const forced = opts.metaStatus?.[id];
      if (forced) return { ok: false, status: forced } as unknown as Response;
      const encManifest = opts.corruptManifest?.includes(id)
        ? toB64(new Uint8Array(48).fill(9))
        : o.encManifest;
      return {
        ok: true,
        status: 200,
        json: async () => ({ encManifest, size: o.blob.length, burnAfterRead: false, expiresAt: 0 }),
      } as unknown as Response;
    }
    const forced = opts.blobStatus?.[id];
    if (forced) return { ok: false, status: forced } as unknown as Response;
    const pieces = opts.frameByFrame?.includes(id) ? o.frames : [o.blob];
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let next = 0;
          return {
            async read() {
              const i = next++;
              await opts.gateRead?.(id, i);
              if (i >= pieces.length) return { done: true, value: undefined };
              return { done: false, value: pieces[i] };
            },
            async cancel() { cancels.push(id); },
          };
        },
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, signals, cancels };
}

/**
 * Let everything already in flight actually finish.
 *
 * Macrotask turns, not microtask ticks. The chains under test go through real
 * WebCrypto (`keyFromFragment`, `decryptManifest`, the stream decryptor), whose
 * promises do NOT settle within a microtask drain — so a microtask-only settle
 * returns while a stale continuation is still on its way, and every "nothing
 * happened afterwards" assertion passes for the wrong reason. That is not
 * hypothetical: it hid a missing cancellation check in the resolve loop, which
 * only became visible once this waited long enough to see the continuation land.
 */
const settle = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0));
};

async function until(check: () => boolean, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let target: MemoryTarget;
const make = (over: Partial<{ pick: (f: FileMetaLite[]) => Promise<SaveTarget> }> = {}) =>
  createStoredReceiver({ pickSaveTarget: over.pick ?? (async () => target) });

beforeEach(() => { target = memoryTarget(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("receiving pre-uploaded files", () => {
  it("asks before it writes anything, then saves the batch", async () => {
    // The consent step is the point. Bytes parked in storage are still bytes a
    // stranger who guessed a code could be sending, so this surface asks exactly
    // the question the live lane asks.
    const one = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([one]);
    const r = make();
    r.offer([one.item]);
    await until(() => r.status === "prompt");

    expect(r.files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(r.total).toBe(5);
    expect(target.output.size).toBe(0); // nothing written before the answer

    await r.accept();
    expect(r.status).toBe("done");
    expect(new TextDecoder().decode(target.output.get("a.txt"))).toBe("hello");
    expect(target.doneCalls).toBe(1);
  });

  it("writes several objects into ONE save target and finalizes it exactly once", async () => {
    // The ZIP branch assembles the whole archive from done(); calling it per
    // object would emit a partial archive and then write into a finished one.
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    installServer([a, b]);
    const r = make();
    r.offer([a.item, b.item]);
    await until(() => r.status === "prompt");
    expect(r.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);

    await r.accept();
    expect(r.status).toBe("done");
    expect(new TextDecoder().decode(target.output.get("a.txt"))).toBe("one");
    expect(new TextDecoder().decode(target.output.get("b.txt"))).toBe("two");
    expect(target.doneCalls).toBe(1);
  });

  it("rebuilds a folder's hierarchy from the flat manifest names", async () => {
    // The stored manifest has no path field: a folder's tree lives inside
    // `name`. Splitting it is what keeps the tree on the browsers that have no
    // directory handle, and it is shared with the download page.
    const o = await makeObject("obj1", [{ name: "trip/day1/a.txt", body: "x" }]);
    installServer([o]);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    expect(r.files[0].name).toBe("a.txt");
    expect(r.files[0].path).toBe("trip/day1/a.txt");
    await r.accept();
    expect(target.opened).toEqual(["trip/day1/a.txt"]);
  });

  it("reports total progress across the whole batch, not per object", async () => {
    const a = await makeObject("obj1", [{ name: "a.txt", body: "aaaa" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "bbbbbb" }]);
    installServer([a, b]);
    const r = make();
    r.offer([a.item, b.item]);
    await until(() => r.status === "prompt");
    expect(r.total).toBe(10);
    await r.accept();
    expect(r.received).toBe(10);
  });
});

describe("retry, idempotency and ordering", () => {
  it("treats a re-delivered id as a no-op — no second prompt, no second download", async () => {
    // The sender re-sends the WHOLE set on every (re)established link. That is
    // only safe because this is true.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const server = installServer([o]);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("done");
    const after = server.calls.length;

    r.offer([o.item]); // the reconnect resend
    await settle();
    expect(r.status).toBe("done");
    expect(server.calls.length).toBe(after); // not one extra request
  });

  it("prompts only for the ids a resend actually adds", async () => {
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    installServer([a, b]);
    const r = make();
    r.offer([a.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    r.dismiss();

    r.offer([a.item, b.item]); // whole set again, one new id
    await until(() => r.status === "prompt");
    expect(r.files.map((f) => f.name)).toEqual(["b.txt"]);
  });

  it("holds a handoff that arrives while another batch is on screen", async () => {
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    installServer([a, b]);
    const r = make();
    r.offer([a.item]);
    await until(() => r.status === "prompt");

    r.offer([b.item]); // an upload finished after the peer joined
    await settle();
    expect(r.files.map((f) => f.name)).toEqual(["a.txt"]); // the prompt did not change
    expect(r.waitingCount).toBe(1);

    await r.accept();
    r.dismiss();
    await until(() => r.status === "prompt");
    expect(r.files.map((f) => f.name)).toEqual(["b.txt"]);
    expect(r.waitingCount).toBe(0);
  });

  it("does not re-ask a question the user already declined", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    r.reject();
    expect(r.status).toBe("idle");

    r.offer([o.item]); // every reconnect resends it
    await settle();
    expect(r.status).toBe("idle");
    expect(target.output.size).toBe(0);
  });

  it("forgets which ids it took when the room changes", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    r.reset();
    expect(r.status).toBe("idle");
    expect(r.files).toEqual([]);
    // A genuinely new room may legitimately reuse nothing, but the driver must
    // not carry the old room's answers into it.
    r.offer([o.item]);
    await until(() => r.status === "prompt");
  });
});

describe("failure is never reported as success", () => {
  it("says the transfer expired when the room's deadline already deleted it", async () => {
    // The one failure with a different remedy: retrying cannot work, so the copy
    // has to send the user to a new code instead.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o], { metaStatus: { obj1: 410 } });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.errorKey).toBe("gone");
    expect(target.output.size).toBe(0);
  });

  it("distinguishes a server refusal from the room being gone", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o], { metaStatus: { obj1: 429 } });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.errorKey).toBe("netFail");
  });

  it("reports an unreachable server as a network failure, never as a bad key", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o], { networkFail: ["obj1"] });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.errorKey).toBe("netFail");
  });

  it("fails hard when the key does not open its object", async () => {
    // §4.4: a key that fails to decrypt is a hard error for that item, never a
    // fallback to an unencrypted path — which does not exist.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o], { corruptManifest: ["obj1"] });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.errorKey).toBe("decryptFail");
  });

  it("fails the WHOLE batch rather than delivering part of it in silence", async () => {
    // Half a folder plus a "Saved." is the outcome §4.4 forbids, and it is worse
    // than an error: the user has no way to know a file is missing.
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    installServer([a, b], { metaStatus: { obj2: 410 } });
    const r = make();
    r.offer([a.item, b.item]);
    await until(() => r.status === "failed");
    expect(r.files).toEqual([]);
    expect(target.output.size).toBe(0);
  });

  it("reports a download that stops midway, and does not claim the files", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o], { blobStatus: { obj1: 500 } });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");
    expect(r.errorKey).toBe("netFail");
    expect(target.doneCalls).toBe(0);
  });

  it("opens one save picker and one run however many times Save is clicked", async () => {
    // `status` cannot see this: it stays `prompt` for as long as the picker
    // dialog is open, so a second click would start a second run over the same
    // objects and write every file twice into two targets.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    let picks = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const r = make({ pick: async () => { picks++; await held; return target; } });
    r.offer([o.item]);
    await until(() => r.status === "prompt");

    const first = r.accept();
    const second = r.accept(); // the impatient second click
    release();
    await Promise.all([first, second]);
    expect(picks).toBe(1);
    expect(r.status).toBe("done");
    expect(target.opened).toEqual(["a.txt"]); // written once, not twice
  });

  it("refuses an object that describes no files rather than claiming it saved one", async () => {
    // "Saved." for a batch that was never downloaded is precisely the dishonest
    // success this module exists to avoid. The manifest codec is what makes it
    // impossible: validateManifestFiles refuses an empty file list on decrypt,
    // so such an object never becomes a prompt at all.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const emptyManifest = toB64(await encryptManifestRaw(o, { files: [] }));
    installServer([{ ...o, encManifest: emptyManifest }]);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.errorKey).toBe("decryptFail");
    expect(r.files).toEqual([]);
    expect(target.output.size).toBe(0);
  });

  it("treats a cancelled save picker as nothing having happened", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    const r = make({ pick: async () => { throw new SaveCancelledError("user cancelled"); } });
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    // Still answerable: the user changed their mind about WHERE, not whether.
    expect(r.status).toBe("prompt");
    expect(r.errorKey).toBe("");
    // And answerable AGAIN — the double-click guard must not have latched.
    await r.accept();
    expect(r.status).toBe("prompt");
  });

  it("reports a save target that cannot be opened at all", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    const r = make({ pick: async () => { throw new Error("no picker"); } });
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");
    expect(r.errorKey).toBe("saveFail");
  });
});

// ── Retry ───────────────────────────────────────────────────────────────────
//
// Taking an id is not the same as delivering it. The dedupe that makes the
// sender's blind whole-set resending correct used to be claimed at OFFER time,
// which meant a single transient failure — one 500, one dropped socket — turned
// every later resend into a no-op: the card said "try again", nothing ever
// tried, and the files sat in storage until the room deleted them. What is
// permanent is a DELIVERED id and a DECLINED id. A FAILED one is exactly the
// thing a retry is for.
describe("a failure is retried, and a success and a refusal are not", () => {
  it("lets the next resend retry a batch whose manifest could not be read", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const opts: ServerOpts = { networkFail: ["obj1"] };
    installServer([o], opts);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.errorKey).toBe("netFail");
    r.dismiss();

    opts.networkFail = []; // the network came back
    r.offer([o.item]); // the reconnect resend, which used to be a no-op forever
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("done");
    expect(new TextDecoder().decode(target.output.get("a.txt"))).toBe("hello");
  });

  it("lets the next resend retry a batch whose download stopped", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const opts: ServerOpts = { blobStatus: { obj1: 500 } };
    installServer([o], opts);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");
    expect(target.doneCalls).toBe(0);
    r.dismiss();

    opts.blobStatus = {};
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("done");
    expect(new TextDecoder().decode(target.output.get("a.txt"))).toBe("hello");
  });

  it("retries on the card, without waiting for a reconnect that may never come", async () => {
    // The resend is the sender's; a receiver whose peer has already gone needs a
    // control of its own, or the copy that says "try again" is addressed to
    // nobody.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const opts: ServerOpts = { blobStatus: { obj1: 503 } };
    installServer([o], opts);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");
    expect(r.retryable).toBe(true);

    opts.blobStatus = {};
    r.retry();
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("done");
    expect(new TextDecoder().decode(target.output.get("a.txt"))).toBe("hello");
  });

  it("offers no retry for the one failure a retry cannot fix", async () => {
    // The room's deadline passed and the ciphertext was deleted with it. The
    // remedy is a new code, and a retry button here would be a lie with a
    // request behind it.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o], { metaStatus: { obj1: 410 } });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.errorKey).toBe("gone");
    expect(r.retryable).toBe(false);
    r.retry();
    await settle();
    expect(r.status).toBe("failed"); // nothing happened
  });

  it("never re-downloads an object it already wrote", async () => {
    // Mixed batch, honest halves: A is on disk, B is not. The retry must be
    // about B alone — re-fetching A would bill the sender for bytes the user
    // already has and write a second copy of a file that is already there.
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    const opts: ServerOpts = { blobStatus: { obj2: 500 } };
    installServer([a, b], opts);
    const r = make();
    r.offer([a.item, b.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");
    expect(new TextDecoder().decode(target.output.get("a.txt"))).toBe("one");

    opts.blobStatus = {};
    const before = target.opened.length;
    target = memoryTarget(); // the retry picks its own destination
    r.retry();
    await until(() => r.status === "prompt");
    expect(r.files.map((f) => f.name)).toEqual(["b.txt"]);
    await r.accept();
    expect(r.status).toBe("done");
    expect(target.opened).toEqual(["b.txt"]); // A was not opened a second time
    expect(before).toBe(2);
  });

  it("does not queue an object twice when a resend and the retry button race", async () => {
    // Both are retries of the same failure, arriving from different directions:
    // the peer re-sends the whole set on reconnect while the failure card is
    // still up, and the user presses the card's own control. Counting the id
    // twice would resolve it twice into one batch and write the file twice.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const opts: ServerOpts = { blobStatus: { obj1: 500 } };
    installServer([o], opts);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");

    opts.blobStatus = {};
    target = memoryTarget(); // the retry opens its own destination
    r.offer([o.item]); // the peer's resend, while the card is still on screen
    r.retry();         // and the user, at the same moment
    await until(() => r.status === "prompt");
    expect(r.files.map((f) => f.name)).toEqual(["a.txt"]);
    await r.accept();
    expect(r.status).toBe("done");
    expect(target.opened).toEqual(["a.txt"]);
    expect(target.doneCalls).toBe(1);
  });

  it("keeps a declined batch declined through a retry and every later resend", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    r.reject();
    expect(r.status).toBe("idle");
    expect(r.retryable).toBe(false);

    r.retry();
    r.offer([o.item]);
    r.offer([o.item]);
    await settle();
    expect(r.status).toBe("idle");
    expect(target.output.size).toBe(0);
  });

  it("writes nothing a second time once a batch is delivered", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const server = installServer([o]);
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("done");
    const after = server.calls.length;
    const opened = target.opened.length;

    r.dismiss();
    r.offer([o.item]);
    r.retry();
    r.offer([o.item]);
    await settle();
    expect(server.calls.length).toBe(after);
    expect(target.opened.length).toBe(opened);
    expect(r.status).toBe("idle");
  });
});

// ── Leaving the room, and answering while a dialog is open ──────────────────
//
// Every await in this driver is a window in which the room can change under it.
// A continuation that resumes into a room it no longer belongs to can resurrect
// a dismissed prompt, write a previous pairing's files to disk after the user
// left, or overwrite the batch a NEW room is in the middle of offering. The
// epoch is what makes each of those a silent no-op.
describe("reset and reject make everything already in flight inert", () => {
  const heldGate = () => {
    let release!: () => void;
    let entered = false;
    const held = new Promise<void>((r) => { release = r; });
    return {
      release,
      entered: () => entered,
      gate: (url: string) => { entered = true; return url.endsWith("/meta") || url.endsWith("/blob") ? held : undefined; },
    };
  };

  it("leaves nothing behind when the room changes mid-manifest-fetch", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const g = heldGate();
    installServer([o], { gate: (u) => (u.endsWith("/meta") ? g.gate(u) : undefined) });
    const r = make();
    r.offer([o.item]);
    await until(() => g.entered());

    r.reset();
    expect(r.status).toBe("idle");
    g.release();
    await settle();
    // The old room's resolve finished into a room that no longer exists.
    expect(r.status).toBe("idle");
    expect(r.files).toEqual([]);
    expect(target.output.size).toBe(0);
  });

  it("does not let a resolve that outlived its room clobber the next one", async () => {
    // The worst shape of the same bug: the continuation lands while a NEW room's
    // batch is already on screen, and publishes the old room's files over it —
    // so the user accepts one set of names and receives another.
    const old = await makeObject("obj1", [{ name: "old.txt", body: "old" }]);
    const fresh = await makeObject("obj2", [{ name: "fresh.txt", body: "new" }]);
    const g = heldGate();
    installServer([old, fresh], { gate: (u) => (u.includes("obj1") ? g.gate(u) : undefined) });
    const r = make();
    r.offer([old.item]);
    await until(() => g.entered());

    r.reset();
    r.offer([fresh.item]);
    await until(() => r.status === "prompt");
    expect(r.files.map((f) => f.name)).toEqual(["fresh.txt"]);

    g.release();
    await settle();
    expect(r.files.map((f) => f.name)).toEqual(["fresh.txt"]);
    await r.accept();
    expect([...target.output.keys()]).toEqual(["fresh.txt"]);
  });

  it("writes nothing when the room changes while the save picker is open", async () => {
    // `status` is still `prompt` for as long as the dialog is up, so the picker
    // resolving is the first moment after the room went away — and by then the
    // batch, its keys and its target are all captured in a closure.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let opened = false;
    const r = make({ pick: async () => { opened = true; await held; return target; } });
    r.offer([o.item]);
    await until(() => r.status === "prompt");

    const accepting = r.accept();
    await until(() => opened);
    r.reset();
    release();
    await accepting;
    expect(target.output.size).toBe(0);
    expect(target.doneCalls).toBe(0);
    expect(r.status).toBe("idle");
  });

  it("writes nothing when the user declines while the save picker is open", async () => {
    // Declining is an ANSWER, and it is available for the whole time the dialog
    // is up. Honouring the picker afterwards would write files the user has
    // just said no to.
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o]);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let opened = false;
    const r = make({ pick: async () => { opened = true; await held; return target; } });
    r.offer([o.item]);
    await until(() => r.status === "prompt");

    const accepting = r.accept();
    await until(() => opened);
    r.reject();
    release();
    await accepting;
    expect(target.output.size).toBe(0);
    expect(target.doneCalls).toBe(0);
    expect(r.status).toBe("idle");
    // And it stays declined: the answer was not lost by the race either.
    r.offer([o.item]);
    await settle();
    expect(r.status).toBe("idle");
  });

  it("stops a download that outlives its room before it finalises the target", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const g = heldGate();
    const srv = installServer([o], { gate: (u) => (u.endsWith("/blob") ? g.gate(u) : undefined) });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    const accepting = r.accept();
    await until(() => g.entered());

    r.reset();
    // The request is in flight, so the only thing that can stop it is the signal
    // it was issued with. Asserted directly: without this, the case passes on a
    // response that simply had not arrived yet.
    expect(srv.signals.at(-1)?.aborted, "the in-flight blob request was never aborted").toBe(true);
    g.release();
    await accepting;
    await settle();
    expect(r.status).toBe("idle");
    expect(target.output.size, "bytes were written for a room the user has left").toBe(0);
    expect(target.doneCalls).toBe(0);
  });

  it("stops writing between two chunks of a stream that is already saving files", async () => {
    // The failure the gated-request cases above cannot see. By the time a
    // response BODY is streaming, the request is long past: every later chunk is
    // decrypted and written by a loop that no epoch check sits inside. So a
    // reset that lands after the first file is on disk used to stop nothing —
    // the rest of the batch went on being written into the previous room's
    // target, one file at a time, with `status` already back to `idle`.
    const o = await makeObject("obj1", [
      { name: "a.txt", body: "first" },
      { name: "b.txt", body: "second" },
      { name: "c.txt", body: "third" },
    ]);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let atSecondRead = false;
    const srv = installServer([o], {
      frameByFrame: ["obj1"],
      gateRead: (_id, i) => {
        if (i !== 1) return undefined;
        atSecondRead = true;
        return held;
      },
    });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    const accepting = r.accept();

    // Chunk 1 has been read, decrypted and COMMITTED — a real write, not a
    // pending one — before the stream is suspended at chunk 2.
    await until(() => atSecondRead);
    await until(() => target.output.has("a.txt"));
    expect(text(target.output.get("a.txt"))).toBe("first");

    r.reset();
    release();
    await accepting;
    await settle();

    expect([...target.output.keys()], "a file was written after the room went away").toEqual(["a.txt"]);
    expect(target.doneCalls).toBe(0);
    expect(srv.cancels, "the ciphertext stream was left running").toEqual(["obj1"]);
    expect(r.status).toBe("idle");
    // A sink for b.txt was opened before the suspension and is deliberately
    // ABANDONED rather than closed: closing is the commit on every target, so
    // tidying up here is what would hand the user the truncated file.
    expect(target.opened).toEqual(["a.txt", "b.txt"]);
  });

  // ── The awaits on the SAVE TARGET, not on the network ─────────────────────
  //
  // The case above suspends a stream read: the room ends while this side is
  // waiting for bytes. These three suspend the other half of the loop — the
  // write, the close and the open — because that is where the damage is done.
  // A check that only runs at the top of a round covers a signal that fired
  // BEFORE the round; the continuation of a pending sink await resumes INSIDE
  // one, past every check it will ever meet, and goes on to commit the file it
  // was writing and create the next one for a room that is over.
  it("does not commit or open anything when the room goes while a write is pending", async () => {
    const o = await makeObject("obj1", [
      { name: "a.txt", body: "first" },
      { name: "b.txt", body: "second" },
    ]);
    installServer([o]); // one delivery spanning both files: the loop never yields to the network
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let writing = false;
    target = memoryTarget({
      gateWrite: (name) => {
        if (name !== "a.txt") return undefined;
        writing = true;
        return held;
      },
    });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    const accepting = r.accept();
    await until(() => writing);

    r.reset();
    release();
    await accepting;
    await settle();

    // Nothing was committed: a.txt's own close is the commit, and it had not
    // been reached when the room went.
    expect([...target.output.keys()], "a file was committed after the room went away").toEqual([]);
    expect(target.opened, "the next entry was created after the room went away").toEqual(["a.txt"]);
    expect(target.doneCalls).toBe(0);
    expect(r.status).toBe("idle");
  });

  it("does not open the next entry when the room goes while a close is pending", async () => {
    const o = await makeObject("obj1", [
      { name: "a.txt", body: "first" },
      { name: "b.txt", body: "second" },
    ]);
    installServer([o]);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let closing = false;
    target = memoryTarget({
      gateClose: (name) => {
        if (name !== "a.txt") return undefined;
        closing = true;
        return held;
      },
    });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    const accepting = r.accept();
    await until(() => closing);

    r.reset();
    release();
    await accepting;
    await settle();

    // a.txt's close was ALREADY under way when the room went, and every byte of
    // it was written before that: finishing it is right, and abandoning it there
    // would throw away a complete file to nobody's benefit. What must not happen
    // is anything NEW — and b.txt is new.
    expect([...target.output.keys()]).toEqual(["a.txt"]);
    expect(target.opened, "the next entry was created after the room went away").toEqual(["a.txt"]);
    expect(target.doneCalls).toBe(0);
    expect(r.status).toBe("idle");
  });

  it("does not commit a zero-byte entry whose open resolved after the room went", async () => {
    // The tail loop, which finishes the manifest entries the plaintext stream
    // never drove. A zero-byte file is still a file the user sees appear, and
    // its open is the one await between the check at the top of the round and
    // the close that commits it.
    const o = await makeObject("obj1", [
      { name: "a.txt", body: "x" },
      { name: "y.txt", body: "" },
      { name: "z.txt", body: "" },
    ]);
    installServer([o]);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let opening = false;
    target = memoryTarget({
      gateOpen: (name) => {
        if (name !== "z.txt") return undefined;
        opening = true;
        return held;
      },
    });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    const accepting = r.accept();
    await until(() => opening);

    r.reset();
    release();
    await accepting;
    await settle();

    expect([...target.output.keys()], "an empty file was created after the room went away")
      .toEqual(["a.txt", "y.txt"]);
    expect(target.doneCalls).toBe(0);
    expect(r.status).toBe("idle");
  });

  it("aborts the manifest read when the room changes while it is in flight", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    const g = heldGate();
    const srv = installServer([o], { gate: (u) => (u.endsWith("/meta") ? g.gate(u) : undefined) });
    const r = make();
    r.offer([o.item]);
    await until(() => g.entered());

    r.reset();
    expect(srv.signals.at(-1)?.aborted, "the in-flight manifest request was never aborted").toBe(true);
    g.release();
    await settle();
    expect(r.status).toBe("idle");
  });

  it("does not report a run it aborted itself as a failure in the next room", async () => {
    // Leaving the room cancels the download, and a cancellation is not a fault:
    // it must not surface as a failure card, and above all must not mark the ids
    // unretryable in a room that has not even seen them.
    const o = await makeObject("obj1", [
      { name: "a.txt", body: "first" },
      { name: "b.txt", body: "second" },
    ]);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let atSecondRead = false;
    installServer([o], {
      frameByFrame: ["obj1"],
      gateRead: (_id, i) => {
        if (i !== 1) return undefined;
        atSecondRead = true;
        return held;
      },
    });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    const accepting = r.accept();
    await until(() => atSecondRead);

    r.reset();
    release();
    await accepting;
    await settle();
    expect(r.status).toBe("idle");
    expect(r.errorKey).toBe("");
    expect(r.retryable).toBe(false);
    expect(r.savedCount).toBe(0);

    // And the next room starts clean: the same object offered again is a fresh
    // question, answered by a complete download.
    target = memoryTarget();
    const r2 = make();
    r2.offer([o.item]);
    await until(() => r2.status === "prompt");
    await r2.accept();
    expect(r2.status).toBe("done");
    expect([...target.output.keys()]).toEqual(["a.txt", "b.txt"]);
  });

  it("keeps writing when reject() is called after the download has started", async () => {
    // Declining is an answer to the PROMPT, and the card offers it nowhere else:
    // once Save is pressed there is no cancel control, so reject() in
    // `receiving` is a no-op and must not tear down a transfer the user asked
    // for. Stated as a test because the abort wiring makes the opposite an easy
    // one-line "improvement" to make by accident.
    const o = await makeObject("obj1", [
      { name: "a.txt", body: "first" },
      { name: "b.txt", body: "second" },
    ]);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let atSecondRead = false;
    installServer([o], {
      frameByFrame: ["obj1"],
      gateRead: (_id, i) => {
        if (i !== 1) return undefined;
        atSecondRead = true;
        return held;
      },
    });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "prompt");
    const accepting = r.accept();
    await until(() => atSecondRead);

    r.reject();
    expect(r.status).toBe("receiving");
    release();
    await accepting;
    expect(r.status).toBe("done");
    expect([...target.output.keys()]).toEqual(["a.txt", "b.txt"]);
    expect(target.doneCalls).toBe(1);
  });

  it("drops the keys it was holding when the room goes", async () => {
    // The keys arrived sealed and never go anywhere: no URL, no storage, no log.
    // Leaving the room is the moment the last copy has to go too, including the
    // ids of a batch that was only ever queued.
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    installServer([a, b]);
    const r = make();
    r.offer([a.item]);
    await until(() => r.status === "prompt");
    r.offer([b.item]); // queued behind the prompt
    await settle();
    expect(r.waitingCount).toBe(1);

    r.reset();
    expect(r.waitingCount).toBe(0);
    expect(r.files).toEqual([]);
    expect(r.total).toBe(0);
    await settle();
    // Nothing resumes on its own: a queued batch from the old room must not
    // promote itself into the new one.
    expect(r.status).toBe("idle");
  });
});

// ── Saying what actually happened ───────────────────────────────────────────
describe("a partial failure is reported as partial", () => {
  it("counts the files that really reached the disk before it stopped", async () => {
    // "Nothing was saved" is false on every target that flushes per file: the
    // user has half a folder and is told they have none of it, so they do not
    // know to go and clean it up (or that the retry will land beside it).
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    installServer([a, b], { blobStatus: { obj2: 500 } });
    const r = make();
    r.offer([a.item, b.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");
    expect(r.savedCount).toBe(1);
    expect(target.output.has("a.txt")).toBe(true);
  });

  it("says nothing was saved when the target only delivers on finalise", async () => {
    // The ZIP branch assembles the whole archive in done(). A batch that never
    // reaches done() produced no file at all, however many entries it added, so
    // reporting a count here would be the same lie in the other direction.
    const a = await makeObject("obj1", [{ name: "a.txt", body: "one" }]);
    const b = await makeObject("obj2", [{ name: "b.txt", body: "two" }]);
    installServer([a, b], { blobStatus: { obj2: 500 } });
    const bundled = memoryTarget();
    bundled.bundled = true;
    const r = make({ pick: async () => bundled });
    r.offer([a.item, b.item]);
    await until(() => r.status === "prompt");
    await r.accept();
    expect(r.status).toBe("failed");
    expect(r.savedCount).toBe(0);
  });

  it("reports nothing saved when the failure came before any byte was written", async () => {
    const o = await makeObject("obj1", [{ name: "a.txt", body: "hello" }]);
    installServer([o], { metaStatus: { obj1: 410 } });
    const r = make();
    r.offer([o.item]);
    await until(() => r.status === "failed");
    expect(r.savedCount).toBe(0);
  });
});
