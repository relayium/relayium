// Who owns a stored send, and what a teardown is allowed to return around.
//
// SCOPE: the engine underneath is a CONTROLLED stand-in, deliberately. These
// are host-lifecycle assertions — did an admission exist during the window
// before a job id did, did a join actually join, was a key emitted after a
// revocation — and a real transport would make each of them a race rather than
// a fact. The real engine, the real shared `encryptFiles` and a real byte-level
// round trip are asserted in `stored-send-ciphertext.test.ts`.
//
// Every case here is one root's independent probe found or asked for.

import { describe, expect, it, vi } from "vitest";
import { StoredSendService, type StoredSendDeps } from "../../src/main/features/stored-send.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A stand-in engine whose every step is observable and holdable. */
function fakeEngine() {
  const calls = { start: 0, revoke: [] as string[], history: 0, link: 0, remove: 0 };
  const holds = { start: null as Promise<void> | null };
  let nextJob = 1;
  const engine = {
    async start() {
      calls.start += 1;
      if (holds.start) await holds.start;
      return {
        ok: true as const,
        jobId: `job-${String(nextJob++)}`,
        contentKey: "a-secret-content-key",
        expects: { fileIndex: 0, seq: 1, bytes: 32 },
        cipherBytes: 32,
        fileCount: 1,
      };
    },
    async revoke(jobId: string) {
      calls.revoke.push(jobId);
      return { status: "cancelled" as const };
    },
    async revokeDocument() {},
    async end() {
      return { status: "published" as const, objectId: "object-1", expiresAt: 1 };
    },
    async cancel() {
      return { status: "cancelled" as const };
    },
    async history() {
      calls.history += 1;
      return [];
    },
    async linkFor() {
      calls.link += 1;
      return "https://relayium.com/d/object-1#k=THE-KEY";
    },
    async deleteObject() {
      calls.remove += 1;
      return "deleted" as const;
    },
    async reconcile() {
      return { result: "no-match" as const, probed: 3, truncated: false };
    },
    async reconcileAccount() {},
    async feed() {
      return { expects: null };
    },
  };
  return { engine, calls, holds };
}

interface Harness {
  readonly service: StoredSendService;
  readonly calls: ReturnType<typeof fakeEngine>["calls"];
  readonly holds: ReturnType<typeof fakeEngine>["holds"];
  epoch: number;
  authorityHold: Promise<void> | null;
  optionsHold: Promise<void> | null;
}

function harness(over: { authority?: StoredSendDeps["authority"] } = {}): Harness {
  const built = fakeEngine();
  const state = { epoch: 1, authorityHold: null as Promise<void> | null, optionsHold: null as Promise<void> | null };
  const service = new StoredSendService({
    origin: "https://relayium.com",
    accountEpoch: () => state.epoch,
    authority:
      over.authority ??
      (async () => {
        if (state.authorityHold) await state.authorityHold;
        return {
          kind: "ok",
          authority: { accountId: "acct", deviceId: "dev", bearer: "bearer", epoch: state.epoch },
        };
      }),
    async options() {
      if (state.optionsHold) await state.optionsHold;
      return { secrets: {} as never, journalDirectory: "/tmp/unused" };
    },
    reportFailure: () => undefined,
  });
  // The engine is built lazily from `options()`; this replaces the built one so
  // the host's lifecycle is what is under test rather than the store's.
  const original = (service as unknown as { engine(): Promise<unknown> }).engine.bind(service);
  (service as unknown as { engine(): Promise<unknown> }).engine = async () => {
    await original();
    return built.engine;
  };
  (service as unknown as { built(): unknown }).built = () => built.engine;
  return {
    service,
    calls: built.calls,
    holds: built.holds,
    get epoch() {
      return state.epoch;
    },
    set epoch(next: number) {
      state.epoch = next;
    },
    get authorityHold() {
      return state.authorityHold;
    },
    set authorityHold(next: Promise<void> | null) {
      state.authorityHold = next;
    },
    get optionsHold() {
      return state.optionsHold;
    },
    set optionsHold(next: Promise<void> | null) {
      state.optionsHold = next;
    },
  };
}

const ENTRY = [{ path: "a.bin", size: 16 }];
const RETENTION = { burnAfterRead: false, ttlSeconds: 86_400 };

describe("an admission exists before a job id does", () => {
  it("does not start an upload for a process that is disposing", async () => {
    // Root's probe: dispose lands while `options()` is still pending. A
    // registry that only held started jobs was empty, dispose returned as
    // though idle, and the parked start then opened an upload anyway.
    const h = harness();
    const options = deferred();
    h.optionsHold = options.promise;

    const starting = h.service.start(ENTRY, RETENTION, 1);
    // The admission is already registered, synchronously.
    expect(h.service.active).toBe(1);

    const disposing = h.service.dispose();
    options.resolve();
    await disposing;

    expect(await starting).toMatchObject({ ok: false });
    expect(h.calls.start).toBe(0);
  });

  it("emits no content key when the document went away mid-start", async () => {
    const h = harness();
    const engineStart = deferred();
    h.holds.start = engineStart.promise;

    const starting = h.service.start(ENTRY, RETENTION, 7);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const revoking = h.service.revokeDocument(7);
    engineStart.resolve();

    const result = await starting;
    await revoking;
    // The engine did create a job — and it was cancelled rather than handed
    // back with its key.
    expect(h.calls.start).toBe(1);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("a-secret-content-key");
    expect(h.calls.revoke.length).toBeGreaterThan(0);
  });

  it("refuses under a quit fence set while the credential was being read", async () => {
    const h = harness();
    const authority = deferred();
    h.authorityHold = authority.promise;
    const starting = h.service.start(ENTRY, RETENTION, 1);
    h.service.fence();
    authority.resolve();
    expect(await starting).toEqual({ ok: false, refusal: "unavailable" });
    expect(h.calls.start).toBe(0);
  });

  it("counts pending admissions against the capacity bound", async () => {
    // Eight concurrent starts all passed a check that ran before any of them
    // had registered.
    const h = harness();
    const options = deferred();
    h.optionsHold = options.promise;
    const many = Array.from({ length: 9 }, (_, i) => h.service.start(ENTRY, RETENTION, i + 1));
    expect(h.service.active).toBe(8);
    options.resolve();
    const results = await Promise.all(many);
    expect(results.filter((r) => !r.ok && r.refusal === "at-capacity")).toHaveLength(1);
    await h.service.dispose();
  });
});

