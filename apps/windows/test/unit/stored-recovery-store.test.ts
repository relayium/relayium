import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, truncate, link, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore, type SecretCipher } from "../../src/main/secrets.js";
import { accountKeyOf } from "../../src/main/inbox/account.js";
import { RecoveryStore } from "../../src/main/stored/upload/recovery-store.js";

const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true }); });
// The store's metadata uses REAL authenticated encryption. DPAPI itself is
// exercised by the existing Windows helper suite, not this portable test.
const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(`test-only:${text}`),
  decrypt: (bytes) => {
    const text = bytes.toString();
    if (!text.startsWith("test-only:")) throw new Error("not a test envelope");
    return text.slice("test-only:".length);
  },
};
const ACCOUNT = "private-account";
const ORIGIN = "https://relayium.com";
const JOB = `u-${"a".repeat(32)}`;
const BODY = new Uint8Array([1, 2, 3, 4, 5, 6]);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relayium-recovery-store-")); owned.push(root);
  const secrets = new SecretStore(join(root, "secrets"), cipher);
  const store = new RecoveryStore(root, secrets);
  const input = { jobId: JOB, accountId: ACCOUNT, origin: ORIGIN, createdAt: 100,
    descriptors: [{ path: "private-name.txt", size: 0 }], sealedManifest: Buffer.from("sealed-manifest").toString("base64"),
    cipherBytes: BODY.length, retention: { burnAfterRead: false, ttlSeconds: 3600 } };
  const path = join(root, "stored-recovery", accountKeyOf(ACCOUNT), accountKeyOf(ORIGIN), JOB);
  return { root, secrets, store, input, path };
}

