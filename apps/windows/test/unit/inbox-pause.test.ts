// The user's own pause: what it stops, what it must not touch, and when it ends.
//
// SCOPE: fakes for the network, the REAL built runtime bundle, the REAL facade
// and a REAL temp directory. The facade cases drive `drain` and `accept`
// through the real drain loop and count what reached the network, so "no claim
// happened" is a fact about the wire rather than about a flag.
//
// ## Three different stops, and only one of them is here
//
// `grant.policy` is the user's stored answer and central is told about it.
// `#fenced` is the quit fence, cleared by `resume()` when the user stays. The
// user pause is neither: it stops new claims while writing nothing, announcing
// nothing, and cancelling nothing already in flight. Several cases below exist
// only to hold that line.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InboxFacade, type FacadeApi } from "../../src/main/inbox/facade.js";
import {
  InboxService,
  type InboxAuthority,
  type InboxServiceDeps,
} from "../../src/main/features/inbox.js";
import { inboxRuntime, resetInboxRuntimeForTest } from "../../src/main/inbox/runtime.js";
import type { InboxRuntime } from "../../src/main/inbox/runtime-contract.js";
import { newAtRestKeyBytes } from "../../src/main/inbox/atrest.js";
import { grantSlotFor } from "../../src/main/features/inbox-grant.js";
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
  const root = await mkdtemp(join(tmpdir(), "inbox-pause-"));
  roots.push(root);
  return root;
}

const ACCOUNT = { accountID: "person@example.invalid", deviceID: "dev-1", epoch: 1 };

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
}

interface Wire {
  claims: number;
  accepts: string[];
  enrols: number;
  deletes: number;
  heartbeats: number;
}

/**
 * An api that counts what reached the network.
 *
 * `claim` answers with nothing, which is enough for these cases: what is being
 * asserted is whether the claim was MADE, and a delivery would drag a
 * destination and a body into a question that is not about either.
 */
function countingApi(wire: Wire, deliveriesPerClaim: () => unknown[] = () => []): FacadeApi {
  return {
    enrol: () => {
      wire.enrols += 1;
      return Promise.resolve({
        protocolVersion: 3,
        receiveCapability: "inbox.receive.v3",
        keyAlgorithm: "x25519",
      });
    },
    heartbeat: () => {
      wire.heartbeats += 1;
      return Promise.resolve({ presence: "online", intervalSeconds: 30 });
    },
    deleteInbox: () => {
      wire.deletes += 1;
      return Promise.resolve();
    },
    registerKey: () => Promise.resolve({ ID: "key-1" }),
    listKeys: () => Promise.resolve([]),
    pending: () => Promise.resolve({ tasks: [], leaseSeconds: 300, heartbeatIntervalSecs: 30 }),
    accept: (taskID: string) => {
      wire.accepts.push(taskID);
      return Promise.resolve({});
    },
    claim: () => {
      wire.claims += 1;
      return Promise.resolve({
        deliveries: deliveriesPerClaim() as never,
        leaseSeconds: 300,
      });
    },
    report: (_t: string, _c: string, state: string) =>
      Promise.resolve({ State: state, Terminal: true, SavedAt: 1 }),
    currentDevice: () => Promise.resolve({ ID: "dev-1", Name: "PC" }),
    blob: () => Promise.reject(new Error("not used")),
    renameDevice: (name: string) => Promise.resolve(name),
  } as unknown as FacadeApi;
}

/** A facade whose claim gate this test drives. */
async function facadeWith(
  root: string,
  wire: Wire,
  mayClaim: () => boolean,
  deliveries: () => unknown[] = () => [],
): Promise<InboxFacade> {
  const runtime = await realRuntime();
  const atRest = newAtRestKeyBytes();
  const secrets = new FakeSecrets();
  const facade = new InboxFacade({
    host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
    runtime,
    features: { files: true, text: false, autoAccept: false },
    apiFor: () => countingApi(wire, deliveries),
    secretsFor: () => secrets,
    atRestKeyFor: () => Promise.resolve(atRest),
    destinationFor: () => Promise.reject(new Error("no destination in these tests")),
    mayClaim,
    now: () => 1_000,
  });
  await facade.adopt(ACCOUNT);
  await facade.enable({ enabled: true }, new AbortController().signal);
  return facade;
}

const newWire = (): Wire => ({ claims: 0, accepts: [], enrols: 0, deletes: 0, heartbeats: 0 });

