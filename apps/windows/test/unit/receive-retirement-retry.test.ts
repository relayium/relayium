// What happens to a destination whose cleanup FAILED.
//
// `receive-lifecycle.test.ts` establishes who owns a lease and when that
// ownership ends. This file is about the case that made "when it ends" wrong:
// `adapter.cancel()` rejects. It is allowed to — the adapter's contract is that
// it rejects rather than letting a caller mistake residue for a clean teardown
// — and on Windows it is the ordinary shape of a file an indexer has open for a
// moment, or a helper process that has not finished exiting.
//
// The service used to treat that rejection as the end of the lease. The entry
// left every registry, its rejected promise stayed cached as THE retirement,
// and the adapter — the only object that could still close the handle — had no
// remaining reference. Everything after that was a lie in the safe-sounding
// direction: the next revocation found nothing to do and returned clean, over a
// staging directory that was still open.
//
// Three paths reached that state, and they are the three the service now has to
// survive: a registered lease, a destination created into a teardown, and a
// publication that failed and could not clean up after itself. Each was
// reproduced independently against the compiled service before this fix.
//
// The correction is ownership, not optimism: a failed cleanup keeps the lease
// and the next teardown tries again. What is bounded is the work per attempt
// and the number of attempts per requested teardown — one — and NOT the
// lifetime of the ownership. An attempt budget was tried and rejected: a
// destination whose lock cleared after five failures was never closed again,
// which is the same bug one counter later.

import { afterEach, describe, expect, it } from "vitest";
import {
  AppService,
  MAX_OWNED_RECEIVES,
  ServiceRefusal,
  type AppServiceDeps,
} from "../../src/main/app-service.js";
import type { NativeReceiveAdapter } from "../../src/main/net/native-receive-adapter.js";
import type { PublishReport } from "../../src/shared/ipc-contract.js";

const ORIGIN = "https://relayium.com";
const MANIFEST = [{ name: "report.txt", size: 4 }];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A destination that reports whether it is still LIVE.
 *
 * The point of every test here: not "was cancel called again" but "did anything
 * ever close this". A stub that merely counted calls would pass against a
 * service that dropped the adapter, because the count it kept would be its own.
 */
class FakeDestination implements NativeReceiveAdapter {
  readonly fileCount = MANIFEST.length;
  calls = 0;
  live = true;
  /** How many of the first N cancels reject. `Infinity` never closes. */
  failuresRemaining: number;
  /** Held cancels, so a test can observe the window a teardown joins. */
  gate: Promise<void> | null = null;
  publishReport: PublishReport = { status: "complete", publishedCount: 1, total: 1 };

  constructor(failuresRemaining = 0) {
    this.failuresRemaining = failuresRemaining;
  }

  assertAuthority(): void {}
  async begin(): Promise<void> {}
  async write(): Promise<void> {}
  async finish(): Promise<void> {}
  async publish(): Promise<PublishReport> {
    return this.publishReport;
  }

  async cancel(): Promise<void> {
    this.calls += 1;
    if (this.gate) await this.gate;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      // Rejects with the resource STILL live — a partial removal, which is what
      // a locked file actually produces. A stub that also closed would let a
      // service that forgets the adapter look correct.
      throw new Error("could not close staged bytes");
    }
    this.live = false;
  }
}

interface Harness {
  service: AppService;
  destination: FakeDestination;
  document: { value: number };
  /** Bump the generation and retire the one that was live, as `IpcRouter` does. */
  revoke(): Promise<void>;
}

let built: AppService[] = [];
let leaseSeq = 0;

function harness(
  destination: FakeDestination,
  over: Partial<AppServiceDeps> = {},
): Harness {
  const document = { value: 1 };
  const service = new AppService({
    origin: ORIGIN,
    makeStore: async () => {
      throw new Error("no store in a direct transfer");
    },
    makeAuthClient: () => {
      throw new Error("no auth client in a direct transfer");
    },
    pickDirectory: async () => "/synthetic-destination",
    openApproval: async () => false,
    newId: () => `lease-${++leaseSeq}`,
    documentGeneration: () => document.value,
    makeDestination: async () => destination,
    ...over,
  });
  built.push(service);
  return {
    service,
    destination,
    document,
    revoke: async () => {
      const retiring = document.value;
      document.value += 1;
      await service.revokeDocument(retiring);
    },
  };
}

