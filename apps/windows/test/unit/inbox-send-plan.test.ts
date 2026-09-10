// Owning tests for the durable send plan.
//
// SCOPE: fakes plus real WebCrypto. These prove the format's strictness and the
// ordering that makes a retry converge. They prove nothing about the network.
import { describe, expect, it } from "vitest";

import { captureAccount } from "../../src/main/inbox/account.js";
import { importAtRestKey, newAtRestKeyBytes, seal as sealAtRest } from "../../src/main/inbox/atrest.js";
import {
  MAX_SEND_PLANS,
  SendPlanError,
  SendPlanStore,
  safeToDrop,
  type PlanFiles,
} from "../../src/main/inbox/send-plan.js";

/** libsodium `crypto_box_seal` of a 32-byte key: 32 epk + 16 mac + 32. */
const SEALED_BOX_BYTES = 80;
const SEALED = "A".repeat(Math.ceil((4 * SEALED_BOX_BYTES) / 3));

const CONTEXT = captureAccount({
  accountID: "person@example.invalid",
  deviceID: "dev-1",
  epoch: 1,
  inboxRoot: "/profile/inbox",
});

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

class FakeFiles implements PlanFiles {
  readonly files = new Map<string, Uint8Array>();
  readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    return value === undefined ? Promise.reject(fsError("ENOENT")) : Promise.resolve(value);
  }
  writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
    return Promise.resolve();
  }
  mkdirp(): Promise<void> {
    return Promise.resolve();
  }
}

function storeOn(files: FakeFiles, key: Uint8Array): SendPlanStore {
  return new SendPlanStore(CONTEXT, files, () => Promise.resolve(key), SEALED_BOX_BYTES);
}

const PATH = `${CONTEXT.directory}/send-plans.enc`;

/** Write a raw plan document, bypassing the store, for format negatives. */
async function writeRaw(files: FakeFiles, key: Uint8Array, document: unknown): Promise<void> {
  const sealed = await sealAtRest(
    await importAtRestKey(key),
    CONTEXT.accountKey,
    "send-plan",
    new TextEncoder().encode(JSON.stringify(document)),
  );
  await files.writeAtomic(PATH, sealed);
}

const BASE = {
  jobID: "job-1",
  targetDeviceID: "dev-2",
  kind: "file" as const,
  idempotencyKey: "idem-1",
  targetKeyID: "key-1",
  targetKeyGeneration: 3,
  now: 1_000,
};