/** Wait for something the loop produces, rather than sleeping for it. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("the claim gate", () => {
  it("claims when the user has not paused", async () => {
    const wire = newWire();
    const facade = await facadeWith(await tempRoot(), wire, () => true);
    await facade.drain(new AbortController().signal);
    expect(wire.claims).toBe(1);
  });

  it("makes NO claim while the user is paused", async () => {
    const wire = newWire();
    // Deliveries waiting, deliberately: an empty queue would let a broken gate
    // look correct, because the loop stops after one empty answer either way.
    const facade = await facadeWith(await tempRoot(), wire, () => false, () => [
      { ID: "waiting", IdempotencyKey: "k", CreatedAt: 1 },
    ]);
    await facade.drain(new AbortController().signal);
    // Not "claimed and discarded" — the request never reached the network.
    expect(wire.claims).toBe(0);
  });

  it("is asked between items, not once before the batch", async () => {
    const wire = newWire();
    let paused = false;
    const root = await tempRoot();
    // Each claim answers with one delivery, so the loop would keep going. The
    // pause lands after the FIRST claim, which is the case a check outside the
    // drain cannot catch: the batch is already running.
    const facade = await facadeWith(root, wire, () => !paused, () => {
      if (wire.claims >= 1) paused = true;
      return [{ ID: `task-${String(wire.claims)}`, IdempotencyKey: "k", CreatedAt: 1 }];
    });
    await facade.drain(new AbortController().signal);
    // Exactly one. A gate consulted only at the top would have claimed the
    // whole batch.
    expect(wire.claims).toBe(1);
  });

  it("records a manual Accept while paused WITHOUT claiming anything", async () => {
    const wire = newWire();
    // Central always has more to hand back. This is the shape that matters: an
    // ungated accept-drain would take these one after another looking for the
    // named task, which is the whole queue restarting off one button.
    const facade = await facadeWith(await tempRoot(), wire, () => false, () => [
      { ID: "someone-elses-task", IdempotencyKey: "k", CreatedAt: 1 },
    ]);

    const outcome = await facade.accept(
      { taskID: "task-1", idempotencyKey: "k", createdAt: 1 },
      new AbortController().signal,
    );

    // The consent IS recorded — the user asked for this delivery and central is
    // told so, which costs no claim.
    expect(wire.accepts).toEqual(["task-1"]);
    // And nothing was taken. Not "one", not "only the right one": `claim` has
    // no task id, so any claim at all is a claim of whatever central chose.
    expect(wire.claims).toBe(0);
    // Reported truthfully rather than as a receipt it never got.
    expect(outcome.kind).toBe("queued");
  });

  it("claims for a manual Accept once the user is no longer paused", async () => {
    const wire = newWire();
    let paused = true;
    const facade = await facadeWith(await tempRoot(), wire, () => !paused);
    paused = false;
    await facade.accept(
      { taskID: "task-1", idempotencyKey: "k", createdAt: 1 },
      new AbortController().signal,
    ).catch(() => undefined);
    // Unpaused, an Accept behaves exactly as it did before this change.
    expect(wire.claims).toBe(1);
  });

  it("withdraws nothing from central and writes no policy", async () => {
    const wire = newWire();
    const facade = await facadeWith(await tempRoot(), wire, () => false);
    await facade.drain(new AbortController().signal);
    // A pause is not a disable. The enrolment stands, and central is told
    // nothing — the device stays reachable and simply takes nothing right now.
    expect(wire.deletes).toBe(0);
    expect(facade.state().kind).not.toBe("disabled");
  });

  it("leaves every existing caller unchanged when no gate is supplied", async () => {
    const wire = newWire();
    const runtime = await realRuntime();
    const root = await tempRoot();
    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () => countingApi(wire),
      secretsFor: () => new FakeSecrets(),
      atRestKeyFor: () => Promise.resolve(newAtRestKeyBytes()),
      destinationFor: () => Promise.reject(new Error("no destination in these tests")),
      now: () => 1_000,
    });
    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);
    await facade.drain(new AbortController().signal);
    // `mayClaim` absent means every claim is allowed.
    expect(wire.claims).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The verbs, on the real service
// ---------------------------------------------------------------------------

const services: InboxService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
});

/**
 * A service with every backoff set to an hour, so nothing fires on its own.
 *
 * The pause cases are about state and boundaries rather than about scheduling,
 * so the loop is deliberately inert here: what is asserted is what the verbs
 * did to the service, and what a network fake was NOT asked for.
 */
