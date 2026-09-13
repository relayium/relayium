// Byte progress, and what an observer is allowed to do.
//
// Two questions run through this file. Does the number mean what a UI will
// assume it means — bytes durably ours, monotonic, bounded by the SIGNED length,
// and not a claim that anything verified? And can a listener, by acting or by
// failing, change what the update did?
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  posixScopeProvider,
  type OwnedFile,
  type StagingScope,
  type StagingScopeProvider,
} from "../../src/main/update/custody.js";
import { UpdateService } from "../../src/main/update/service.js";
import { PRODUCTION_TRUST_BASE, type UpdateTrust } from "../../src/main/update/trust.js";
import type { UpdateState } from "../../src/main/update/state.js";

const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});

const CHUNKS = [1000, 1000, 1000, 1096];
const TOTAL = CHUNKS.reduce((sum, size) => sum + size, 0);
const PAYLOAD = new Uint8Array(TOTAL).fill(3);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const RELEASE = "https://github.com/relayium/relayium/releases/download/windows-v0.3.0/Setup.exe";

interface World {
  readonly service: UpdateService;
  readonly seen: UpdateState[];
  readonly dir: string;
}

/** A feed and an artifact delivered in known chunks, with a hook per chunk. */
async function world(
  options: {
    readonly beforeChunk?: (index: number, service: () => UpdateService) => Promise<void> | void;
    readonly payload?: Uint8Array;
    /** What the SIGNED manifest declares, when the body is deliberately not
     *  that length. */
    readonly declaredBytes?: number;
    readonly listener?: (state: UpdateState) => void;
    /** Wraps custody so a test can fail or stall a specific chunk's write. */
    readonly onWrite?: (index: number) => Promise<void> | void;
    /** Holds the journal's own write — the claim recorded before anything is
     *  created — so a test can observe the job while it genuinely has work. */
    readonly onJournalWrite?: (index: number) => Promise<void> | void;
    /** Holds the download's staging-scope open — real work the body reaches
     *  even after a listener has fenced it. */
    readonly onScopeOpen?: () => Promise<void> | void;
  } = {},
): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-update-progress-"));
  owned.push(dir);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const payload = options.payload ?? PAYLOAD;
  const document = {
    schema: 1,
    product: "relayium-windows",
    channel: "stable",
    platform: "windows",
    arch: "x64",
    version: "0.3.0",
    build: 9,
    artifact: {
      url: RELEASE,
      sizeBytes: options.declaredBytes ?? payload.byteLength,
      sha256: SHA,
    },
    publishedAt: 1_789_000_000,
    notesUrl: null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const signature = sign(null, bytes, privateKey).toString("base64url");
  const trust: UpdateTrust = {
    ...PRODUCTION_TRUST_BASE,
    publicKeys: [jwk.x ?? ""],
    expectedPublisher: "CN=Relayium",
  };
  let service!: UpdateService;
  // A scope whose WRITE a test can interfere with. Everything else delegates,
  // so the download runs through the real capability.
  const base = posixScopeProvider;
  const provider: StagingScopeProvider =
    options.onWrite === undefined &&
    options.onJournalWrite === undefined &&
    options.onScopeOpen === undefined
      ? base
      : {
          open: async (appRoot, component) => {
            await options.onScopeOpen?.();
            const scope = await base.open(appRoot, component);
            let writes = 0;
            let records = 0;
            return {
              directory: scope.directory,
              pathFor: (name) => scope.pathFor(name),
              identityOf: (name) => scope.identityOf(name),
              removeOwned: (name, receipt) => scope.removeOwned(name, receipt),
              readBounded: (name, max) => scope.readBounded(name, max),
              hashOwned: (name, receipt, bytes) => scope.hashOwned(name, receipt, bytes),
              commit: (file, to) => scope.commit(file, to),
              close: () => scope.close(),
              createExclusive: async (name): Promise<OwnedFile> => {
                // The journal publishes through a temp in this same scope, so
                // holding its creation holds the record write itself.
                if (name.endsWith(".tmp")) {
                  const record = records;
                  records += 1;
                  await options.onJournalWrite?.(record);
                }
                const file = await scope.createExclusive(name);
                if (!name.endsWith(".exe")) return file;
                return {
                  name: file.name,
                  path: file.path,
                  receipt: file.receipt,
                  sync: () => file.sync(),
                  close: () => file.close(),
                  discard: () => file.discard(),
                  write: async (chunk) => {
                    const index = writes;
                    writes += 1;
                    await options.onWrite?.(index);
                    await file.write(chunk);
                  },
                };
              },
            } satisfies StagingScope;
          },
        };
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    const target = String(url);
    if (target.endsWith(".sig")) return new Response(signature, { status: 200 });
    if (target === trust.feedUrl) {
      return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 });
    }
    let at = 0;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (at >= payload.byteLength) {
          controller.close();
          return;
        }
        await options.beforeChunk?.(index, () => service);
        const size = CHUNKS[index] ?? payload.byteLength - at;
        controller.enqueue(payload.subarray(at, Math.min(at + size, payload.byteLength)));
        at += size;
        index += 1;
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const seen: UpdateState[] = [];
  service = new UpdateService({
    trust,
    engineering: false,
    current: { version: "0.2.0", build: 7 },
    dataDirectory: dir,
    verifier: { verify: async () => "signed-by-expected-publisher" },
    feed: { fetchImpl },
    artifact: { fetchImpl },
    scope: provider,
  });
  service.subscribe(options.listener ?? ((state) => seen.push(state)));
  return { service, seen, dir };
}