/** The service's private registries, read to assert on ownership itself. */
function registries(service: AppService) {
  return service as unknown as {
    retiring: Set<{ cleanupAttempts: number; lastCleanupReason: string | null }>;
    disposal: Promise<void> | null;
  };
}

/**
 * A service that hands out a FRESH destination per open, so a test can fill the
 * owned set the way a renderer would rather than by reusing one adapter.
 */
function multiHarness(make: (index: number) => FakeDestination) {
  const made: FakeDestination[] = [];
  const document = { value: 1 };
  let pickerCalls = 0;
  const service = new AppService({
    origin: ORIGIN,
    makeStore: async () => {
      throw new Error("no store in a direct transfer");
    },
    makeAuthClient: () => {
      throw new Error("no auth client in a direct transfer");
    },
    pickDirectory: async () => {
      pickerCalls += 1;
      return "/synthetic-destination";
    },
    openApproval: async () => false,
    newId: () => `lease-${++leaseSeq}`,
    documentGeneration: () => document.value,
    makeDestination: async () => {
      const destination = make(made.length);
      made.push(destination);
      return destination;
    },
  });
  built.push(service);
  return { service, made, document, pickerCalls: () => pickerCalls };
}

async function openDirect(h: Harness): Promise<string> {
  const opened = await h.service.openReceive(MANIFEST, "direct");
  if ("cancelled" in opened) throw new Error("picker cancelled");
  return opened.leaseId;
}

afterEach(async () => {
  for (const service of built) await service.dispose().catch(() => undefined);
  built = [];
  leaseSeq = 0;
});

