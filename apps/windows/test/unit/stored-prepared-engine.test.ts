import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore, type SecretCipher } from "../../src/main/secrets.js";
import { accountKeyOf } from "../../src/main/inbox/account.js";
import { captureAuthority, Fence } from "../../src/main/stored/upload/authority.js";
import { RecoveryStore } from "../../src/main/stored/upload/recovery-store.js";
import { PreparedUploadEngine } from "../../src/main/stored/upload/prepared-engine.js";
import { planUpload } from "../../src/main/stored/upload/plan.js";
import { UploadTransport } from "../../src/main/stored/upload/transport.js";
import { storedRuntime, resetStoredRuntimeForTest } from "../../src/main/stored/runtime.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";
import { encryptFiles } from "../../../../web/src/lib/store-crypto";

const ORIGIN = "https://relayium.com";
const ACCOUNT = "synthetic-account";
const JOB = `u-${"c".repeat(32)}`;
const owned: string[] = [];
let runtime: StoredRuntime;
beforeAll(async () => {
  resetStoredRuntimeForTest();
  runtime = await storedRuntime(async () => import(new URL("../../dist/main/stored-runtime.js", import.meta.url).href));
});
afterEach(async () => { for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true }); });
const cipher: SecretCipher = {
  isAvailable: () => true, encrypt: (s) => Buffer.from(s), decrypt: (s) => s.toString(),
};

