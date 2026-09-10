// Stored SEND, as a feature of this process.
//
// `stored/upload/**` is the accepted engine: it owns the session, the offset
// algebra, the retained replay window, the durable key custody, the journal and
// finalization. It does NOT own the set of jobs a running app has, which
// account they belong to, when a quit may refuse a new one, or what a page is
// allowed to ask for — the same division `features/stored-receive.ts` and
// `features/inbox.ts` draw, for the same reasons.
//
// ## What crosses to the renderer, and the one thing that is a widening
//
// The renderer holds the user's `File` objects and runs the PRODUCTION shared
// `encryptFiles`. Main receives ciphertext frames. So there is no arbitrary-path
// reader in main and none is needed.
//
// The cost of that arrangement is stated rather than glossed: the content key
// for one job crosses main→renderer, because the renderer is what encrypts. It
// is released by the engine's own fence, to ONE document, for ONE job, and is
// revoked the moment the job settles or that document goes away. This is not
// "the key never reaches the renderer" — that would be false here, and it is
// true on the receive side for a reason that does not apply to sending.
//
// The BEARER is a different matter and never crosses at all.
//
// ## Ambiguity is a first-class outcome
//
// A finalize whose answer was lost may or may not have published an object.
// The engine reports `ambiguous`, keeps the key and keeps the record. Nothing
// here upgrades that to a success: there is no object id to put in a link, and
// composing one would hand the user a URL that opens nothing. The page is
// offered a re-check instead.

import {
  MAX_ACTIVE_JOBS,
  StoredUploadService,
  type FrameExpectation,
  type StoredUploadServiceOptions,
} from "../stored/upload/service.js";
import type { CipherFrame, UploadOutcome } from "../stored/upload/engine.js";
import type { UploadRecord } from "../stored/upload/journal.js";
import type { UploadDescriptor } from "../stored/upload/plan.js";
import type { UploadRetention } from "../stored/upload/transport.js";
import type {
  StoredSendHistoryEntry,
  StoredSendOutcome,
  StoredSendStart,
} from "../../shared/ipc-contract.js";

/** The authority a send is admitted under. Captured, never looked up later. */
export interface SendAuthority {
  readonly accountId: string;
  readonly deviceId: string;
  readonly bearer: string;
  readonly epoch: number;
  /** The document that asked. One document, one job. */
  readonly document: number;
}

export type SendAuthorityResult =
  | { readonly kind: "ok"; readonly authority: Omit<SendAuthority, "document"> }
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" };

export interface StoredSendDeps {
  readonly origin: string;
  /**
   * Everything the engine needs, resolved on first use.
   *
   * A function because the encrypted store and the data root are both
   * asynchronous and the root can fail; see `engine()`.
   */
  options(): Promise<StoredUploadServiceOptions>;
  /**
   * The account authority for a send, read FRESH at admission.
   *
   * Everything a job is fenced on comes from here, including the bearer — which
   * this feature holds only for as long as it takes to hand to the engine, and
   * never publishes.
   */
  authority(): Promise<SendAuthorityResult>;
  /** The current account epoch, read synchronously by the change watcher. */
  accountEpoch(): number;
  /** Progress and outcomes, emitted on the document that asked. */
  onProgress?(job: { readonly id: string; readonly document: number }, committed: number, total: number): void;
  onOutcome?(job: { readonly id: string; readonly document: number }, outcome: StoredSendOutcome): void;
  reportFailure?(err: unknown): void;
  /**
   * Put text on the system clipboard.
   *
   * The only caller is `copyLink`, which composes the link itself from custody
   * plus the server's object id. Nothing here takes a caller-supplied string:
   * `window.ts` denies every renderer permission including the browser
   * clipboard, and the answer to that is a narrow action main performs, not a
   * bridge that writes whatever a page hands it.
   */
  writeClipboard?(text: string): void;
  /** The document generation on screen, for the copy's liveness check. */
  currentDocument?(): number;
  /**
   * The engine's own seams, declared here so a host can name them.
   *
   * Folded into `options()` in production. Kept as a type so the composition
   * point has something to be `Pick`ed from rather than restating the four
   * names in another file.
   */
  readonly upload?: Pick<StoredUploadServiceOptions, "transportFactory" | "sourceFactory" | "runtime" | "now">;
}

