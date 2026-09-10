// Owning tests for the account-scoped Inbox stores.
//
// SCOPE: these drive fakes and real WebCrypto. They prove the account, key,
// journal and at-rest rules. They prove nothing about the server (owed
// separately as real-server fixture interop) and nothing about Windows
// filesystem behaviour.
import { describe, expect, it, vi } from "vitest";

import {
  AccountChangedError,
  AccountJobs,
  accountKeyOf,
  captureAccount,
  sameAccount,
} from "../../src/main/inbox/account.js";
import {
  AT_REST_KEY_BYTES,
  AtRestError,
  newAtRestKeyBytes,
  open as openAtRest,
  seal as sealAtRest,
} from "../../src/main/inbox/atrest.js";
import { importAtRestKey } from "../../src/main/inbox/atrest.js";
import {
  InboxKeyError,
  InboxKeyStore,
  MAX_KEY_HISTORY,
  keySlotFor,
  type SecretSlot,
} from "../../src/main/inbox/keys.js";
import {
  JournalError,
  MAX_JOURNAL_TASKS,
  RETENTION,
  evictable,
  TaskJournal,
  type JournalFiles,
  type TaskPhase,
} from "../../src/main/inbox/journal.js";
import { inboxRuntime, resetInboxRuntimeForTest } from "../../src/main/inbox/runtime.js";
import type { InboxRuntime } from "../../src/main/inbox/runtime-contract.js";

async function realRuntime(): Promise<InboxRuntime> {
  resetInboxRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const artifact = pathToFileURL(resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  return inboxRuntime(() => import(artifact) as Promise<{ default?: unknown }>);
}

/**
 * A rejection shaped like the real store's.
 *
 * This detail is why the original defect survived: the fake rejected with a
 * plain `Error`, so a catch-all in the store under test looked correct. The real
 * `SecretStore` throws `SecretStoreError` with a `code` that separates
 * `not-found` from `unreadable` and `undecryptable` — and its own header warns
 * that collapsing them is how an identity gets silently replaced. A fake that
 * does not carry the code cannot catch a caller that ignores it.
 */
function secretError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A rejection shaped like Node's fs errors. */
function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** An in-memory SecretStore slice. */
class FakeSecrets implements SecretSlot {
  readonly values = new Map<string, string>();
  get(key: string): Promise<string> {
    const value = this.values.get(key);
    if (value === undefined) return Promise.reject(secretError("not-found"));
    return Promise.resolve(value);
  }
  put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

/** An in-memory atomic filesystem. */
class FakeFiles implements JournalFiles {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  /** Counts writes so atomicity can be asserted by observation. */
  writes = 0;
  readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) return Promise.reject(fsError("ENOENT"));
    return Promise.resolve(value);
  }
  writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.files.set(path, bytes.slice());
    return Promise.resolve();
  }
  mkdirp(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }
}

const CONTEXT_A = captureAccount({
  accountID: "person-a@example.test",
  deviceID: "dev-a",
  epoch: 1,
  inboxRoot: "/data/inbox",
});
const CONTEXT_B = captureAccount({
  accountID: "person-b@example.test",
  deviceID: "dev-b",
  epoch: 1,
  inboxRoot: "/data/inbox",
});

describe("account context", () => {
  it("never puts an account identifier on disk", () => {
    // An account id is usually an email. It must not become a directory name.
    expect(CONTEXT_A.directory).not.toContain("person-a");
    expect(CONTEXT_A.directory).not.toContain("@");
    expect(CONTEXT_A.accountKey).toMatch(/^[0-9a-f]{32}$/);
    expect(CONTEXT_A.accountKey).toBe(accountKeyOf("person-a@example.test"));
  });

  it("separates accounts and is stable across captures", () => {
    expect(CONTEXT_A.directory).not.toBe(CONTEXT_B.directory);
    const again = captureAccount({
      accountID: "person-a@example.test",
      deviceID: "dev-a",
      epoch: 1,
      inboxRoot: "/data/inbox",
    });
    expect(sameAccount(CONTEXT_A, again)).toBe(true);
    expect(sameAccount(CONTEXT_A, CONTEXT_B)).toBe(false);
  });

  it("is frozen, so one holder cannot rewrite another's view", () => {
    expect(Object.isFrozen(CONTEXT_A)).toBe(true);
    expect(() => {
      (CONTEXT_A as { deviceID: string }).deviceID = "someone-else";
    }).toThrow();
  });

  it("treats an epoch change as a different context", () => {
    const rotated = captureAccount({
      accountID: "person-a@example.test",
      deviceID: "dev-a",
      epoch: 2,
      inboxRoot: "/data/inbox",
    });
    expect(sameAccount(CONTEXT_A, rotated)).toBe(false);
  });
});

describe("account jobs", () => {
  it("aborts AND JOINS outstanding work before adoption", async () => {
    const jobs = new AccountJobs(CONTEXT_A);
    let finished = false;
    const job = jobs.run(async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // Work that runs AFTER the abort: close() must not return until this has.
      await Promise.resolve();
      finished = true;
    });

    const closing = jobs.close();
    await closing;
    // Joined, not merely signalled. Returning before this ran would let the old
    // account's work overlap the new one's writes.
    expect(finished).toBe(true);
    expect(jobs.outstanding).toBe(0);
    await job;
  });

  it("refuses new work once the context is gone", async () => {
    const jobs = new AccountJobs(CONTEXT_A);
    await jobs.close();
    await expect(jobs.run(async () => undefined)).rejects.toBeInstanceOf(AccountChangedError);
  });

  it("joins a job that rejected", async () => {
    const jobs = new AccountJobs(CONTEXT_A);
    const failing = jobs.run(() => Promise.reject(new Error("boom")));
    await expect(failing).rejects.toThrow("boom");
    await jobs.close();
    expect(jobs.outstanding).toBe(0);
  });
});