describe("send plan store", () => {
  it("stages, advances and reloads", async () => {
    const files = new FakeFiles();
    const key = newAtRestKeyBytes();
    const store = storeOn(files, key);
    await store.stage(BASE);
    await store.advance("job-1", "uploading", { manifestDigest: "d1", uploadID: "up-1" }, 2);
    await store.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 2);
    await store.advance("job-1", "creating", { wrappedKey: SEALED, protocolVersion: 3, wrapAlgorithm: "x25519-sealedbox-v1" }, 3);
    const reread = storeOn(files, key);
    const plan = await reread.find("job-1");
    expect(plan).toMatchObject({ phase: "creating", storedObjectID: "obj-1", wrappedKey: SEALED });
  });

  it("refuses a replayed job id that names a DIFFERENT delivery", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    await store.stage(BASE);
    // Same intent replays cleanly.
    expect((await store.stage(BASE)).jobID).toBe("job-1");
    // A different target, kind or key is not a replay.
    for (const change of [
      { targetDeviceID: "dev-9" },
      { kind: "text" as const },
      { idempotencyKey: "idem-other" },
    ]) {
      await expect(store.stage({ ...BASE, ...change })).rejects.toBeInstanceOf(SendPlanError);
    }
  });

  it("refuses two plans under one idempotency key", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    await store.stage(BASE);
    await expect(store.stage({ ...BASE, jobID: "job-2" })).rejects.toMatchObject({
      code: "illegal-transition",
    });
  });

  it("refuses a backwards or illegal phase move", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    await store.stage(BASE);
    await store.advance("job-1", "uploading", { manifestDigest: "d1", uploadID: "up-1" }, 2);
    await store.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 2);
    await store.advance("job-1", "creating", { wrappedKey: SEALED, protocolVersion: 3, wrapAlgorithm: "x25519-sealedbox-v1" }, 3);
    // Re-entering an earlier phase is how a second task gets created.
    await expect(store.advance("job-1", "uploaded", {}, 4)).rejects.toMatchObject({
      code: "illegal-transition",
    });
  });

  it("never replaces a recorded task id", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    await store.stage(BASE);
    await store.advance("job-1", "uploading", { manifestDigest: "d1", uploadID: "up-1" }, 2);
    await store.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 2);
    await store.advance("job-1", "creating", { wrappedKey: SEALED, protocolVersion: 3, wrapAlgorithm: "x25519-sealedbox-v1" }, 3);
    await store.advance("job-1", "created", { taskID: "task-1" }, 4);
    await expect(
      store.advance("job-1", "created", { taskID: "task-other" }, 5),
    ).rejects.toMatchObject({ code: "illegal-transition" });
  });

  it("forgets only a settled plan", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    await store.stage(BASE);
    await expect(store.forget("job-1")).rejects.toMatchObject({ code: "illegal-transition" });
    await store.advance("job-1", "settled", {}, 2);
    expect(await store.forget("job-1")).toBe(true);
  });

  it("refuses at the retention bound rather than evicting a plan", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    for (let i = 0; i < MAX_SEND_PLANS; i += 1) {
      await store.stage({ ...BASE, jobID: `job-${String(i)}`, idempotencyKey: `idem-${String(i)}` });
    }
    await expect(
      store.stage({ ...BASE, jobID: "one-too-many", idempotencyKey: "idem-extra" }),
    ).rejects.toMatchObject({ code: "illegal-transition" });
    // The oldest is still there: nothing was dropped to make room.
    expect(await store.find("job-0")).not.toBeNull();
  });

  it("returns records that cannot be mutated behind the store's back", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    const staged = await store.stage(BASE);
    expect(Object.isFrozen(staged)).toBe(true);
    expect(() => {
      (staged as unknown as { taskID: string }).taskID = "forged";
    }).toThrow();
    expect((await store.find("job-1"))?.taskID).toBe("");
  });
});

