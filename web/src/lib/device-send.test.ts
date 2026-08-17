import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import sodium from "libsodium-wrappers";
import { decodeKey, decryptManifest, encodeKey, importStoreKey } from "./store-crypto";
import { decodeInboxManifest, INBOX_MANIFEST_MAX_TEXT_BYTES } from "./inbox-manifest";
import {
  CAP_RECEIVE_V3,
  CAP_TEXT_V1,
  INBOX_KEY_ALGORITHM,
  INBOX_PROTOCOL_VERSION,
} from "./device-inbox";
import {
  CANCELLABLE_STATES,
  SendFailure,
  cancelInboxTask,
  fetchInboxTask,
  newIdempotencyKey,
  sendFilesToDevice,
  sendTextToDevice,
} from "./device-send";

await sodium.ready;

const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const TASK_ID = "aaaabbbbccccddddeeeeffff00001111";
const OBJECT_ID = "11112222333344445555666677778888";

let target = sodium.crypto_box_keypair();

interface Call {
  url: string;
  method: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
}

let calls: Call[] = [];
/** Per-URL-prefix overrides, consulted before the default happy path. */
let handlers: ((c: Call) => Promise<Response> | Response | undefined)[] = [];
/** Everything the init body carried, so the manifest can be decrypted. */
let initBody: Uint8Array | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function taskJson(over: Record<string, unknown> = {}) {
  return {
    ID: TASK_ID,
    SourceDeviceID: "bbbbccccddddeeeeffff000011112222",
    TargetDeviceID: DEVICE_ID,
    IdempotencyKey: "",
    StoredFileID: OBJECT_ID,
    State: "queued",
    ErrorCode: "",
    CiphertextBytes: 42,
    SavedAt: 0,
    TerminalAt: 0,
    Terminal: false,
    ExpiresAt: 1_700_600_000,
    CreatedAt: 1_700_000_000,
    UpdatedAt: 1_700_000_000,
    TargetKeyID: "k1",
    TargetKeyGeneration: 1,
    ...over,
  };
}

/** Local hex, not `sodium.to_hex`: request bodies arrive as subarray views the
 *  wasm wrapper refuses, and this assertion must never fail for a reason that
 *  has nothing to do with what leaked. */
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function toBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(String(body));
}

function stubFetch() {
  const impl = vi.fn(async (input: string, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body,
      headers: init?.headers,
    };
    calls.push(call);
    for (const h of handlers) {
      const r = await h(call);
      if (r) return r;
    }
    // Default: the resumable upload happy path, then a created task.
    if (call.url === "/api/devices/browser-install" && call.method === "POST") {
      return json({ deviceId: "bbbbccccddddeeeeffff000011112222", created: false });
    }
    if (call.url.startsWith("/api/uploads/") && call.url.endsWith("/finalize")) {
      return json({ id: OBJECT_ID, expiresAt: 1_700_600_000 });
    }
    if (call.url.startsWith("/api/uploads/") && call.method === "PATCH") {
      const range = new Headers(call.headers).get("Content-Range") ?? "";
      const end = Number(/bytes \d+-(\d+)\//.exec(range)?.[1] ?? -1) + 1;
      return json({ received: end });
    }
    if (call.url.startsWith("/api/uploads")) {
      initBody = await toBytes(call.body);
      return json({ uploadId: "9999888877776666555544443333222", chunkSize: 1 << 20 });
    }
    if (call.url.includes("/inbox/tasks") && call.method === "POST") {
      return json({ task: taskJson(), created: true }, 201);
    }
    if (call.url.startsWith("/api/files/") && call.method === "DELETE") {
      return json({ status: "ok" });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function sendOpts(over: Record<string, unknown> = {}) {
  return { ttl: 604_800, idempotencyKey: "web-fixed-key", ...over } as never;
}

/** A send target. `presentsText` is what makes both halves of the capability
 *  rule reachable: a message needs `inbox.text.v1` and a file must not. */
function targetSpec(presentsText = true) {
  return {
    deviceID: DEVICE_ID,
    keyID: "k1",
    keyGeneration: 1,
    algorithm: INBOX_KEY_ALGORITHM,
    publicKey: encodeKey(target.publicKey),
    capabilities: presentsText
      ? [CAP_RECEIVE_V3, "inbox.autoaccept.v1", CAP_TEXT_V1]
      : [CAP_RECEIVE_V3, "inbox.autoaccept.v1"],
  };
}

/** The content key central was handed, unsealed the way the target device would
 *  unseal it — the only key that opens anything below. */
function contentKeyFromCreate(): Uint8Array {
  const body = JSON.parse(String(created()!.body));
  const sealed = sodium.from_base64(body.wrappedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  return sodium.crypto_box_seal_open(sealed, target.publicKey, target.privateKey);
}

/** The sealed frame-0 unit of the delivery that was just uploaded. */
function frameZero(): Uint8Array {
  const len = new DataView(initBody!.buffer, initBody!.byteOffset, 4).getUint32(0);
  expect(initBody!.length, "the length prefix does not describe the frame").toBe(4 + len);
  return initBody!.slice(4, 4 + len);
}

/** Frame 0, decoded with the Device Inbox v2 codec. */
async function sealedManifest(contentKey: Uint8Array) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(12) },
    await importStoreKey(contentKey),
    frameZero() as Uint8Array<ArrayBuffer>,
  );
  return decodeInboxManifest(new Uint8Array(pt));
}

/** Every payload frame's plaintext, concatenated in the order it was sent —
 *  which is the order the manifest's items claim. */
async function payloadPlaintext(contentKey: Uint8Array): Promise<Uint8Array> {
  const key = await importStoreKey(contentKey);
  const parts: Uint8Array[] = [];
  for (const c of calls.filter((c) => c.method === "PATCH")) {
    parts.push(await toBytes(c.body));
  }
  const stream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    stream.set(p, at);
    at += p.length;
  }
  const out: number[] = [];
  let off = 0;
  let seq = 1;
  while (off + 4 <= stream.length) {
    const n = new DataView(stream.buffer, stream.byteOffset + off, 4).getUint32(0);
    off += 4;
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(8, seq);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      stream.slice(off, off + n) as Uint8Array<ArrayBuffer>,
    );
    out.push(...new Uint8Array(pt));
    off += n;
    seq++;
  }
  expect(off, "trailing bytes after the last frame").toBe(stream.length);
  return new Uint8Array(out);
}