describe("a teardown joins work the renderer never finished", () => {
  it("quiesces an idle admitted job with no end or cancel from the page", async () => {
    // Root's second probe: an admitted job whose renderer never calls back.
    // `settled` was resolved only by `end`/`cancel`, so every join waited
    // forever — a reload, a sign-out or a quit would hang.
    const h = harness();
    const started = await h.service.start(ENTRY, RETENTION, 1);
    expect(started.ok).toBe(true);
    expect(h.service.active).toBe(1);

    const quiesced = await Promise.race([
      h.service.quiesce().then(() => "joined"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(quiesced).toBe("joined");
    expect(h.calls.revoke).toEqual([(started as { jobId: string }).jobId]);
    expect(h.service.active).toBe(0);
  });

  it("joins an idle job on a sign-out", async () => {
    const h = harness();
    await h.service.start(ENTRY, RETENTION, 1);
    h.epoch = 2;
    const joined = await Promise.race([
      h.service.onAccountChanged().then(() => "joined"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(joined).toBe("joined");
    expect(h.service.active).toBe(0);
  });

  it("joins an idle job on a document replacement", async () => {
    const h = harness();
    await h.service.start(ENTRY, RETENTION, 3);
    const joined = await Promise.race([
      h.service.revokeDocument(3).then(() => "joined"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(joined).toBe("joined");
    expect(h.service.active).toBe(0);
  });
});

describe("auxiliary operations are owned too", () => {
  it("drops a link that came back after a quit was agreed", async () => {
    // A link IS the key. One composed before the fence and returned after it
    // hands the secret to a page the quit already accounted for.
    const h = harness();
    const link = h.service.link("job-1");
    h.service.fence();
    expect(await link).toBeNull();
  });

  it("drops a link that came back after the account changed", async () => {
    const h = harness();
    const link = h.service.link("job-1");
    h.epoch = 2;
    expect(await link).toBeNull();
  });

  it("refuses to start a link, a delete or a history read once fenced", async () => {
    const h = harness();
    h.service.fence();
    expect(await h.service.link("job-1")).toBeNull();
    expect(await h.service.remove("job-1")).toBe("failed");
    expect(await h.service.history()).toBeNull();
    expect(h.calls.link).toBe(0);
    expect(h.calls.remove).toBe(0);
    expect(h.calls.history).toBe(0);
  });

  it("joins an auxiliary operation that is still in flight at quiesce", async () => {
    const h = harness();
    const authority = deferred();
    h.authorityHold = authority.promise;
    const reading = h.service.history();
    const quiescing = h.service.quiesce();
    authority.resolve();
    const joined = await Promise.race([
      quiescing.then(() => "joined"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(joined).toBe("joined");
    await reading;
  });

  it("reports an unreadable history as unknown rather than as empty", async () => {
    // "You have not sent anything yet" over a journal that could not be opened
    // tells the user their sends are gone.
    const failing = harness();
    (failing.service as unknown as { engine(): Promise<unknown> }).engine = async () => {
      throw new Error("journal unreadable");
    };
    expect(await failing.service.history()).toBeNull();
  });
});

describe("what an outcome is allowed to claim", () => {
  it("never reports a no-match reconciliation as a failure", async () => {
    // `reconcile.ts` is explicit that a bounded probe finding nothing is not
    // proof of absence. Reporting it as failed asserts nothing was created,
    // which is the one thing this process cannot know.
    const h = harness();
    expect(await h.service.reconcile("job-1")).toEqual({ status: "ambiguous", code: "no-match" });
  });

  it("reports a throw out of finalize as ambiguous, not failed", async () => {
    const h = harness();
    const started = await h.service.start(ENTRY, RETENTION, 1);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    (h.service as unknown as { engine(): Promise<unknown> }).engine = async () => ({
      end: () => Promise.reject(new Error("the answer was lost")),
    });
    const outcome = await h.service.end(started.jobId);
    expect(outcome.status).toBe("ambiguous");
  });

  it("emits the outcome on the document that asked", async () => {
    const seen: { document: number; status: string }[] = [];
    const built = fakeEngine();
    const service = new StoredSendService({
      origin: "https://relayium.com",
      accountEpoch: () => 1,
      authority: async () => ({
        kind: "ok",
        authority: { accountId: "a", deviceId: "d", bearer: "b", epoch: 1 },
      }),
      options: async () => ({ secrets: {} as never, journalDirectory: "/tmp/unused" }),
      onOutcome: (job, outcome) => seen.push({ document: job.document, status: outcome.status }),
    });
    (service as unknown as { engine(): Promise<unknown> }).engine = async () => built.engine;
    (service as unknown as { built(): unknown }).built = () => built.engine;

    const started = await service.start(ENTRY, RETENTION, 42);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.end(started.jobId);
    expect(seen).toEqual([{ document: 42, status: "published" }]);
  });
});