describe("a cleanup that failed has not finished", () => {
  it("retries a registered lease the first teardown could not close", async () => {
    const destination = new FakeDestination(1);
    const h = harness(destination);
    await openDirect(h);

    // The document goes away and the cleanup fails. The teardown says so —
    // returning clean here is the bug, not the failure itself.
    await expect(h.revoke()).rejects.toThrow(ServiceRefusal);
    expect(destination.calls).toBe(1);
    expect(destination.live).toBe(true);

    // The lease is still OWNED, so the next teardown has something to find.
    expect(registries(h.service).retiring.size).toBe(1);

    // And it actually tries again, rather than joining the failure that already
    // happened. This is what the second call used to do: nothing, cleanly.
    await h.service.revokeDocument(1);
    expect(destination.calls).toBe(2);
    expect(destination.live).toBe(false);
    expect(registries(h.service).retiring.size).toBe(0);
  });

  it("keeps a destination created INTO a teardown, and retires it on the NEXT one", async () => {
    // The window where the picker has returned and the destination is being
    // built while the document underneath it changes. The open cleans up rather
    // than registering — and that cleanup can fail like any other.
    const destination = new FakeDestination(1);
    const entered = deferred();
    const release = deferred();
    const h = harness(destination, {
      makeDestination: async () => {
        entered.resolve();
        await release.promise;
        return destination;
      },
    });

    const opening = h.service.openReceive(MANIFEST, "direct").catch((err: unknown) => err);
    await entered.promise;

    // The teardown joins this open — it is past the picker, so it can leave a
    // destination behind — and the destination lands mid-join.
    h.document.value += 1;
    const revoking = h.service.revokeDocument(1).catch((err: unknown) => err);
    release.resolve();

    expect(await opening).toBeInstanceOf(ServiceRefusal);
    // ONE attempt, and it was the open's own. The sweep rescans after the join
    // and finds the destination that failed to close — but it does not try
    // again inside its own window: nothing about the lock has changed since the
    // attempt it just watched fail, and spending the next teardown's attempt
    // here would report one outcome having consumed two.
    expect(destination.calls).toBe(1);
    expect(destination.live).toBe(true);
    // What it does instead is REPORT it. Returning clean over a destination
    // that had just been created and had failed to close is the failure this
    // rescan exists to close.
    expect(await revoking).toBeInstanceOf(ServiceRefusal);
    expect(registries(h.service).retiring.size).toBe(1);

    // And the next teardown is the retry.
    await h.service.revokeDocument(1);
    expect(destination.calls).toBe(2);
    expect(destination.live).toBe(false);
    expect(registries(h.service).retiring.size).toBe(0);
  });

  it("attempts a rescued destination once per teardown, not once per registry it is in", async () => {
    // Same window, but nothing here can close the destination. Each teardown
    // is worth exactly one attempt against it — never two because it was
    // reachable through both the pre-join snapshot and the rescan.
    const destination = new FakeDestination(Number.POSITIVE_INFINITY);
    const entered = deferred();
    const release = deferred();
    const h = harness(destination, {
      makeDestination: async () => {
        entered.resolve();
        await release.promise;
        return destination;
      },
    });

    const opening = h.service.openReceive(MANIFEST, "direct").catch((err: unknown) => err);
    await entered.promise;
    h.document.value += 1;
    const revoking = h.service.revokeDocument(1).catch((err: unknown) => err);
    release.resolve();

    await opening;
    expect(await revoking).toBeInstanceOf(ServiceRefusal);
    expect(destination.calls).toBe(1);

    await expect(h.service.revokeDocument(1)).rejects.toThrow(ServiceRefusal);
    expect(destination.calls).toBe(2);
    await expect(h.service.revokeDocument(1)).rejects.toThrow(ServiceRefusal);
    expect(destination.calls).toBe(3);

    // Still live, and still owned. Ownership does not lapse because attempts
    // did not work.
    expect(destination.live).toBe(true);
    expect(registries(h.service).retiring.size).toBe(1);
  });

  it("retries a failed publication's cleanup from a later teardown", async () => {
    const destination = new FakeDestination(1);
    destination.publishReport = { status: "failed", reason: "io-failed", residue: true };
    const h = harness(destination);
    const leaseId = await openDirect(h);

    // The caller is told about the PUBLICATION, which is the accurate outcome
    // for them; the cleanup failure does not replace it.
    expect(await h.service.publishReceive(leaseId)).toMatchObject({ status: "failed" });
    expect(destination.calls).toBe(1);
    expect(destination.live).toBe(true);

    // But it is not swallowed either. The lease left the map — no further work
    // may be accepted — and stayed owned, so the next teardown retries.
    expect(h.service.openLeaseCount).toBe(0);
    await h.revoke();
    expect(destination.calls).toBe(2);
    expect(destination.live).toBe(false);
  });

  it("does not cancel again after a cleanup that SUCCEEDED", async () => {
    // The other half of the correction. Retrying a failure must not become
    // retrying everything: a closed destination is closed, and a second cancel
    // against it is the double-cleanup the shared retirement exists to prevent.
    const destination = new FakeDestination(0);
    const h = harness(destination);
    const leaseId = await openDirect(h);

    await h.service.cancelReceive(leaseId);
    expect(destination.calls).toBe(1);
    expect(destination.live).toBe(false);

    await h.revoke();
    await h.service.dispose();
    expect(destination.calls).toBe(1);
  });

  it("joins one in-flight attempt however many teardowns arrive during it", async () => {
    // Concurrent teardowns must not each start a cancel against the same files.
    // The retry is per TEARDOWN, not per caller.
    const destination = new FakeDestination(1);
    const gate = deferred();
    destination.gate = gate.promise;
    const h = harness(destination);
    const leaseId = await openDirect(h);

    const cancelling = h.service.cancelReceive(leaseId).catch((err: unknown) => err);
    const revoking = h.service.revokeDocument(1).catch((err: unknown) => err);
    const disposing = h.service.dispose().catch((err: unknown) => err);

    await new Promise((r) => setTimeout(r, 20));
    expect(destination.calls).toBe(1);

    gate.resolve();
    // Every one of them is told the truth about the same attempt.
    expect(await cancelling).toBeInstanceOf(Error);
    expect(await revoking).toBeInstanceOf(ServiceRefusal);
    expect(await disposing).toBeInstanceOf(ServiceRefusal);
    expect(destination.calls).toBe(1);
  });
});