async function serviceIn(
  root: string,
  wire: Wire,
  reuse?: Map<string, string>,
  over: { enabled?: boolean; heartbeatHold?: () => Promise<void> | null } = {},
) {
  const runtime = await realRuntime();
  const secrets = reuse ?? new Map<string, string>();
  if (over.enabled === true) {
    // The same derivation the service performs, so a preset grant lands where
    // it will look: sha256(deviceID) truncated.
    const { createHash } = await import("node:crypto");
    const accountKey = createHash("sha256").update("dev-1", "utf8").digest("hex").slice(0, 32);
    secrets.set(
      grantSlotFor(accountKey),
      JSON.stringify({ v: 2, directory: `${root}/chosen`, enabled: true, policy: "ask", withdrawalPending: false }),
    );
  }
  const slot = {
    async get(key: string) {
      const value = secrets.get(key);
      if (value === undefined) throw Object.assign(new Error("not-found"), { code: "not-found" });
      return value;
    },
    async put(key: string, value: string) {
      secrets.set(key, value);
    },
    async delete(key: string) {
      secrets.delete(key);
    },
    async putIfAbsent(key: string, value: string) {
      const existing = secrets.get(key);
      if (existing !== undefined) return { created: false, value: existing };
      secrets.set(key, value);
      return { created: true, value };
    },
  };
  const state = {
    authority: { kind: "ok", bearer: "bearer", epoch: 1 } as InboxAuthority,
    epoch: 1,
    document: 1,
  };
  const deps: InboxServiceDeps = {
    origin: "https://relayium.com",
    dataRoot: () => root,
    platform: "windows",
    appVersion: "0.0.1",
    authority: async () => state.authority,
    accountEpoch: () => state.epoch,
    currentDocument: () => state.document,
    grantSlot: async () => slot,
    keySlot: async () => slot,
    pickDirectory: async () => `${root}/chosen`,
    runtime: async () => runtime,
    makeApi: () =>
      ({
        ...countingApi(wire),
        // Holdable, so a test can stand inside the pass — between the point the
        // account is bound and the point a claim would be made.
        heartbeat: async () => {
          wire.heartbeats += 1;
          const held = over.heartbeatHold?.();
          if (held) await held;
          return { presence: "online", intervalSeconds: 30 };
        },
      }) as never,
    resolveDevice: async () => ({ id: "dev-1", name: "A PC" }),
    directoryUsable: async () => true,
    makeDestination: async () => ({
      fileCount: 0,
      assertAuthority() {},
      async begin() {},
      async write() {},
      async finish() {},
      async publish() {
        return { status: "complete", publishedCount: 0, total: 0 } as const;
      },
      async cancel() {},
    }),
    backoff: { idle: 3600, afterWork: 3600, first: 3600, cap: 3600, blocked: 3600 },
    reportFailure: () => undefined,
  } as unknown as InboxServiceDeps;
  const service = new InboxService(deps);
  services.push(service);
  return {
    service,
    state,
    secrets,
    pauseReceiving: () => service.pauseReceiving(),
  };
}