/** The outgoing selection, in the shape a picker or the folder walker produces:
 *  bytes plus the relative path that becomes the manifest name. */
const FILES = () => [
  { file: new File([new TextEncoder().encode("payroll numbers")], "Q3 payroll.xlsx") },
  { file: new File([new TextEncoder().encode("more")], "notes.md"), path: "secret folder/notes.md" },
];

/** What the manifest of `FILES()` must say, in order. */
const FILE_NAMES = ["Q3 payroll.xlsx", "secret folder/notes.md"];
const FILE_SIZES = [15, 4];

beforeEach(() => {
  calls = [];
  handlers = [];
  initBody = null;
  target = sodium.crypto_box_keypair();
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

const created = () => calls.find((c) => c.url.includes("/inbox/tasks") && c.method === "POST");
const creates = () => calls.filter((c) => c.url.includes("/inbox/tasks") && c.method === "POST");
const deletes = () => calls.filter((c) => c.url.startsWith("/api/files/") && c.method === "DELETE");
const uploadInits = () => calls.filter((c) => c.url.startsWith("/api/uploads?"));

describe("sending to a device", () => {
  it("uploads as purpose=device_task, unlimited-until-TTL, and never as a share", async () => {
    await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    const init = uploadInits();
    expect(init).toHaveLength(1);
    expect(init[0].url, "the upload did not carry the task purpose").toContain("purpose=device_task");
    // The queue requires an unlimited-until-TTL object; central refuses the
    // contradiction by name, so this client must never ask for one.
    expect(init[0].url).toContain("burnAfterRead=0");
    expect(init[0].url).not.toContain("maxDownloads");
  });

  it("the single-shot fallback carries the purpose too", async () => {
    // `uploadFileResumable` falls back to one POST /api/files when the chunked
    // endpoints are unusable — an older server, a node without PATCH-append.
    // That path is where a dropped purpose would turn a private delivery into a
    // PUBLIC capability-link object, so it is asserted on its own rather than
    // inferred from the chunked one.
    handlers.push((c) => (c.url.startsWith("/api/uploads") ? new Response("gone", { status: 404 }) : undefined));
    const posts: { url: string }[] = [];
    class FakeXHR {
      upload = {} as { onprogress?: unknown };
      status = 200;
      responseText = JSON.stringify({ id: OBJECT_ID, expiresAt: 1_700_600_000 });
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      withCredentials = false;
      open(_m: string, url: string) { posts.push({ url }); }
      send() { queueMicrotask(() => this.onload?.()); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);

    await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    expect(posts).toHaveLength(1);
    expect(posts[0].url, "the single-shot fallback uploaded a public share").toContain("purpose=device_task");
    expect(posts[0].url).toContain("/api/files?");
    expect(posts[0].url).not.toContain("maxDownloads");
    expect(created(), "no task was created after the fallback upload").toBeTruthy();
  });

  it("an ordinary share upload's request is unchanged by any of this", async () => {
    const { uploadFileResumable } = await import("./stored-file");
    await uploadFileResumable([new File(["x"], "a.txt")], { burnAfterRead: true, ttl: 3600 });
    const init = uploadInits();
    expect(init).toHaveLength(1);
    expect(init[0].url, "a share upload started announcing a purpose").not.toContain("purpose");
    expect(init[0].url).toContain("burnAfterRead=1");
  });

  it("creates the task with exactly the seven fields central accepts", async () => {
    await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    const body = JSON.parse(String(created()!.body));
    // The list is exhaustive on purpose. v2 added `protocolVersion` and NOTHING
    // else: no kind, no name, no path, no message, no key. Content kind lives
    // inside the encrypted manifest, so a seventh describing field appearing
    // here would be central learning what it must not be able to learn.
    expect(Object.keys(body).sort()).toEqual([
      "idempotencyKey",
      "protocolVersion",
      "storedFileId",
      "targetKeyGeneration",
      "targetKeyId",
      "wrapAlgorithm",
      "wrappedKey",
    ]);
    expect(body.protocolVersion).toBe(INBOX_PROTOCOL_VERSION);
    expect(body.wrapAlgorithm).toBe(INBOX_KEY_ALGORITHM);
    expect(body.storedFileId).toBe(OBJECT_ID);
    expect(body.targetKeyId).toBe("k1");
    expect(body.targetKeyGeneration).toBe(1);
  });

  it("the sealed key opens on the target device and decrypts the manifest it was sent with", async () => {
    // The end-to-end property, asserted rather than assumed: the box central
    // stores contains the key that decrypts the ciphertext central stores, and
    // only the target device can get at it.
    await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    const body = JSON.parse(String(created()!.body));
    const sealed = sodium.from_base64(body.wrappedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const contentKey = sodium.crypto_box_seal_open(sealed, target.publicKey, target.privateKey);
    expect(contentKey.length).toBe(32);

    // Frame 0 is the Device Inbox v2 manifest, opened with the v2 codec. It is
    // NOT the shared Stored-Wire manifest: a delivery that sealed that document
    // is refused by its own receiver as `verify_failed`, after the whole
    // ciphertext has been uploaded, queued and downloaded.
    const manifest = await sealedManifest(contentKey);
    expect(manifest.items.map((i) => i.kind)).toEqual(["file", "file"]);
    expect(manifest.items.map((i) => i.name)).toEqual(FILE_NAMES);
    expect(manifest.items.map((i) => i.size)).toEqual(FILE_SIZES);

    await expect(
      decryptManifest(await importStoreKey(contentKey), frameZero()),
      "a delivery's frame 0 must not also parse as the shared manifest",
    ).rejects.toThrow();
  });

  it("no request carries a file name, a path or the raw content key", async () => {
    await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    const body = JSON.parse(String(created()!.body));
    const sealed = sodium.from_base64(body.wrappedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const contentKey = sodium.crypto_box_seal_open(sealed, target.publicKey, target.privateKey);
    const rawKeyB64 = encodeKey(contentKey);

    const everything: string[] = [];
    for (const c of calls) {
      everything.push(c.url);
      everything.push(hex(await toBytes(c.body)));
    }
    const blob = everything.join("\n");
    // Names travel only inside AES-GCM ciphertext, so their bytes must not
    // appear anywhere — not in a URL, not in a body, not in a header.
    expect(blob).not.toContain(hex(new TextEncoder().encode("payroll")));
    expect(blob).not.toContain(hex(new TextEncoder().encode("secret folder")));
    expect(blob).not.toContain("payroll");
    expect(blob).not.toContain(rawKeyB64);
    expect(blob).not.toContain(hex(contentKey));
  });

  it("persists nothing: no upload key, no share link, no storage write at all", async () => {
    // A share upload files its content key under the object id in localStorage
    // so My Files can rebuild the `/d/<id>#k=<key>` link. Doing that for a
    // delivery would be a real leak of a different shape: `#k=` plus an id is a
    // capability anyone on the machine could use, for ciphertext the user
    // believes only their own laptop can read — and the id is not even
    // publicly fetchable, so the entry would be pure liability.
    const before = JSON.stringify(localStorage);
    const writes: string[] = [];
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      writes.push(k);
      return realSet.call(this, k, v);
    });
    try {
      await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    } finally {
      vi.restoreAllMocks();
    }
    expect(writes, `a device send wrote to storage: ${writes.join(", ")}`).toEqual([]);
    expect(JSON.stringify(localStorage)).toBe(before);
    expect(localStorage.getItem("relayium.uploadKeys.v1"), "the delivery key was filed as a share key").toBeNull();
    // And no capability link was built anywhere along the way.
    const urls = calls.map((c) => c.url).join("\n");
    expect(urls).not.toContain("#k=");
    expect(urls).not.toContain("/d/");
  });

  it("refuses an empty selection without touching the network", async () => {
    await expect(sendFilesToDevice(targetSpec(), [], sendOpts())).rejects.toMatchObject({ code: "no_files" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a device id that would compose a different request path", async () => {
    await expect(
      sendFilesToDevice({ ...targetSpec(), deviceID: "../me" }, FILES(), sendOpts()),
    ).rejects.toBeInstanceOf(SendFailure);
    expect(calls, "a refused device id still cost a request").toHaveLength(0);
  });

  it("mints a distinct, wire-legal idempotency key per send", () => {
    const keys = new Set(Array.from({ length: 200 }, newIdempotencyKey));
    expect(keys.size).toBe(200);
    for (const k of keys) {
      expect(k.length).toBeLessThanOrEqual(128);
      expect(k).toMatch(/^[\x21-\x7e]+$/);
    }
  });
});

describe("the stale-key race", () => {
  it("re-reads the current key, re-seals, and retries the SAME create", async () => {
    const fresh = sodium.crypto_box_keypair();
    let createCount = 0;
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks") && c.method === "POST") {
        createCount++;
        if (createCount === 1) return json({ error: "stale_target_key" }, 409);
        return json({ task: taskJson({ TargetKeyID: "k2" }), created: true }, 201);
      }
      if (c.url.endsWith("/inbox/keys")) {
        return json({
          keys: [
            { ID: "k2", Algorithm: INBOX_KEY_ALGORITHM, PublicKey: encodeKey(fresh.publicKey), Generation: 2, SupersededAt: 0, RevokedAt: 0 },
            { ID: "k1", Algorithm: INBOX_KEY_ALGORITHM, PublicKey: encodeKey(target.publicKey), Generation: 1, SupersededAt: 5, RevokedAt: 0 },
          ],
        });
      }
      return undefined;
    });

    const task = await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    expect(task.ID).toBe(TASK_ID);

    const bodies = creates().map((c) => JSON.parse(String(c.body)));
    expect(bodies).toHaveLength(2);
    // The retry must not rebind: same object, same idempotency key. Only the
    // key material changes.
    expect(bodies[1].storedFileId).toBe(bodies[0].storedFileId);
    expect(bodies[1].idempotencyKey).toBe(bodies[0].idempotencyKey);
    expect(bodies[1].targetKeyId).toBe("k2");
    expect(bodies[1].targetKeyGeneration).toBe(2);
    expect(bodies[1].wrappedKey).not.toBe(bodies[0].wrappedKey);
    // …and the ciphertext is NOT re-uploaded.
    expect(uploadInits(), "the whole file was uploaded again for a key rotation").toHaveLength(1);
    // The re-sealed box opens under the NEW key and not the old one.
    const sealed = sodium.from_base64(bodies[1].wrappedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    expect(sodium.crypto_box_seal_open(sealed, fresh.publicKey, fresh.privateKey).length).toBe(32);
    expect(() => sodium.crypto_box_seal_open(sealed, target.publicKey, target.privateKey)).toThrow();
    expect(deletes()).toHaveLength(0);
  });

  it("gives up honestly when the device has no usable current key, and releases the object", async () => {
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks") && c.method === "POST") return json({ error: "stale_target_key" }, 409);
      if (c.url.endsWith("/inbox/keys")) return json({ keys: [] });
      return undefined;
    });
    await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({
      code: "stale_target_key",
    });
    expect(deletes().map((d) => d.url)).toEqual([`/api/files/${OBJECT_ID}`]);
  });

  it("does not loop forever on a device that keeps rotating", async () => {
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks") && c.method === "POST") return json({ error: "stale_target_key" }, 409);
      if (c.url.endsWith("/inbox/keys")) {
        const k = sodium.crypto_box_keypair();
        return json({ keys: [{ ID: "kN", Algorithm: INBOX_KEY_ALGORITHM, PublicKey: encodeKey(k.publicKey), Generation: 9, SupersededAt: 0, RevokedAt: 0 }] });
      }
      return undefined;
    });
    await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({
      code: "stale_target_key",
    });
    expect(creates().length).toBeLessThanOrEqual(3);
  });
});