describe("ownership does not expire, and that is the point", () => {
  it("closes the destination on the attempt AFTER the lock clears, however many failed first", async () => {
    // The case an attempt budget gets wrong, and the reason there is no budget.
    // A staging directory held by an indexer, or by a helper that has not
    // finished exiting, fails every attempt until it does not — and a service
    // that had released the adapter by then can never close it, whatever it
    // wrote in a log about having tried.
    const destination = new FakeDestination(5);
    const h = harness(destination);
    await openDirect(h);

    for (let i = 0; i < 5; i += 1) {
      await expect(h.service.revokeDocument(1)).rejects.toThrow(/could not clean up 1 transfer/);
      expect(destination.live).toBe(true);
      // Never dropped, however long this goes on.
      expect(registries(h.service).retiring.size).toBe(1);
    }

    // The lock clears. The sixth attempt is the one that matters, and it is
    // only reachable because the adapter was still owned.
    await h.service.revokeDocument(1);
    expect(destination.calls).toBe(6);
    expect(destination.live).toBe(false);
    expect(registries(h.service).retiring.size).toBe(0);

    // Nothing left to report or to clean.
    await h.service.dispose();
    expect(destination.calls).toBe(6);
  });

  it("retains a truncated reason per lease, never the Error", async () => {
    // Bounded is about what is RETAINED per entry, not about how long an entry
    // is kept. A retained `Error` pins a stack and everything its closure
    // captured, in the privileged process, on a path a failing disk drives
    // repeatedly.
    const destination = new FakeDestination(Number.POSITIVE_INFINITY);
    const h = harness(destination);
    await openDirect(h);

    for (let i = 0; i < 4; i += 1) {
      await expect(h.service.revokeDocument(1)).rejects.toThrow(ServiceRefusal);
    }

    const [entry] = [...registries(h.service).retiring];
    expect(entry?.cleanupAttempts).toBe(4);
    expect(entry?.lastCleanupReason).toBe("could not close staged bytes");
  });

  it("keeps saying so for as long as it is true", async () => {
    const destination = new FakeDestination(Number.POSITIVE_INFINITY);
    const h = harness(destination);
    await openDirect(h);

    await expect(h.service.revokeDocument(1)).rejects.toThrow(/could not clean up 1 transfer\(s\)/);
    // A second teardown over the same open destination does not get to report a
    // clean bill of health — and reports ONE transfer, the one that is actually
    // still there, not an accumulated tally of attempts.
    await expect(h.service.revokeDocument(1)).rejects.toThrow(/could not clean up 1 transfer\(s\)/);
    await expect(h.service.dispose()).rejects.toThrow(/could not clean up transfers on shutdown/);
    expect(destination.live).toBe(true);
  });
});

describe("a failed quit is not a completed quit", () => {
  it("lets a second dispose actually retry instead of replaying the first failure", async () => {
    const destination = new FakeDestination(1);
    const h = harness(destination);
    await openDirect(h);

    await expect(h.service.dispose()).rejects.toThrow(/could not clean up transfers on shutdown/);
    expect(destination.calls).toBe(1);
    expect(destination.live).toBe(true);

    // Caching the rejection made every later attempt free and useless: the
    // caller got the same error, the handle stayed open, and nothing had been
    // tried. The service is still disposed — this is a retry of the teardown,
    // not a resume of the service.
    await h.service.dispose();
    expect(destination.calls).toBe(2);
    expect(destination.live).toBe(false);
    await expect(h.service.openReceive(MANIFEST, "direct")).rejects.toThrow(ServiceRefusal);
  });

  it("keeps a SUCCESSFUL disposal cached", async () => {
    const destination = new FakeDestination(0);
    const h = harness(destination);
    await openDirect(h);

    const first = h.service.dispose();
    const second = h.service.dispose();
    expect(second).toBe(first);
    await first;
    await h.service.dispose();
    // One teardown happened, however many callers asked.
    expect(destination.calls).toBe(1);
    expect(registries(h.service).disposal).not.toBeNull();
  });
});

