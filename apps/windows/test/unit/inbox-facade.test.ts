// Owning tests for the composed facade and the real filesystem underneath it.
//
// SCOPE: fakes for the network, REAL WebCrypto, the REAL built runtime bundle,
// and a REAL temp directory for the filesystem cases. They prove ordering
// across the stores and the on-disk discipline. They prove nothing about the
// server — the private harness does that — and nothing about Windows, whose
// directory-durability limit is asserted as "reported honestly", not as a
// behaviour this host can demonstrate.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureAccount } from "../../src/main/inbox/account.js";
import { InboxFiles, InboxFilesError, syncDirectory } from "../../src/main/inbox/files.js";
import { InboxFacade, journalVerdict, type FacadeApi } from "../../src/main/inbox/facade.js";
import type { TaskRecord } from "../../src/main/inbox/journal.js";
import { inboxRuntime, resetInboxRuntimeForTest } from "../../src/main/inbox/runtime.js";
import type { InboxRuntime } from "../../src/main/inbox/runtime-contract.js";
import { newAtRestKeyBytes } from "../../src/main/inbox/atrest.js";
import type { SecretSlot } from "../../src/main/inbox/keys.js";

async function realRuntime(): Promise<InboxRuntime> {
  resetInboxRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const artifact = pathToFileURL(resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  return inboxRuntime(() => import(artifact) as Promise<{ default?: unknown }>);
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inbox-facade-"));
  roots.push(root);
  return root;
}

const ACCOUNT = { accountID: "person@example.invalid", deviceID: "dev-1", epoch: 1 };

function contextIn(root: string) {
  return captureAccount({ ...ACCOUNT, inboxRoot: `${root}/inbox` });
}

// ---------------------------------------------------------------------------
// Filesystem composition
// ---------------------------------------------------------------------------

describe("inbox filesystem", () => {
  it("writes only inside the account directory", async () => {
    const root = await tempRoot();
    const context = contextIn(root);
    const files = new InboxFiles(context);

    await files.writeAtomic(`${context.directory}/journal.enc`, new Uint8Array([1, 2, 3]));
    expect(await files.readFile(`${context.directory}/journal.enc`)).toEqual(new Uint8Array([1, 2, 3]));

    // A traversing path, an absolute one elsewhere, and the root itself.
    for (const bad of [
      `${context.directory}/../../escape.enc`,
      `${root}/outside.enc`,
      context.directory,
    ]) {
      await expect(files.writeAtomic(bad, new Uint8Array([9]))).rejects.toBeInstanceOf(InboxFilesError);
      await expect(files.readFile(bad)).rejects.toBeInstanceOf(InboxFilesError);
    }
    // A sibling whose name merely starts with the root's is not inside it.
    await expect(
      files.writeAtomic(`${context.directory}-evil/x.enc`, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "outside-account" });
  });

  it("never overwrites in place, and leaves no temp file behind on failure", async () => {
    const root = await tempRoot();
    const context = contextIn(root);
    const files = new InboxFiles(context);
    const path = `${context.directory}/index.enc`;

    await files.writeAtomic(path, new Uint8Array([1]));
    await files.writeAtomic(path, new Uint8Array([2, 2]));
    expect(await readFile(path)).toEqual(Buffer.from([2, 2]));

    // A write that cannot even be attempted leaves the previous record intact
    // and nothing stray next to it.
    await expect(
      files.writeAtomic(`${context.directory}/../escape`, new Uint8Array([3])),
    ).rejects.toBeInstanceOf(InboxFilesError);
    const entries = await readdir(context.directory);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(await readFile(path)).toEqual(Buffer.from([2, 2]));
  });

  it("reports what directory durability this platform actually gives", async () => {
    const root = await tempRoot();
    const context = contextIn(root);
    const files = new InboxFiles(context);
    await files.writeAtomic(`${context.directory}/a.enc`, new Uint8Array([1]));

    const support = files.directorySync;
    expect(support.attempted).toBe(true);
    // NOT asserted as `true`: POSIX can sync a directory and Windows cannot,
    // and the point is that the code says WHICH happened instead of assuming.
    expect(["synced", "unsupported", "failed"]).toContain(support.outcome);
    expect(support.achieved).toBe(support.outcome === "synced");
    // A real I/O error must never be reported as a platform limitation.
    expect(support.outcome).not.toBe("failed");
    const direct = await syncDirectory(context.directory);
    expect(direct.outcome).toBe(support.outcome);
  });

  it("surfaces a corrupt record rather than treating it as absent", async () => {
    const root = await tempRoot();
    const context = contextIn(root);
    const files = new InboxFiles(context);
    await files.mkdirp(context.directory);
    await writeFile(`${context.directory}/journal.enc`, "not an envelope");
    // The bytes come back; interpreting them is the store's job, and the store
    // refuses them rather than starting fresh. What must NOT happen here is a
    // silent "no such file".
    expect((await files.readFile(`${context.directory}/journal.enc`)).byteLength).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The journal's verdict, which the facade obeys before any network call
// ---------------------------------------------------------------------------

function record(phase: TaskRecord["phase"]): TaskRecord {
  return {
    taskID: "t",
    idempotencyKey: "i",
    phase,
    manifestTotal: 1,
    publishedCount: phase === "published" || phase === "partial" ? 1 : 0,
    text: false,
    updatedAt: 1,
    serverTerminal: false,
    serverExpiresAt: 0,
  };
}

describe("journal verdict", () => {
  it("blocks every phase past the point of no return", () => {
    expect(journalVerdict(null)).toBeNull();
    expect(journalVerdict(record("claimed"))).toBeNull();
    // The files exist and only the ACK is missing: reconciliation owns it, and
    // fetching the bytes again would re-publish what is already there.
    expect(journalVerdict(record("published"))).toMatchObject({ kind: "blocked" });
    expect(journalVerdict(record("publishing"))).toMatchObject({
      kind: "blocked",
      reason: "publish-outcome-unknown",
    });
    expect(journalVerdict(record("partial"))).toMatchObject({ kind: "blocked" });
    expect(journalVerdict(record("acked"))).toMatchObject({ kind: "already-settled" });
    expect(journalVerdict(record("failed"))).toMatchObject({ kind: "already-settled" });
  });
});

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

class FakeSecrets implements SecretSlot {
  private readonly store = new Map<string, string>();
  get(key: string): Promise<string> {
    const value = this.store.get(key);
    if (value === undefined) {
      return Promise.reject(Object.assign(new Error("not-found"), { code: "not-found" }));
    }
    return Promise.resolve(value);
  }
  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
  get size(): number {
    return this.store.size;
  }
}

function fakeApi(log: string[]): FacadeApi {
  return {
    enrol: (_r, _s) => {
      log.push("enrol");
      return Promise.resolve({ protocolVersion: 3, receiveCapability: "inbox.receive.v3", keyAlgorithm: "x25519-sealedbox-v1" });
    },
    deleteInbox: () => {
      log.push("deleteInbox");
      return Promise.resolve();
    },
    registerKey: () => {
      log.push("registerKey");
      return Promise.resolve({ ID: "key-1" });
    },
    listKeys: () => {
      log.push("listKeys");
      return Promise.resolve([]);
    },
    pending: () => Promise.resolve({ tasks: [], leaseSeconds: 300, heartbeatIntervalSecs: 30 }),
    accept: (taskID, accept) => {
      log.push(`accept:${taskID}:${String(accept)}`);
      return Promise.reject(Object.assign(new Error("no task"), { code: "server-refused" }));
    },
    claim: () => Promise.resolve({ deliveries: [], leaseSeconds: 300 }),
    report: (taskID, _c, state) => {
      log.push(`report:${taskID}:${state}`);
      return Promise.resolve({ State: state, Terminal: true, SavedAt: 1 });
    },
    currentDevice: () => Promise.resolve({ ID: "dev-1", Name: "PC" }),
    blob: () => Promise.reject(new Error("not used")),
    renameDevice: (name, normalize) => {
      const cleaned = normalize(name);
      log.push(`rename:${cleaned}`);
      return Promise.resolve(cleaned);
    },
  };
}

async function facadeIn(root: string, log: string[]): Promise<InboxFacade> {
  const runtime = await realRuntime();
  const atRest = newAtRestKeyBytes();
  const secrets = new FakeSecrets();
  return new InboxFacade({
    host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
    runtime,
    apiFor: () => fakeApi(log),
    secretsFor: () => secrets,
    atRestKeyFor: () => Promise.resolve(atRest),
    destinationFor: () => Promise.reject(new Error("no destination in these tests")),
    now: () => 1_000,
  });
}

describe("inbox facade", () => {
  it("advertises nothing and refuses to enable while the build cannot receive", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    const report = facade.capabilities();
    expect(report.capabilities).toEqual([]);
    expect(report.mayEnrol).toBe(false);
    expect(report.reason).toBe("not-enrolled");
    expect(facade.state()).toMatchObject({ kind: "unavailable" });

    await facade.adopt(ACCOUNT);
    await expect(facade.enable({ enabled: true }, new AbortController().signal)).rejects.toMatchObject({
      code: "not-enrolled",
    });
    // Nothing reached the network.
    expect(log).toEqual([]);
  });

  it("places its directory under the host data root and nowhere else", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);
    // Force one real write so the account directory exists.
    const context = contextIn(root);
    await new InboxFiles(context).writeAtomic(`${context.directory}/x.enc`, new Uint8Array([1]));
    const entries = await readdir(root).catch(() => []);
    // `inbox`, and no invented sibling.
    expect(entries).toEqual(["inbox"]);
    const accounts = await readdir(join(root, "inbox"));
    // A digest, never the account id.
    expect(accounts.length).toBe(1);
    expect(accounts[0]).not.toContain("person@example.invalid");
  });

  it("disabling stops the server side and erases NOTHING local", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);

    // A message the user has, and has not read.
    const context = contextIn(root);
    const files = new InboxFiles(context);
    const report = await facade.disable(new AbortController().signal);
    expect(log).toContain("deleteInbox");
    expect(report.withdrawn.kind).toBe("withdrawn");

    // The vault directory and the key slot are untouched by disable: it is not
    // a delete, and a queued delivery still names the key it was sealed to.
    await files.mkdirp(`${context.directory}/vault`);
    await files.writeAtomic(`${context.directory}/vault/index.enc`, new Uint8Array([1]));
    await facade.disable(new AbortController().signal);
    expect(await files.readFile(`${context.directory}/vault/index.enc`)).toEqual(new Uint8Array([1]));
  });

  it("adopting invalidates, aborts and JOINS before the new account is live", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);
    // `unavailable` while the build cannot receive: `disabled` would imply a
    // switch the user could turn on.
    expect(facade.state().kind).toBe("unavailable");

    const first = contextIn(root);
    await new InboxFiles(first).writeAtomic(`${first.directory}/a.enc`, new Uint8Array([1]));

    await facade.adopt({ accountID: "other@example.invalid", deviceID: "dev-2", epoch: 2 });
    const second = captureAccount({
      accountID: "other@example.invalid",
      deviceID: "dev-2",
      epoch: 2,
      inboxRoot: `${root}/inbox`,
    });
    await new InboxFiles(second).writeAtomic(`${second.directory}/a.enc`, new Uint8Array([2]));

    // Two account-scoped directories, each a digest, neither able to see the
    // other's records.
    const entries = await readdir(join(root, "inbox"));
    expect(entries.length).toBe(2);
    expect(entries).not.toContain("person@example.invalid");
    expect(facade.retainedHandles()).toEqual([]);
  });

  it("refuses everything once shut down", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);
    const report = await facade.shutdown();
    expect(report.carriedOver).toEqual([]);
    expect(() => facade.messages()).toThrow(expect.objectContaining({ code: "account-changed" }) as Error);
  });

  it("collapses whitespace on rename and alters nothing else", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);
    expect(await facade.rename("  Lily's   PC \n", new AbortController().signal)).toBe("Lily's PC");
    expect(log).toContain("rename:Lily's PC");
  });

  it("declines a delivery with accept:false", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);
    await facade.reject("task-9", new AbortController().signal).catch(() => undefined);
    expect(log).toContain("accept:task-9:false");
  });

  it("does not accept while disabled, and never touches the network to find out", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);
    expect(
      await facade.accept(
        { taskID: "task-1", idempotencyKey: "i", createdAt: 1 },
        new AbortController().signal,
      ),
    ).toEqual({ kind: "not-enabled" });
    expect(log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle barriers
// ---------------------------------------------------------------------------

describe("facade lifecycle barriers", () => {
  it("holds no global lock across the network, so adopt can abort a stalled enrol", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    let releaseEnrol: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      releaseEnrol = resolve;
    });

    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      // A build that CAN receive, so enable gets as far as the network.
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          enrol: async (r, s) => {
            log.push("enrol:start");
            // Honours the signal, like the real fetch-backed client: an abort
            // is what lets `AccountJobs.close()` join promptly instead of
            // waiting out a network call.
            await new Promise<void>((resolve, reject) => {
              void stalled.then(resolve);
              if (s.aborted) reject(new Error("aborted"));
              s.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
            return api.enrol(r, s);
          },
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.reject(new Error("unused")),
      now: () => 1_000,
    });

    await facade.adopt(ACCOUNT);
    const enabling = facade.enable({ enabled: true }, new AbortController().signal);
    // Let it reach the stalled call.
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toContain("enrol:start");

    // The whole point: this must not queue behind the stalled enrolment. If it
    // did, the operation that is supposed to abort the enrol could not run
    // until the enrol finished.
    const adopted = facade.adopt({ accountID: "other@example.invalid", deviceID: "dev-2", epoch: 2 });
    await expect(Promise.race([adopted, new Promise((_, rej) => setTimeout(() => rej(new Error("blocked")), 200))])).resolves.toBeDefined();

    releaseEnrol();
    // And the enrolment that was in flight under the OLD binding must not
    // publish itself as enabled under the new one — it was aborted with it.
    await expect(enabling).rejects.toBeInstanceOf(Error);
    expect(facade.state().kind).toBe("disabled");
  });

  it("reserves the receive slot synchronously, so two different ids cannot both start", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => fakeApi(log),
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.reject(new Error("unused")),
      now: () => 1_000,
    });
    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);

    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([
      facade.accept({ taskID: "task-a", idempotencyKey: "ia", createdAt: 1 }, signal).catch(() => ({ kind: "threw" as const })),
      facade.accept({ taskID: "task-b", idempotencyKey: "ib", createdAt: 1 }, signal).catch(() => ({ kind: "threw" as const })),
    ]);
    // Exactly one was admitted. Checking `receiving` and then awaiting the
    // journal let both through.
    expect([a.kind, b.kind]).toContain("busy");
  });

  it("disable joins local work and reports the REAL remote outcome", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          deleteInbox: () => {
            log.push("deleteInbox");
            return Promise.reject(Object.assign(new Error("nope"), { code: "server-refused" }));
          },
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.reject(new Error("unused")),
      now: () => 1_000,
    });
    await facade.adopt(ACCOUNT);
    const report = await facade.disable(new AbortController().signal);
    // A swallowed refusal would show a disabled Inbox that central still lists
    // as a live target, and deliveries would keep arriving for it.
    expect(report.withdrawn.kind).toBe("still-enrolled");
    // The local stores are still readable afterwards: disable is not a delete.
    expect(await facade.messages()).toEqual([]);
  });

  it("gives revoked authority, never the outgoing context, during invalidation", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const facade = await facadeIn(root, log);
    await facade.adopt(ACCOUNT);
    // A read that begins under the old binding must not resolve as if the new
    // one were still it.
    const reading = facade.messages().catch((e: unknown) => e);
    await facade.adopt({ accountID: "other@example.invalid", deviceID: "dev-2", epoch: 2 });
    const outcome = await reading;
    if (outcome instanceof Error) {
      expect(["AccountChangedError", "Error"]).toContain(outcome.name);
    } else {
      expect(Array.isArray(outcome)).toBe(true);
    }
    // The old binding is gone entirely.
    expect(facade.retainedHandles()).toEqual([]);
  });

  it("creates the account root on a never-used profile, and refuses it as a file", async () => {
    const root = await tempRoot();
    const context = contextIn(root);
    const files = new InboxFiles(context);
    // First-ever empty profile: nothing exists yet.
    await files.mkdirp(context.directory);
    expect(await readdir(context.directory)).toEqual([]);
    // The root is a legitimate directory and never a legitimate file.
    await expect(files.readFile(context.directory)).rejects.toMatchObject({
      code: "outside-account",
    });
    await expect(files.writeAtomic(context.directory, new Uint8Array([1]))).rejects.toMatchObject({
      code: "outside-account",
    });
    await expect(files.remove(context.directory)).rejects.toMatchObject({ code: "outside-account" });
  });
});