describe("failures and cleanup", () => {
  it("returns the invisible quota immediately on every definitive refusal", async () => {
    for (const [serverCode, expected] of [
      ["auto_receive_disabled", "auto_receive_disabled"],
      ["device_cannot_receive", "device_cannot_receive"],
      ["inbox_queue_full", "inbox_queue_full"],
      ["stored_object_already_bound", "stored_object_already_bound"],
      ["some_future_token", "unknown"],
    ] as const) {
      calls = [];
      handlers = [
        (c) =>
          c.url.includes("/inbox/tasks") && c.method === "POST"
            ? json({ error: serverCode }, serverCode === "inbox_queue_full" ? 429 : 409)
            : undefined,
      ];
      await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({ code: expected });
      expect(deletes(), `no cleanup after ${serverCode}`).toHaveLength(1);
    }
  });

  it("converges on the task that already exists when the answer was lost", async () => {
    // Three ambiguous creates, then the lookup finds our idempotency key: the
    // write DID land, so this is a success and nothing may be deleted.
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks") && c.method === "POST") throw new TypeError("network down");
      if (c.url.includes("/inbox/tasks?limit=") && c.method === "GET") {
        return json({ tasks: [taskJson({ IdempotencyKey: "web-fixed-key" })] });
      }
      return undefined;
    });
    const task = await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    expect(task.ID).toBe(TASK_ID);
    expect(creates()).toHaveLength(3);
    expect(deletes(), "a converged task's ciphertext was deleted").toHaveLength(0);
  });

  it("releases the object when the lookup PROVES no task was created", async () => {
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks") && c.method === "POST") throw new TypeError("network down");
      if (c.url.includes("/inbox/tasks?limit=") && c.method === "GET") return json({ tasks: [] });
      return undefined;
    });
    await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({ code: "network" });
    expect(deletes()).toHaveLength(1);
  });

  it("KEEPS the ciphertext when the outcome is genuinely unknown", async () => {
    // The lookup failed too, so a delivery may be live. Destroying ciphertext on
    // a guess would turn a slow transfer into a lost one; GC reclaims it after
    // the bind grace if no task ever owned it.
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks")) throw new TypeError("network down");
      return undefined;
    });
    await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({ code: "network" });
    expect(deletes(), "ciphertext was deleted while its fate was unknown").toHaveLength(0);
  });

  it("does not retry a 5xx forever, but does treat it as ambiguous", async () => {
    handlers.push((c) =>
      c.url.includes("/inbox/tasks") && c.method === "POST" ? new Response("boom", { status: 503 }) : undefined,
    );
    handlers.push((c) =>
      c.url.includes("/inbox/tasks?limit=") && c.method === "GET" ? json({ tasks: [] }) : undefined,
    );
    await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({ code: "network" });
    expect(creates()).toHaveLength(3);
  });

  it("maps a signed-out upload without pretending anything was queued", async () => {
    handlers.push((c) => (c.url.startsWith("/api/uploads") ? new Response("no", { status: 401 }) : undefined));
    await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({ code: "signed_out" });
    expect(created()).toBeUndefined();
  });

  it("maps an over-quota upload to its own guidance", async () => {
    handlers.push((c) => (c.url.startsWith("/api/uploads") ? new Response("no", { status: 429 }) : undefined));
    await expect(sendFilesToDevice(targetSpec(), FILES(), sendOpts())).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });

  it("refuses to wrap to an unusable key and never uploads twice for it", async () => {
    const zeroKey = encodeKey(new Uint8Array(32));
    await expect(
      sendFilesToDevice({ ...targetSpec(), publicKey: zeroKey }, FILES(), sendOpts()),
    ).rejects.toMatchObject({ code: "unsupported_key" });
    // The upload already happened (the seal is deliberately last), so the
    // object must be released rather than left invisible.
    expect(deletes()).toHaveLength(1);
    expect(created()).toBeUndefined();
  });

  it("cancelling between finalize and create releases the object", async () => {
    const controller = new AbortController();
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks") && c.method === "POST") {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return undefined;
    });
    await expect(
      sendFilesToDevice(targetSpec(), FILES(), sendOpts({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(deletes()).toHaveLength(1);
  });

  it("reports progress through the two sender-local phases", async () => {
    const seen: string[] = [];
    await sendFilesToDevice(
      targetSpec(),
      FILES(),
      sendOpts({ onProgress: (p: { phase: string }) => seen.push(p.phase) }),
    );
    expect(new Set(seen)).toContain("uploading");
    expect(seen[seen.length - 1], "the create step was not distinguishable from the upload").toBe("registering");
  });
});