describe("at-rest records", () => {
  it("round-trips", async () => {
    const key = await importAtRestKey(newAtRestKeyBytes());
    const sealed = await sealAtRest(key, CONTEXT_A.accountKey, "vault-record", new TextEncoder().encode("hello"));
    const opened = await openAtRest(key, CONTEXT_A.accountKey, "vault-record", sealed);
    expect(new TextDecoder().decode(opened)).toBe("hello");
  });

  it("writes ciphertext only — no plaintext survives in the record", async () => {
    const key = await importAtRestKey(newAtRestKeyBytes());
    const secret = "SECRET-MESSAGE-4f21";
    const sealed = await sealAtRest(key, CONTEXT_A.accountKey, "vault-record", new TextEncoder().encode(secret));
    expect(new TextDecoder().decode(sealed)).not.toContain(secret);
    expect(Buffer.from(sealed).includes(Buffer.from(secret))).toBe(false);
  });

  it("refuses a record replayed into another account", async () => {
    // The associated data binds the account, so a ciphertext moved between
    // account directories fails authentication instead of decrypting.
    const key = await importAtRestKey(newAtRestKeyBytes());
    const sealed = await sealAtRest(key, CONTEXT_A.accountKey, "vault-record", new TextEncoder().encode("a"));
    await expect(
      openAtRest(key, CONTEXT_B.accountKey, "vault-record", sealed),
    ).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses a record reinterpreted as a different kind", async () => {
    const key = await importAtRestKey(newAtRestKeyBytes());
    const sealed = await sealAtRest(key, CONTEXT_A.accountKey, "journal", new TextEncoder().encode("a"));
    await expect(
      openAtRest(key, CONTEXT_A.accountKey, "vault-record", sealed),
    ).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses a corrupt record rather than reporting it absent", async () => {
    const key = await importAtRestKey(newAtRestKeyBytes());
    const sealed = await sealAtRest(key, CONTEXT_A.accountKey, "vault-record", new TextEncoder().encode("a"));
    const envelope = JSON.parse(new TextDecoder().decode(sealed)) as { ct: string };
    const tampered = new TextEncoder().encode(
      JSON.stringify({ ...envelope, ct: Buffer.from("garbage").toString("base64") }),
    );
    // "unreadable", never "no record" — the difference between reporting a
    // problem and silently discarding the user's history.
    await expect(
      openAtRest(key, CONTEXT_A.accountKey, "vault-record", tampered),
    ).rejects.toBeInstanceOf(AtRestError);
  });

  it("refuses a future format version instead of guessing", async () => {
    const key = await importAtRestKey(newAtRestKeyBytes());
    const sealed = await sealAtRest(key, CONTEXT_A.accountKey, "journal", new TextEncoder().encode("a"));
    const envelope = JSON.parse(new TextDecoder().decode(sealed)) as Record<string, unknown>;
    const future = new TextEncoder().encode(JSON.stringify({ ...envelope, v: 99 }));
    await expect(
      openAtRest(key, CONTEXT_A.accountKey, "journal", future),
    ).rejects.toMatchObject({ code: "unsupported-version" });
  });

  it("refuses a wrong-length key", async () => {
    await expect(importAtRestKey(new Uint8Array(AT_REST_KEY_BYTES - 1))).rejects.toMatchObject({
      code: "key-unavailable",
    });
  });
});