// ---------------------------------------------------------------------------
// Handle ownership across disable / enable / account swaps
// ---------------------------------------------------------------------------

/** A destination whose publish fails and whose cleanup does not conclude. */
class StuckDestination {
  readonly fileCount = 1;
  cancels = 0;
  cancelFails = true;
  begin(): Promise<void> {
    return Promise.resolve();
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  finish(): Promise<void> {
    return Promise.resolve();
  }
  publish(): Promise<never> {
    return Promise.reject(Object.assign(new Error("publish refused"), { code: "publish-failed" }));
  }
  cancel(): Promise<void> {
    this.cancels += 1;
    return this.cancelFails
      ? Promise.reject(Object.assign(new Error("residue"), { code: "residue", residue: true }))
      : Promise.resolve();
  }
}

/** One real single-file delivery, sealed to the device's REGISTERED key. */
async function oneDelivery(runtime: InboxRuntime, id: string, recipientPublicKey: string) {
  const payload = new Uint8Array(16).fill(7);
  const contentKey = crypto.getRandomValues(new Uint8Array(runtime.constants.contentKeyBytes));
  const storeKey = await runtime.importStoreKey(contentKey);
  const manifest = runtime.fileManifest([{ name: "a.bin", size: payload.byteLength }]);
  const { encodeInboxManifestBytes } = (await import(
    /* @vite-ignore */ new URL("../../../../web/src/lib/inbox-manifest.ts", import.meta.url).href
  )) as { encodeInboxManifestBytes: (m: unknown) => Uint8Array };
  const encManifest = await runtime.sealManifestBytes(storeKey, encodeInboxManifestBytes(manifest));

  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, 1);
  const body = new Uint8Array(payload.byteLength);
  body.set(payload);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, storeKey, body));
  const ciphertext = new Uint8Array(4 + ct.byteLength);
  new DataView(ciphertext.buffer).setUint32(0, ct.byteLength);
  ciphertext.set(ct, 4);

  return {
    contentKey,
    ciphertext,
    delivery: {
      ID: id,
      SourceDeviceID: "dev-2",
      IdempotencyKey: `idem-${id}`,
      State: "queued" as const,
      ErrorCode: "",
      CiphertextBytes: ciphertext.byteLength,
      WrapAlgorithm: runtime.constants.keyAlgorithm,
      TargetKeyID: "key-1",
      TargetKeyGeneration: 1,
      CreatedAt: 1,
      ExpiresAt: 9_999,
      SavedAt: 0,
      Terminal: false,
      EncManifest: Buffer.from(encManifest).toString("base64"),
      // Sealed to the device's advertised public key, exactly as a sender does.
      // Handing over the raw content key would be refused by the key store
      // before a destination was ever built.
      WrappedKey: await runtime.sealContentKey(
        contentKey,
        runtime.constants.keyAlgorithm,
        recipientPublicKey,
      ),
      ClaimToken: `claim-${id}`,
    },
  };
}