describe("growth is bounded at admission, never by forgetting", () => {
  it("refuses a new receive once the owned set is full, without opening a picker", async () => {
    // Unresolved cleanups keep their adapters forever, so the ceiling has to be
    // somewhere. It is here — on creating a NEW child — and not on releasing
    // one that already exists.
    const h = multiHarness(() => new FakeDestination(Number.POSITIVE_INFINITY));

    for (let i = 0; i < MAX_OWNED_RECEIVES; i += 1) {
      const opened = await h.service.openReceive(MANIFEST, "direct");
      if ("cancelled" in opened) throw new Error("picker cancelled");
      await h.service.cancelReceive(opened.leaseId).catch(() => undefined);
    }

    // All sixteen failed their cleanup and are still owned, so the seventeenth
    // is refused...
    expect(registries(h.service).retiring.size).toBe(MAX_OWNED_RECEIVES);
    const pickersBefore = h.pickerCalls();
    await expect(h.service.openReceive(MANIFEST, "direct")).rejects.toThrow(ServiceRefusal);

    // ...before the native folder dialog, and before anything was spawned. A
    // refusal that first made the user choose a folder would be a worse way of
    // saying the same thing.
    expect(h.pickerCalls()).toBe(pickersBefore);
    expect(h.made.length).toBe(MAX_OWNED_RECEIVES);
    // And nothing was evicted to make room.
    expect(registries(h.service).retiring.size).toBe(MAX_OWNED_RECEIVES);
  });

  it("admits again as soon as a cleanup actually succeeds", async () => {
    // The bound is on what is OWNED, not a lifetime quota: a destination that
    // closes gives its slot back.
    const h = multiHarness(() => new FakeDestination(1));

    for (let i = 0; i < MAX_OWNED_RECEIVES; i += 1) {
      const opened = await h.service.openReceive(MANIFEST, "direct");
      if ("cancelled" in opened) throw new Error("picker cancelled");
      await h.service.cancelReceive(opened.leaseId).catch(() => undefined);
    }
    await expect(h.service.openReceive(MANIFEST, "direct")).rejects.toThrow(ServiceRefusal);

    // One teardown, one attempt each — and this time the destinations close.
    await h.service.revokeDocument(1);
    expect(registries(h.service).retiring.size).toBe(0);
    for (const destination of h.made) expect(destination.live).toBe(false);

    const opened = await h.service.openReceive(MANIFEST, "direct");
    expect("leaseId" in opened).toBe(true);
  });

  it("leaves the ordinary case alone: one active receive, and several links", async () => {
    // The bound must not be a behaviour change for anything a user actually
    // does. A working transfer opens, publishes and frees its slot; a handful
    // of concurrent ones coexist.
    const h = multiHarness(() => new FakeDestination(0));

    for (let i = 0; i < 20; i += 1) {
      const opened = await h.service.openReceive(MANIFEST, "direct");
      if ("cancelled" in opened) throw new Error("picker cancelled");
      expect(await h.service.publishReceive(opened.leaseId)).toMatchObject({ status: "complete" });
    }

    const concurrent = [];
    for (let i = 0; i < 4; i += 1) {
      const opened = await h.service.openReceive(MANIFEST, "direct");
      if ("cancelled" in opened) throw new Error("picker cancelled");
      concurrent.push(opened.leaseId);
    }
    expect(concurrent).toHaveLength(4);
    for (const leaseId of concurrent) await h.service.cancelReceive(leaseId);
  });

  it("counts a picker the user has not answered, and admits after it resolves", async () => {
    // An open in flight owns a slot too — a dialog on screen is a receive this
    // process has committed to — but it must RELEASE it when the user cancels,
    // or a few dismissed dialogs would wedge receiving for the session.
    const pickers: Array<(value: string | null) => void> = [];
    const h = multiHarness(() => new FakeDestination(0));
    const service = h.service as unknown as {
      deps: { pickDirectory(): Promise<string | null> };
    };
    service.deps.pickDirectory = () =>
      new Promise<string | null>((resolve) => {
        pickers.push(resolve);
      });

    const held = [];
    for (let i = 0; i < MAX_OWNED_RECEIVES; i += 1) {
      held.push(h.service.openReceive(MANIFEST, "direct").catch((err: unknown) => err));
    }
    await new Promise((r) => setTimeout(r, 10));
    await expect(h.service.openReceive(MANIFEST, "direct")).rejects.toThrow(ServiceRefusal);

    // The user dismisses one dialog. Nothing was created, so nothing is owned.
    pickers[0]?.(null);
    expect(await held[0]).toEqual({ cancelled: true });

    // The slot it released is admissible immediately — the next open reaches
    // the picker rather than being refused.
    const admitted = h.service.openReceive(MANIFEST, "direct").catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 10));
    expect(pickers).toHaveLength(MAX_OWNED_RECEIVES + 1);

    pickers[MAX_OWNED_RECEIVES]?.(null);
    expect(await admitted).toEqual({ cancelled: true });
    for (const resolve of pickers.slice(1, MAX_OWNED_RECEIVES)) resolve(null);
    await Promise.all(held.slice(1));
  });
});