describe("reading and cancelling a task", () => {
  it("refuses to poll or cancel through an id that is not one inert token", async () => {
    expect(await fetchInboxTask("../me", TASK_ID)).toBeNull();
    expect(await fetchInboxTask(DEVICE_ID, "../../files")).toBeNull();
    expect(await cancelInboxTask(DEVICE_ID, "..")).toBe(false);
    expect(calls, "a refused id still reached the network").toHaveLength(0);
  });

  it("distinguishes gone (404) from a transient failure", async () => {
    handlers.push(() => new Response("nope", { status: 404 }));
    expect(await fetchInboxTask(DEVICE_ID, TASK_ID)).toBeNull();
    handlers = [() => new Response("later", { status: 503 })];
    expect(await fetchInboxTask(DEVICE_ID, TASK_ID)).toBeUndefined();
    handlers = [
      () => {
        throw new TypeError("offline");
      },
    ];
    expect(await fetchInboxTask(DEVICE_ID, TASK_ID)).toBeUndefined();
  });

  it("treats an already-deleted task as cancelled", async () => {
    handlers.push(() => new Response("gone", { status: 404 }));
    expect(await cancelInboxTask(DEVICE_ID, TASK_ID)).toBe(true);
  });

  it("offers cancellation only where nothing is in flight", () => {
    // A live lease means the device may be seconds from a successful commit;
    // deleting under it would turn that into a failed report.
    expect([...CANCELLABLE_STATES].sort()).toEqual([
      "attention_required",
      "failed_retryable",
      "notified",
      "queued",
    ]);
    for (const s of ["downloading", "verifying", "saved", "expired", "revoked", "failed_terminal"]) {
      expect(CANCELLABLE_STATES.has(s), `${s} offered a cancel button`).toBe(false);
    }
  });
});