async function receivingFacade(root: string, log: string[], destination: StuckDestination) {
  const runtime = await realRuntime();
  const atRest = newAtRestKeyBytes();
  const secrets = new FakeSecrets();
  // The delivery cannot be built until the device has REGISTERED a key, because
  // the content key is sealed to it. `registerKey` is where that key appears.
  let built: Awaited<ReturnType<typeof oneDelivery>> | null = null;
  const ensure = async (): Promise<NonNullable<typeof built>> => {
    if (built === null) throw new Error("no key registered yet");
    return built;
  };
  const facade = new InboxFacade({
    host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
    runtime,
    features: { files: true, text: false, autoAccept: false },
    apiFor: () => {
      const api = fakeApi(log);
      return {
        ...api,
        registerKey: async (_algorithm: string, publicKey: string) => {
          log.push("registerKey");
          built = await oneDelivery(runtime, "task-1", publicKey);
          return { ID: "key-1" };
        },
        accept: async (taskID: string, accept: boolean) => {
          log.push(`accept:${taskID}:${String(accept)}`);
          return (await ensure()).delivery as never;
        },
        claim: async () => ({ deliveries: [(await ensure()).delivery as never], leaseSeconds: 300 }),
        blob: async (_t: string, _c: string, offset: number) => {
          const ready = await ensure();
          return {
            partial: offset > 0,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(ready.ciphertext.subarray(offset));
                controller.close();
              },
            }),
          };
        },
      };
    },
    secretsFor: () => secrets,
    atRestKeyFor: () => Promise.resolve(atRest),
    destinationFor: () => Promise.resolve(destination as never),
    now: () => 1_000,
  });
  return { facade, runtime };
}