describe("a teardown cannot hide a lease from another one", () => {
  /**
   * Two teardowns with DIFFERENT filters, overlapping in time.
   *
   * A sweep deletes the leases it selected from the map and then awaits the
   * opens it has to join. During that await those destinations exist, are this
   * process's, and — before the correction — were in no registry at all, only
   * in a local variable inside the suspended sweep. A second teardown that does
   * not select the same pending open does not join it either: it looks, finds
   * nothing, and returns.
   *
   * That is not a hypothetical pairing. A sign-out selects `account` leases and
   * ignores a `direct` open entirely, so it would report a completed cleanup —
   * and go on to publish the new authority — over an account destination that a
   * concurrent document revocation was holding in a local Set.
   */
  it("registers what it selected BEFORE it awaits a pending open", async () => {
    const registered = new FakeDestination(0);
    const gate = deferred();
    registered.gate = gate.promise;
    const pendingDestination = new FakeDestination(0);

    const entered = deferred();
    const release = deferred();
    let opens = 0;
    const document = { value: 1 };
    const service = new AppService({
      origin: ORIGIN,
      // An account lease needs a session, and nothing else here does.
      makeStore: async () => {
        const values = new Map<string, string>();
        return {
          get: async (key: string) => values.get(key) ?? null,
          put: async (key: string, value: string) => {
            values.set(key, value);
          },
          delete: async (key: string) => {
            values.delete(key);
          },
        } as never;
      },
      makeAuthClient: () => {
        throw new Error("no auth client in this test");
      },
      pickDirectory: async () => "/synthetic-destination",
      openApproval: async () => false,
      newId: () => `lease-${++leaseSeq}`,
      documentGeneration: () => document.value,
      makeDestination: async () => {
        if (++opens === 1) return registered;
        entered.resolve();
        await release.promise;
        return pendingDestination;
      },
    });
    built.push(service);

    // An ACCOUNT lease, and a DIRECT open the user is still inside.
    const opened = await service.openReceive(MANIFEST, "account");
    if ("cancelled" in opened) throw new Error("picker cancelled");
    const opening = service.openReceive(MANIFEST, "direct").catch((err: unknown) => err);
    await entered.promise;

    // Sweep one: the document goes away. It selects both, so it deletes the
    // account lease from the map and suspends joining the direct open.
    const revoking = service.revokeDocument(1).catch((err: unknown) => err);
    await new Promise((r) => setImmediate(r));
    expect(service.openLeaseCount).toBe(0);

    // Sweep two: the sign-out predicate, which is what `signOut` runs once its
    // transition begins. It selects `account` only — it does not fence or join
    // the direct open — so nothing about the pending open can make it wait.
    const internal = service as unknown as { cancelLeases(): Promise<void> };
    let signedOutLeases = false;
    const cancelling = internal.cancelLeases().then(() => {
      signedOutLeases = true;
    });

    // It must NOT be able to report a completed cleanup here: the account
    // destination is still open, held by a cancel that has not finished.
    await new Promise((r) => setTimeout(r, 20));
    expect(signedOutLeases).toBe(false);
    expect(registered.live).toBe(true);

    gate.resolve();
    await cancelling;
    // It returned only once the destination it is responsible for was closed,
    // and it joined the retirement already in flight rather than starting a
    // second cancel against the same files.
    expect(registered.live).toBe(false);
    expect(registered.calls).toBe(1);

    release.resolve();
    await Promise.all([opening, revoking]);
    expect(pendingDestination.live).toBe(false);
  });
});