const downloads = (seen: readonly UpdateState[]): number[] =>
  seen.filter((state) => state.kind === "downloading").map((state) => state.receivedBytes);

describeOnPosix("byte progress", () => {
  it("reports each chunk once it is WRITTEN, monotonically, up to the signed size", async () => {
    const w = await world();
    expect((await w.service.check()).kind).toBe("update-available");
    expect((await w.service.download()).kind).toBe("ready");
    await w.service.quiesce();

    const counts = downloads(w.seen);
    // Zero on admission, then one report per chunk — after each write, so the
    // last equals the signed length exactly.
    expect(counts).toEqual([0, 1000, 2000, 3000, TOTAL]);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1] as number);
    }
    expect(Math.max(...counts)).toBe(TOTAL);
  });

  it("is a count, not a verdict: the final report is not the ready state", async () => {
    // A UI that treated "received == size" as success would be verifying
    // nothing. The bytes are hashed AFTER the last chunk.
    const w = await world();
    await w.service.check();
    await w.service.download();
    await w.service.quiesce();

    const kinds = w.seen.map((state) => state.kind);
    const lastFull = w.seen.findLastIndex(
      (state) => state.kind === "downloading" && state.receivedBytes === TOTAL,
    );
    expect(lastFull).toBeGreaterThanOrEqual(0);
    // Something came after the full count, and it is what decided the outcome.
    expect(kinds.slice(lastFull + 1)).toContain("ready");
  });

  it("reports nothing beyond the signed length when the body runs long", async () => {
    // The ceiling is the manifest's, not the stream's: an over-long body is cut
    // mid-flight, and no report may describe bytes past what was signed.
    const longer = new Uint8Array(TOTAL + 5000).fill(3);
    // The manifest declares the REAL length; the body sends more. That is the
    // over-long case, and the ceiling that stops it is the manifest's.
    const w = await world({ payload: longer, declaredBytes: TOTAL });
    await w.service.check();
    const state = await w.service.download();
    await w.service.quiesce();
    expect(state.kind).toBe("verify-failed");
    for (const count of downloads(w.seen)) expect(count).toBeLessThanOrEqual(TOTAL);
  });

  it("stops reporting once the download is fenced, and never reports after", async () => {
    // Quiesce mid-stream. Everything after the fence is a stopped download, and
    // a stopped download that still ticks is the phantom progress this exists
    // to prevent.
    let fencedAt = -1;
    const w = await world({
      beforeChunk: async (index, service) => {
        if (index !== 2) return;
        fencedAt = index;
        await service().quiesce();
      },
    });
    await w.service.check();
    await w.service.download();
    const before = w.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fencedAt).toBe(2);
    // Nothing arrived after the run settled.
    expect(w.seen.length).toBe(before);
    // And no report describes more than what had been written when the fence
    // went up.
    expect(Math.max(...downloads(w.seen))).toBeLessThan(TOTAL);
  });
});