describe("the service threads the gate into the facade", () => {
  it("a pause taken mid-pass stops the claim that pass was heading for", async () => {
    const wire = newWire();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holdOnce = true;
    const { service } = await serviceIn(await tempRoot(), wire, undefined, {
      enabled: true,
      heartbeatHold: () => {
        if (!holdOnce) return null;
        holdOnce = false;
        return held;
      },
    });

    service.start();
    // Parked inside the pass, past the account and the consent, before a claim.
    await waitFor("the pass to reach the heartbeat", () => wire.heartbeats >= 1);
    expect(wire.claims).toBe(0);

    // The user pauses while the pass is in flight. Nothing is cancelled.
    service.pauseReceiving();
    release!();

    // The pass runs on and reaches the gate the SERVICE supplied to the FACADE.
    // If that wiring were missing, the drain would claim here.
    await waitFor("the pass to finish", () => service.view().status.kind !== "starting", 4000)
      .catch(() => undefined);
    expect(wire.claims).toBe(0);
  });

  it("resuming wakes the loop and the claim happens", async () => {
    const wire = newWire();
    const { service } = await serviceIn(await tempRoot(), wire, undefined, { enabled: true });
    service.start();
    service.pauseReceiving();
    await waitFor("a pass to complete while paused", () => wire.heartbeats >= 1);
    expect(wire.claims).toBe(0);

    // Every backoff is an hour, so nothing would fire on its own: a claim after
    // this can only be the wake `resumeReceiving` performs.
    service.resumeReceiving();
    // The budget here is about the RUNNER, not the product. The wake is
    // immediate — `resumeReceiving` performs it, and every backoff is an hour,
    // so nothing else could produce a claim — but this file runs in a parallel
    // vitest worker, and a loaded Windows runner can stall one for seconds.
    // Hosted run 34671774469 failed this at 4185ms against the 4000ms default.
    //
    // TWO clocks, and the first attempt only moved one. Raising this budget
    // without raising vitest's per-test timeout (5000ms) meant the case stopped
    // failing on its own budget and started failing on vitest's, with "Test
    // timed out in 5000ms" instead of a message naming the wake — the flake
    // unfixed and the diagnostic worse. Run 34676037986 said so twice. The
    // inner budget is deliberately BELOW the outer one so this assertion is
    // the one that reports.
    //
    // Raising them cannot hide a product regression: a wake that never happens
    // still fails, just later.
    await waitFor("the claim after resume", () => wire.claims >= 1, 20_000);
    expect(wire.claims).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe("pauseReceiving and resumeReceiving", () => {
  it("start unpaused, and report the state truthfully", async () => {
    const { service } = await serviceIn(await tempRoot(), newWire());
    expect(service.receivingPaused).toBe(false);
    service.pauseReceiving();
    expect(service.receivingPaused).toBe(true);
    service.resumeReceiving();
    expect(service.receivingPaused).toBe(false);
  });

  it("are idempotent", async () => {
    const { service } = await serviceIn(await tempRoot(), newWire());
    service.pauseReceiving();
    service.pauseReceiving();
    expect(service.receivingPaused).toBe(true);
    service.resumeReceiving();
    service.resumeReceiving();
    expect(service.receivingPaused).toBe(false);
  });

  it("survive a quit prompt the user answered with Stay", async () => {
    const { service } = await serviceIn(await tempRoot(), newWire());
    service.pauseReceiving();
    // `fence` and `resume` are the QUIT pair. Staying puts the app back to
    // work; it does not answer a question about receiving that the user
    // answered separately, and unpausing here would silently undo them.
    service.fence();
    service.resume();
    expect(service.receivingPaused).toBe(true);
  });

  it("write no policy and ask the network for nothing", async () => {
    const wire = newWire();
    const { service, secrets } = await serviceIn(await tempRoot(), wire);
    const before = new Map(secrets);
    service.pauseReceiving();
    service.resumeReceiving();
    // Not a stored answer, not an announcement, not a withdrawal: the user's
    // consent, their enrolment and their folder are exactly as they left them.
    expect([...secrets.entries()]).toEqual([...before.entries()]);
    expect(wire.deletes).toBe(0);
    expect(wire.enrols).toBe(0);
  });

  it("is cleared when the account is replaced", async () => {
    const { service, state } = await serviceIn(await tempRoot(), newWire());
    service.start();
    // Bound is the precondition: the reset happens where the binding is
    // released, so a service that never bound would prove nothing here.
    await waitFor("the account to bind", () => service.view().deviceName !== "");

    service.pauseReceiving();
    expect(service.receivingPaused).toBe(true);

    // A sign-out hands the app to somebody else. Carrying a decision the next
    // account never made — with no control yet to undo it — would leave them
    // receiving nothing for a reason they cannot see.
    state.authority = { kind: "signed-out" } as InboxAuthority;
    state.epoch = 2;
    service.onAuthorityChanged();
    await waitFor("the binding to be released", () => service.view().deviceName === "");

    expect(service.receivingPaused).toBe(false);
  });

  it("a same-account refresh leaves it alone", async () => {
    const { service } = await serviceIn(await tempRoot(), newWire());
    service.start();
    await waitFor("the account to bind", () => service.view().deviceName !== "");
    service.pauseReceiving();

    // The epoch has NOT moved, which is what `onAuthorityChanged` compares. It
    // is the same account being looked at again, and nothing about the user's
    // intent has changed.
    service.onAuthorityChanged();
    expect(service.receivingPaused).toBe(true);
  });

  it("a DOCUMENT replacement leaves it alone", async () => {
    const { service, state } = await serviceIn(await tempRoot(), newWire());
    service.start();
    await waitFor("the account to bind", () => service.view().deviceName !== "");
    service.pauseReceiving();

    // A reload. The document really does advance while the account epoch does
    // not — the distinction the resident invariant is built on — and the
    // previous version of this case never moved it, so it proved only the
    // refresh above.
    state.document += 1;
    service.onAuthorityChanged();
    expect(service.receivingPaused).toBe(true);
  });

  it("is never written down, and a NEW service over the same stores is unpaused", async () => {
    const root = await tempRoot();
    const first = await serviceIn(root, newWire());
    const before = new Set(first.secrets.keys());
    first.pauseReceiving();
    // Nothing was stored.
    expect([...first.secrets.keys()].filter((key) => !before.has(key))).toEqual([]);
    for (const value of first.secrets.values()) expect(value).not.toContain("paus");

    // And the part the absence of a key does not prove on its own: a second
    // service over the SAME root and the SAME secret store — which is what a
    // restart is — has nothing to read and starts receiving.
    const second = await serviceIn(root, newWire(), first.secrets);
    expect(second.service.receivingPaused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A real delivery, finishing while the pause stops the next one
// ---------------------------------------------------------------------------

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
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, storeKey, payload));
  const ciphertext = new Uint8Array(4 + ct.byteLength);
  new DataView(ciphertext.buffer).setUint32(0, ct.byteLength);
  ciphertext.set(ct, 4);

  return {
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
      WrappedKey: await runtime.sealContentKey(
        contentKey,
        runtime.constants.keyAlgorithm,
        recipientPublicKey,
      ),
      ClaimToken: `claim-${id}`,
    },
  };
}

describe("a delivery already claimed", () => {
  it("finishes and publishes while the pause stops the NEXT claim", async () => {
    const wire = newWire();
    const root = await tempRoot();
    const runtime = await realRuntime();
    const atRest = newAtRestKeyBytes();
    const secrets = new FakeSecrets();

    let paused = false;
    let built: Awaited<ReturnType<typeof oneDelivery>> | null = null;
    const published: number[] = [];

    const facade = new InboxFacade({
      host: { dataRoot: root, platform: "windows", appVersion: "0.0.1" },
      runtime,
      features: { files: true, text: false, autoAccept: false },
      apiFor: () =>
        ({
          ...countingApi(wire),
          registerKey: async (_algorithm: string, publicKey: string) => {
            // The delivery cannot exist until the device has registered the key
            // its content key is sealed to.
            built = await oneDelivery(runtime, "task-1", publicKey);
            return { ID: "key-1" };
          },
          claim: async () => {
            wire.claims += 1;
            if (built === null) return { deliveries: [], leaseSeconds: 300 };
            // The user pauses the moment the first delivery is in hand. From
            // here the drain must finish THIS one and claim nothing further.
            paused = true;
            return { deliveries: [built.delivery as never], leaseSeconds: 300 };
          },
          blob: async (_t: string, _c: string, offset: number) => ({
            partial: offset > 0,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(built!.ciphertext.subarray(offset));
                controller.close();
              },
            }),
          }),
        }) as never,
      secretsFor: () => secrets,
      atRestKeyFor: () => Promise.resolve(atRest),
      destinationFor: () =>
        Promise.resolve({
          fileCount: 1,
          assertAuthority() {},
          async begin() {},
          async write() {},
          async finish() {},
          async publish() {
            published.push(1);
            return { status: "complete", publishedCount: 1, total: 1 } as const;
          },
          async cancel() {},
        } as never),
      mayClaim: () => !paused,
      now: () => 1_000,
    });
    await facade.adopt(ACCOUNT);
    await facade.enable({ enabled: true }, new AbortController().signal);

    const report = await facade.drain(new AbortController().signal);

    // The delivery that was already claimed ran to completion: real ciphertext,
    // real manifest, a real publish. A pause is a refusal to admit MORE, and
    // cancelling what is already in hand would lose a transfer the user can see.
    expect(published).toEqual([1]);
    expect(report.processed).toHaveLength(1);
    expect(report.processed[0]).toMatchObject({ taskID: "task-1", outcome: { kind: "received" } });
    // And nothing further was taken, though the api would have answered again.
    expect(wire.claims).toBe(1);

    await facade.shutdown();
  });
});