/**
 * One ADMISSION — registered before the authority is even read.
 *
 * ## Why this exists before a job id does
 *
 * `start` reads the credential, builds the engine on first use and then calls
 * into it: three awaits before anything is registered. A registry that only
 * held started jobs was empty for the whole of that window, so a dispose, a
 * sign-out or a reload landing in it found nothing to revoke, returned as
 * though the app were idle — and the parked `start` then went on to open an
 * upload under the retired authority and hand its content key to a document
 * that no longer exists.
 *
 * So the admission is the unit, it is registered synchronously, and the job id
 * is written into it when there is one. `control` is what a teardown aborts;
 * every step of `start` re-checks it, and the engine job is cancelled if the
 * abort arrived after it was created.
 */
interface Admission {
  /** Null until the engine has given this admission a job. */
  jobId: string | null;
  readonly document: number;
  readonly epoch: number;
  readonly control: AbortController;
  /**
   * Resolved when the work has actually STOPPED, whatever stopped it.
   *
   * Resolved by exactly one place — `retire` — because it used to be resolved
   * only by the renderer-driven `end`/`cancel` path. A job the renderer never
   * finished, which is precisely what a reload or a sign-out leaves behind, then
   * had a promise nobody would ever resolve, and every teardown that joined it
   * hung forever.
   */
  readonly settled: Promise<void>;
  markSettled(): void;
}

/** An auxiliary operation: history, link, delete, reconcile. */
interface Auxiliary {
  readonly epoch: number;
  readonly control: AbortController;
  readonly settled: Promise<void>;
  markSettled(): void;
}

/** What this feature is holding, for the quit prompt and the risk snapshot. */
export interface StoredSendInventory {
  /** Jobs still in flight. Each is an upload the user would lose. */
  readonly active: number;
  /** Uploads whose outcome this process could not establish. */
  readonly unresolved: number;
}

export class StoredSendService {
  /**
   * The engine, built on FIRST USE.
   *
   * Not in the constructor, because building it needs the encrypted store and
   * the resolved data root — both asynchronous, and the data root can fail
   * outright on a host this product does not ship to. A registration that
   * awaited either would take the whole app down before a window existed; the
   * Inbox learned that the expensive way and this follows it.
   */
  #uploads: StoredUploadService | null = null;
  #building: Promise<StoredUploadService> | null = null;
  /** Every admission, from before the authority is read until it has stopped. */
  readonly #admissions = new Set<Admission>();
  /** Every history/link/delete/reconcile call in flight. */
  readonly #auxiliary = new Set<Auxiliary>();
  /** See `StoredReceiveService.fenced`: one flag, both reasons. */
  #fenced = false;
  #disposed = false;

  constructor(private readonly deps: StoredSendDeps) {}