describeOnPosix("a report follows a write, or does not happen", () => {
  it("does not report a chunk whose write FAILED", async () => {
    // The number means "durably ours". A chunk that arrived, was hashed, and
    // then could not be written is not progress — and reporting it before the
    // write would make a failing disk look like a moving download.
    const w = await world({
      onWrite: (index) => {
        if (index === 1) throw new Error("the disk said no");
      },
    });
    expect((await w.service.check()).kind).toBe("update-available");
    const state = await w.service.download();
    await w.service.quiesce();

    expect(state.kind).toBe("verify-failed");
    // The first chunk was written and reported; the second was not written, so
    // its cumulative count must never have been published.
    expect(downloads(w.seen)).toEqual([0, 1000]);
  });

  it("drops a report that arrives after the run was fenced", async () => {
    // A write that completes AFTER a quiesce still calls back. That report is
    // about a download that has been stopped, and publishing it would show
    // movement on a job that is over.
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const w = await world({
      onWrite: async (index) => {
        if (index !== 1) return;
        reached();
        await stalled;
      },
    });
    await w.service.check();
    const pending = w.service.download();
    await arrived;

    // Fence while the second write is still in flight. The join is bounded
    // because the job is blocked inside custody by construction.
    await w.service.quiesce(50);
    const beforeRelease = w.seen.length;
    release();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The late write's report was dropped: no `downloading` state was published
    // after the fence, and no count exceeds what had been written before it.
    expect(downloads(w.seen)).toEqual([0, 1000]);
    const afterFence = w.seen.slice(beforeRelease);
    expect(afterFence.map((state) => state.kind)).not.toContain("downloading");
    // What DID arrive is the refusal. A stopped run must still be able to say
    // it stopped — that is the one thing the fence deliberately lets through.
    expect(afterFence.every((state) => state.kind === "verify-failed")).toBe(true);
  });
});

describeOnPosix("a listener that reaches back", () => {
  it("is told joined:false while the job it named still holds real work", async () => {
    // The reentrancy a listener holding ONLY a state can still reach: it closed
    // over the service and calls `quiesce`.
    //
    // The work is held on purpose, inside the journal's own write — the claim
    // this download must record before it creates anything. While that is held
    // the job is unambiguously running, so a bounded join must report
    // `joined: false`. There is no promise-ordering ambiguity to hide behind:
    // the answer is given while the barrier is still closed.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });

    let reported: { readonly joined: boolean } | null = null;
    let asked: Promise<unknown> | null = null;
    let armed = false;

    const w = await world({
      onScopeOpen: async () => {
        // Armed only for the download. A listener that fences the job aborts it
        // before it can claim anything, so the barrier has to sit on work the
        // body reaches regardless — opening the staging scope, which happens
        // before any fence check.
        if (!armed) return;
        armed = false;
        entered();
        await held;
      },
      listener: (state) => {
        if (state.kind !== "downloading" || asked !== null) return;
        asked = w.service.quiesce(20).then((result) => {
          reported = result;
        });
      },
    });

    expect((await w.service.check()).kind).toBe("update-available");
    armed = true;
    const pending = w.service.download();

    // The barrier is closed: the job is inside real staging work.
    await inside;
    await asked;
    // Answered while the work was still held, and answered honestly.
    expect(reported).toEqual({ joined: false });

    // A PATIENT join, issued while the same work is still held. This is what
    // separates a real join from a flag: it must not answer at all until the
    // job finishes, and must then say it joined. An implementation that read
    // "a slot is taken" and returned `false` immediately would answer here
    // straight away, and an implementation that saw no registered promise
    // would answer `true` while the work was still running.
    let patientSettled = false;
    let downloadSettled = false;
    const patient = w.service.quiesce(5_000).then((result) => {
      patientSettled = true;
      return result;
    });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(patientSettled).toBe(false);

    release();
    const state = await pending;
    downloadSettled = true;
    expect(await patient).toEqual({ joined: true });
    // Answered after the job it named, not before it.
    expect(downloadSettled).toBe(true);
    expect(state.kind).not.toBe("ready");

    // And with nothing outstanding, the same call is truthful the other way.
    expect(await w.service.quiesce(1_000)).toEqual({ joined: true });
  });
});

