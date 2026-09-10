import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseReceiveAdapter } from "../../src/main/net/native-receive-adapter.js";
import { ReceiveLease } from "../../src/main/io/receive-lease.js";
import { AppService, type AppServiceDeps } from "../../src/main/app-service.js";
import { BEARER_KEY } from "../../src/main/account/device-auth.js";
import { SecretStore, SecretStoreError, type SecretCipher } from "../../src/main/secrets.js";

const ORIGIN = "https://relayium.com";
const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);
const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.concat([MAGIC, Buffer.from(p, "utf8").map((b) => b ^ 0x5a)]),
  decrypt: (c) => {
    if (!c.subarray(0, 4).equals(MAGIC)) throw new Error("foreign");
    return Buffer.from(c.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
  },
};

/** A deferred, so a test can hold a response open across another operation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fresh attempt name per call. Nonces are single-use in `AppService`. */
let nonceSeq = 0;
const nextNonce = (): string => `nonce-${++nonceSeq}`;

let dir = "";
let root = "";
let storesBuilt = 0;

interface Harness {
  service: AppService;
  store: SecretStore;
  pickDirectory: () => Promise<string | null>;
}

/**
 * The PORTABLE staging destination, injected explicitly on every platform.
 *
 * These tests assert `ReceiveLease` staging lifecycle — a real staging
 * directory under the chosen root, a real handle, and a publication that
 * refuses truthfully as `unsupported`. Left to the default, `openDestination`
 * chooses by platform: on Windows it opens the packaged native helper, which in
 * a Vitest run has no packaged layout to resolve and fails with
 * `NativeHelperError`. That is the SHIPPING behaviour and must not be softened;
 * what was wrong was a test asking for portable semantics and not saying so.
 *
 * Stated here rather than mocked: no `process.platform` is touched, the
 * production default is untouched, and the Windows native path keeps its own
 * tests.
 */
const portableDestination: NonNullable<AppServiceDeps["makeDestination"]> = async (options) =>
  new LeaseReceiveAdapter(await ReceiveLease.open(options));