  /**
   * The engine, memoised on the PROMISE so concurrent callers share one build,
   * and cleared on failure so a transient problem is retryable.
   */
  private engine(): Promise<StoredUploadService> {
    const built = this.#uploads;
    if (built !== null) return Promise.resolve(built);
    const pending = this.#building;
    if (pending !== null) return pending;
    const run = this.deps.options().then((options) => {
      const service = new StoredUploadService(options);
      this.#uploads = service;
      return service;
    });
    this.#building = run;
    run.catch(() => {
      if (this.#building === run) this.#building = null;
    });
    return run;
  }

  /** The engine if it has been built, for a teardown that must not build one. */
  private built(): StoredUploadService | null {
    return this.#uploads;
  }

  /** True while any upload is running — for the quit risk snapshot. */
  get active(): number {
    return this.#admissions.size;
  }

  /**
   * Stop admitting new sends. Nothing running is touched.
   *
   * Synchronous, and set together with every other feature's fence in one tick:
   * a quit asks the user a question and then waits for a human, and an upload
   * admitted in that window is one the prompt never mentioned.
   */
  fence(): void {
    this.#fenced = true;
  }

  /** The user stayed. Admissions are open again; nothing stopped comes back. */
  resume(): void {
    if (!this.#disposed) this.#fenced = false;
  }

  /**
   * Stop admitting, revoke every job, and JOIN them. Recoverable.
   *
   * Every fence is revoked synchronously for every job BEFORE any join, which
   * is the rule the engine's own `reconcileAccount` states: a loop that awaited
   * each teardown in turn would leave later jobs live — and holding a bearer —
   * while the first was still unwinding.
   */
  async quiesce(): Promise<StoredSendInventory> {
    this.fence();
    // Both, and both aborted before either is joined: a link or a delete in
    // flight holds the BEARER just as a job does.
    const auxiliary = [...this.#auxiliary];
    for (const operation of auxiliary) operation.control.abort();
    await Promise.all([this.revokeAll("cancelled"), this.retireAuxiliary(auxiliary)]);
    return this.inventory();
  }

  /** Terminal. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#fenced = true;
    const auxiliary = [...this.#auxiliary];
    for (const operation of auxiliary) operation.control.abort();
    await Promise.all([this.revokeAll("cancelled"), this.retireAuxiliary(auxiliary)]);
  }

  private async revokeAll(reason: "cancelled" | "account-changed"): Promise<void> {
    await this.retireAll([...this.#admissions], reason);
  }

  /**
   * Stop a set of admissions and JOIN them.
   *
   * Aborted synchronously for every one FIRST, then joined — the rule stated in
   * `StoredReceiveService.retire` and in the engine's own `reconcileAccount`.
   * The registrations are kept until the joins complete, so a second teardown
   * arriving meanwhile joins the same work rather than concluding it is idle.
   *
   * The BUILT engine only: a teardown that constructed one would open a secret
   * store and a journal on the way out of the process. An admission whose start
   * never reached the engine has no job to revoke and is stopped by its abort.
   */
  private async retireAll(
    doomed: readonly Admission[],
    reason: "cancelled" | "account-changed" | "document-revoked",
  ): Promise<void> {
    if (doomed.length === 0) return;
    for (const admission of doomed) admission.control.abort();
    const engine = this.built();
    const stopping = doomed.map(async (admission) => {
      const jobId = admission.jobId;
      if (engine === null || jobId === null) return;
      await engine.revoke(jobId, reason).catch(() => null);
      // The engine has finished with it, so this admission has genuinely
      // stopped even if the renderer never calls `end`.
      this.retire(admission);
    });
    await Promise.allSettled([...stopping, ...doomed.map((admission) => admission.settled)]);
    // Only now: a registration removed before its join would let a concurrent
    // teardown report an idle app over work that was still unwinding.
    for (const admission of doomed) this.#admissions.delete(admission);
  }

  /** Resolve one admission's join, exactly once, whatever stopped it. */
  private retire(admission: Admission): void {
    admission.markSettled();
  }

  /** Stop and join every auxiliary operation. Same order: abort all, then join. */
  private async retireAuxiliary(doomed: readonly Auxiliary[]): Promise<void> {
    if (doomed.length === 0) return;
    for (const operation of doomed) operation.control.abort();
    await Promise.allSettled(doomed.map((operation) => operation.settled));
    for (const operation of doomed) this.#auxiliary.delete(operation);
  }

  /** What this process is holding, for the quit prompt. */
  inventory(): StoredSendInventory {
    return { active: this.#admissions.size, unresolved: this.#unresolved };
  }

  /**
   * How many uploads this account cannot account for.
   *
   * Cached from the last history read rather than re-read here: `inventory` is
   * called from a synchronous risk snapshot, and a quit prompt must not wait on
   * a file read to say what is at stake.
   */
  #unresolved = 0;

  // -------------------------------------------------------------------------
  // One send
  // -------------------------------------------------------------------------

  /**
   * Begin an upload, or refuse.
   *
   * The fence and the capacity bound are checked SYNCHRONOUSLY before the first
   * await. The authority is captured once, here, and travels with the job:
   * nothing downstream reads "the current account" again.
   */
  async start(
    descriptors: readonly UploadDescriptor[],
    retention: UploadRetention,
    document: number,
  ): Promise<StoredSendStart> {
    if (this.#disposed || this.#fenced) return { ok: false, refusal: "unavailable" };
    if (this.#admissions.size >= MAX_ACTIVE_JOBS) return { ok: false, refusal: "at-capacity" };
    if (descriptors.length === 0) return { ok: false, refusal: "nothing-picked" };

    // ---- REGISTERED SYNCHRONOUSLY, before the first await ------------------
    //
    // Everything below yields — the credential, the device lookup, building the
    // engine, and the engine's own start. A teardown arriving in ANY of those
    // windows has to be able to find this and stop it; a registry that only
    // held started jobs was empty for all of them.
    //
    // Registering here also makes the capacity bound real: eight concurrent
    // starts all passed the check above when none of them had registered yet.
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const admission: Admission = {
      jobId: null,
      document,
      epoch: this.deps.accountEpoch(),
      control: new AbortController(),
      settled,
      markSettled,
    };
    this.#admissions.add(admission);
    // ------------------------------------------------------------------------

    try {
      const authority = await this.deps.authority();
      if (admission.control.signal.aborted) return { ok: false, refusal: "unavailable" };
      if (authority.kind === "signed-out") return { ok: false, refusal: "signed-out" };
      if (authority.kind === "unavailable") return { ok: false, refusal: "unavailable" };
      // The epoch the credential was read under must still be the one this
      // admission was taken under, or the upload would open under an account
      // that replaced the one the user was looking at.
      if (authority.authority.epoch !== admission.epoch) return { ok: false, refusal: "unavailable" };
      if (this.#disposed || this.#fenced) return { ok: false, refusal: "unavailable" };

      const engine = await this.engine();
      // Re-checked after the BUILD, which opens a secret store and a journal and
      // is the longest of these windows on a cold start.
      if (admission.control.signal.aborted || this.#disposed || this.#fenced) {
        return { ok: false, refusal: "unavailable" };
      }

      const result = await engine.start({
        authority: {
          accountId: authority.authority.accountId,
          deviceId: authority.authority.deviceId,
          // The engine's fence keys the released content key on this, so it is
          // the document's own identity rather than a job-local name.
          documentId: String(document),
          origin: this.deps.origin,
          bearer: authority.authority.bearer,
        },
        descriptors,
        retention,
        onProgress: (committed: number, total: number) => {
          if (admission.control.signal.aborted) return;
          this.deps.onProgress?.({ id: admission.jobId ?? "", document }, committed, total);
        },
      });

      if (!result.ok) {
        return {
          ok: false,
          refusal: "refused",
          code: result.refusal.code,
          manifest: result.refusal.refusal,
        };
      }

      // The engine created a job. From here the admission owns it, so a
      // teardown revokes it rather than leaving it running.
      admission.jobId = result.jobId;

      // ## The abort that landed WHILE the engine was starting
      //
      // The job now exists on the server side of this process. Returning its
      // content key to a document that has been replaced — or after a quit was
      // agreed — is exactly the emission root's probe caught, so the job is
      // cancelled and nothing is handed back.
      if (admission.control.signal.aborted || this.#disposed || this.#fenced) {
        await engine.revoke(result.jobId, "cancelled").catch(() => null);
        // Cleared, so the `finally` below retires this admission. Leaving the
        // id set marked it as owning live work that nothing would ever settle,
        // and a teardown joining it waited forever — the same hang, one window
        // later. It owns nothing now: the job was just revoked.
        admission.jobId = null;
        return { ok: false, refusal: "unavailable" };
      }

      return {
        ok: true,
        jobId: result.jobId,
        // The one secret that crosses. See the header.
        contentKey: result.contentKey,
        expects: result.expects,
        cipherBytes: result.cipherBytes,
        fileCount: result.fileCount,
      };
    } catch (err) {
      this.deps.reportFailure?.(err);
      return { ok: false, refusal: "internal" };
    } finally {
      // A refusal ends this admission here; a success leaves it registered and
      // it is retired by `settle`, by a teardown, or by a revocation. The
      // distinction is `jobId`: an admission with one still owns live work.
      if (admission.jobId === null) {
        this.#admissions.delete(admission);
        this.retire(admission);
      }
    }
  }

  /** Hand over one ciphertext frame and learn what is owed next. */
  async feed(jobId: string, frame: CipherFrame): Promise<{ readonly expects: FrameExpectation | null }> {
    return (await this.engine()).feed(jobId, frame);
  }

  /** Finalize. The outcome is durable before it is reported. */
  async end(jobId: string): Promise<StoredSendOutcome> {
    return this.settle(jobId, async () => (await this.engine()).end(jobId));
  }

  /** The user pressed Cancel. */
  async cancel(jobId: string): Promise<StoredSendOutcome> {
    return this.settle(jobId, async () => (await this.engine()).cancel(jobId));
  }

  private async settle(jobId: string, run: () => Promise<UploadOutcome>): Promise<StoredSendOutcome> {
    const job = [...this.#admissions].find((entry) => entry.jobId === jobId);
    try {
      const outcome = await run();
      const reported = describeOutcome(outcome);
      if (job !== undefined) this.deps.onOutcome?.({ id: jobId, document: job.document }, reported);
      return reported;
    } catch (err) {
      this.deps.reportFailure?.(err);
      // NOT reported as failed: a throw here says this process could not
      // establish what happened, which is exactly what `ambiguous` means. The
      // record and the key are retained by the engine either way.
      const reported: StoredSendOutcome = { status: "ambiguous", code: "internal" };
      if (job !== undefined) this.deps.onOutcome?.({ id: jobId, document: job.document }, reported);
      return reported;
    } finally {
      // Released only once the engine has actually settled it, so a teardown
      // joining this job is joining something that has stopped.
      if (job !== undefined) {
        this.#admissions.delete(job);
        this.retire(job);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Authority changes
  // -------------------------------------------------------------------------

  /**
   * The account moved. Every job under the old one is revoked and joined.
   *
   * The engine's `reconcileAccount` revokes every mismatched fence in one
   * synchronous pass before joining any of them; this mirrors that for the
   * host's own registry so the two cannot disagree about what is still live.
   */
  async onAccountChanged(): Promise<void> {
    const epoch = this.deps.accountEpoch();
    // Admissions that have not read an authority yet are included: the epoch
    // they were taken under is already stale, and letting one finish would open
    // an upload for an account the user has left.
    const doomed = [...this.#admissions].filter((admission) => admission.epoch !== epoch);
    const auxiliary = [...this.#auxiliary].filter((operation) => operation.epoch !== epoch);
    for (const operation of auxiliary) operation.control.abort();
    // The unresolved count belongs to the account that is leaving. Carried
    // forward, it would put the old account's unfinished uploads into the new
    // account's quit prompt — a number about somebody else's data.
    this.#unresolved = 0;
    await Promise.all([this.retireAll(doomed, "account-changed"), this.retireAuxiliary(auxiliary)]);
  }

  /**
   * A document went away — a reload, or a crashed renderer.
   *
   * Unlike Inbox receiving, a send genuinely belongs to its page: the page holds
   * the `File` objects and produces the ciphertext, so a document that is gone
   * cannot finish what it started. The engine revokes the key exposure with it.
   */
  async revokeDocument(generation: number): Promise<void> {
    const doomed = [...this.#admissions].filter((admission) => admission.document === generation);
    const engine = this.built();
    await Promise.all([
      this.retireAll(doomed, "document-revoked"),
      // The engine's own pass too: it revokes the key exposure for this
      // document, including for a job this registry never learned the id of.
      engine === null ? Promise.resolve() : engine.revokeDocument(String(generation)).catch(() => undefined),
    ]);
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * This account's sends, newest first.
   *
   * Account-isolated by the engine, and narrowed again here: what reaches the
   * page is counts, closed codes and an object id — never a key, never a link.
   * A link is composed on demand and only for a proven-published record.
   */
  /**
   * Run one auxiliary operation, owned so a teardown can stop and join it.
   *
   * Registered synchronously and re-checked after every await, for the same
   * reason a job is: each of these reads local state first and only afterwards
   * uses the BEARER or exposes the KEY, so each has a window in which a
   * sign-out or a quit must be able to stop it. An unregistered one is a
   * request a quiesce reports as finished while it is still going out.
   */
  private async auxiliary<T>(
    body: (check: () => boolean) => Promise<T>,
    refused: T,
  ): Promise<T> {
    if (this.#disposed || this.#fenced) return refused;
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const operation: Auxiliary = {
      epoch: this.deps.accountEpoch(),
      control: new AbortController(),
      settled,
      markSettled,
    };
    this.#auxiliary.add(operation);
    /** Still wanted: not aborted, not fenced, and still the same account. */
    const alive = (): boolean =>
      !operation.control.signal.aborted &&
      !this.#disposed &&
      !this.#fenced &&
      this.deps.accountEpoch() === operation.epoch;
    try {
      const answer = await body(alive);
      return alive() ? answer : refused;
    } catch (err) {
      this.deps.reportFailure?.(err);
      return refused;
    } finally {
      this.#auxiliary.delete(operation);
      operation.markSettled();
    }
  }

  /**
   * This account's sends, newest first.
   *
   * `null` means the record could not be READ, which is emphatically not an
   * empty history: showing "you have not sent anything yet" over a journal this
   * process failed to open would tell the user their sends are gone.
   */
  async history(): Promise<readonly StoredSendHistoryEntry[] | null> {
    return this.auxiliary(async (alive) => {
      const authority = await this.deps.authority();
      // Signed out is EMPTY, not unknown: there is no account, so there is
      // genuinely nothing of the user's to list. Only a store this process
      // could not read is unknown — conflating the two would put a "could not
      // be read" warning in front of somebody who has simply not signed in.
      if (authority.kind === "signed-out") return [];
      if (authority.kind !== "ok" || !alive()) return null;
      const engine = await this.engine();
      // ## The boundary a nested `await` hid
      //
      // Building the engine opens a secret store and a journal, and on a cold
      // start it is the longest wait here. A dispose or an account revocation
      // landing in it found nothing admitted and returned — and the resumed
      // call then reached the backend anyway. So the check is AFTER the build
      // and immediately BEFORE the side effect, with nothing awaited between.
      if (!alive()) return null;
      const records = await engine.history(authority.authority.accountId);
      if (!alive()) return null;
      this.#unresolved = records.filter((record) => record.state === "ambiguous").length;
      return records.map(describeRecord);
    }, null);
  }

  /**
   * The shareable link for one published send.
   *
   * Composed by the engine from custody plus the server's object id, and never
   * stored: a link IS the key, so a persisted one would be a second copy of the
   * secret under a name that looks harmless. A link that came back after a
   * sign-out or a quit is DROPPED rather than returned.
   */
  async link(jobId: string): Promise<string | null> {
    return this.auxiliary(async (alive) => {
      const authority = await this.deps.authority();
      if (authority.kind !== "ok" || !alive()) return null;
      const engine = await this.engine();
      if (!alive()) return null;
      const composed = await engine.linkFor(jobId, authority.authority.accountId, this.deps.origin);
      // The check that matters: the key is already in this string.
      return alive() ? composed : null;
    }, null);
  }

  /**
   * Put one published send's link on the clipboard, from MAIN.
   *
   * The link IS the key, so this is the same shape the Inbox message copy uses
   * and for the same reason: the page names a JOB, main composes the link under
   * the live account and writes it. A page cannot ask for anything else to be
   * put on the clipboard.
   *
   * Fenced, account-checked and DOCUMENT-checked immediately before the
   * synchronous write. A copy that resumed after a sign-out would put the
   * previous account's key on the clipboard of whoever is using the app now;
   * one that resumed after a reload would let a retired page reach outside the
   * app.
   */
  async copyLink(jobId: string, document: number): Promise<"copied" | "unavailable"> {
    const write = this.deps.writeClipboard;
    if (write === undefined) return "unavailable";
    return this.auxiliary(async (alive) => {
      const authority = await this.deps.authority();
      if (authority.kind !== "ok" || !alive()) return "unavailable" as const;
      const engine = await this.engine();
      if (!alive()) return "unavailable" as const;
      const composed = await engine.linkFor(jobId, authority.authority.accountId, this.deps.origin);
      if (composed === null) return "unavailable" as const;
      // The checks that matter: the key is already in this string, and the
      // write below is the irreversible half.
      if (!alive()) return "unavailable" as const;
      if ((this.deps.currentDocument?.() ?? document) !== document) return "unavailable" as const;
      write(composed);
      return "copied" as const;
    }, "unavailable");
  }

  /** Delete one published object. The key is retired only after the server
   *  confirms the object is gone or absent — never before. */
  async remove(jobId: string): Promise<"deleted" | "absent" | "not-found" | "failed"> {
    return this.auxiliary(async (alive) => {
      const authority = await this.deps.authority();
      if (authority.kind !== "ok") return "not-found" as const;
      if (!alive()) return "failed" as const;
      const engine = await this.engine();
      // The check root's third probe caught: a dispose during a deferred build
      // must not be followed by a NEW delete. An already-running one may finish
      // — the object is being removed either way — but nothing new starts.
      if (!alive()) return "failed" as const;
      return engine.deleteObject(jobId, authority.authority.accountId, {
        origin: this.deps.origin,
        bearer: authority.authority.bearer,
      });
    }, "failed");
  }

  /** Ask again what an ambiguous send actually did. Never re-uploads. */
  async reconcile(jobId: string): Promise<StoredSendOutcome> {
    const unknown: StoredSendOutcome = { status: "ambiguous", code: "cancelled" };
    return this.auxiliary(async (alive) => {
      const authority = await this.deps.authority();
      if (authority.kind !== "ok" || !alive()) return unknown;
      const engine = await this.engine();
      if (!alive()) return unknown;
      const outcome = await engine.reconcile(jobId, authority.authority.accountId, {
        origin: this.deps.origin,
        bearer: authority.authority.bearer,
      });
      if (!alive()) return unknown;
      if (outcome.result === "resolved" && outcome.record.objectId !== null) {
        return {
          status: "published",
          objectId: outcome.record.objectId,
          expiresAt: outcome.record.expiresAt,
        } as const;
      }
      // ## `no-match` is NOT proof of absence, and is not reported as one
      //
      // `reconcile.ts` says so explicitly: it probed a bounded list and found
      // nothing carrying this upload's sealed manifest, which is a failure to
      // FIND rather than a finding. Reporting it as failed would tell the user
      // nothing was created, and the whole reason the record is ambiguous is
      // that this process cannot know that. It stays ambiguous, and the key
      // stays retained.
      if (outcome.result === "no-match") return { status: "ambiguous", code: "no-match" } as const;
      if (outcome.result === "unavailable") return { status: "ambiguous", code: outcome.code } as const;
      return { status: "ambiguous", code: "internal" } as const;
    }, unknown);
  }

  /** Recover this account's records at sign-in. Read-only; never re-uploads. */
  async reconcileAccount(): Promise<void> {
    const authority = await this.deps.authority();
    if (authority.kind !== "ok") return;
    try {
      await (await this.engine()).reconcileAccount({
        accountId: authority.authority.accountId,
        deviceId: authority.authority.deviceId,
      });
    } catch (err) {
      this.deps.reportFailure?.(err);
    }
  }
}

/**
 * The engine's outcome, as the page may see it.
 *
 * `ambiguous` is carried through unchanged and is deliberately NOT collapsed
 * into either neighbour. Calling it published invents an object id; calling it
 * failed asserts nothing was created, and one of those is a claim this process
 * cannot make.
 */
function describeOutcome(outcome: UploadOutcome): StoredSendOutcome {
  switch (outcome.status) {
    case "published":
      return { status: "published", objectId: outcome.objectId, expiresAt: outcome.expiresAt };
    case "ambiguous":
      return { status: "ambiguous", code: outcome.code };
    case "failed":
      return { status: "failed", code: outcome.code };
    default:
      return { status: "cancelled" };
  }
}

/** One journal record, narrowed to what a page may render. */
function describeRecord(record: UploadRecord): StoredSendHistoryEntry {
  return {
    jobId: record.jobId,
    state: record.state,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    burnAfterRead: record.burnAfterRead,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    // A closed code this process wrote, or nothing. Never a message and never
    // a server string.
    note: record.note,
    /** Whether a link can be composed at all. The link itself is asked for. */
    linkable: record.state === "published" && record.objectId !== null,
  };
}