describe("complete ciphertext recovery store", () => {
  it("reopens exactly the complete ciphertext and authenticated plan across instances", async () => {
    const { store, root, secrets, input } = await fixture();
    expect(await store.list(ACCOUNT, ORIGIN)).toEqual([]);
    const writer = await store.create(input);
    await writer.append(BODY.subarray(0, 2)); await writer.append(BODY.subarray(2));
    const plan = await writer.finish();
    const reopened = new RecoveryStore(root, secrets);
    expect(await reopened.read(ACCOUNT, ORIGIN, JOB)).toEqual(plan);
    await reopened.verify(plan);
    expect(await reopened.range(plan, 1, 4)).toEqual(BODY.subarray(1, 5));
    expect(await reopened.list(ACCOUNT, ORIGIN)).toEqual([plan]);
    expect(await reopened.list("other-account", ORIGIN)).toEqual([]);
    expect(await reopened.list(ACCOUNT, "https://example.org")).toEqual([]);
  });

  it("keeps interrupted preparation incomplete and never marks it resumable", async () => {
    const { store, input } = await fixture();
    const writer = await store.create(input);
    await writer.append(BODY.subarray(0, 2));
    await expect(writer.finish()).rejects.toMatchObject({ code: "incomplete" });
    await writer.close();
    const plan = await store.read(ACCOUNT, ORIGIN, JOB);
    expect(plan.phase).toBe("preparing");
    await expect(store.verify(plan)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("refuses producer overrun and concurrent writes without corrupting the accepted bytes", async () => {
    const { store, input } = await fixture();
    const writer = await store.create(input);
    await expect(writer.append(new Uint8Array(7))).rejects.toMatchObject({ code: "corrupt" });
    const first = writer.append(BODY);
    await expect(writer.append(BODY)).rejects.toMatchObject({ code: "conflict" });
    await expect(writer.finish()).rejects.toMatchObject({ code: "conflict" });
    await first;
    const plan = await writer.finish();
    await store.verify(plan);
  });

  it("joins a write before closing the spool and refuses later writes", async () => {
    const { store, input } = await fixture();
    const writer = await store.create(input);
    const write = writer.append(BODY);
    const closing = writer.close();
    await Promise.all([write, closing]);
    await expect(writer.append(BODY)).rejects.toMatchObject({ code: "conflict" });
    expect((await store.read(ACCOUNT, ORIGIN, JOB)).phase).toBe("preparing");
  });

  it("a repeated close joins the original descriptor close instead of returning early", async () => {
    const { store, input } = await fixture(); const writer = await store.create(input);
    const order: string[] = [];
    const first = writer.close().then(() => { order.push("first"); });
    const joined = writer.close().then(() => { order.push("joined"); });
    await Promise.all([first, joined]);
    expect(order).toEqual(["first", "joined"]);
  });
  it("stops full-body verification after cancellation and closes its handle without deleting recovery bytes", async () => {
    const { store, input, path } = await fixture();
    const body = new Uint8Array(3 * 1024 * 1024).fill(37);
    const writer = await store.create({ ...input, cipherBytes: body.length });
    await writer.append(body); const plan = await writer.finish();
    const probe = await open(join(path, "cipher.bin"), "r");
    const prototype = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
    await probe.close();
    const original = prototype.read; const control = new AbortController();
    const reason = new Error("controlled verification cancellation"); let reads = 0;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (this: unknown, ...args) {
      const answer = await original.apply(this, args); reads++; control.abort(reason); return answer;
    });
    try { await expect(store.verify(plan, control.signal)).rejects.toBe(reason); expect(reads).toBe(1); }
    finally { spy.mockRestore(); }
    await store.verify(plan);
    expect((await readFile(join(path, "cipher.bin"))).equals(body)).toBe(true);
  });

  it("never replaces a lost protected key beside existing recovery data", async () => {
    const { store, input, secrets, root } = await fixture();
    const writer = await store.create(input); await writer.append(BODY); await writer.finish();
    await secrets.delete("stored-upload-recovery-key");
    const restarted = new RecoveryStore(root, secrets);
    await expect(restarted.read(ACCOUNT, ORIGIN, JOB)).rejects.toMatchObject({ code: "unavailable" });
    await expect(restarted.create({ ...input, jobId: `u-${"b".repeat(32)}` })).rejects.toMatchObject({ code: "unavailable" });
    await expect(secrets.get("stored-upload-recovery-key")).rejects.toMatchObject({ code: "not-found" });
  });

  it.each(["truncate", "same-size-corruption"])("refuses %s before the body can be used for an upload", async (kind) => {
    const { store, input, path } = await fixture();
    const writer = await store.create(input); await writer.append(BODY); const plan = await writer.finish();
    if (kind === "truncate") await truncate(join(path, "cipher.bin"), 5);
    else await writeFile(join(path, "cipher.bin"), new Uint8Array(6).fill(9));
    await expect(store.verify(plan)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("protects names, origin/account binding and metadata integrity", async () => {
    const { store, input, path } = await fixture();
    const writer = await store.create(input); await writer.append(BODY); await writer.finish();
    const raw = await readFile(join(path, "plan.enc"));
    expect(raw.includes(Buffer.from("private-name.txt"))).toBe(false);
    expect(raw.includes(Buffer.from(ACCOUNT))).toBe(false);
    const changed = JSON.parse(raw.toString());
    changed.ct = Buffer.from("substituted plan").toString("base64");
    await writeFile(join(path, "plan.enc"), JSON.stringify(changed));
    await expect(store.read(ACCOUNT, ORIGIN, JOB)).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.list(ACCOUNT, ORIGIN)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("refuses a second producer and stale state transitions", async () => {
    const { store, input } = await fixture();
    const writer = await store.create(input); await writer.append(BODY); const ready = await writer.finish();
    await expect(store.create(input)).rejects.toBeTruthy();
    await expect(store.update(ready, { phase: "published", objectId: "invented" })).rejects.toMatchObject({ code: "conflict" });
    const upload = await store.update(ready, { phase: "uploading", uploadId: "session-1", chunkSize: 65536 });
    await expect(store.update(ready, { phase: "uploading", uploadId: "session-2", chunkSize: 65536 })).rejects.toMatchObject({ code: "conflict" });
    const finalizing = await store.update(upload, { phase: "finalizing" });
    const done = await store.update(finalizing, { phase: "published", objectId: "object-1", expiresAt: 4000 });
    expect(done.revision).toBe(5);
    await expect(store.update(done, { phase: "uploading" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses hard-linked ciphertext and out-of-range reads", async () => {
    const { store, input, path, root } = await fixture();
    const writer = await store.create(input); await writer.append(BODY); const plan = await writer.finish();
    await expect(store.range(plan, 5, 2)).rejects.toMatchObject({ code: "corrupt" });
    await link(join(path, "cipher.bin"), join(root, "outside-alias"));
    await expect(store.verify(plan)).rejects.toMatchObject({ code: "corrupt" });
  });
});