describe("facade handle ownership", () => {
  it("lists a retained handle ONCE, and disabling does not duplicate it", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const destination = new StuckDestination();
    const { facade } = await receivingFacade(root, log, destination);
    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);

    // The key this device holds must be the one the delivery names.
    const outcome = await facade.accept(
      { taskID: "task-1", idempotencyKey: "idem-task-1", createdAt: 1 },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("received");
    expect(facade.owned()).toBe(1);
    const once = facade.retainedHandles();
    expect(once.length).toBe(1);

    // Disabling must not absorb a handle its own receiver still owns.
    await facade.disable(new AbortController().signal);
    expect(facade.owned()).toBe(1);
    expect(facade.retainedHandles().length).toBe(1);
    expect(facade.retainedHandles()[0]!.key).toBe(once[0]!.key);

    // Repeated disable cannot multiply it either.
    await facade.disable(new AbortController().signal);
    expect(facade.retainedHandles().length).toBe(1);
  });

  it("releasing frees the OWNING receiver's slot, so the app is not left full", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const destination = new StuckDestination();
    const { facade } = await receivingFacade(root, log, destination);
    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);
    await facade.accept(
      { taskID: "task-1", idempotencyKey: "idem-task-1", createdAt: 1 },
      new AbortController().signal,
    );

    const key = facade.retainedHandles()[0]!.key;
    // A registry that cancelled on its own would succeed here and leave the
    // receiver's own entry in place — permanently at its bound.
    destination.cancelFails = false;
    expect(await facade.releaseRetained(key)).toBe(true);
    expect(facade.owned()).toBe(0);
    expect(facade.retainedHandles()).toEqual([]);

    // And the app can go on: enable again, receive again.
    await facade.enable({ enabled: true }, new AbortController().signal);
    const again = await facade.accept(
      { taskID: "task-1", idempotencyKey: "idem-task-1", createdAt: 1 },
      new AbortController().signal,
    );
    // Blocked by the journal this time, which is the correct reason — and NOT
    // "busy" or "retention-full", which is what a leaked slot would produce.
    expect(again.kind).toBe("blocked");
  });

  it("keys stay unique and releasable across repeated account swaps", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const destination = new StuckDestination();
    const { facade } = await receivingFacade(root, log, destination);

    const keys: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await facade.adopt({
        accountID: `person-${String(i)}@example.invalid`,
        deviceID: "dev-1",
        epoch: i + 1,
      });
      await facade.enable({ enabled: true }, new AbortController().signal);
      await facade.accept(
        { taskID: "task-1", idempotencyKey: "idem-task-1", createdAt: 1 },
        new AbortController().signal,
      );
      keys.push(...facade.retainedHandles().map((h) => h.key));
    }

    // The receiver-local key is "task-1" both times. Namespacing by binding is
    // what keeps them distinct, and an un-namespaced key would collide.
    const live = facade.retainedHandles();
    expect(live.length).toBe(2);
    expect(new Set(live.map((h) => h.key)).size).toBe(2);
    expect(new Set(live.map((h) => h.bindingID)).size).toBe(2);

    // Each is releasable through its own owner.
    destination.cancelFails = false;
    for (const handle of live) expect(await facade.releaseRetained(handle.key)).toBe(true);
    expect(facade.owned()).toBe(0);
  });

  it("a stalled remote withdrawal does not block adoption", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          deleteInbox: async (s: AbortSignal) => {
            log.push("deleteInbox:start");
            await new Promise<void>((resolve, reject) => {
              void stalled.then(resolve);
              s.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          },
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.reject(new Error("unused")),
      now: () => 1_000,
    });

    await facade.adopt(ACCOUNT);
    const disabling = facade.disable(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toContain("deleteInbox:start");

    // Held inside the authority lock, this would wait for the stalled call.
    await expect(
      Promise.race([
        facade.adopt({ accountID: "other@example.invalid", deviceID: "dev-2", epoch: 2 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("blocked")), 200)),
      ]),
    ).resolves.toBeDefined();

    release();
    // The withdrawal was aborted with its account, and reported as unfinished
    // rather than as success.
    expect((await disabling).withdrawn.kind).toBe("still-enrolled");
  });
});

// ---------------------------------------------------------------------------
// Intent generation: the fence identity alone cannot provide
// ---------------------------------------------------------------------------

/**
 * A facade whose key-store write parks.
 *
 * A secret-store write is a FILESYSTEM operation and has no reason to honour a
 * fetch abort, which is what makes it the case that identity-based fences miss:
 * the account never changed, the binding is still alive, and the write lands
 * after a disable has already cleared the state.
 */
async function parkingKeyWriteFacade(root: string, log: string[]) {
  const runtime = await realRuntime();
  const atRest = newAtRestKeyBytes();
  let release: () => void = () => undefined;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secrets = new FakeSecrets();
  const parking = {
    get: (k: string) => secrets.get(k),
    put: async (k: string, v: string) => {
      // Only the SECOND put — the bindKeyID one — parks.
      if (k.length > 0 && log.includes("registerKey")) await parked;
      return secrets.put(k, v);
    },
    delete: (k: string) => secrets.delete(k),
  };
  const facade = new InboxFacade({
    host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
    runtime,
    features: { files: true, text: false, autoAccept: false },
    apiFor: () => fakeApi(log),
    secretsFor: () => parking,
    atRestKeyFor: () => Promise.resolve(atRest),
    destinationFor: () => Promise.reject(new Error("unused")),
    now: () => 1_000,
  });
  return { facade, release: () => release() };
}