class Server {
  readonly methods: string[] = [];
  body = Buffer.alloc(0);
  failPatch = false;
  dropFinalize = false;
  finalized = false;
  initCount = 0;
  readonly fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = options?.method ?? "GET";
    this.methods.push(`${method} ${path}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (method === "POST" && path === "/api/uploads") {
      this.initCount++; return json(200, { uploadId: "session-1", chunkSize: 65536 });
    }
    if (method === "GET") return this.finalized ? json(404, {}) : json(200, { received: this.body.length });
    if (method === "PATCH") {
      if (this.failPatch) return json(403, {});
      const start = Number(/bytes (\d+)-/.exec((options?.headers as Record<string, string>)["content-range"])?.[1]);
      if (start !== this.body.length) return json(409, { received: this.body.length });
      this.body = Buffer.concat([this.body, Buffer.from(options?.body as Uint8Array)]);
      return json(200, { received: this.body.length });
    }
    if (path.endsWith("/finalize")) {
      if (options?.body !== '{"recoverFinalized":true}') throw new Error("missing durable finalize opt-in");
      this.finalized = true;
      if (this.dropFinalize) throw new TypeError("synthetic response loss");
      return json(200, { id: "object-1", expiresAt: 1800000000, recovered: true });
    }
    return json(404, {});
  }) as typeof fetch;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "relayium-prepared-")); owned.push(root);
  const secrets = new SecretStore(join(root, "secrets"), cipher);
  const store = new RecoveryStore(root, secrets);
  const server = new Server();
  const data = Uint8Array.from({ length: runtime.constants.storeChunkSize + 1000 }, (_, i) => i % 251);
  const generated = await runtime.generateKey();
  const files = [new File([data], "synthetic.txt")];
  const planned = planUpload([{ path: "synthetic.txt", size: data.length }], runtime.constants);
  if (!planned.ok) throw new Error("plan refused");
  const sealed = await runtime.sealManifest(generated.key, { files: planned.plan.manifest });
  const frames: Uint8Array[] = [];
  for await (const frame of encryptFiles(files, generated.key)) frames.push(frame);
  const context = (newStore = store) => ({ store: newStore, runtime, fence: new Fence(captureAuthority({ accountId: ACCOUNT, deviceId: "synthetic-device", documentId: "synthetic-document", origin: ORIGIN, bearer: "synthetic-bearer" })),
    transport: new UploadTransport(ORIGIN, "synthetic-bearer", { fetchImpl: server.fetch }) });
  const engine = await PreparedUploadEngine.create(context(), {
    jobId: JOB, accountId: ACCOUNT, origin: ORIGIN, createdAt: 100,
    descriptors: [{ path: "synthetic.txt", size: data.length }], sealedManifest: Buffer.from(sealed).toString("base64"),
    cipherBytes: planned.plan.cipherBytes, retention: { burnAfterRead: false, ttlSeconds: 3600 },
  });
  const feed = async () => {
    for (const bytes of frames) {
      const next = engine.expects;
      if (!next) throw new Error("missing preparation expectation");
      await engine.feed({ ...next, bytes });
    }
  };
  return { root, secrets, store, server, engine, frames, feed, context };
}

describe("prepare completely before upload, then recover original ciphertext", () => {
  it("settles a short producer without opening HTTP or leaving an open preparer", async () => {
    const { server, engine } = await setup();
    expect(await engine.end()).toMatchObject({ status: "failed", code: "producer-short" });
    expect(engine.outcome).toMatchObject({ status: "failed", code: "producer-short" });
    expect(server.methods).toEqual([]);
  });

  it("a mislabelled preparation frame settles a real failure before HTTP", async () => {
    const { server, engine, frames } = await setup();
    const expected = engine.expects!;
    await expect(engine.feed({ ...expected, seq: expected.seq + 1, bytes: frames[0]! })).rejects.toMatchObject({ code: "frame-sequence" });
    expect(engine.outcome).toMatchObject({ status: "failed", code: "frame-sequence" });
    expect(server.methods).toEqual([]);
  });
  it("opens no network session before all ciphertext is fsynced and its protected plan is ready", async () => {
    const { server, engine, frames, feed, store } = await setup();
    await feed();
    expect(server.methods).toEqual([]);
    expect((await store.read(ACCOUNT, ORIGIN, JOB)).phase).toBe("preparing");
    expect((await engine.end()).status).toBe("published");
    expect(server.body).toEqual(Buffer.concat(frames.map((f) => Buffer.from(f))));
    expect(server.initCount).toBe(1);
    expect((await store.read(ACCOUNT, ORIGIN, JOB)).phase).toBe("published");
  });

  it("reopens an interrupted job and resumes the same session with the same ciphertext", async () => {
    const { server, engine, frames, feed, root, secrets, context } = await setup();
    await feed(); server.failPatch = true;
    expect((await engine.end()).status).toBe("interrupted");
    server.failPatch = false;
    const restarted = await PreparedUploadEngine.recover(context(new RecoveryStore(root, secrets)), ACCOUNT, ORIGIN, JOB);
    expect((await restarted.end()).status).toBe("published");
    expect(server.initCount).toBe(1);
    expect(server.body).toEqual(Buffer.concat(frames.map((f) => Buffer.from(f))));
  });

  it("recovers a lost finalized answer without status, PATCH or another init", async () => {
    const { server, engine, feed, context } = await setup();
    await feed(); server.dropFinalize = true;
    expect((await engine.end()).status).toBe("ambiguous");
    const prior = server.methods.length;
    server.dropFinalize = false;
    const restarted = await PreparedUploadEngine.recover(context(), ACCOUNT, ORIGIN, JOB);
    expect((await restarted.end()).status).toBe("published");
    expect(server.methods.slice(prior)).toEqual(["POST /api/uploads/session-1/finalize"]);
    expect(server.initCount).toBe(1);
  });

  it("refuses changed local ciphertext before any recovery network operation", async () => {
    const { server, engine, feed, context, root } = await setup();
    await feed(); server.failPatch = true; await engine.end();
    const path = join(root, "stored-recovery", accountKeyOf(ACCOUNT), accountKeyOf(ORIGIN), JOB, "cipher.bin");
    const original = await readFile(path); original[0] = (original[0] ?? 0) ^ 1; await writeFile(path, original);
    const prior = server.methods.length;
    await expect(PreparedUploadEngine.recover(context(), ACCOUNT, ORIGIN, JOB)).rejects.toMatchObject({ code: "corrupt" });
    expect(server.methods).toHaveLength(prior);
  });
});
