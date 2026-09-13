// Who owns a stored receive, and what a teardown is allowed to wait for.
//
// `stored/receive.ts` owns one transfer and is tested on its own. This is about
// the set of them: admission, the fences that abort them, and the two things a
// quit must not do — wait for a human, or return while a helper is still being
// torn down.
//
// Every assertion here is a SIDE EFFECT: whether a destination was opened,
// whether a teardown returned, whether progress reached the host. An
// acknowledgement would prove nothing.

import { describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_STORED_RECEIVES,
  StoredReceiveService,
  type StoredReceiveDeps,
} from "../../src/main/features/stored-receive.js";
import { CleanupRegistry } from "../../src/main/stored/cleanup.js";
import type { StoredObjectFacts, StoredReceiveReport } from "../../src/main/stored/report.js";
import type { StoredReceiveOptions } from "../../src/main/stored/receive.js";

const FACTS: StoredObjectFacts = {
  fileCount: 2,
  totalBytes: 1024,
  burnAfterRead: false,
  expiresAt: 4_000_000_000,
};

const SAVED: StoredReceiveReport = {
  status: "saved",
  facts: FACTS,
  publishedCount: 2,
  residue: false,
  cleanupTicket: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A stand-in for `receiveStoredLink` that behaves like the real one where it
 * matters: it asks for a folder, and it only opens a destination if it gets one.
 */
function fakeReceive(
  over: {
    onGrant?: (granted: boolean) => void;
    progress?: readonly [number, number][];
    hold?: Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const receive = async (options: StoredReceiveOptions): Promise<StoredReceiveReport> => {
    calls.push(options.link);
    const grant = await options.authority.grant(FACTS);
    over.onGrant?.(grant !== null);
    if (grant === null) return { status: "declined" };
    for (const [received, total] of over.progress ?? []) options.onProgress?.(received, total);
    if (over.hold) await over.hold;
    if (options.signal?.aborted === true) return { status: "cancelled", residue: false, cleanupTicket: null };
    return SAVED;
  };
  return { receive, calls };
}

function service(over: Partial<StoredReceiveDeps> = {}) {
  const deps: StoredReceiveDeps = {
    pickDestination: async () => ({ rootPath: "/chosen", authorityId: "stored-0" }),
    receive: fakeReceive().receive,
    cleanups: new CleanupRegistry(),
    ...over,
  };
  return new StoredReceiveService(deps);
}

const LINK = "https://relayium.com/d/abc#k=Zm9v";

const start = (svc: StoredReceiveService, link = LINK) =>
  svc.start({ link, authority: { document: 1 } });

describe("admission", () => {
  it("registers the job before it yields, so a teardown can find it", async () => {
    const held = deferred<void>();
    const svc = service({ receive: fakeReceive({ hold: held.promise }).receive });

    const started = start(svc);
    if ("refusal" in started) throw new Error("refused");
    // Synchronously after `start` returns — no await in between.
    expect(svc.active).toBe(1);
    expect(svc.inventory().active).toBe(1);

    held.resolve();
    await started.outcome;
    expect(svc.active).toBe(0);
  });

  it("refuses beyond its own ceiling rather than growing", async () => {
    const held = deferred<void>();
    const svc = service({ receive: fakeReceive({ hold: held.promise }).receive });
    const running = [];
    for (let i = 0; i < MAX_ACTIVE_STORED_RECEIVES; i += 1) {
      const s = start(svc);
      if ("refusal" in s) throw new Error("refused early");
      running.push(s.outcome);
    }
    expect(start(svc)).toEqual({ refusal: "at-capacity" });

    held.resolve();
    await Promise.all(running);
    // A slot is given back by finishing, never by evicting.
    expect("jobId" in start(svc)).toBe(true);
    await svc.quiesce();
  });

  it("refuses an oversized link before anything parses or fetches it", () => {
    const { receive, calls } = fakeReceive();
    const svc = service({ receive });
    expect(start(svc, `https://relayium.com/d/${"a".repeat(4000)}`)).toEqual({ refusal: "too-long" });
    expect(calls).toEqual([]);
  });

  it("refuses once quiescing, and admits again after Stay", async () => {
    // Found by the real-DOM run rather than by this file: a quit the user
    // refused left stored receive fenced forever, because the resume path knew
    // about the lease service and not about this one. The page's next paste was
    // answered "Relayium is shutting down" by an app that was not.
    const svc = service();
    await svc.quiesce();
    expect(start(svc)).toEqual({ refusal: "unavailable" });

    svc.resume();
    const after = start(svc);
    expect("jobId" in after).toBe(true);
    if ("jobId" in after) await after.outcome;
    await svc.quiesce();
  });
});

describe("a teardown does not wait for a human", () => {
  it("returns while a folder picker is still open, and the late answer opens NOTHING", async () => {
    // The failure this closes: `grant` awaited the dialog, and the teardown
    // joined the job, so quit hung for as long as the picker was on screen.
    const picker = deferred<{ rootPath: string; authorityId: string } | null>();
    const asked = deferred<void>();
    let opened = 0;

    const svc = service({
      pickDestination: () => {
        asked.resolve();
        return picker.promise;
      },
      receive: fakeReceive({
        onGrant: (granted) => {
          if (granted) opened += 1;
        },
      }).receive,
    });

    const started = start(svc);
    if ("refusal" in started) throw new Error("refused");
    await asked.promise;

    // The dialog is open and unanswered. Quiesce must still return.
    let quiesced = false;
    const quiescing = svc.quiesce().then((inventory) => {
      quiesced = true;
      return inventory;
    });
    const inventory = await Promise.race([
      quiescing,
      new Promise((r) => setTimeout(() => r("timed out"), 500)),
    ]);
    expect(inventory).not.toBe("timed out");
    expect(quiesced).toBe(true);

    // And the user answers afterwards. Nothing may open.
    picker.resolve({ rootPath: "/chosen-too-late", authorityId: "stored-0" });
    await started.outcome;
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toBe(0);
  });

  it("counts an unanswered picker as no resource at all", async () => {
    const picker = deferred<null>();
    const asked = deferred<void>();
    const svc = service({
      pickDestination: () => {
        asked.resolve();
        return picker.promise;
      },
    });
    const started = start(svc);
    if ("refusal" in started) throw new Error("refused");
    await asked.promise;

    const inventory = await svc.quiesce();
    // Nothing was created, so nothing is retained. An unopened folder is not a
    // destination and must not be reported as residue.
    expect(inventory.retained).toEqual([]);
    picker.resolve(null);
    expect(await started.outcome).toEqual({ ok: true, report: { status: "declined" } });
  });
});

describe("the fences", () => {
  it("aborts every job of a document that went away, and leaves the others", async () => {
    // Separate holds, so releasing the revoked job says nothing about the one
    // that should still be running.
    const mine = deferred<void>();
    const theirs = deferred<void>();
    let opened = 0;
    const holds = [mine.promise, theirs.promise];
    let index = 0;
    const svc = service({
      receive: async (options) => {
        const hold = holds[index++]!;
        const grant = await options.authority.grant(FACTS);
        if (grant === null) return { status: "declined" };
        opened += 1;
        await hold;
        return options.signal?.aborted === true
          ? { status: "cancelled", residue: false, cleanupTicket: null }
          : SAVED;
      },
    });
    const a = start(svc);
    const b = svc.start({ link: "https://relayium.com/d/b#k=x", authority: { document: 2 } });
    if ("refusal" in a || "refusal" in b) throw new Error("refused");
    await new Promise((r) => setTimeout(r, 5));
    expect(opened).toBe(2);

    const revoking = svc.revokeDocument(1);
    mine.resolve();
    await revoking;

    // Document 1's job ended; document 2's is still running and was never
    // touched.
    expect(await a.outcome).toMatchObject({ ok: true, report: { status: "cancelled" } });
    expect(svc.active).toBe(1);

    theirs.resolve();
    expect(await b.outcome).toMatchObject({ ok: true, report: { status: "saved" } });
  });

  it("SURVIVES an account change, because a public link has no account in it", async () => {
    // The shipped Mac composes it this way: `CloudDownloadModel` holds no
    // account, session or bearer, and `RelayiumApp.swift:888` cancels it from
    // exactly one place — the quit guard. No sign-out path touches it.
    //
    // Killing a stranger's download because the user logged in would be a
    // Windows-only behaviour wearing parity's name. There is deliberately no
    // account fence here to call: this asserts the absence, and that the job
    // runs on through a sign-out and finishes.
    const held = deferred<void>();
    const svc = service({ receive: fakeReceive({ hold: held.promise }).receive });
    const started = start(svc);
    if ("refusal" in started) throw new Error("refused");
    await new Promise((r) => setTimeout(r, 5));

    // Everything an account change does in this process happens here. None of
    // it reaches an anonymous download.
    expect("reconcileAccount" in svc).toBe(false);
    expect(svc.active).toBe(1);

    held.resolve();
    expect(await started.outcome).toMatchObject({ ok: true, report: { status: "saved" } });
  });

  it("stops reporting progress for a job that was cancelled", async () => {
    const gate = deferred<void>();
    const seen: Array<[number, number]> = [];
    const svc = service({
      onProgress: (_id, received, total) => seen.push([received, total]),
      receive: async (options) => {
        const grant = await options.authority.grant(FACTS);
        if (grant === null) return { status: "declined" };
        options.onProgress?.(10, 100);
        await gate.promise;
        // After the cancel. A live-looking bar for a transfer nobody will
        // finish is worse than no bar.
        options.onProgress?.(90, 100);
        return { status: "cancelled", residue: false, cleanupTicket: null };
      },
    });

    const started = start(svc);
    if ("refusal" in started) throw new Error("refused");
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([[10, 100]]);

    svc.cancel(started.jobId);
    gate.resolve();
    await started.outcome;
    expect(seen).toEqual([[10, 100]]);
  });

  it("ignores a cancel for an id it does not have", () => {
    expect(service().cancel("stored-receive-999")).toBe(false);
  });
});

describe("retained cleanups", () => {
  it("has ONE owner per ticket, however many callers ask", async () => {
    const cleanups = new CleanupRegistry();
    const gate = deferred<void>();
    let attempts = 0;
    const ticket = cleanups.retain({
      cancel: async () => {
        attempts += 1;
        await gate.promise;
      },
    } as never);
    if (ticket === null) throw new Error("no ticket");
    const svc = service({ cleanups });

    const first = svc.retryCleanup(ticket);
    const second = svc.retryCleanup(ticket);
    expect(second).toBe(first);
    expect(svc.inventory().retrying).toEqual([ticket]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(attempts).toBe(1);
    expect(svc.inventory().retrying).toEqual([]);
  });

  it("is JOINED by a teardown rather than left running into it", async () => {
    const cleanups = new CleanupRegistry();
    const gate = deferred<void>();
    let finished = false;
    const ticket = cleanups.retain({
      cancel: async () => {
        await gate.promise;
        finished = true;
      },
    } as never);
    if (ticket === null) throw new Error("no ticket");
    const svc = service({ cleanups });

    void svc.retryCleanup(ticket);
    let quiesced = false;
    const quiescing = svc.quiesce().then(() => {
      quiesced = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    // The retry owns a helper child process. A quit that returned here would be
    // returning around it.
    expect(quiesced).toBe(false);

    gate.resolve();
    await quiescing;
    expect(finished).toBe(true);
  });

  it("keeps a ticket whose retry failed, and reports it", async () => {
    const cleanups = new CleanupRegistry();
    const svc = service({ cleanups });
    const ticket = cleanups.retain({
      cancel: async () => {
        throw new Error("still locked");
      },
    } as never);
    if (ticket === null) throw new Error("no ticket");

    expect(await svc.retryCleanup(ticket)).toMatchObject({ outcome: "uncertain" });
    // Kept: the next attempt may be the one that works.
    expect(svc.inventory().retained).toEqual([ticket]);
  });

  it("answers 'unknown' for a ticket nobody holds", async () => {
    expect(await service().retryCleanup("stored-cleanup-404")).toEqual({ outcome: "unknown" });
  });

  // ## The admission fence, proved by what the destination was ASKED to do
  //
  // Every case below counts `cancel()` calls on the retained destination, not
  // the answer this service returned. A refusal that still reached the helper
  // would be a refusal in name only.

  it("starts NOTHING once the service is terminally disposed", async () => {
    const cleanups = new CleanupRegistry();
    let attempts = 0;
    const ticket = cleanups.retain({
      cancel: async () => {
        attempts += 1;
      },
    } as never);
    if (ticket === null) throw new Error("no ticket");
    const svc = service({ cleanups });

    await svc.dispose();
    const answer = await svc.retryCleanup(ticket);

    // The side effect. A helper child process started here is one no teardown
    // is waiting for, in a process that is on its way out.
    expect(attempts).toBe(0);
    expect(answer).toEqual({ outcome: "unavailable" });
    // And ownership was NOT given up: the ticket is exactly where it was.
    expect(svc.inventory().retained).toEqual([ticket]);
    expect(cleanups.tickets).toEqual([ticket]);
    // Terminal means terminal: Stay cannot revive a disposed service.
    svc.resume();
    expect(await svc.retryCleanup(ticket)).toEqual({ outcome: "unavailable" });
    expect(attempts).toBe(0);
  });

  it("starts NOTHING while a quit is being decided, and works again after Stay", async () => {
    const cleanups = new CleanupRegistry();
    let attempts = 0;
    const ticket = cleanups.retain({
      cancel: async () => {
        attempts += 1;
      },
    } as never);
    if (ticket === null) throw new Error("no ticket");
    const svc = service({ cleanups });

    // The quit prompt is on screen. This is exactly when a page offering
    // "try cleaning up again" gets pressed.
    svc.fence();
    expect(await svc.retryCleanup(ticket)).toEqual({ outcome: "unavailable" });
    expect(attempts).toBe(0);
    expect(svc.inventory().retained).toEqual([ticket]);

    // Stay. The retained ticket is retryable again, and this time it runs.
    svc.resume();
    expect(await svc.retryCleanup(ticket)).toEqual({ outcome: "clean" });
    expect(attempts).toBe(1);
    expect(svc.inventory().retained).toEqual([]);
  });

  it("admits nothing new DURING a quiesce, and still joins the retry it owns", async () => {
    const cleanups = new CleanupRegistry();
    const gate = deferred<void>();
    let owned = 0;
    let late = 0;
    const ownedTicket = cleanups.retain({
      cancel: async () => {
        owned += 1;
        await gate.promise;
      },
    } as never);
    const lateTicket = cleanups.retain({
      cancel: async () => {
        late += 1;
      },
    } as never);
    if (ownedTicket === null || lateTicket === null) throw new Error("no ticket");
    const svc = service({ cleanups });

    // Owned BEFORE the teardown, so `retire` can see it.
    const running = svc.retryCleanup(ownedTicket);
    let quiesced = false;
    const quiescing = svc.quiesce().then(() => {
      quiesced = true;
    });
    await new Promise((r) => setTimeout(r, 10));

    // `retire` snapshots the retries it can see. A retry admitted now would own
    // a helper that snapshot never included — the join would return around it.
    expect(await svc.retryCleanup(lateTicket)).toEqual({ outcome: "unavailable" });
    expect(late).toBe(0);
    expect(quiesced).toBe(false);

    gate.resolve();
    await Promise.all([running, quiescing]);
    expect(owned).toBe(1);
    // Both tickets survive the quiesce: one was confirmed clean, the other was
    // never attempted, and neither was dropped.
    expect(cleanups.tickets).toEqual([lateTicket]);
  });

  it("joins an attempt that is already owned rather than refusing it", async () => {
    const cleanups = new CleanupRegistry();
    const gate = deferred<void>();
    let attempts = 0;
    const ticket = cleanups.retain({
      cancel: async () => {
        attempts += 1;
        await gate.promise;
      },
    } as never);
    if (ticket === null) throw new Error("no ticket");
    const svc = service({ cleanups });

    const first = svc.retryCleanup(ticket);
    svc.fence();
    // Already running, already joined by the teardown: answering it is not new
    // work, and refusing would hide a result the caller is entitled to.
    const second = svc.retryCleanup(ticket);
    expect(second).toBe(first);

    gate.resolve();
    expect(await second).toEqual({ outcome: "clean" });
    expect(attempts).toBe(1);
  });
});

describe("dispose", () => {
  it("is terminal, and refuses afterwards", async () => {
    const svc = service();
    await svc.dispose();
    expect(start(svc)).toEqual({ refusal: "unavailable" });
    svc.resume();
    expect(start(svc)).toEqual({ refusal: "unavailable" });
  });

  it("passes the link through untouched, and never keeps it", async () => {
    // The fragment is the key. It goes to the receive and nowhere else — not
    // into the job id, not into the inventory, not into a report.
    const { receive, calls } = fakeReceive();
    const svc = service({ receive });
    const link = "https://relayium.com/d/abc#k=SECRETKEY";
    const started = start(svc, link);
    if ("refusal" in started) throw new Error("refused");
    await started.outcome;

    expect(calls).toEqual([link]);
    expect(started.jobId).not.toContain("SECRETKEY");
    expect(JSON.stringify(svc.inventory())).not.toContain("SECRETKEY");
  });
});

describe("the host's own picker is only asked once the manifest is judged", () => {
  it("passes the object's facts and the asking job, so the host can name the authority", async () => {
    const pick = vi.fn(async () => ({ rootPath: "/chosen", authorityId: "stored-0" }));
    const svc = service({ pickDestination: pick });
    const started = start(svc);
    if ("refusal" in started) throw new Error("refused");
    await started.outcome;
    // The job's own document, not whichever one is current when the dialog
    // closes: a grant is authority the document that asked gave.
    expect(pick).toHaveBeenCalledWith(FACTS, { id: started.jobId, document: 1 });
  });
});

describe("what is delivered carries the document that ASKED", () => {
  it("reports progress and the outcome on the originating generation", async () => {
    const progress: Array<{ id: string; document: number }> = [];
    const outcomes: Array<{ id: string; document: number }> = [];
    const svc = service({
      onProgress: (job) => progress.push({ ...job }),
      onOutcome: (job) => outcomes.push({ ...job }),
      receive: fakeReceive({ progress: [[10, 100]] }).receive,
    });

    const started = svc.start({ link: LINK, authority: { document: 7 } });
    if ("refusal" in started) throw new Error("refused");
    await started.outcome;

    // A host that read its CURRENT generation when delivering would send both
    // of these to whatever document replaced 7. The number has to travel with
    // the job, and a job id is not a substitute: a freshly mounted controller
    // has no id to mismatch against.
    expect(progress).toEqual([{ id: started.jobId, document: 7 }]);
    expect(outcomes).toEqual([{ id: started.jobId, document: 7 }]);
  });

  it("still names the retired document when the outcome is the revocation's own", async () => {
    const held = deferred<void>();
    const outcomes: Array<{ id: string; document: number }> = [];
    const svc = service({
      onOutcome: (job) => outcomes.push({ ...job }),
      receive: fakeReceive({ hold: held.promise }).receive,
    });
    const started = svc.start({ link: LINK, authority: { document: 4 } });
    if ("refusal" in started) throw new Error("refused");
    await new Promise((r) => setTimeout(r, 5));

    // The document goes away, which is what ends this job. Its cancellation is
    // the LAST thing a replacement document must be told about.
    const revoked = svc.revokeDocument(4);
    held.resolve();
    await revoked;

    expect(outcomes).toEqual([{ id: started.jobId, document: 4 }]);
  });
});

describe("the admission fence", () => {
  it("refuses new work without touching what is running", async () => {
    const held = deferred<void>();
    let aborted = false;
    const svc = service({
      receive: async (options) => {
        const grant = await options.authority.grant(FACTS);
        if (grant === null) return { status: "declined" };
        options.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        await held.promise;
        if (options.signal?.aborted === true) return { status: "cancelled", residue: false, cleanupTicket: null };
        return SAVED;
      },
    });

    const running = start(svc);
    if ("refusal" in running) throw new Error("refused");
    await new Promise((r) => setTimeout(r, 5));

    // A quit is being DECIDED. Nothing stops; nothing new starts.
    svc.fence();
    expect(start(svc)).toEqual({ refusal: "unavailable" });
    expect(aborted).toBe(false);
    expect(svc.active).toBe(1);

    held.resolve();
    // The side effect, not the acknowledgement: the fenced transfer finished
    // and saved, because a fence is not a cancel.
    expect(await running.outcome).toMatchObject({ ok: true, report: { status: "saved" } });
  });

  it("is lifted by Stay, and a new receive really starts", async () => {
    const { receive, calls } = fakeReceive();
    const svc = service({ receive });
    svc.fence();
    expect(start(svc)).toEqual({ refusal: "unavailable" });
    expect(calls).toEqual([]);

    svc.resume();
    const started = start(svc);
    if ("refusal" in started) throw new Error("refused after Stay");
    await started.outcome;
    expect(calls).toEqual([LINK]);
  });
});