describe("inbox key store", () => {
  it("keeps private halves out of every listing accessor", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    const keys = new InboxKeyStore(CONTEXT_A, secrets, runtime);
    const record = await keys.append(1000);

    expect(Object.keys(record)).not.toContain("privateKey");
    const history = await keys.history();
    for (const entry of history) expect(Object.keys(entry)).not.toContain("privateKey");
    const current = await keys.current();
    expect(current === null ? [] : Object.keys(current)).not.toContain("privateKey");
  });

  it("stores key material only in the secret store, account-scoped", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    await new InboxKeyStore(CONTEXT_A, secrets, runtime).append(1000);
    // One slot, named by the account DIGEST, and nothing else written anywhere.
    expect([...secrets.values.keys()]).toEqual([keySlotFor(CONTEXT_A.accountKey)]);
    expect([...secrets.values.keys()][0]).not.toContain("person-a");
  });

  it("cannot see another account's keys", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    await new InboxKeyStore(CONTEXT_A, secrets, runtime).append(1000);
    expect(await new InboxKeyStore(CONTEXT_B, secrets, runtime).current()).toBeNull();
  });

  it("treats a never-enrolled device as empty, not broken", async () => {
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    expect(await keys.current()).toBeNull();
    expect(await keys.history()).toEqual([]);
  });

  it("reports an unreadable history rather than starting fresh", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    await secrets.put(keySlotFor(CONTEXT_A.accountKey), "not json");
    const keys = new InboxKeyStore(CONTEXT_A, secrets, runtime);
    // Starting fresh here would silently orphan every pending delivery.
    await expect(keys.history()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("opens a task's sealed key using the key the TASK names, not the newest", async () => {
    // The retention rule's whole purpose: a task queued before a rotation was
    // sealed to the older key.
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    const keys = new InboxKeyStore(CONTEXT_A, secrets, runtime);

    const older = await keys.append(1000);
    await keys.bindKeyID(older.publicKey, "key-old");
    const newer = await keys.append(2000);
    await keys.bindKeyID(newer.publicKey, "key-new");

    const contentKey = new Uint8Array(runtime.constants.contentKeyBytes).fill(5);
    const sealedToOlder = await runtime.sealContentKey(
      contentKey,
      runtime.constants.keyAlgorithm,
      older.publicKey,
    );
    expect(await keys.openSealedContentKey("key-old", runtime.decodeKey(sealedToOlder))).toEqual(contentKey);
    // And the newest key must NOT open it.
    await expect(
      keys.openSealedContentKey("key-new", runtime.decodeKey(sealedToOlder)),
    ).rejects.toThrow();
  });

  it("refuses at the retention bound instead of evicting a key a task may need", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    const keys = new InboxKeyStore(CONTEXT_A, secrets, runtime);
    for (let i = 0; i < MAX_KEY_HISTORY; i += 1) await keys.append(1000 + i);

    // Evicting the oldest would make every task still queued against it
    // permanently undecryptable, with no way for anyone to notice.
    await expect(keys.append(9999)).rejects.toMatchObject({ code: "retention-full" });
    expect((await keys.history()).length).toBe(MAX_KEY_HISTORY);
  });

  it("refuses a task naming a key it does not hold", async () => {
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    const record = await keys.append(1000);
    await keys.bindKeyID(record.publicKey, "key-1");
    await expect(
      keys.openSealedContentKey("key-unknown", new Uint8Array(80)),
    ).rejects.toBeInstanceOf(InboxKeyError);
  });

  it("refuses to bind an id to a key it never appended", async () => {
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    await expect(keys.bindKeyID("not-a-key", "key-1")).rejects.toMatchObject({ code: "unknown-key" });
  });

  it("appends durably BEFORE the id is known, so a crash cannot orphan it", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    const put = vi.spyOn(secrets, "put");
    const keys = new InboxKeyStore(CONTEXT_A, secrets, runtime);
    const record = await keys.append(1000);
    // Persisted already, with an empty keyID: publishing first and persisting
    // second would advertise a key whose private half was never written down.
    expect(put).toHaveBeenCalledTimes(1);
    expect(record.keyID).toBe("");
    expect((await keys.current())?.keyID).toBe("");
  });
});