describeOnPosix("what an observer cannot do", () => {
  it("cannot fail the download or skip its cleanup by throwing", async () => {
    // Every notification throws. The download must still complete, verify, and
    // leave a committed record.
    let calls = 0;
    const w = await world({
      listener: () => {
        calls += 1;
        throw new Error("observer is broken");
      },
    });
    expect((await w.service.check()).kind).toBe("update-available");
    expect((await w.service.download()).kind).toBe("ready");
    await w.service.quiesce();
    expect(calls).toBeGreaterThan(4);
    // The service's own record is intact.
    expect(w.service.current.kind).toBe("ready");
  });

  it("cannot edit the state it is handed", async () => {
    const w = await world();
    await w.service.check();
    const handed = w.seen[w.seen.length - 1] as { kind: string };
    expect(Object.isFrozen(handed)).toBe(true);
    expect(() => {
      (handed as { kind: string }).kind = "ready";
    }).toThrow();

    // NESTED too. A top-level freeze would leave the candidate — the object a
    // UI actually reads — editable, and a listener could rewrite the version or
    // the size this service reported.
    const withCandidate = w.seen.find((state) => "candidate" in state) as unknown as {
      candidate: { version: string };
    };
    expect(withCandidate).toBeDefined();
    expect(Object.isFrozen(withCandidate.candidate)).toBe(true);
    expect(() => {
      withCandidate.candidate.version = "9.9.9";
    }).toThrow();

    // And the service still says what actually happened.
    expect(w.service.current.kind).toBe("update-available");
  });

  it("is handed one frozen argument — which is isolation, NOT a restriction", async () => {
    // Worth stating precisely, because the weaker claim is tempting and wrong:
    // a listener closes over whatever its author gives it, so it CAN call
    // `quiesce`, `check` or `download`, and it can unsubscribe itself. Passing
    // only a state restricts nothing.
    //
    // What actually holds is isolation, not restriction:
    //
    //   * the argument is deeply frozen, so a listener cannot edit this
    //     service's record of what happened;
    //   * any command it issues goes through the SAME single-flight admission
    //     as any other caller — a reentrant `check` during a download is
    //     refused, not queued;
    //   * a `quiesce` it calls joins the job that is actually running, because
    //     the admission is registered before anything is published;
    //   * and the fences in `progressed`/`publish` mean nothing it triggers can
    //     make a stopped job appear to still be moving.
    const args: unknown[][] = [];
    const w = await world({
      listener: (...rest: unknown[]) => {
        args.push(rest);
      },
    });
    await w.service.check();
    expect(args.length).toBeGreaterThan(0);
    for (const call of args) {
      expect(call).toHaveLength(1);
      expect(Object.isFrozen(call[0])).toBe(true);
    }
  });

  it("cannot start a second job by reacting to the first", async () => {
    // The isolation that matters when a listener does reach back: its command
    // meets the same admission gate as anyone else's.
    const w = await world({});
    await w.service.check();
    let reentrant: UpdateState | null = null;
    const unsubscribe = w.service.subscribe((state) => {
      if (state.kind !== "downloading" || reentrant !== null) return;
      // Synchronous, from inside the notification.
      void w.service.check("manual").then((result) => {
        reentrant = result;
      });
    });
    const state = await w.service.download();
    unsubscribe();
    await w.service.quiesce();

    // The download completed on its own terms; the reentrant check was refused
    // rather than queued or interleaved.
    expect(state.kind).toBe("ready");
    expect(reentrant).not.toBeNull();
    expect((reentrant as unknown as UpdateState).kind).not.toBe("checking");
  });

  it("stops hearing immediately when it unsubscribes from inside a callback", async () => {
    // A UI tearing down mid-transition must not receive another callback after
    // it has gone. Removal takes effect for every later notification, including
    // ones already in the same transition sequence.
    const w = await world({});
    const heard: string[] = [];
    const unsubscribe = w.service.subscribe((state) => {
      heard.push(state.kind);
      if (state.kind === "downloading") unsubscribe();
    });
    await w.service.check();
    await w.service.download();
    await w.service.quiesce();

    expect(heard).toContain("downloading");
    // Nothing after the first `downloading`: not the byte reports, not `ready`.
    expect(heard.filter((kind) => kind === "downloading")).toHaveLength(1);
    expect(heard).not.toContain("ready");
  });

  it("hands out residue that cannot be edited", async () => {
    // `residue()` reports this service's OWN in-memory records. Live references
    // would let a caller change what the installation believes it still owes.
    const w = await world({});
    const entries = await w.service.residue();
    expect(Object.isFrozen(entries)).toBe(true);
    for (const entry of entries) expect(Object.isFrozen(entry)).toBe(true);
  });

  it("stops hearing anything once it unsubscribes, and unsubscribing twice is safe", async () => {
    const w = await world();
    const heard: UpdateState[] = [];
    const unsubscribe = w.service.subscribe((state) => heard.push(state));
    await w.service.check();
    const afterCheck = heard.length;
    expect(afterCheck).toBeGreaterThan(0);

    unsubscribe();
    unsubscribe();
    await w.service.download();
    await w.service.quiesce();
    expect(heard.length).toBe(afterCheck);
    // The other subscriber kept hearing, so the removal was of exactly one.
    expect(w.seen.length).toBeGreaterThan(afterCheck);
  });

  it("never hears from a half-built service", async () => {
    // A listener cannot exist before the constructor returns, so the initial
    // state is assigned without notifying. What a subscriber sees first is a
    // TRANSITION, never the constructor's own assignment.
    const w = await world();
    expect(w.seen).toEqual([]);
    expect(w.service.current.kind).toBe("idle");
    await w.service.check();
    expect(w.seen[0]?.kind).toBe("checking");
  });
});