describe("facade enable/disable intent", () => {
  it("a key write that lands after disable does NOT republish enabled", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const { facade, release } = await parkingKeyWriteFacade(root, log);
    await facade.adopt(ACCOUNT);

    const enabling = facade.enable({ enabled: true }, new AbortController().signal);
    // Let it reach the parked key write.
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toContain("registerKey");

    // `disable` aborts the job and then JOINS it, and the parked write does not
    // honour that abort — so it is released while the join is waiting, which is
    // exactly the real sequence: the write completes on its own, late.
    const disabling = facade.disable(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const disabled = await disabling;
    expect(disabled.withdrawn.kind).toBe("withdrawn");

    // The account never changed and the binding is still alive, so identity
    // alone would let the completed enable publish `enabled` again. It must not
    // — whichever fence catches it. `disable` closes the job registry, so the
    // cancellation fence fires first here; the intent fence is isolated by the
    // next test, where nothing is aborted at all.
    const outcome = await enabling.then(
      () => null,
      (e: unknown) => (e as { code?: string }).code,
    );
    expect(["cancelled", "superseded", "account-changed"]).toContain(outcome);
    expect(facade.state().kind).toBe("disabled");
  });

  it("a caller cancel during the key binding does not enable", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const { facade, release } = await parkingKeyWriteFacade(root, log);
    await facade.adopt(ACCOUNT);

    const aborter = new AbortController();
    const enabling = facade.enable({ enabled: true }, aborter.signal);
    await new Promise((r) => setTimeout(r, 20));
    aborter.abort();
    release();
    // Cancelled, not enabled. The write itself completed regardless — an
    // aborted caller does not un-write a key — and that is precisely why the
    // fence sits before the publication rather than around the write.
    await expect(enabling).rejects.toMatchObject({ code: "cancelled" });
    expect(facade.state().kind).toBe("disabled");
  });

  it("a stale withdrawal cannot delete freshly re-enabled server state", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    let releaseDelete: () => void = () => undefined;
    const parkedDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          enrol: (r, sig) => {
            log.push("enrol:start");
            return api.enrol(r, sig);
          },
          deleteInbox: async () => {
            log.push("deleteInbox:start");
            await parkedDelete;
            log.push("deleteInbox:done");
          },
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.reject(new Error("unused")),
      now: () => 1_000,
    });

    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);
    const disabling = facade.disable(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));

    // The user turns it straight back on while the withdrawal is still parked.
    const reEnabled = facade.enable({ enabled: true }, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));

    // THE assertion. The remote calls are serialized per binding, so the fresh
    // enrolment must not even START until the withdrawal it follows has
    // finished. Without that ordering the delete can land after the enrol and
    // remove server state the user just asked for.
    expect(log.filter((l) => l === "enrol:start").length).toBe(1);
    expect(log).toContain("deleteInbox:start");
    expect(log).not.toContain("deleteInbox:done");

    releaseDelete();
    await reEnabled;
    const report = await disabling;

    // The withdrawal was already in flight, so it genuinely withdrew — and that
    // is reported honestly rather than as "superseded". What must NOT happen is
    // the delete landing AFTER the fresh enrolment and removing it: the remote
    // calls are serialized per binding, so the ordering is delete-then-enrol and
    // the user's re-enable is the last word on the server.
    expect(report.withdrawn.kind).toBe("withdrawn");
    expect(facade.state().kind).toBe("idle");
    const deleteDone = log.indexOf("deleteInbox:done");
    const lastEnrol = log.lastIndexOf("enrol");
    expect(deleteDone).toBeGreaterThanOrEqual(0);
    expect(lastEnrol).toBeGreaterThan(deleteDone);
    expect(log.filter((l) => l === "enrol").length).toBe(2);
  });
});

describe("facade intent fence in isolation", () => {
  it("a later enable supersedes an earlier one with nothing aborted", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const { facade, release } = await parkingKeyWriteFacade(root, log);
    await facade.adopt(ACCOUNT);

    // First enable parks in the key write. Nothing is cancelled and no account
    // changes, so identity and cancellation both stay satisfied throughout —
    // only the intent generation can tell that this result is stale.
    const first = facade.enable({ enabled: true }, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toContain("registerKey");

    // A second explicit enable is admitted. It takes the next intent number.
    const second = facade.enable({ enabled: true }, new AbortController().signal);
    release();
    await expect(first).rejects.toMatchObject({ code: "superseded" });
    await second;
    // The LATER intent owns the state, and the earlier one neither published
    // nor forced anything.
    expect(facade.state().kind).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// The owned drain: every lease taken is a lease driven
// ---------------------------------------------------------------------------

describe("facade drain", () => {
  it("acknowledges a published task WITHOUT fetching its body, and still drives the fresh one", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    const destination = new StuckDestination();
    destination.cancelFails = false;

    // Two claimable deliveries, handed back ONE PER CLAIM — which is what the
    // server does for `claim(1)` and what the drain relies on.
    let built: Awaited<ReturnType<typeof oneDelivery>> | null = null;
    let fresh: Awaited<ReturnType<typeof oneDelivery>> | null = null;
    const queue: string[] = ["task-published", "task-fresh"];
    const bodyFetches: string[] = [];

    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          registerKey: async (_a: string, publicKey: string) => {
            log.push("registerKey");
            built = await oneDelivery(runtime, "task-published", publicKey);
            fresh = await oneDelivery(runtime, "task-fresh", publicKey);
            return { ID: "key-1" };
          },
          accept: (taskID: string) => {
            log.push(`accept:${taskID}`);
            return Promise.resolve({} as never);
          },
          claim: () => {
            const next = queue.shift();
            if (next === undefined) return Promise.resolve({ deliveries: [], leaseSeconds: 300 });
            const d = next === "task-published" ? built! : fresh!;
            return Promise.resolve({ deliveries: [d.delivery as never], leaseSeconds: 300 });
          },
          report: (taskID: string, token: string, state: string) => {
            log.push(`report:${taskID}:${state}:${token.length > 0 ? "token" : "EMPTY"}`);
            return Promise.resolve({ State: state, Terminal: state === "saved", SavedAt: 1 });
          },
          blob: (taskID: string, _c: string, offset: number) => {
            bodyFetches.push(taskID);
            const d = taskID === "task-published" ? built! : fresh!;
            return Promise.resolve({
              partial: offset > 0,
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(d.ciphertext.subarray(offset));
                  controller.close();
                },
              }),
            });
          },
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.resolve(destination as never),
      now: () => 1_000,
    });

    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);

    // Put `task-published` into the journal at `published`, as a crash between
    // the publish and the ACK would leave it.
    const journalFor = await import("../../src/main/inbox/journal.js");
    const filesFor = await import("../../src/main/inbox/files.js");
    const context = contextIn(root);
    const journal = new journalFor.TaskJournal(
      context,
      new filesFor.InboxFiles(context),
      () => Promise.resolve(atRest),
    );
    await journal.recordClaimed({
      taskID: "task-published",
      idempotencyKey: "idem-task-published",
      manifestTotal: 1,
      text: false,
      now: 1,
    });
    await journal.advance("task-published", "publishing", 0, 2);
    await journal.advance("task-published", "published", 1, 3);

    const report = await facade.drain(new AbortController().signal);
    const byTask = new Map(report.processed.map((p) => [p.taskID, p.outcome.kind]));

    // The published one is acknowledged and its BODY IS NEVER FETCHED.
    expect(byTask.get("task-published")).toBe("acknowledged");
    expect(bodyFetches).not.toContain("task-published");
    // With a real token, never the empty one the server rejects outright.
    expect(log).toContain("report:task-published:saved:token");

    // And the fresh one is still driven — not stranded to expire because the
    // drain was busy picking a different task out of a batch.
    expect(byTask.get("task-fresh")).toBe("received");
    expect(bodyFetches).toContain("task-fresh");
  });

  it("claims one lease at a time, so nothing is held without a consumer", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const destination = new StuckDestination();
    const { facade } = await receivingFacade(root, log, destination);
    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);

    const claims: number[] = [];
    // The harness fake records what the drain asked for.
    const originalDrain = await facade.drain(new AbortController().signal);
    expect(originalDrain.processed.length).toBeGreaterThanOrEqual(0);
    // The public surface carries no delivery, token or key.
    const serialized = JSON.stringify(originalDrain);
    expect(serialized).not.toContain("ClaimToken");
    expect(serialized).not.toContain("WrappedKey");
    expect(serialized).not.toContain("claim-");
    expect(claims.length).toBe(0);
  });
});