describe("inbox key store against the REAL SecretStore", () => {
  it("uses a slot the real store will accept", async () => {
    // The defect this pins: the slot used to be `inbox/<accountKey>/keys`, and
    // `SecretStore.assertKey` validates a key with `validateSegment` — the
    // receive path's FILENAME validator — which refuses a slash as
    // `separator-in-segment`. Enrolment therefore failed on the first `put`
    // with `invalid-key`, so no amount of fake-based testing could have worked.
    const runtime = await realRuntime();
    const { SecretStore } = await import("../../src/main/secrets.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "inbox-secrets-"));
    try {
      // A synthetic cipher: this asserts the KEY-NAME and round-trip contract,
      // not DPAPI, which only a real Windows session provides.
      const cipher = {
        isAvailable: () => true,
        encrypt: (plaintext: string) => Buffer.from(plaintext, "utf8"),
        decrypt: (ciphertext: Buffer) => ciphertext.toString("utf8"),
      };
      const store = new SecretStore(dir, cipher);
      const keys = new InboxKeyStore(CONTEXT_A, store, runtime);

      const record = await keys.append(1);
      expect((await keys.history()).length).toBe(1);
      expect(record.keyID).toBe("");

      await keys.bindKeyID(record.publicKey, "key-1");
      expect((await keys.current())?.keyID).toBe("key-1");

      // And the private half round-trips through the real store well enough to
      // open a sealed key.
      const contentKey = new Uint8Array(runtime.constants.contentKeyBytes).fill(3);
      const sealed = await runtime.sealContentKey(
        contentKey,
        runtime.constants.keyAlgorithm,
        record.publicKey,
      );
      expect(await keys.openSealedContentKey("key-1", runtime.decodeKey(sealed))).toEqual(contentKey);

      await keys.forget({ reason: "account-removed", pendingDeliveries: 0 });
      expect(await keys.current()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps two accounts in separate slots the real store accepts", async () => {
    const runtime = await realRuntime();
    const { SecretStore } = await import("../../src/main/secrets.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "inbox-secrets-"));
    try {
      const cipher = {
        isAvailable: () => true,
        encrypt: (p: string) => Buffer.from(p, "utf8"),
        decrypt: (c: Buffer) => c.toString("utf8"),
      };
      const store = new SecretStore(dir, cipher);
      await new InboxKeyStore(CONTEXT_A, store, runtime).append(1);
      expect(await new InboxKeyStore(CONTEXT_B, store, runtime).current()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("storage failures are never mistaken for absence", () => {
  it.each(["undecryptable", "unreadable", "invalid-key", "encryption-unavailable"])(
    "refuses a %s key history and writes nothing over it",
    async (code) => {
      // The failure this pins: a catch-all turned every storage error into an
      // empty history, and the caller then generated a NEW key and wrote it
      // over a slot it could not read — orphaning every pending delivery.
      const runtime = await realRuntime();
      let writes = 0;
      const hostile: SecretSlot = {
        get: () => Promise.reject(secretError(code)),
        put: () => {
          writes += 1;
          return Promise.resolve();
        },
        delete: () => Promise.resolve(),
      };
      const keys = new InboxKeyStore(CONTEXT_A, hostile, runtime);
      await expect(keys.append(1)).rejects.toMatchObject({ code: "unreadable" });
      await expect(keys.history()).rejects.toMatchObject({ code: "unreadable" });
      // Nothing written: the surviving history is not overwritten.
      expect(writes).toBe(0);
    },
  );

  it("treats only an explicit not-found as an empty history", async () => {
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    expect(await keys.history()).toEqual([]);
  });

  it("refuses a present-but-empty slot rather than re-enrolling", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    await secrets.put(keySlotFor(CONTEXT_A.accountKey), "");
    await expect(
      new InboxKeyStore(CONTEXT_A, secrets, runtime).history(),
    ).rejects.toMatchObject({ code: "unreadable" });
  });

  it.each(["EACCES", "EIO", "EPERM"])(
    "refuses a %s journal read and does not overwrite it",
    async (code) => {
      // Worse than the key case: the old catch-all reported no history and the
      // next write OVERWROTE the journal that could not be read, destroying the
      // record of what had already been published and ACKed.
      let writes = 0;
      const journal = new TaskJournal(
        CONTEXT_A,
        {
          readFile: () => Promise.reject(fsError(code)),
          writeAtomic: () => {
            writes += 1;
            return Promise.resolve();
          },
          mkdirp: () => Promise.resolve(),
        },
        () => Promise.resolve(newAtRestKeyBytes()),
      );
      await expect(
        journal.recordClaimed({ taskID: "t", idempotencyKey: "i", manifestTotal: 1, text: false, now: 1 }),
      ).rejects.toMatchObject({ code: "unreadable" });
      expect(writes).toBe(0);
    },
  );
});

describe("concurrent key appends", () => {
  it("loses no private key when appends overlap", async () => {
    // `SecretStore` serialises each `put`, which makes a single write atomic and
    // does nothing for a read-then-write pair. Two overlapping appends both read
    // the same history and the second write discarded the first key — a private
    // half generated, possibly published, then lost.
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    const keys = new InboxKeyStore(CONTEXT_A, secrets, runtime);
    const appended = await Promise.all([keys.append(1), keys.append(2), keys.append(3)]);
    const history = await keys.history();
    expect(history).toHaveLength(3);
    // Every generated key survived, and each is distinct.
    for (const record of appended) {
      expect(history.some((k) => k.publicKey === record.publicKey)).toBe(true);
    }
    expect(new Set(history.map((k) => k.publicKey)).size).toBe(3);
    // Generations are consecutive rather than three copies of the same number.
    expect(history.map((k) => k.generation).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("keeps a bind from racing an append", async () => {
    const runtime = await realRuntime();
    const secrets = new FakeSecrets();
    const keys = new InboxKeyStore(CONTEXT_A, secrets, runtime);
    const first = await keys.append(1);
    await Promise.all([keys.bindKeyID(first.publicKey, "key-1"), keys.append(2)]);
    const history = await keys.history();
    expect(history).toHaveLength(2);
    expect(history.find((k) => k.publicKey === first.publicKey)?.keyID).toBe("key-1");
  });
});

describe("task journal", () => {
  const journalOf = (files: FakeFiles, keyBytes: Uint8Array): TaskJournal =>
    new TaskJournal(CONTEXT_A, files, () => Promise.resolve(keyBytes));

  it("records a claim durably and reads it back", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    await journal.recordClaimed({
      taskID: "t1",
      idempotencyKey: "idem-1",
      manifestTotal: 3,
      text: false,
      now: 10,
    });
    expect(await journal.find("t1")).toMatchObject({ phase: "claimed", manifestTotal: 3 });
    expect(files.writes).toBe(1);
  });

  /** Long enough that a chance substring hit in random base64 is impossible. */
  const LEAK_PROBE_ID = "leak-probe-task-9f2c4a7e";

  it("stores no filenames or content — metadata only", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    await journal.recordClaimed({
      taskID: LEAK_PROBE_ID,
      idempotencyKey: "idem-1",
      manifestTotal: 1,
      text: false,
      now: 10,
    });
    // Ciphertext, and in any case there is nothing to leak: the record shape
    // carries counts and a phase, never a name or a path.
    const raw = new TextDecoder().decode(files.files.get(`${CONTEXT_A.directory}/journal.enc`) ?? new Uint8Array());
    // The probe is LONG on purpose. This assertion used to search the sealed
    // envelope for the two-character id "t1", and a base64 ciphertext contains
    // any given pair by chance about 7% of the time — measured at 7 failures in
    // 50 runs, which made this a false RED roughly one run in seven and proved
    // nothing when it passed. A distinctive id cannot collide by accident, so a
    // hit here is a real leak.
    expect(raw).not.toContain(LEAK_PROBE_ID);
    const record = await journal.find(LEAK_PROBE_ID);
    expect(Object.keys(record ?? {}).sort()).toEqual([
      "idempotencyKey",
      "manifestTotal",
      "phase",
      "publishedCount",
      "serverExpiresAt",
      "serverTerminal",
      "taskID",
      "text",
      "updatedAt",
    ]);
  });

  it("replays the ACK after a crash between publish and ACK — never re-publishes", async () => {
    const files = new FakeFiles();
    const keyBytes = newAtRestKeyBytes();
    const first = journalOf(files, keyBytes);
    await first.recordClaimed({ taskID: "t1", idempotencyKey: "i1", manifestTotal: 2, text: false, now: 10 });
    await first.advance("t1", "publishing", 0, 11);
    await first.advance("t1", "published", 2, 12);
    // Process dies here, before the ACK.

    const afterRestart = journalOf(files, keyBytes);
    const pending = await afterRestart.needsReconcile();
    expect(pending).toHaveLength(1);
    // A FULL publish is recorded, so replaying the ACK is safe: the prefix is
    // authoritative and the files are neither duplicated nor dropped.
    expect(pending[0]).toMatchObject({
      kind: "replay-ack",
      task: { phase: "published", publishedCount: 2, manifestTotal: 2 },
    });
  });

  it("reports an in-flight publish as BLOCKED, never as ackable", async () => {
    // The ambiguity root insisted stays explicit: this journal records counts,
    // not destination identity or a receipt, so nothing here establishes what
    // actually landed. Auto-ACKing would claim a save that may not exist;
    // re-publishing would duplicate files. The type makes it impossible for a
    // caller to mistake this for the replayable case.
    const files = new FakeFiles();
    const keyBytes = newAtRestKeyBytes();
    const journal = journalOf(files, keyBytes);
    await journal.recordClaimed({ taskID: "t2", idempotencyKey: "i2", manifestTotal: 1, text: false, now: 1 });
    await journal.advance("t2", "publishing", 0, 2);
    const pending = await journalOf(files, keyBytes).needsReconcile();
    expect(pending).toEqual([
      {
        kind: "blocked",
        reason: "publish-outcome-unknown",
        task: expect.objectContaining({ taskID: "t2", phase: "publishing" }),
      },
    ]);
  });

  it("dedups a redelivery by idempotency key, not only by task id", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    await journal.recordClaimed({ taskID: "t1", idempotencyKey: "same", manifestTotal: 1, text: true, now: 1 });
    await journal.advance("t1", "publishing", 0, 2);
    await journal.advance("t1", "published", 1, 3);
    await journal.advance("t1", "acked", 1, 4);
    // Central may redeliver under a NEW task id with the same idempotency key;
    // treating that as new would save the same message twice.
    expect(await journal.isSettled("t9", "same", 100)).toBe("settled");
    expect(await journal.isSettled("t9", "different", 100)).toBe("not-settled");
  });

  it("refuses a replay whose manifest total changed", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    await journal.recordClaimed({ taskID: "t1", idempotencyKey: "i1", manifestTotal: 3, text: false, now: 1 });
    await expect(
      journal.recordClaimed({ taskID: "t1", idempotencyKey: "i1", manifestTotal: 4, text: false, now: 2 }),
    ).rejects.toMatchObject({ code: "total-mismatch" });
  });

  it("is idempotent for an unchanged replay", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    const a = await journal.recordClaimed({ taskID: "t1", idempotencyKey: "i1", manifestTotal: 3, text: false, now: 1 });
    const b = await journal.recordClaimed({ taskID: "t1", idempotencyKey: "i1", manifestTotal: 3, text: false, now: 2 });
    expect(b).toEqual(a);
    expect(files.writes).toBe(1);
  });

  it("serialises concurrent updates without losing one", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    await Promise.all([
      journal.recordClaimed({ taskID: "a", idempotencyKey: "ia", manifestTotal: 1, text: false, now: 1 }),
      journal.recordClaimed({ taskID: "b", idempotencyKey: "ib", manifestTotal: 1, text: false, now: 1 }),
      journal.recordClaimed({ taskID: "c", idempotencyKey: "ic", manifestTotal: 1, text: false, now: 1 }),
    ]);
    expect((await journal.all()).map((t) => t.taskID).sort()).toEqual(["a", "b", "c"]);
  });

  it("reports an unreadable journal rather than an empty one", async () => {
    const files = new FakeFiles();
    const keyBytes = newAtRestKeyBytes();
    await files.writeAtomic(`${CONTEXT_A.directory}/journal.enc`, new TextEncoder().encode("{}"));
    await expect(journalOf(files, keyBytes).all()).rejects.toBeInstanceOf(AtRestError);
  });

  it("refuses to advance a task it never recorded", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    await expect(journal.advance("ghost", "acked", 1, 1)).rejects.toMatchObject({ code: "not-recorded" });
  });

  it("prunes only settled tasks", async () => {
    const files = new FakeFiles();
    const journal = journalOf(files, newAtRestKeyBytes());
    await journal.recordClaimed({ taskID: "old", idempotencyKey: "i1", manifestTotal: 1, text: false, now: 0 });
    await journal.advance("old", "publishing", 0, 0);
    await journal.advance("old", "published", 1, 0);
    await journal.advance("old", "acked", 1, 0);
    await journal.recordClaimed({ taskID: "live", idempotencyKey: "i2", manifestTotal: 1, text: false, now: 0 });
    await journal.advance("live", "publishing", 0, 0);
    await journal.advance("live", "published", 1, 0);
    // Local terminality is NOT enough any more: without server proof nothing is
    // evictable, however old it is.
    expect(await journal.pruneSettled(10_000)).toBe(0);
    await journal.recordServerState("old", { terminal: true, expiresAt: 0 }, 10_000);
    expect(await journal.pruneSettled(10_001)).toBe(1);
    expect((await journal.all()).map((t) => t.taskID)).toEqual(["live"]);
  });
});

describe("journal phase transitions and bounds", () => {
  // One key per fixture, held so a re-read can actually decrypt: a fresh random
  // key per construction would make every reopen `unreadable` and the assertion
  // would pass for the wrong reason.
  async function claimed(
    total: number,
  ): Promise<{ journal: TaskJournal; files: FakeFiles; reopen: () => TaskJournal }> {
    const files = new FakeFiles();
    const keyBytes = newAtRestKeyBytes();
    const make = (): TaskJournal =>
      new TaskJournal(CONTEXT_A, files, () => Promise.resolve(keyBytes));
    const journal = make();
    await journal.recordClaimed({ taskID: "t", idempotencyKey: "i", manifestTotal: total, text: false, now: 1 });
    return { journal, files, reopen: make };
  }

  it("refuses to ACK a partial batch", async () => {
    // The transition that would tell central a partial batch was complete.
    const { journal } = await claimed(3);
    await journal.advance("t", "publishing", 0, 2);
    await journal.advance("t", "partial", 1, 3);
    await expect(journal.advance("t", "acked", 1, 4)).rejects.toMatchObject({
      code: "illegal-transition",
    });
  });

  it("refuses to re-drive a settled task", async () => {
    const { journal } = await claimed(1);
    await journal.advance("t", "publishing", 0, 2);
    await journal.advance("t", "published", 1, 3);
    await journal.advance("t", "acked", 1, 4);
    for (const phase of ["publishing", "published", "claimed", "failed"] as TaskPhase[]) {
      await expect(journal.advance("t", phase, 1, 5)).rejects.toMatchObject({
        code: "illegal-transition",
      });
    }
  });

  it("refuses to skip straight from claimed to published", async () => {
    // The intent-to-publish record is what makes a crash reconcilable, so it
    // cannot be optional.
    const { journal } = await claimed(1);
    await expect(journal.advance("t", "published", 1, 2)).rejects.toMatchObject({
      code: "illegal-transition",
    });
  });

  it("refuses a published count above the declared total", async () => {
    const { journal } = await claimed(2);
    await journal.advance("t", "publishing", 0, 2);
    await expect(journal.advance("t", "published", 3, 3)).rejects.toMatchObject({
      code: "count-out-of-range",
    });
  });

  it("refuses a count that goes backwards", async () => {
    const { journal } = await claimed(3);
    await journal.advance("t", "publishing", 2, 2);
    await expect(journal.advance("t", "partial", 1, 3)).rejects.toMatchObject({
      code: "count-out-of-range",
    });
  });

  it("requires `published` to be a FULL publish", async () => {
    const { journal } = await claimed(3);
    await journal.advance("t", "publishing", 0, 2);
    await expect(journal.advance("t", "published", 2, 3)).rejects.toMatchObject({
      code: "count-out-of-range",
    });
  });

  it("requires `partial` to be a proper prefix", async () => {
    const { journal } = await claimed(3);
    await journal.advance("t", "publishing", 0, 2);
    await expect(journal.advance("t", "partial", 0, 3)).rejects.toMatchObject({
      code: "count-out-of-range",
    });
    await expect(journal.advance("t", "partial", 3, 3)).rejects.toMatchObject({
      code: "count-out-of-range",
    });
  });

  it("does not report a partial task as reconcilable", async () => {
    const { journal, reopen } = await claimed(3);
    await journal.advance("t", "publishing", 0, 2);
    await journal.advance("t", "partial", 1, 3);
    expect(await reopen().needsReconcile()).toEqual([]);
  });
});

describe("journal record validation", () => {
  /** Write a journal whose records are whatever the test says. */
  async function writeRecords(records: unknown[]): Promise<TaskJournal> {
    const files = new FakeFiles();
    const keyBytes = newAtRestKeyBytes();
    const key = await importAtRestKey(keyBytes);
    // v2 with a watermark: the only readable format. v1 is refused outright.
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ v: 2, tasks: records, watermark: 0 }),
    );
    const sealed = await sealAtRest(key, CONTEXT_A.accountKey, "journal", plaintext);
    await files.writeAtomic(`${CONTEXT_A.directory}/journal.enc`, sealed);
    return new TaskJournal(CONTEXT_A, files, () => Promise.resolve(keyBytes));
  }

  const valid = {
    taskID: "t",
    idempotencyKey: "i",
    phase: "claimed",
    manifestTotal: 2,
    publishedCount: 0,
    text: false,
    updatedAt: 1,
    serverTerminal: false,
    serverExpiresAt: 0,
  };

  it("accepts a well-formed record", async () => {
    expect((await (await writeRecords([valid])).all())[0]).toMatchObject({ taskID: "t" });
  });

  it.each([
    ["a phase outside the closed set", { ...valid, phase: "whatever" }],
    ["a count above the total", { ...valid, publishedCount: 5 }],
    ["a negative count", { ...valid, publishedCount: -1 }],
    ["a non-integer total", { ...valid, manifestTotal: 1.5 }],
    ["a missing task id", { ...valid, taskID: "" }],
    ["a non-string task id", { ...valid, taskID: 7 }],
    ["a non-boolean text flag", { ...valid, text: "yes" }],
    ["a published record that is not a full publish", { ...valid, phase: "published", publishedCount: 1 }],
    ["an acked record that is not a full publish", { ...valid, phase: "acked", publishedCount: 1 }],
    ["a record that is not an object", 42],
  ])("refuses %s", async (_label, record) => {
    // Trusting the array's shape meant a malformed journal could yield a record
    // the reconciliation logic would then act on.
    const journal = await writeRecords([record]);
    await expect(journal.all()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses an unbounded identifier", async () => {
    const journal = await writeRecords([{ ...valid, taskID: "x".repeat(1000) }]);
    await expect(journal.all()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses a journal holding more records than the bound", async () => {
    const many = Array.from({ length: MAX_JOURNAL_TASKS + 1 }, (_unused, i) => ({
      ...valid,
      taskID: `t${i}`,
    }));
    await expect((await writeRecords(many)).all()).rejects.toMatchObject({ code: "unreadable" });
  });
});

describe("journal retention", () => {
  it("prunes settled records to make room rather than growing without bound", async () => {
    const files = new FakeFiles();
    const journal = new TaskJournal(CONTEXT_A, files, () => Promise.resolve(newAtRestKeyBytes()));
    for (let i = 0; i < MAX_JOURNAL_TASKS; i += 1) {
      await journal.recordClaimed({ taskID: `t${i}`, idempotencyKey: `i${i}`, manifestTotal: 1, text: false, now: i });
      await journal.advance(`t${i}`, "publishing", 0, i);
      await journal.advance(`t${i}`, "published", 1, i);
      await journal.advance(`t${i}`, "acked", 1, i);
      // Server proof: without it nothing is evictable, whatever its phase.
      await journal.recordServerState(`t${i}`, { terminal: true, expiresAt: 0 }, i);
    }
    await journal.recordClaimed({ taskID: "fresh", idempotencyKey: "if", manifestTotal: 1, text: false, now: 9999 });
    const all = await journal.all();
    expect(all.length).toBeLessThanOrEqual(MAX_JOURNAL_TASKS);
    expect(all.some((t) => t.taskID === "fresh")).toBe(true);
    // The oldest settled record made way, not a live one.
    expect(all.some((t) => t.taskID === "t0")).toBe(false);
  });

  it("refuses a new claim when every tracked task is still live", async () => {
    // An untracked task is one whose publish cannot be reconciled, so tracking
    // it without a durable record would be worse than refusing the claim.
    const files = new FakeFiles();
    const journal = new TaskJournal(CONTEXT_A, files, () => Promise.resolve(newAtRestKeyBytes()));
    for (let i = 0; i < MAX_JOURNAL_TASKS; i += 1) {
      await journal.recordClaimed({ taskID: `t${i}`, idempotencyKey: `i${i}`, manifestTotal: 1, text: false, now: i });
    }
    await expect(
      journal.recordClaimed({ taskID: "one-more", idempotencyKey: "im", manifestTotal: 1, text: false, now: 1 }),
    ).rejects.toMatchObject({ code: "retention-full" });
  });
});

describe("retention requires server-side proof, not local terminality", () => {
  const make = (files: FakeFiles, keyBytes: Uint8Array): TaskJournal =>
    new TaskJournal(CONTEXT_A, files, () => Promise.resolve(keyBytes));

  async function partialTask(): Promise<{ journal: TaskJournal }> {
    const journal = make(new FakeFiles(), newAtRestKeyBytes());
    await journal.recordClaimed({ taskID: "p", idempotencyKey: "ip", manifestTotal: 3, text: false, now: 1 });
    await journal.advance("p", "publishing", 0, 2);
    await journal.advance("p", "partial", 1, 3);
    return { journal };
  }

  it("never evicts a partial, however old — the saved prefix is authoritative", async () => {
    // A `partial` has publishedCount > 0 and central has NOT completed the
    // delivery. Dropping the record loses the only statement of which files
    // already exist, and a redelivery is then free to duplicate them.
    const { journal } = await partialTask();
    const record = (await journal.all())[0];
    expect(record?.phase).toBe("partial");
    expect(evictable(record!, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(await journal.pruneSettled(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("evicts a partial only once central says the delivery is terminal", async () => {
    const { journal } = await partialTask();
    await journal.recordServerState("p", { terminal: true, expiresAt: 0 }, 100);
    expect(await journal.pruneSettled(101)).toBe(1);
  });

  it("evicts on an advertised expiry that has passed", async () => {
    const { journal } = await partialTask();
    // `expiresAt` is WIRE SECONDS; `pruneSettled` takes a millisecond clock.
    // This test previously used 500 as both, which is the conflation that made
    // every record with an expiry immediately evictable.
    await journal.recordServerState("p", { terminal: false, expiresAt: 500 }, 100);
    expect(await journal.pruneSettled(400_000)).toBe(0);
    expect(await journal.pruneSettled(500_001)).toBe(1);
  });

  it("does NOT evict a partial whose server expiry is still an hour away", async () => {
    const { journal } = await partialTask();
    const nowMs = 1_770_000_000_000;
    // Central has not finished with it and the expiry is in the future. A
    // partial holds the only record of which files already exist, so evicting
    // it here would let a redelivery duplicate them.
    await journal.recordServerState(
      "p",
      { terminal: false, expiresAt: Math.floor(nowMs / 1000) + 3600 },
      nowMs,
    );
    const record = await journal.find("p");
    expect(evictable(record!, nowMs)).toBe(false);
    expect(await journal.pruneSettled(nowMs)).toBe(0);
    expect((await journal.find("p"))?.phase).toBe("partial");
  });

  it("never evicts a failed record on local terminality alone", async () => {
    const journal = make(new FakeFiles(), newAtRestKeyBytes());
    await journal.recordClaimed({ taskID: "f", idempotencyKey: "if", manifestTotal: 1, text: false, now: 1 });
    await journal.advance("f", "failed", 0, 2);
    expect(await journal.pruneSettled(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("ages out an acked tombstone on the bounded horizon", async () => {
    const journal = make(new FakeFiles(), newAtRestKeyBytes());
    await journal.recordClaimed({ taskID: "a", idempotencyKey: "ia", manifestTotal: 1, text: false, now: 0 });
    await journal.advance("a", "publishing", 0, 0);
    await journal.advance("a", "published", 1, 0);
    await journal.advance("a", "acked", 1, 0);
    expect(await journal.pruneSettled(RETENTION.ackedTombstoneMs)).toBe(0);
    expect(await journal.pruneSettled(RETENTION.ackedTombstoneMs + 1)).toBe(1);
  });

  it("refuses a new claim when nothing is provably settled", async () => {
    const journal = make(new FakeFiles(), newAtRestKeyBytes());
    for (let i = 0; i < MAX_JOURNAL_TASKS; i += 1) {
      await journal.recordClaimed({ taskID: `t${i}`, idempotencyKey: `i${i}`, manifestTotal: 2, text: false, now: i });
      await journal.advance(`t${i}`, "publishing", 0, i);
      await journal.advance(`t${i}`, "partial", 1, i);
    }
    // All locally terminal, none provably settled server-side.
    await expect(
      journal.recordClaimed({ taskID: "next", idempotencyKey: "in", manifestTotal: 1, text: false, now: 1 }),
    ).rejects.toMatchObject({ code: "retention-full" });
  });

  it("reports dedup as UNKNOWN for a delivery older than the evicted window", async () => {
    // After dropping history, "we have no record" is not "it never happened".
    const journal = make(new FakeFiles(), newAtRestKeyBytes());
    await journal.recordClaimed({ taskID: "old", idempotencyKey: "io", manifestTotal: 1, text: false, now: 100 });
    await journal.advance("old", "publishing", 0, 100);
    await journal.advance("old", "published", 1, 100);
    await journal.advance("old", "acked", 1, 100);
    await journal.recordServerState("old", { terminal: true, expiresAt: 0 }, 100);
    expect(await journal.pruneSettled(200)).toBe(1);
    // The watermark is a LOCAL millisecond timestamp.
    expect(journal.dedupHorizon).toBe(100);

    // `isSettled` takes the delivery's creation time in WIRE SECONDS, so these
    // are seconds either side of a 100 ms watermark. Passing local milliseconds
    // here is what made every future delivery answer `unknown`.
    expect(await journal.isSettled("whatever", "unrelated", 0)).toBe("unknown");
    expect(await journal.isSettled("whatever", "unrelated", 1)).toBe("not-settled");
  });
});

describe("key id binding", () => {
  async function boundStore(): Promise<{ keys: InboxKeyStore; publicKey: string; runtime: InboxRuntime }> {
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    const record = await keys.append(1);
    return { keys, publicKey: record.publicKey, runtime };
  }

  it.each(["", "  ", "a".repeat(200), "has space", "has/slash", "quote\"" ])(
    "refuses a malformed key id %j",
    async (keyID) => {
      // An id central never issued cannot match a task, so writing a malformed
      // one silently orphans the key it was meant to name.
      const { keys, publicKey } = await boundStore();
      await expect(keys.bindKeyID(publicKey, keyID)).rejects.toMatchObject({ code: "invalid-key-id" });
    },
  );

  it("is immutable once bound", async () => {
    const { keys, publicKey } = await boundStore();
    await keys.bindKeyID(publicKey, "key-1");
    // Rebinding would re-point this private key at another key's deliveries.
    await expect(keys.bindKeyID(publicKey, "key-2")).rejects.toMatchObject({ code: "already-bound" });
    expect((await keys.current())?.keyID).toBe("key-1");
  });

  it("accepts a repeat of the SAME binding as a harmless retry", async () => {
    const { keys, publicKey } = await boundStore();
    await keys.bindKeyID(publicKey, "key-1");
    await expect(keys.bindKeyID(publicKey, "key-1")).resolves.toBeUndefined();
  });

  it("refuses a duplicate id across records", async () => {
    // Two records claiming one id makes key selection ambiguous, and the wrong
    // choice is an undecryptable delivery with no explanation.
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    const first = await keys.append(1);
    const second = await keys.append(2);
    await keys.bindKeyID(first.publicKey, "key-1");
    await expect(keys.bindKeyID(second.publicKey, "key-1")).rejects.toMatchObject({
      code: "duplicate-key-id",
    });
  });
});

describe("destroying the key history", () => {
  it("refuses while deliveries still need the keys", async () => {
    // Sign-out is reversible and routine; this is not. A key discarded here
    // makes every queued delivery permanently undecryptable.
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    await keys.append(1);
    await expect(
      keys.forget({ reason: "inbox-disabled", pendingDeliveries: 2 }),
    ).rejects.toMatchObject({ code: "pending-deliveries" });
    expect(await keys.current()).not.toBeNull();
  });

  it("proceeds only when the loss is stated deliberately", async () => {
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    await keys.append(1);
    await keys.forget({ reason: "account-removed", pendingDeliveries: 2, discardPendingDeliveries: true });
    expect(await keys.current()).toBeNull();
  });

  it("proceeds freely when nothing is pending", async () => {
    const runtime = await realRuntime();
    const keys = new InboxKeyStore(CONTEXT_A, new FakeSecrets(), runtime);
    await keys.append(1);
    await keys.forget({ reason: "inbox-disabled", pendingDeliveries: 0 });
    expect(await keys.current()).toBeNull();
  });
});