function harness(over: Partial<AppServiceDeps> = {}): Harness {
  const store = new SecretStore(join(dir, "secrets"), cipher);
  const deps: AppServiceDeps = {
    origin: ORIGIN,
    async makeStore() {
      storesBuilt += 1;
      // A real await, so two concurrent first calls genuinely overlap.
      await new Promise((r) => setTimeout(r, 5));
      return store;
    },
    makeAuthClient: () =>
      ({
        start: async () => ({
          userCode: "WDJB-MJHT",
          deviceCode: "dc",
          verificationURL: `${ORIGIN}/device`,
          interval: 5,
          expiresIn: 600,
        }),
        poll: async () => ({ status: "ok" as const, accessToken: "tok", accountEmail: "a@b.c" }),
      }) as never,
    pickDirectory: async () => root,
    openApproval: async () => true,
    newId: () => `lease-${Math.random().toString(16).slice(2)}`,
    makeDestination: portableDestination,
    ...over,
  };
  return { service: new AppService(deps), store, pickDirectory: deps.pickDirectory };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relayium-svc-"));
  root = await mkdtemp(join(tmpdir(), "relayium-dest-"));
  storesBuilt = 0;
  nonceSeq = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("initialisation", () => {
  // Caching the RESOLVED value rather than the promise lets two concurrent
  // first calls both see "not initialised", both build a store, and both race
  // to mint an installation identity — two identities for one machine.
  it("initialises once for concurrent first callers", async () => {
    const { service } = harness();
    const results = await Promise.all([
      service.authState(),
      service.authState(),
      service.authState(),
      service.authState(),
    ]);
    expect(storesBuilt).toBe(1);
    for (const r of results) expect(r.store).toBe("ok");
  });

  it("does not cache a failure, so the user can retry", async () => {
    let attempt = 0;
    const { service } = harness({
      async makeStore() {
        attempt += 1;
        if (attempt === 1) throw new Error("data root unavailable");
        return new SecretStore(join(dir, "secrets"), cipher);
      },
    });
    expect((await service.authState()).store).toBe("unreadable");
    expect((await service.authState()).store).toBe("ok");
  });
});

describe("auth state distinguishes its failures", () => {
  it("reports a genuinely absent session as signed out with a healthy store", async () => {
    const { service } = harness();
    expect(await service.authState()).toEqual({ signedIn: false, accountEmail: "", store: "ok" });
  });

  // "No session" and "I cannot open my own storage" are different problems, and
  // only one of them is fixed by signing in again.
  it("reports an unavailable cipher distinctly from being signed out", async () => {
    const unavailable = new SecretStore(join(dir, "secrets"), { ...cipher, isAvailable: () => false });
    const { service } = harness({ makeStore: async () => unavailable });
    expect(await service.authState()).toEqual({
      signedIn: false,
      accountEmail: "",
      store: "unavailable",
    });
  });
});

describe("a response that lands after the world changed", () => {
  // The regression that matters most: a poll held open by the network until
  // after the user signed out must not resurrect that session.
  it("never persists a bearer from a poll that completes after sign-out", async () => {
    const gate = deferred<{ status: "ok"; accessToken: string; accountEmail: string }>();
    const { service, store } = harness({
      makeAuthClient: () =>
        ({
          start: async () => ({
            userCode: "WDJB-MJHT",
            deviceCode: "dc",
            verificationURL: `${ORIGIN}/device`,
            interval: 5,
            expiresIn: 600,
          }),
          poll: () => gate.promise,
        }) as never,
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await service.signOut();
    gate.resolve({ status: "ok", accessToken: "tok", accountEmail: "a@b.c" });

    await expect(polling).rejects.toThrow(/account changed/);
    await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
    expect((await service.authState()).signedIn).toBe(false);
  });

  // The picker is a dialog the user can sit in front of for minutes. Reading the
  // authority after it returns would stamp a lease begun under the old account
  // with the new account's authority.
  it("refuses a lease whose picker returned after a sign-out", async () => {
    const gate = deferred<string | null>();
    const { service } = harness({ pickDirectory: () => gate.promise });

    const opening = service.openReceive([{ name: "a.bin", size: 4 }]);
    await service.signOut();
    gate.resolve(root);

    await expect(opening).rejects.toThrow(/account changed/);
    // And nothing was staged in the folder the user had chosen.
    expect(await readdir(root)).toEqual([]);
    expect(service.openLeaseCount).toBe(0);
  });

  it("cancels in-flight leases when the account changes, leaving no partials", async () => {
    const { service } = harness();
    const opened = await service.openReceive([{ name: "a.bin", size: 1024 }]);
    if ("cancelled" in opened) throw new Error("expected a lease");
    await service.beginFile(opened.leaseId, 0);
    await service.writeChunk(opened.leaseId, 0, new Uint8Array(256));

    await service.signOut();

    expect(await readdir(root)).toEqual([]);
    await expect(service.writeChunk(opened.leaseId, 0, new Uint8Array(1))).rejects.toThrow();
  });
});

describe("dispose", () => {
  it("cancels open leases so a quit leaves nothing staged", async () => {
    const { service } = harness();
    const opened = await service.openReceive([{ name: "a.bin", size: 1024 }]);
    if ("cancelled" in opened) throw new Error("expected a lease");
    await service.beginFile(opened.leaseId, 0);
    await service.writeChunk(opened.leaseId, 0, new Uint8Array(512));

    await service.dispose();

    expect(await readdir(root)).toEqual([]);
    await expect(service.authState()).resolves.toMatchObject({ signedIn: false });
  });

  it("refuses new work once disposed", async () => {
    const { service } = harness();
    await service.dispose();
    await expect(service.openReceive([{ name: "a", size: 1 }])).rejects.toThrow(/disposed/);
  });
});

describe("sign-out", () => {
  it("clears the bearer and keeps the installation identity", async () => {
    const { service, store } = harness();
    const nonce = nextNonce();
    await service.startSignIn(nonce);
    await service.pollSignIn(nonce);
    expect((await service.authState()).signedIn).toBe(true);

    const identity = await store.get("installation-identity");
    await service.signOut();

    await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
    // Cleared with the bearer, signing back in would mint a third device row.
    expect(await store.get("installation-identity")).toBe(identity);
  });
});

// ---------------------------------------------------------------------------
// Sign-in cancellation authority.
//
// The defect these exist for: a renderer `cancel` that cleared its own timers
// and assigned "signed out" while main happily kept the attempt alive, so the
// next poll adopted a bearer for a sign-in the user had abandoned.
//
// Every case below drives a REAL interleaving with entered/release barriers
// rather than a sleep. One discipline runs through all of them: a cancellation
// that is correctly JOINING a held operation is never awaited before that
// operation is released. Awaiting it first would deadlock the test and the
// deadlock would look like the bug.
// ---------------------------------------------------------------------------

/** A clock the test moves, so expiry is driven by time rather than by waiting. */
function clockFrom(start: number) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

/** Entered/release/completed barriers for one held operation. */
function barrier<T>() {
  const entered = deferred<void>();
  const release = deferred<T>();
  return { entered, release };
}

/** Let already-resolved continuations run without advancing real time. */
const settle = async (turns = 3): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

const START_RESPONSE = {
  userCode: "WDJB-MJHT",
  deviceCode: "dc",
  verificationURL: `${ORIGIN}/device`,
  interval: 5,
  expiresIn: 600,
};

const OK_POLL = { status: "ok" as const, accessToken: "tok", accountEmail: "a@b.c" };

/**
 * A store that delegates to a real `SecretStore` but can hold or fail one call.
 *
 * The cast is nominal only: every method really is the real store's, so the
 * encryption, the bounds and the `not-found` semantics under test are the
 * shipped ones rather than a stub's idea of them.
 */
function instrumentedStore(
  store: SecretStore,
  hooks: {
    put?: (key: string, value: string, real: () => Promise<void>) => Promise<void>;
    del?: (key: string, real: () => Promise<void>) => Promise<void>;
    get?: (key: string, real: () => Promise<string>) => Promise<string>;
  },
): SecretStore {
  return {
    get: (key: string) => (hooks.get ? hooks.get(key, () => store.get(key)) : store.get(key)),
    put: (key: string, value: string) =>
      hooks.put ? hooks.put(key, value, () => store.put(key, value)) : store.put(key, value),
    delete: (key: string) => (hooks.del ? hooks.del(key, () => store.delete(key)) : store.delete(key)),
    putIfAbsent: (key: string, value: string) => store.putIfAbsent(key, value),
  } as unknown as SecretStore;
}

describe("sign-in cancellation is main's decision, not the renderer's", () => {
  it("refuses a poll that succeeds after the attempt was cancelled", async () => {
    const held = barrier<typeof OK_POLL>();
    const { service, store } = harness({
      makeAuthClient: () =>
        ({
          start: async () => START_RESPONSE,
          poll: () => {
            held.entered.resolve();
            return held.release.promise;
          },
        }) as never,
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;

    // No adoption transition is queued yet, so this cancel does not join
    // anything and may be awaited before the release.
    const cancelled = await service.cancelSignIn(nonce);
    expect(cancelled.cleanupFailure).toBeNull();
    expect(cancelled.state.signedIn).toBe(false);

    held.release.resolve(OK_POLL);
    await expect(polling).rejects.toThrow(/sign-in cancelled/);
    await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
    expect((await service.authState()).signedIn).toBe(false);
  });

  it("stops an adoption that was cancelled while its lease cleanup was running", async () => {
    const held = barrier<void>();
    const original = ReceiveLease.prototype.cancel;
    // Patched rather than injected: `openReceive` constructs the real lease, and
    // the point is to hold the real teardown the adoption awaits.
    ReceiveLease.prototype.cancel = function patched(this: ReceiveLease): Promise<void> {
      held.entered.resolve();
      return held.release.promise.then(() => original.call(this));
    };
    try {
      const { service, store } = harness({
        makeAuthClient: () =>
          ({ start: async () => START_RESPONSE, poll: async () => OK_POLL }) as never,
      });
      const opened = await service.openReceive([{ name: "a.bin", size: 4 }]);
      if ("cancelled" in opened) throw new Error("expected a lease");

      const nonce = nextNonce();
      await service.startSignIn(nonce);
      const polling = service.pollSignIn(nonce);
      await held.entered.promise;

      // Started, NOT awaited: this cancellation correctly joins the adoption,
      // which is blocked on the barrier below.
      const cancelling = service.cancelSignIn(nonce);
      await settle();
      held.release.resolve();

      await expect(polling).rejects.toThrow(/sign-in cancelled/);
      const result = await cancelling;
      expect(result.cleanupFailure).toBeNull();
      expect(result.state.signedIn).toBe(false);
      await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
    } finally {
      ReceiveLease.prototype.cancel = original;
    }
  });

  it("removes the credential an adoption wrote before it was cancelled", async () => {
    const held = barrier<void>();
    const { service, store } = harness({
      makeAuthClient: () =>
        ({ start: async () => START_RESPONSE, poll: async () => OK_POLL }) as never,
      makeStore: async () =>
        instrumentedStore(new SecretStore(join(dir, "secrets"), cipher), {
          put: async (key, _value, real) => {
            if (key !== BEARER_KEY) return real();
            held.entered.resolve();
            await held.release.promise;
            await real();
          },
        }),
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;

    const cancelling = service.cancelSignIn(nonce);
    await settle();
    held.release.resolve();

    await expect(polling).rejects.toThrow(/sign-in cancelled/);
    const result = await cancelling;
    expect(result.cleanupFailure).toBeNull();
    expect(result.state.signedIn).toBe(false);
    await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
  });

  // The rule this proves: a cancellation that cannot clean up says so. Reporting
  // it as an ordinary cancellation would leave a token on disk behind a message
  // that says there is none.
  it("reports a compensating deletion that failed instead of claiming it cancelled", async () => {
    const held = barrier<void>();
    const { service } = harness({
      makeAuthClient: () =>
        ({ start: async () => START_RESPONSE, poll: async () => OK_POLL }) as never,
      makeStore: async () =>
        instrumentedStore(new SecretStore(join(dir, "secrets"), cipher), {
          put: async (key, _value, real) => {
            if (key !== BEARER_KEY) return real();
            held.entered.resolve();
            await held.release.promise;
            await real();
          },
          del: async (key) => {
            if (key !== BEARER_KEY) throw new Error("unexpected delete");
            throw new Error("disk went away");
          },
        }),
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;

    const cancelling = service.cancelSignIn(nonce);
    await settle();
    held.release.resolve();

    await expect(polling).rejects.toThrow(/could not remove the credential it wrote/);
    const result = await cancelling;
    expect(result.cleanupFailure).toMatch(/could not remove the credential it wrote/);
    // And the report is honest about what is actually on disk.
    expect(result.state.signedIn).toBe(true);
  });

  it("never deletes a stored credential it cannot prove it wrote", async () => {
    const held = barrier<void>();
    let deletes = 0;
    let written = false;
    const { service, store } = harness({
      makeAuthClient: () =>
        ({ start: async () => START_RESPONSE, poll: async () => OK_POLL }) as never,
      makeStore: async () =>
        instrumentedStore(new SecretStore(join(dir, "secrets"), cipher), {
          put: async (key, _value, real) => {
            if (key !== BEARER_KEY) return real();
            held.entered.resolve();
            await held.release.promise;
            await real();
            written = true;
          },
          // Only the compensating read-back lies, so `startSignIn`'s
          // already-signed-in check still sees the genuine empty store.
          get: async (key, real) =>
            key === BEARER_KEY && written ? "someone-elses-token" : real(),
          del: async (key, real) => {
            if (key === BEARER_KEY) deletes += 1;
            return real();
          },
        }),
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;
    const cancelling = service.cancelSignIn(nonce);
    await settle();
    held.release.resolve();

    await expect(polling).rejects.toThrow(/different stored credential/);
    expect((await cancelling).cleanupFailure).toMatch(/different stored credential/);
    expect(deletes).toBe(0);
    // The real store still holds what the adoption actually put there.
    expect(await store.get(BEARER_KEY)).toBe(OK_POLL.accessToken);
  });

  it("does not sign out an account that is already signed in", async () => {
    const { service, store } = harness();
    const first = nextNonce();
    await service.startSignIn(first);
    await service.pollSignIn(first);
    expect((await service.authState()).signedIn).toBe(true);

    // A stale Cancel arriving from a renderer that raced its own state.
    const result = await service.cancelSignIn(first);
    expect(result.cleanupFailure).toBeNull();
    expect(result.state.signedIn).toBe(true);
    expect(await store.get(BEARER_KEY)).toBe("tok");
  });

  it("refuses to start a second sign-in over a held credential", async () => {
    const { service } = harness();
    const first = nextNonce();
    await service.startSignIn(first);
    await service.pollSignIn(first);

    await expect(service.startSignIn(nextNonce())).rejects.toThrow(/already signed in/);
  });

  // The `StoreHealth` distinction must survive the new check: "I cannot open my
  // own storage" is not "you are already signed in".
  it("surfaces store health rather than flattening it into 'already signed in'", async () => {
    const { service } = harness({
      makeStore: async () =>
        instrumentedStore(new SecretStore(join(dir, "secrets"), cipher), {
          get: async (key, real) => {
            if (key === BEARER_KEY) throw new SecretStoreError("encryption-unavailable");
            return real();
          },
        }),
    });
    await expect(service.startSignIn(nextNonce())).rejects.toMatchObject({
      code: "encryption-unavailable",
    });
    expect((await service.authState()).store).toBe("unavailable");
  });

  it("ignores a cancel that names an attempt which is no longer current", async () => {
    const { service } = harness();
    const first = nextNonce();
    await service.startSignIn(first);
    await service.cancelSignIn(first);

    const second = nextNonce();
    await service.startSignIn(second);
    // The stale nonce must not reach the newer attempt.
    await service.cancelSignIn(first);

    await expect(service.pollSignIn(second)).resolves.toMatchObject({ status: "ok" });
  });

  it("refuses a poll for an attempt that was cancelled", async () => {
    const { service } = harness();
    const nonce = nextNonce();
    await service.startSignIn(nonce);
    await service.cancelSignIn(nonce);
    await expect(service.pollSignIn(nonce)).rejects.toThrow(/no sign-in in progress/);
  });

  it("supersedes a previous attempt by identity, refusing its poll", async () => {
    const { service } = harness();
    const first = nextNonce();
    const second = nextNonce();
    await service.startSignIn(first);
    await service.startSignIn(second);

    await expect(service.pollSignIn(first)).rejects.toThrow(/no sign-in in progress/);
    await expect(service.pollSignIn(second)).resolves.toMatchObject({ status: "ok" });
  });

  it("refuses a reused nonce, so a replay cannot name a live attempt", async () => {
    const { service } = harness();
    const nonce = nextNonce();
    await service.startSignIn(nonce);
    await service.signOut();
    await expect(service.startSignIn(nonce)).rejects.toThrow(/nonce reused/);
  });

  // The two calls are independent IPC invocations; the renderer fires Cancel
  // without waiting for `start`. If the order inverts, the start must lose.
  it("refuses a start whose cancel arrived first", async () => {
    const { service } = harness();
    const nonce = nextNonce();
    await service.cancelSignIn(nonce);
    await expect(service.startSignIn(nonce)).rejects.toThrow(/sign-in cancelled/);
  });

  it("leaves no attempt behind when the cancel lands during start", async () => {
    const held = barrier<typeof START_RESPONSE>();
    const { service } = harness({
      makeAuthClient: () =>
        ({
          start: () => {
            held.entered.resolve();
            return held.release.promise;
          },
          poll: async () => OK_POLL,
        }) as never,
    });

    const nonce = nextNonce();
    const starting = service.startSignIn(nonce);
    await held.entered.promise;
    await service.cancelSignIn(nonce);
    held.release.resolve(START_RESPONSE);

    await expect(starting).rejects.toThrow(/sign-in cancelled/);
    await expect(service.pollSignIn(nonce)).rejects.toThrow(/no sign-in in progress/);
  });

  it("aborts the network call it was waiting on", async () => {
    const held = barrier<typeof OK_POLL>();
    let pollSignal: AbortSignal | undefined;
    const { service } = harness({
      makeAuthClient: () =>
        ({
          start: async () => START_RESPONSE,
          poll: (_code: string, signal?: AbortSignal) => {
            pollSignal = signal;
            held.entered.resolve();
            return held.release.promise;
          },
        }) as never,
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;
    expect(pollSignal?.aborted).toBe(false);

    await service.cancelSignIn(nonce);
    expect(pollSignal?.aborted).toBe(true);

    held.release.resolve(OK_POLL);
    await expect(polling).rejects.toThrow(/sign-in cancelled/);
  });

  it("cancels the attempt when the service is disposed", async () => {
    const held = barrier<typeof OK_POLL>();
    const { service, store } = harness({
      makeAuthClient: () =>
        ({
          start: async () => START_RESPONSE,
          poll: () => {
            held.entered.resolve();
            return held.release.promise;
          },
        }) as never,
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;

    await service.dispose();
    held.release.resolve(OK_POLL);

    await expect(polling).rejects.toThrow(/disposed|cancelled/);
    await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("main enforces its own sign-in deadline", () => {
  const clock = (start = 1_000_000) => clockFrom(start);

  it("refuses to issue a poll once the deadline has passed", async () => {
    const time = clock();
    const { service } = harness({ now: time.now });
    const nonce = nextNonce();
    await service.startSignIn(nonce);

    time.advance(START_RESPONSE.expiresIn * 1000 + 1);
    await expect(service.pollSignIn(nonce)).resolves.toMatchObject({ status: "expired" });
    // Terminal: the attempt is gone rather than merely reported once.
    await expect(service.pollSignIn(nonce)).rejects.toThrow(/no sign-in in progress/);
  });

  // The one a renderer countdown cannot close: the poll was issued in time and
  // came back late. Without a re-check AFTER the await, this adopts.
  it("does not adopt a success withheld across the deadline", async () => {
    const time = clock();
    const held = barrier<typeof OK_POLL>();
    const { service, store } = harness({
      now: time.now,
      makeAuthClient: () =>
        ({
          start: async () => START_RESPONSE,
          poll: () => {
            held.entered.resolve();
            return held.release.promise;
          },
        }) as never,
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;

    time.advance(START_RESPONSE.expiresIn * 1000 + 1);
    held.release.resolve(OK_POLL);

    await expect(polling).resolves.toMatchObject({ status: "expired" });
    await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
    expect((await service.authState()).signedIn).toBe(false);
  });

  it("does not keep a credential written by an adoption held across the deadline", async () => {
    const time = clock();
    const held = barrier<void>();
    const { service, store } = harness({
      now: time.now,
      makeAuthClient: () =>
        ({ start: async () => START_RESPONSE, poll: async () => OK_POLL }) as never,
      makeStore: async () =>
        instrumentedStore(new SecretStore(join(dir, "secrets"), cipher), {
          put: async (key, _value, real) => {
            if (key !== BEARER_KEY) return real();
            held.entered.resolve();
            await held.release.promise;
            await real();
          },
        }),
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const polling = service.pollSignIn(nonce);
    await held.entered.promise;

    time.advance(START_RESPONSE.expiresIn * 1000 + 1);
    held.release.resolve();

    await expect(polling).rejects.toThrow(/sign-in expired/);
    await expect(store.get(BEARER_KEY)).rejects.toMatchObject({ code: "not-found" });
  });

  // The deadline belongs to the server's response, not to whenever the browser
  // finished opening. A cold default browser can take seconds, and every one of
  // them has already been counted against the code.
  //
  // Fixing it at the response also means `startSignIn` itself fails here rather
  // than handing back a user code for an already-dead attempt — which is the
  // honest outcome, and would not happen if the deadline started when the
  // browser open returned.
  it("does not let a slow browser open extend the deadline", async () => {
    const time = clock();
    const { service } = harness({
      now: time.now,
      openApproval: async () => {
        time.advance(START_RESPONSE.expiresIn * 1000 + 1);
        return true;
      },
    });

    const nonce = nextNonce();
    await expect(service.startSignIn(nonce)).rejects.toThrow(/sign-in expired/);
    await expect(service.pollSignIn(nonce)).rejects.toThrow(/no sign-in in progress/);
  });
});

describe("privileged request admission", () => {
  // UI pacing is not admission control. A renderer that fires many polls must
  // not become many concurrent HTTP requests from the privileged process.
  it("allows one outstanding poll per attempt and reports the rest as pending", async () => {
    const held = barrier<typeof OK_POLL>();
    let requests = 0;
    const { service } = harness({
      makeAuthClient: () =>
        ({
          start: async () => START_RESPONSE,
          poll: () => {
            requests += 1;
            held.entered.resolve();
            return held.release.promise;
          },
        }) as never,
    });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    const first = service.pollSignIn(nonce);
    await held.entered.promise;

    const overlapping = await Promise.all([
      service.pollSignIn(nonce),
      service.pollSignIn(nonce),
      service.pollSignIn(nonce),
    ]);
    for (const result of overlapping) expect(result).toEqual({ status: "pending" });
    expect(requests).toBe(1);

    held.release.resolve({ status: "pending" } as never);
    await expect(first).resolves.toMatchObject({ status: "pending" });

    // Admission is released for the NEXT poll, not permanently spent.
    const held2 = barrier<typeof OK_POLL>();
    held.entered = held2.entered;
    held.release = held2.release;
    const second = service.pollSignIn(nonce);
    await held2.entered.promise;
    expect(requests).toBe(2);
    held2.release.resolve(OK_POLL);
    await expect(second).resolves.toMatchObject({ status: "ok" });
  });

  // The renderer's countdown must not outlive main's willingness to poll.
  it("returns the deadline that is left, not the one the server first granted", async () => {
    const time = clockFrom(1_000_000);
    const { service } = harness({
      now: time.now,
      openApproval: async () => {
        time.advance(120_000); // a cold browser taking two minutes
        return true;
      },
    });

    const started = await service.startSignIn(nextNonce());
    expect(started.expiresIn).toBe(START_RESPONSE.expiresIn - 120);
  });
});

// ---------------------------------------------------------------------------
// The account-change watcher, and the credential a main feature captures
// ---------------------------------------------------------------------------

describe("the account authority a resident feature subscribes to", () => {
  it("wakes its watchers exactly once for one sign-out", async () => {
    // `signOut` used to call `notifyAuthorityChange()` twice — once where it
    // belongs, immediately after the epoch bump, and once more a few lines
    // later at a misleading indentation. Nothing between the two calls changes
    // what a watcher observes, so the second was pure duplication.
    //
    // It matters because a watcher is a callback of unknown cost. The Device
    // Inbox scheduler tears a binding down from one: invalidate, abort, and
    // queue a join. Firing it twice for a single transition runs that teardown
    // a second time against state the first pass already retired.
    const { service } = harness();
    const nonce = nextNonce();
    await service.startSignIn(nonce);
    await service.pollSignIn(nonce);

    let woken = 0;
    const release = service.onAccountChanged(() => {
      woken += 1;
    });
    await service.signOut();
    release();

    expect(woken).toBe(1);
  });

  it("stops waking a watcher that released itself", async () => {
    const { service } = harness();
    let woken = 0;
    service.onAccountChanged(() => {
      woken += 1;
    })();
    const nonce = nextNonce();
    await service.startSignIn(nonce);
    await service.pollSignIn(nonce);
    await service.signOut();
    expect(woken).toBe(0);
  });

  it("hands a main feature the bearer and the epoch it was read under", async () => {
    const { service } = harness();
    expect(await service.captureAccountAuthority()).toEqual({ kind: "signed-out" });

    const nonce = nextNonce();
    await service.startSignIn(nonce);
    await service.pollSignIn(nonce);

    const captured = await service.captureAccountAuthority();
    expect(captured).toEqual({ kind: "ok", bearer: "tok", epoch: service.accountEpoch });

    await service.signOut();
    expect(await service.captureAccountAuthority()).toEqual({ kind: "signed-out" });
  });

  it("reports an unusable store as unavailable rather than as signed out", async () => {
    // The distinction the Inbox depends on: an enrolment may still be live on
    // the server, so "could not read this PC's storage" must not be rendered as
    // an invitation to switch a feature on that is already on.
    const { service } = harness({
      makeStore: async () => {
        throw new SecretStoreError("encryption-unavailable");
      },
    });
    expect(await service.captureAccountAuthority()).toEqual({ kind: "unavailable" });
  });
});