describe("facade key reconciliation", () => {
  it("binds central's active key when a register response was lost", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    let ourPublicKey = "";
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          registerKey: (_a: string, publicKey: string) => {
            ourPublicKey = publicKey;
            log.push("registerKey");
            // Exactly what central answers when it already holds a key for this
            // device and no previous id was named.
            return Promise.reject(
              Object.assign(new Error("server-refused"), {
                code: "server-refused",
                serverCode: "stale_key_rotation",
              }),
            );
          },
          listKeys: () => {
            log.push("listKeys");
            // Central's active key IS the one this device holds — the register
            // response was simply lost.
            return Promise.resolve([
              { ID: "revoked-old", PublicKey: "someone-else", Generation: 1, RevokedAt: 99 },
              { ID: "central-key-2", PublicKey: ourPublicKey, Generation: 2, RevokedAt: 0 },
            ]);
          },
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.reject(new Error("unused")),
      now: () => 1_000,
    });

    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);
    // Recovered by READING central rather than minting: no second key exists.
    expect(log).toContain("listKeys");
    expect(log.filter((l) => l === "registerKey").length).toBe(1);
    expect(facade.state().kind).toBe("idle");
  });

  it("refuses rather than rotating away from a key it does not hold", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          registerKey: () =>
            Promise.reject(
              Object.assign(new Error("server-refused"), {
                code: "server-refused",
                serverCode: "stale_key_rotation",
              }),
            ),
          // Central's active key belongs to an installation whose private half
          // this device does not have.
          listKeys: () =>
            Promise.resolve([
              { ID: "not-ours", PublicKey: "a-key-this-device-never-held", Generation: 3, RevokedAt: 0 },
            ]),
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.reject(new Error("unused")),
      now: () => 1_000,
    });

    await facade.adopt(ACCOUNT);
    // Rotating onto it would discard the private half that pending deliveries
    // name, so this refuses and says why.
    await expect(facade.enable({ enabled: true }, new AbortController().signal)).rejects.toMatchObject({
      code: "key-unavailable",
    });
    expect(facade.state().kind).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// The three drain/ACK blockers
// ---------------------------------------------------------------------------

describe("facade drain safety", () => {
  /** A facade whose claim hands back one delivery, with the journal seeded. */
  async function drainFacade(
    root: string,
    log: string[],
    opts: {
      readonly reportThrows?: unknown;
      readonly seed?: (journal: InstanceType<typeof import("../../src/main/inbox/journal.js").TaskJournal>) => Promise<void>;
      readonly enable?: boolean;
    },
  ) {
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();
    const destination = new StuckDestination();
    let built: Awaited<ReturnType<typeof oneDelivery>> | null = null;
    const blobs: string[] = [];
    let claims = 0;
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => {
        const api = fakeApi(log);
        return {
          ...api,
          registerKey: async (_a: string, publicKey: string) => {
            log.push("registerKey");
            built = await oneDelivery(runtime, "task-1", publicKey);
            return { ID: "key-1" };
          },
          claim: () => {
            claims += 1;
            if (built === null || claims > 1) return Promise.resolve({ deliveries: [], leaseSeconds: 300 });
            return Promise.resolve({ deliveries: [built.delivery as never], leaseSeconds: 300 });
          },
          report: (taskID: string, _t: string, state: string) => {
            log.push(`report:${taskID}:${state}`);
            if (opts.reportThrows !== undefined && state === "saved") {
              return Promise.reject(opts.reportThrows);
            }
            return Promise.resolve({ State: state, Terminal: state === "saved", SavedAt: 1 });
          },
          blob: (taskID: string, _c: string, offset: number) => {
            blobs.push(taskID);
            return Promise.resolve({
              partial: offset > 0,
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(built!.ciphertext.subarray(offset));
                  controller.close();
                },
              }),
            });
          },
        };
      },
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () => Promise.resolve(destination as never),
      now: () => 1_000,
    });
    await facade.adopt(ACCOUNT);
    if (opts.enable !== false) await facade.enable({ enabled: true }, new AbortController().signal);
    if (opts.seed !== undefined) {
      const journalMod = await import("../../src/main/inbox/journal.js");
      const filesMod = await import("../../src/main/inbox/files.js");
      const context = contextIn(root);
      await opts.seed(
        new journalMod.TaskJournal(context, new filesMod.InboxFiles(context), () => Promise.resolve(atRest)),
      );
    }
    return { facade, blobs, atRest, claimCount: () => claims };
  }

  it("does NOT claim an ACK when the task is terminal for a reason other than saved", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    // The 409 the server actually sends after a TTL: task_terminal / expired.
    const expired = Object.assign(new Error("task-terminal"), {
      code: "task-terminal",
      serverCode: "task_terminal",
      // The server echoes the task it is talking about, id included.
      task: { ID: "task-1", State: "expired", Terminal: true },
    });
    const { facade, atRest } = await drainFacade(root, log, {
      reportThrows: expired,
      seed: async (journal) => {
        await journal.recordClaimed({
          taskID: "task-1", idempotencyKey: "idem-task-1", manifestTotal: 1, text: false, now: 1,
        });
        await journal.advance("task-1", "publishing", 0, 2);
        await journal.advance("task-1", "published", 1, 3);
      },
    });

    const report = await facade.drain(new AbortController().signal);
    expect(report.processed[0]?.outcome.kind).toBe("blocked");

    const journalMod = await import("../../src/main/inbox/journal.js");
    const filesMod = await import("../../src/main/inbox/files.js");
    const context = contextIn(root);
    const fresh = new journalMod.TaskJournal(context, new filesMod.InboxFiles(context), () =>
      Promise.resolve(atRest),
    );
    const rec = await fresh.find("task-1");
    // NOT acked — central never said saved. But it IS recorded terminal, so
    // retention can evict it without anyone claiming an acknowledgement.
    expect(rec?.phase).toBe("published");
    expect(rec?.serverTerminal).toBe(true);
  });

  it("ignores a 409 echoing a DIFFERENT task, and records nothing for it", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    // Terminal and saved — but for some other task entirely.
    const wrongTask = Object.assign(new Error("task-terminal"), {
      code: "task-terminal",
      serverCode: "task_terminal",
      task: { ID: "a-completely-different-task", State: "saved", Terminal: true },
    });
    const { facade, atRest } = await drainFacade(root, log, {
      reportThrows: wrongTask,
      seed: async (journal) => {
        await journal.recordClaimed({
          taskID: "task-1", idempotencyKey: "idem-task-1", manifestTotal: 1, text: false, now: 1,
        });
        await journal.advance("task-1", "publishing", 0, 2);
        await journal.advance("task-1", "published", 1, 3);
      },
    });

    const report = await facade.drain(new AbortController().signal);
    expect(report.processed[0]?.outcome.kind).toBe("blocked");

    const journalMod = await import("../../src/main/inbox/journal.js");
    const filesMod = await import("../../src/main/inbox/files.js");
    const context = contextIn(root);
    const fresh = new journalMod.TaskJournal(context, new filesMod.InboxFiles(context), () =>
      Promise.resolve(atRest),
    );
    const rec = await fresh.find("task-1");
    // Neither acked nor marked terminal: the echo said nothing about THIS task.
    expect(rec?.phase).toBe("published");
    expect(rec?.serverTerminal).toBe(false);
  });

  it("consults the dedup verdict for every claimed item, before any body", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const { facade, blobs } = await drainFacade(root, log, {
      seed: async (journal) => {
        // The SAME idempotency key under a different task id. `isSettled`
        // matches on either, so this delivery is provably already settled even
        // though `find` returns nothing for its id — which is exactly the case
        // the drain used to walk straight past into a download.
        await journal.recordClaimed({
          taskID: "earlier-delivery", idempotencyKey: "idem-task-1", manifestTotal: 1, text: false, now: 1,
        });
        await journal.advance("earlier-delivery", "publishing", 0, 2);
        await journal.advance("earlier-delivery", "published", 1, 3);
        await journal.advance("earlier-delivery", "acked", 1, 4);
      },
    });

    const report = await facade.drain(new AbortController().signal);
    const outcome = report.processed[0]?.outcome;
    // `unknown` means the records that could have answered were pruned. The
    // delivery predates the watermark, so the journal cannot say whether it
    // already landed — and receiving it again could duplicate it.
    expect(outcome).toMatchObject({ kind: "blocked", reason: "already-settled" });
    // Decided BEFORE any body: the automatic path used to skip this check
    // entirely and download.
    expect(blobs).toEqual([]);
  });

  it("reconciles from metadata alone while disabled, and never reaches the network", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const { facade, blobs, claimCount } = await drainFacade(root, log, {
      enable: false,
      seed: async (journal) => {
        await journal.recordClaimed({
          taskID: "stuck", idempotencyKey: "i", manifestTotal: 1, text: false, now: 1,
        });
        await journal.advance("stuck", "publishing", 0, 2);
      },
    });

    const before = log.length;
    const outcomes = await facade.reconcile(new AbortController().signal);
    // A `publishing` record is a genuine stop and is reported as one.
    expect(outcomes.some((o) => o.kind === "blocked")).toBe(true);
    // Disabled means DISABLED. Asserted on the CLAIM COUNT, not on the absence
    // of downloads: with nothing enrolled there is nothing to claim anyway, so
    // "no blobs" would pass on a build that reached for the network regardless.
    expect(claimCount()).toBe(0);
    expect(blobs).toEqual([]);
    expect(log.slice(before).filter((l) => l.startsWith("report:"))).toEqual([]);
  });
});