// The Device Inbox v2 manifest a sender seals.
//
// Everything here is asserted against the BYTES a delivery produced, opened
// with its own content key, rather than against the intermediate values the
// sender happened to compute. That is the only way to check the property that
// matters: a v2 receiver opens frame 0 with the v2 codec, so a sender that
// sealed the shared Stored-Wire manifest has produced a delivery its own
// receiver refuses as `verify_failed` — after the whole file has been uploaded,
// queued and downloaded.
describe("the sealed v2 manifest", () => {
  it("seals a file delivery's names, sizes and order, hierarchy included", async () => {
    await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    const manifest = await sealedManifest(contentKeyFromCreate());

    expect(manifest.v).toBe(3);
    expect(manifest.items.map((i) => i.kind)).toEqual(["file", "file"]);
    // Item order is the SENDER's and is never sorted: item i describes the
    // payload frames of blob i, so reordering renames every file.
    expect(manifest.items.map((i) => i.name)).toEqual(FILE_NAMES);
    expect(manifest.items.map((i) => i.size)).toEqual(FILE_SIZES);
  });

  it("keeps a folder's hierarchy and an empty file, and matches the payload order", async () => {
    const picked = [
      { file: new File([new TextEncoder().encode("second")], "IMG_0002.jpg"), path: "trip/day 1/IMG_0002.jpg" },
      { file: new File([new TextEncoder().encode("first")], "IMG_0001.jpg"), path: "trip/day 1/IMG_0001.jpg" },
      // An empty file is a real file: a manifest item of size 0 and no frame.
      { file: new File([], "empty.txt"), path: "trip/notes/empty.txt" },
      { file: new File([new TextEncoder().encode("hello device inbox")], "readme.md") },
    ];
    await sendFilesToDevice(targetSpec(), picked, sendOpts());
    const key = contentKeyFromCreate();
    const manifest = await sealedManifest(key);

    expect(manifest.items.map((i) => i.name)).toEqual([
      "trip/day 1/IMG_0002.jpg",
      "trip/day 1/IMG_0001.jpg",
      "trip/notes/empty.txt",
      "readme.md",
    ]);
    expect(manifest.items.map((i) => i.size)).toEqual([6, 5, 0, 18]);
    expect(new TextDecoder().decode(await payloadPlaintext(key))).toBe("secondfirsthello device inbox");
  });

  it("a share upload's frame 0 is still the shared Stored-Wire manifest", async () => {
    const { uploadFileResumable } = await import("./stored-file");
    const out = await uploadFileResumable([new File(["x"], "a.txt")], { burnAfterRead: true, ttl: 3600 });
    const shared = await decryptManifest(await importStoreKey(decodeKey(out.key)), frameZero());
    expect(shared.files).toEqual([{ name: "a.txt", size: 1 }]);
  });

  it("refuses a name no receiver would accept, before a byte is uploaded", async () => {
    for (const name of ["../../etc/passwd", "/etc/passwd", "a\\b.txt", "a/../b"]) {
      calls = [];
      await expect(
        sendFilesToDevice(targetSpec(), [{ file: new File(["x"], "x"), path: name }], sendOpts()),
      ).rejects.toMatchObject({ code: "unsendable_content" });
      expect(uploadInits(), `${name} reached the network`).toHaveLength(0);
      expect(creates()).toHaveLength(0);
    }
  });

  it("refuses to seal a v2 manifest onto a share, or the shared one onto a delivery", async () => {
    const { uploadFileResumable, ManifestPurposeMismatchError } = await import("./stored-file");
    // A share carrying a v2 manifest is a download page that cannot read its
    // own file list.
    await expect(
      uploadFileResumable([new File(["x"], "a.txt")], {
        burnAfterRead: false,
        ttl: 3600,
        sealedManifest: new TextEncoder().encode('{"v":2,"items":[{"kind":"file","name":"a.txt","size":1}]}'),
      }),
    ).rejects.toBeInstanceOf(ManifestPurposeMismatchError);
    // And the reverse: a delivery that did not seal its own document would seal
    // the shared one, which its own receiver refuses as `verify_failed`.
    await expect(
      uploadFileResumable([new File(["x"], "a.txt")], {
        burnAfterRead: false,
        ttl: 3600,
        purpose: "device_task",
      }),
    ).rejects.toBeInstanceOf(ManifestPurposeMismatchError);
    expect(uploadInits(), "a refused upload still opened a session").toHaveLength(0);
  });
});