describe("send plan format", () => {
  it("refuses null, a wrong version and a non-array", async () => {
    const key = newAtRestKeyBytes();
    // A document from ANOTHER version is refused in place and left on disk: it
    // may record a delivery that is still live, and this build is not the one to
    // reinterpret it.
    for (const document of [null, 42, "text", { v: 2, plans: [] }, { v: 4, plans: [] }, { v: 3, plans: {} }]) {
      const files = new FakeFiles();
      await writeRaw(files, key, document);
      // `null` parses as JSON; dereferencing it used to be a TypeError rather
      // than this store's own typed refusal.
      await expect(storeOn(files, key).all()).rejects.toMatchObject({ code: "unreadable" });
    }
  });

  it("validates every record rather than casting it", async () => {
    const key = newAtRestKeyBytes();
    const valid = {
      jobID: "j", targetDeviceID: "d", kind: "file", phase: "staged", idempotencyKey: "i",
      wrappedKey: "", protocolVersion: 0, wrapAlgorithm: "",
      targetKeyID: "k", targetKeyGeneration: 1, resealed: false,
      storedObjectID: "", taskID: "", updatedAt: 1,
    };
    const bad: Record<string, unknown>[] = [
      { ...valid, phase: "whatever" },
      { ...valid, kind: "folder" },
      { ...valid, jobID: "" },
      { ...valid, targetKeyGeneration: -1 },
      { ...valid, targetKeyGeneration: 1.5 },
      { ...valid, resealed: "no" },
      { ...valid, updatedAt: "soon" },
      // A sealed box that is not one.
      { ...valid, wrappedKey: "not-base64url!!" },
      { ...valid, wrappedKey: "AAAA" },
      { ...valid, protocolVersion: -1 },
      { ...valid, protocolVersion: 1.5 },
      { ...valid, wrapAlgorithm: 7 },
      // Phase-dependent identity a retry could not converge from.
      { ...valid, phase: "uploaded", storedObjectID: "" },
      { ...valid, phase: "creating", storedObjectID: "o", wrappedKey: "" },
      { ...valid, phase: "created", taskID: "" },
    ];
    for (const record of bad) {
      const files = new FakeFiles();
      await writeRaw(files, key, { v: 3, plans: [record] });
      await expect(storeOn(files, key).all()).rejects.toMatchObject({ code: "unreadable" });
    }
  });

  it("refuses duplicate job ids and duplicate idempotency keys on disk", async () => {
    const key = newAtRestKeyBytes();
    const one = {
      jobID: "j", targetDeviceID: "d", kind: "file", phase: "staged", idempotencyKey: "i",
      wrappedKey: "", protocolVersion: 0, wrapAlgorithm: "",
      targetKeyID: "k", targetKeyGeneration: 1, resealed: false,
      storedObjectID: "", taskID: "", updatedAt: 1,
    };
    for (const pair of [
      [one, { ...one, idempotencyKey: "i2" }],
      [one, { ...one, jobID: "j2" }],
    ]) {
      const files = new FakeFiles();
      await writeRaw(files, key, { v: 3, plans: pair });
      await expect(storeOn(files, key).all()).rejects.toMatchObject({ code: "unreadable" });
    }
  });

  it("refuses a journal document sealed under the JOURNAL purpose", async () => {
    const key = newAtRestKeyBytes();
    const files = new FakeFiles();
    // Same account, same key, same file name — and a plausible journal body.
    // It fails AUTHENTICATION, one layer below the shape check, because the
    // associated data binds the purpose.
    const sealed = await sealAtRest(
      await importAtRestKey(key),
      CONTEXT.accountKey,
      "journal",
      new TextEncoder().encode(JSON.stringify({ v: 3, tasks: [], watermark: 0 })),
    );
    await files.writeAtomic(PATH, sealed);
    await expect(storeOn(files, key).all()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses a plan file written under the OLD journal purpose, and preserves it", async () => {
    const key = newAtRestKeyBytes();
    const files = new FakeFiles();
    // What an earlier development build wrote. Those files never shipped, so
    // they are refused rather than migrated — and left exactly as they are.
    const legacy = await sealAtRest(
      await importAtRestKey(key),
      CONTEXT.accountKey,
      "journal",
      new TextEncoder().encode(JSON.stringify({ v: 3, plans: [] })),
    );
    await files.writeAtomic(PATH, legacy);
    const store = storeOn(files, key);
    await expect(store.all()).rejects.toMatchObject({ code: "unreadable" });
    await expect(store.stage(BASE)).rejects.toMatchObject({ code: "unreadable" });
    expect(Buffer.from(files.files.get(PATH)!)).toEqual(Buffer.from(legacy));
  });

  it("a send plan cannot be opened as any other purpose", async () => {
    const key = newAtRestKeyBytes();
    const files = new FakeFiles();
    const store = storeOn(files, key);
    await store.stage(BASE);
    const written = files.files.get(PATH)!;
    const atRest = await importAtRestKey(key);
    const { open: openAtRest } = await import("../../src/main/inbox/atrest.js");
    for (const kind of ["journal", "vault-index", "vault-record"] as const) {
      await expect(openAtRest(atRest, CONTEXT.accountKey, kind, written)).rejects.toBeTruthy();
    }
    // And it opens under its own.
    await expect(openAtRest(atRest, CONTEXT.accountKey, "send-plan", written)).resolves.toBeTruthy();
  });

  it("does NOT treat an unreadable store as empty", async () => {
    const key = newAtRestKeyBytes();
    const files = new FakeFiles();
    await files.writeAtomic(PATH, new TextEncoder().encode("not an envelope"));
    const store = storeOn(files, key);
    await expect(store.all()).rejects.toMatchObject({ code: "unreadable" });
    // And a stage must not overwrite it: those idempotency keys are what a live
    // delivery converges on.
    await expect(store.stage(BASE)).rejects.toMatchObject({ code: "unreadable" });
  });
});

describe("upload phases", () => {
  it("only a staged or settled plan may be dropped", () => {
    // Every other phase describes something that may exist on the server.
    expect(safeToDrop("staged")).toBe(true);
    expect(safeToDrop("settled")).toBe(true);
    for (const phase of ["uploading", "upload-unknown", "uploaded", "creating", "created"] as const) {
      expect(safeToDrop(phase)).toBe(false);
    }
  });

  it("an in-flight upload cannot go back to staged", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    await store.stage(BASE);
    await store.advance("job-1", "uploading", { manifestDigest: "d1", uploadID: "up-1" }, 2);
    // Returning to `staged` would re-assert that nothing exists, which is
    // exactly what an initiated upload disproves.
    await expect(store.advance("job-1", "staged", {}, 3)).rejects.toMatchObject({
      code: "illegal-transition",
    });
  });

  it("an unobserved finalize cannot be settled on a guess", async () => {
    const store = storeOn(new FakeFiles(), newAtRestKeyBytes());
    await store.stage(BASE);
    await store.advance("job-1", "uploading", { manifestDigest: "d1", uploadID: "up-1" }, 2);
    await store.advance("job-1", "upload-unknown", {}, 3);
    // It resolves only by asking the server, never by assuming either way.
    await expect(store.advance("job-1", "settled", {}, 4)).rejects.toMatchObject({
      code: "illegal-transition",
    });
    await expect(store.advance("job-1", "staged", {}, 4)).rejects.toMatchObject({
      code: "illegal-transition",
    });
    await store.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 5);
    expect((await store.find("job-1"))?.phase).toBe("uploaded");
  });

  it("requires the upload identity a recovery reconciles from", async () => {
    const key = newAtRestKeyBytes();
    const base = {
      jobID: "j", targetDeviceID: "d", kind: "file", idempotencyKey: "i",
      wrappedKey: "", protocolVersion: 0, wrapAlgorithm: "",
      targetKeyID: "k", targetKeyGeneration: 1, resealed: false,
      storedObjectID: "", uploadID: "", manifestDigest: "", taskID: "", updatedAt: 1,
    };
    for (const phase of ["uploading", "upload-unknown"]) {
      const files = new FakeFiles();
      await writeRaw(files, key, { v: 3, plans: [{ ...base, phase }] });
      await expect(storeOn(files, key).all()).rejects.toMatchObject({ code: "unreadable" });
    }
    // The manifest digest is what is required. The UPLOAD ID is not: `uploading`
    // is entered before init, so a lost init response leaves a plan with no id —
    // which is exactly the case this phase exists for.
    const noID = new FakeFiles();
    await writeRaw(noID, key, {
      v: 3,
      plans: [{ ...base, phase: "uploading", uploadID: "", manifestDigest: "d1" }],
    });
    expect((await storeOn(noID, key).all()).length).toBe(1);
    const withID = new FakeFiles();
    await writeRaw(withID, key, {
      v: 3,
      plans: [{ ...base, phase: "uploading", uploadID: "up-1", manifestDigest: "d1" }],
    });
    expect((await storeOn(withID, key).all()).length).toBe(1);
  });
});

describe("the complete create request on disk", () => {
  it("records the version and algorithm that request carried", async () => {
    const files = new FakeFiles();
    const store = storeOn(files, newAtRestKeyBytes());
    await store.stage({
      jobID: "job-1", targetDeviceID: "d", kind: "file", idempotencyKey: "i",
      targetKeyID: "k", targetKeyGeneration: 1, now: 1,
    });
    await store.advance("job-1", "uploading", { manifestDigest: "d1" }, 2);
    await store.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 3);
    await store.advance(
      "job-1",
      "creating",
      { wrappedKey: SEALED, protocolVersion: 3, wrapAlgorithm: "x25519-sealedbox-v1" },
      4,
    );

    // Persisting the sealed box alone is not "the exact request": a later build
    // whose negotiated version or algorithm had moved would rebuild a DIFFERENT
    // request under the same idempotency key — and the handler validates both
    // BEFORE it reaches the idempotent replay, so that retry would be refused
    // without central ever being asked whether the first attempt succeeded.
    expect(await store.find("job-1")).toMatchObject({
      wrappedKey: SEALED,
      protocolVersion: 3,
      wrapAlgorithm: "x25519-sealedbox-v1",
    });
  });
});