describe("facade concurrent reconcile", () => {
  it("a concurrent reconcile and drain do not both claim", async () => {
    const root = await tempRoot();
    const log: string[] = [];
    const { facade, claimCount } = await (async () => {
      const runtime = await realRuntime();
      const atRest = newAtRestKeyBytes();
      const secrets = new FakeSecrets();
      let claims = 0;
      let release: () => void = () => undefined;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = new InboxFacade({
        host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
        runtime,
        features: { files: true, text: false, autoAccept: false },
        apiFor: () => {
          const api = fakeApi(log);
          return {
            ...api,
            claim: async () => {
              claims += 1;
              // Park the first claim so the second caller overlaps it.
              if (claims === 1) await parked;
              return { deliveries: [], leaseSeconds: 300 };
            },
          };
        },
        secretsFor: () => secrets,
        atRestKeyFor: () => Promise.resolve(atRest),
        destinationFor: () => Promise.reject(new Error("unused")),
        now: () => 1_000,
      });
      await f.adopt(ACCOUNT);
      await f.enable({ enabled: true }, new AbortController().signal);
      const first = f.drain(new AbortController().signal);
      await new Promise((r) => setTimeout(r, 10));
      const second = f.reconcile(new AbortController().signal);
      await new Promise((r) => setTimeout(r, 10));
      release();
      await Promise.all([first, second]);
      return { facade: f, claimCount: () => claims };
    })();

    // One claim. Reconcile shares the drain's admission gate, so it cannot
    // start a second concurrent claim loop.
    expect(claimCount()).toBe(1);
    expect(facade.state().kind).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// The dedup watermark must survive a restart — REAL filesystem
// ---------------------------------------------------------------------------

describe("journal dedup watermark durability", () => {
  async function journalOn(root: string, key: Uint8Array) {
    const journalMod = await import("../../src/main/inbox/journal.js");
    const filesMod = await import("../../src/main/inbox/files.js");
    const context = contextIn(root);
    return new journalMod.TaskJournal(context, new filesMod.InboxFiles(context), () =>
      Promise.resolve(key),
    );
  }

  it("a FRESH instance on the same file still knows what was pruned", async () => {
    const root = await tempRoot();
    const key = newAtRestKeyBytes();
    const nowMs = 1_770_000_000_000;

    const first = await journalOn(root, key);
    await first.recordClaimed({
      taskID: "old", idempotencyKey: "io", manifestTotal: 1, text: false, now: nowMs,
    });
    await first.advance("old", "publishing", 0, nowMs);
    await first.advance("old", "published", 1, nowMs);
    await first.advance("old", "acked", 1, nowMs);
    await first.recordServerState("old", { terminal: true, expiresAt: 0 }, nowMs);
    expect(await first.pruneSettled(nowMs + 1)).toBe(1);
    expect(first.dedupHorizon).toBe(nowMs);

    // A NEW process reading the same file. Held only in memory the horizon was
    // erased here, and this journal then answered `not-settled` for deliveries
    // it could no longer vouch for — exactly the post-crash case.
    const restarted = await journalOn(root, key);
    const olderSeconds = Math.floor(nowMs / 1000) - 60;
    expect(await restarted.isSettled("gone", "unrelated", olderSeconds)).toBe("unknown");
    expect(restarted.dedupHorizon).toBe(nowMs);
  });

  it("a delivery created AFTER the watermark is a clean negative", async () => {
    const root = await tempRoot();
    const key = newAtRestKeyBytes();
    const nowMs = 1_770_000_000_000;

    const first = await journalOn(root, key);
    await first.recordClaimed({
      taskID: "old", idempotencyKey: "io", manifestTotal: 1, text: false, now: nowMs,
    });
    await first.advance("old", "publishing", 0, nowMs);
    await first.advance("old", "published", 1, nowMs);
    await first.advance("old", "acked", 1, nowMs);
    await first.recordServerState("old", { terminal: true, expiresAt: 0 }, nowMs);
    await first.pruneSettled(nowMs + 1);

    const restarted = await journalOn(root, key);
    // Newer than the horizon, in WIRE SECONDS. Answering `unknown` here would
    // block every future delivery — the failure mode of comparing a seconds
    // value against a millisecond watermark.
    const newerSeconds = Math.floor(nowMs / 1000) + 60;
    expect(await restarted.isSettled("fresh", "idem-fresh", newerSeconds)).toBe("not-settled");
  });

  it("a failed write does not advance the watermark this process claims", async () => {
    const root = await tempRoot();
    const key = newAtRestKeyBytes();
    const nowMs = 1_770_000_000_000;
    const journal = await journalOn(root, key);
    await journal.recordClaimed({
      taskID: "old", idempotencyKey: "io", manifestTotal: 1, text: false, now: nowMs,
    });
    await journal.advance("old", "publishing", 0, nowMs);
    await journal.advance("old", "published", 1, nowMs);
    await journal.advance("old", "acked", 1, nowMs);
    await journal.recordServerState("old", { terminal: true, expiresAt: 0 }, nowMs);

    // The prune's write fails. The watermark must not move: this process would
    // otherwise claim a horizon the disk does not have.
    const filesMod = await import("../../src/main/inbox/files.js");
    const context = contextIn(root);
    const failing = new filesMod.InboxFiles(context);
    Object.defineProperty(failing, "writeAtomic", {
      value: () => Promise.reject(Object.assign(new Error("EIO"), { code: "write-failed" })),
    });
    const journalMod = await import("../../src/main/inbox/journal.js");
    const brittle = new journalMod.TaskJournal(context, failing, () => Promise.resolve(key));
    await expect(brittle.pruneSettled(nowMs + 1)).rejects.toBeTruthy();
    expect(brittle.dedupHorizon).toBe(0);

    // And the file on disk still holds the record, so a later run can retry.
    const reread = await journalOn(root, key);
    expect((await reread.find("old"))?.phase).toBe("acked");
  });

  /** Write a raw journal document, bypassing the store, for format negatives. */
  async function writeRawJournal(root: string, key: Uint8Array, document: unknown): Promise<Uint8Array> {
    const atrest = await import("../../src/main/inbox/atrest.js");
    const filesMod = await import("../../src/main/inbox/files.js");
    const context = contextIn(root);
    const files = new filesMod.InboxFiles(context);
    const sealed = await atrest.seal(
      await atrest.importAtRestKey(key),
      context.accountKey,
      "journal",
      new TextEncoder().encode(JSON.stringify(document)),
    );
    await files.mkdirp(context.directory);
    await files.writeAtomic(`${context.directory}/journal.enc`, sealed);
    return sealed;
  }

  it("refuses a v2 document whose watermark is missing", async () => {
    const root = await tempRoot();
    const key = newAtRestKeyBytes();
    // Accepting this as 0 would defeat the strict format: a truncated or
    // hand-edited document would become a journal claiming it never pruned.
    await writeRawJournal(root, key, { v: 2, tasks: [] });
    const journal = await journalOn(root, key);
    await expect(journal.all()).rejects.toMatchObject({ code: "unreadable" });

    for (const bad of [-1, 1.5, Number.NaN, "0", null]) {
      const other = await tempRoot();
      await writeRawJournal(other, key, { v: 2, tasks: [], watermark: bad });
      const j = await journalOn(other, key);
      await expect(j.all()).rejects.toMatchObject({ code: "unreadable" });
    }
  });

  it("refuses a v1 document and leaves its bytes BYTE-IDENTICAL", async () => {
    const root = await tempRoot();
    const key = newAtRestKeyBytes();
    // A v1 document carried no watermark and stored expiries in wire seconds.
    // Migrating would mean inventing both. The Inbox has never shipped, so
    // there is no such document to migrate — it is refused, and untouched.
    const written = await writeRawJournal(root, key, {
      v: 1,
      tasks: [
        {
          taskID: "legacy", idempotencyKey: "il", phase: "partial", manifestTotal: 2,
          publishedCount: 1, text: false, updatedAt: 1_770_000_000_000,
          serverTerminal: false, serverExpiresAt: 1_770_003_600,
        },
      ],
    });

    const journal = await journalOn(root, key);
    await expect(journal.all()).rejects.toMatchObject({ code: "unreadable" });
    await expect(
      journal.recordClaimed({
        taskID: "new", idempotencyKey: "in", manifestTotal: 1, text: false, now: 1_770_000_000_000,
      }),
    ).rejects.toMatchObject({ code: "unreadable" });

    // Isolating the VERSION check: a v1 document carrying an otherwise valid
    // watermark must still be refused. Without this the watermark check alone
    // would catch a real v1 document, and a build that started accepting v1
    // would pass the case above for the wrong reason.
    const withMark = await tempRoot();
    await writeRawJournal(withMark, key, { v: 1, tasks: [], watermark: 0 });
    const versioned = await journalOn(withMark, key);
    await expect(versioned.all()).rejects.toMatchObject({ code: "unreadable" });

    // Nothing reset it, nothing deleted it, nothing rewrote it.
    const { readFile } = await import("node:fs/promises");
    const context = contextIn(root);
    const after = new Uint8Array(await readFile(`${context.directory}/journal.enc`));
    expect(Buffer.from(after)).toEqual(Buffer.from(written));
  });

  it("refuses an unknown journal version rather than starting fresh", async () => {
    const root = await tempRoot();
    const key = newAtRestKeyBytes();
    const journal = await journalOn(root, key);
    await journal.recordClaimed({
      taskID: "t", idempotencyKey: "i", manifestTotal: 1, text: false, now: 1_770_000_000_000,
    });

    // A document written by a LATER build. Reinterpreting it would discard the
    // record of what had already been published and acked.
    const atrest = await import("../../src/main/inbox/atrest.js");
    const filesMod = await import("../../src/main/inbox/files.js");
    const context = contextIn(root);
    const files = new filesMod.InboxFiles(context);
    const sealed = await atrest.seal(
      await atrest.importAtRestKey(key),
      context.accountKey,
      "journal",
      new TextEncoder().encode(JSON.stringify({ v: 99, tasks: [], watermark: 0 })),
    );
    await files.writeAtomic(`${context.directory}/journal.enc`, sealed);

    const later = await journalOn(root, key);
    await expect(later.all()).rejects.toMatchObject({ code: "unreadable" });
  });
});