describe("sending a message", () => {
  const MESSAGE = "meet me at 6 — 会议室 B";

  it("seals one text item carrying only its byte length", async () => {
    await sendTextToDevice(targetSpec(), MESSAGE, sendOpts());
    const manifest = await sealedManifest(contentKeyFromCreate());

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].kind).toBe("text");
    // A text item has NO name key: an empty string is something a receiver
    // could be tempted to treat as a destination, an absent one cannot be.
    expect("name" in manifest.items[0]).toBe(false);
    expect(manifest.items[0].size).toBe(new TextEncoder().encode(MESSAGE).length);
  });

  it("carries the body in the payload frames and nowhere else", async () => {
    await sendTextToDevice(targetSpec(), MESSAGE, sendOpts());
    const key = contentKeyFromCreate();
    expect(new TextDecoder().decode(await payloadPlaintext(key))).toBe(MESSAGE);

    // Not in the manifest frame, and not anywhere central can read it: every
    // request URL and body, hexed, must not contain the message's bytes.
    const body = new TextEncoder().encode(MESSAGE);
    const everything: string[] = [];
    for (const c of calls) {
      everything.push(c.url);
      everything.push(hex(await toBytes(c.body)));
    }
    const blob = everything.join("\n");
    expect(blob).not.toContain(hex(body));
    expect(blob).not.toContain(MESSAGE);
    expect(hex(frameZero())).not.toContain(hex(body));
  });

  it("creates the task with exactly the seven opaque fields a file send uses", async () => {
    await sendTextToDevice(targetSpec(), MESSAGE, sendOpts());
    const body = JSON.parse(String(created()!.body));

    expect(Object.keys(body).sort()).toEqual([
      "idempotencyKey",
      "protocolVersion",
      "storedFileId",
      "targetKeyGeneration",
      "targetKeyId",
      "wrapAlgorithm",
      "wrappedKey",
    ]);
    expect(body.protocolVersion).toBe(INBOX_PROTOCOL_VERSION);
    // Kind is sealed. Nothing on this request may name it, or name what the
    // delivery contains, ever.
    for (const forbidden of ["kind", "text", "message", "name", "path", "manifest", "itemCount"]) {
      expect(Object.keys(body), `the create carried ${forbidden}`).not.toContain(forbidden);
    }
    expect(String(created()!.body)).not.toContain(MESSAGE);
  });

  it("is indistinguishable from a file delivery on the wire", async () => {
    await sendTextToDevice(targetSpec(), MESSAGE, sendOpts());
    const messageInit = uploadInits()[0].url;
    const messageCreate = Object.keys(JSON.parse(String(created()!.body))).sort();

    calls = [];
    await sendFilesToDevice(targetSpec(), FILES(), sendOpts());
    expect(uploadInits()[0].url.replace(/size=\d+/, "size=N")).toBe(messageInit.replace(/size=\d+/, "size=N"));
    expect(Object.keys(JSON.parse(String(created()!.body))).sort()).toEqual(messageCreate);
  });

  it("refuses a target that would not present a message as a message", async () => {
    await expect(sendTextToDevice(targetSpec(false), MESSAGE, sendOpts())).rejects.toMatchObject({
      code: "text_unsupported",
    });
    expect(uploadInits(), "the ciphertext was uploaded anyway").toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("fails closed when the target's capabilities are unknown", async () => {
    const spec = targetSpec();
    delete (spec as { capabilities?: unknown }).capabilities;
    await expect(sendTextToDevice(spec, MESSAGE, sendOpts())).rejects.toMatchObject({
      code: "text_unsupported",
    });
  });

  it("sends FILES to that same target without the text capability", async () => {
    // The other half of the rule, and the more important one: requiring
    // `inbox.text.v1` of a file send would refuse the CLI, iOS, and every other
    // receiver that takes files perfectly well and renders no messages.
    const task = await sendFilesToDevice(targetSpec(false), FILES(), sendOpts());
    expect(task.ID).toBe(TASK_ID);
    expect(uploadInits()[0].url).toContain("purpose=device_task");
    expect((await sealedManifest(contentKeyFromCreate())).items[0].kind).toBe("file");
  });

  it("refuses an empty message and one over 64 KiB, in UTF-8 bytes", async () => {
    await expect(sendTextToDevice(targetSpec(), "", sendOpts())).rejects.toMatchObject({
      code: "empty_message",
    });
    await expect(
      sendTextToDevice(targetSpec(), "a".repeat(INBOX_MANIFEST_MAX_TEXT_BYTES + 1), sendOpts()),
    ).rejects.toMatchObject({ code: "message_too_long" });
    // One emoji is four UTF-8 bytes, so a per-character bound would let this
    // past a check the seal then refuses.
    await expect(
      sendTextToDevice(targetSpec(), "🙂".repeat(INBOX_MANIFEST_MAX_TEXT_BYTES / 4 + 1), sendOpts()),
    ).rejects.toMatchObject({ code: "message_too_long" });
    expect(uploadInits()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("accepts both ends of the range", async () => {
    for (const size of [1, INBOX_MANIFEST_MAX_TEXT_BYTES]) {
      calls = [];
      await sendTextToDevice(targetSpec(), "a".repeat(size), sendOpts());
      expect((await sealedManifest(contentKeyFromCreate())).items[0].size).toBe(size);
    }
  });

  it("one delivery is one kind: nothing can attach a file to a message", async () => {
    await sendTextToDevice(targetSpec(), MESSAGE, sendOpts());
    const manifest = await sealedManifest(contentKeyFromCreate());
    expect(new Set(manifest.items.map((i) => i.kind)).size).toBe(1);
  });

  it("converges a retry onto one delivery, exactly as a file send does", async () => {
    // The first create's answer is lost; the second carries the SAME
    // idempotency key, so central converges rather than queueing a second
    // message — and the delivery is still a message.
    let attempt = 0;
    handlers.push((c) => {
      if (c.url.includes("/inbox/tasks") && c.method === "POST" && attempt++ === 0) {
        return new Response("", { status: 502 });
      }
      return undefined;
    });
    const task = await sendTextToDevice(targetSpec(), MESSAGE, sendOpts());

    expect(task.ID).toBe(TASK_ID);
    expect(creates()).toHaveLength(2);
    const keys = creates().map((c) => JSON.parse(String(c.body)).idempotencyKey);
    expect(new Set(keys).size, "the retry minted a second idempotency key").toBe(1);
    expect(uploadInits(), "the retry re-uploaded the ciphertext").toHaveLength(1);
    expect((await sealedManifest(contentKeyFromCreate())).items[0].kind).toBe("text");
  });

  it("stays a message across a key rotation and reseal", async () => {
    const rotated = sodium.crypto_box_keypair();
    let attempt = 0;
    handlers.push((c) => {
      if (c.url.includes("/inbox/keys")) {
        return json({
          keys: [
            {
              ID: "k2",
              Algorithm: INBOX_KEY_ALGORITHM,
              PublicKey: encodeKey(rotated.publicKey),
              Generation: 2,
              SupersededAt: 0,
              RevokedAt: 0,
            },
          ],
        });
      }
      if (c.url.includes("/inbox/tasks") && c.method === "POST" && attempt++ === 0) {
        return json({ error: "stale_target_key" }, 409);
      }
      return undefined;
    });

    await sendTextToDevice(targetSpec(), MESSAGE, sendOpts());

    expect(creates()).toHaveLength(2);
    expect(JSON.parse(String(creates()[1].body)).targetKeyId).toBe("k2");
    expect(uploadInits(), "a reseal must not re-upload a byte").toHaveLength(1);
    // The reseal wrapped the SAME content key, so the manifest it opens is the
    // one the first attempt sealed — still a message, never a file.
    const body = JSON.parse(String(creates()[1].body));
    const sealed = sodium.from_base64(body.wrappedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const key = sodium.crypto_box_seal_open(sealed, rotated.publicKey, rotated.privateKey);
    expect((await sealedManifest(key)).items[0].kind).toBe("text");
  });
});

describe("who may be offered a text send", () => {
  const inboxView = (over: Record<string, unknown> = {}) => ({
    Presence: "online",
    LastHeartbeatAt: 1,
    PresenceExpiresAt: 2,
    HeartbeatIntervalSeconds: 30,
    ProtocolVersion: 2,
    Capabilities: [CAP_RECEIVE_V3, CAP_TEXT_V1],
    ReceiveCapability: CAP_RECEIVE_V3,
    AutoAccept: "auto",
    ReceiveDirReady: true,
    Platform: "macos",
    AppVersion: "1.0",
    Revoked: false,
    CanReceive: true,
    RegisteredAt: 1,
    Key: {
      ID: "k1",
      Algorithm: INBOX_KEY_ALGORITHM,
      PublicKey: encodeKey(target.publicKey),
      Generation: 1,
      CreatedAt: 1,
      SupersededAt: 0,
      RevokedAt: 0,
    },
    ...over,
  });

  it("follows the announced token", async () => {
    const { canSendText, parseDeviceInbox } = await import("./device-inbox");
    expect(canSendText(DEVICE_ID, parseDeviceInbox(inboxView()))).toBe(true);
    expect(canSendText(DEVICE_ID, parseDeviceInbox(inboxView({ Capabilities: [CAP_RECEIVE_V3] })))).toBe(false);
    expect(canSendText(DEVICE_ID, null)).toBe(false);
  });

  it("does not suppress text for an unusable receive folder", async () => {
    // A message is never written to the receive folder, so a folder that is not
    // ready has nothing to do with whether one can land. It stays a truthful
    // FILE caveat and blocks nothing.
    const { canSendText, sendAvailability, parseDeviceInbox } = await import("./device-inbox");
    const inbox = parseDeviceInbox(inboxView({ ReceiveDirReady: false }));
    expect(canSendText(DEVICE_ID, inbox)).toBe(true);
    const avail = sendAvailability(DEVICE_ID, inbox);
    expect(avail.sendable).toBe(true);
    expect(avail.caveats).toContain("directory_not_ready");
  });

  it("still refuses text on a device no send may reach at all", async () => {
    const { canSendText, parseDeviceInbox } = await import("./device-inbox");
    for (const over of [{ Revoked: true }, { CanReceive: false }, { AutoAccept: "off" }]) {
      expect(canSendText(DEVICE_ID, parseDeviceInbox(inboxView(over))), JSON.stringify(over)).toBe(false);
    }
  });
});
