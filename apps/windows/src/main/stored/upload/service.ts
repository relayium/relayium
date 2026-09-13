// The host-facing surface of stored SEND. This is the contract RT binds to.
//
// ## The split, and why it is this one
//
// The renderer holds the user's `File` objects — from `<input>`,
// `webkitdirectory` and drag-drop, all of which open the NATIVE Windows dialogs
// while granting the renderer no arbitrary-path read channel — and it runs the
// shared `encryptFiles`. Main receives CIPHERTEXT. So no native read helper
// exists or is needed, and the send UX is the one the RT lane already built.
//
// What main owns, and the renderer therefore cannot reach:
//
//   * the account BEARER, which never crosses to a renderer;
//   * the upload session, the offset algebra and the retained replay window;
//   * the durable key custody and the journal;
//   * finalization and the object id.
//
// What crosses to the renderer is exactly one secret: the content key for the
// job its own document owns, because the renderer is what encrypts. That is a
// real widening against S1's receive path, where the raw key never had to exist
// in main, and it is stated as a contract rather than glossed: ONE key, ONE
// owning document, ONE job, revoked the moment the job settles or the document
// goes away. It is not "the key never reaches the renderer", which would be
// false.
//
// ## Ordering that a crash must not be able to break
//
//   1. plan and refuse — before a key exists, before a request is made;
//   2. generate the key, seal the manifest, refuse an oversized one;
//   3. admit a journal record (bounded admission);
//   4. persist the key — BEFORE init, so ciphertext can never outlive its key;
//   5. init, and record the session id;
//   6. frames, then finalize.
//
// A crash between 4 and 6 leaves a retained key and a record that says the
// outcome is unknown, which is recoverable. The reverse order would leave
// ciphertext on a server with no key anywhere, which is not.

import { randomUUID } from "node:crypto";

import { SecretStore } from "../../secrets.js";
import type { ManifestRefusal } from "../manifest.js";
import type { StoredRuntime } from "../runtime-contract.js";
import { storedRuntime } from "../runtime.js";
import { StoredTransport, type StoredObjectSource } from "../transport.js";
import {
  AuthorityRevoked,
  captureAuthority,
  Fence,
  type AuthorityInput,
  type RevocationReason,
} from "./authority.js";
import { CustodyError, UploadKeyCustody } from "./custody.js";
import {
  UploadEngine,
  UploadFailure,
  type CipherFrame,
  type UploadFailureCode,
  type UploadOutcome,
} from "./engine.js";
import { JournalError, UploadJournal, type UploadRecord } from "./journal.js";
import { manifestDigest, reconcileUpload, type ReconcileOutcome } from "./reconcile.js";
import { planUpload, sealedManifestFits, type UploadDescriptor, type UploadRefusal } from "./plan.js";
import { UploadTransport, type UploadRetention } from "./transport.js";

/** The next frame the producer owes: its file, its global sequence number and
 *  its exact ciphertext length. Everything a producer needs to be checkable. */
export interface FrameExpectation {
  readonly fileIndex: number;
  readonly seq: number;
  readonly bytes: number;
}

export type StartRefusalCode =
  | "manifest-refused"
  | "manifest-too-large-to-send"
  | "runtime-unavailable"
  | "key-custody"
  | "journal"
  | "at-capacity"
  | "authority"
  | "server-refused"
  | "network"
  | "timeout"
  | "internal";

export interface StartRefusal {
  readonly code: StartRefusalCode;
  /** Which manifest shape was refused, when that is what happened. Never a
   *  filename: see `ManifestRefusal`. */
  readonly refusal: ManifestRefusal | null;
  readonly status: number | null;
}

export type StartResult =
  | {
      readonly ok: true;
      readonly jobId: string;
      /** The content key for the owning document. See the header. */
      readonly contentKey: string;
      /** What the producer must send first. */
      readonly expects: FrameExpectation | null;
      readonly cipherBytes: number;
      readonly fileCount: number;
    }
  | { readonly ok: false; readonly refusal: StartRefusal };

export interface StartRequest {
  readonly authority: AuthorityInput;
  /** Ordered, and the producer MUST encrypt this exact array in this order. */
  readonly descriptors: readonly UploadDescriptor[];
  readonly retention: UploadRetention;
  readonly onProgress?: (committed: number, total: number) => void;
}

/**
 * A tracked job — INCLUDING one whose `start` has not finished yet.
 *
 * `engine` is null while a start is still running. That window is the whole
 * reason this shape exists: an earlier version registered the job only after
 * init returned, so `reconcileAccount`, `revoke` and `inventory` could not see
 * a start in progress. A sign-out landing while the key was being persisted
 * would then let init go out under the OLD bearer and hand a content key back
 * to a document that was already gone. Root caught it.
 *
 * `finished` resolves when the start settles, so a revocation can JOIN a
 * pending start instead of racing it.
 */
interface Job {
  readonly id: string;
  readonly accountId: string;
  readonly fence: Fence;
  engine: UploadEngine | null;
  readonly finished: Promise<void>;
  /** The durable settlement, once one is under way. A quiesce joins it. */
  settling: Promise<void> | null;
}

export interface StoredUploadServiceOptions {
  readonly secrets: SecretStore;
  /** Where the journal file lives. The host's userData directory. */
  readonly journalDirectory: string;
  readonly runtime?: () => Promise<StoredRuntime>;
  /** Test seam. Production builds one per job from the captured authority. */
  readonly transportFactory?: (authority: { origin: string; bearer: string }) => UploadTransport;
  /** The unauthenticated metadata reader, for reconciliation. */
  readonly sourceFactory?: (origin: string) => StoredObjectSource;
  readonly now?: () => number;
}

/**
 * How many jobs this process will have in flight at once, counting PENDING
 * STARTS.
 *
 * The journal's record cap cannot serve as this bound: it is consulted after
 * the runtime load, the key generation and the seal, so a burst of starts does
 * all of that work — and holds all of those registry entries — before any of
 * them is refused. This is checked in the synchronous admission block instead,
 * so a start that will not be admitted costs nothing at all.
 */
export const MAX_ACTIVE_JOBS = 8;

/**
 * An auxiliary operation: history's link, delete and reconcile.
 *
 * They are tracked for the same reason jobs are. Each reads local state
 * (journal, then custody) and only afterwards uses the BEARER or exposes the
 * KEY, so each has a window in which a sign-out must be able to stop it. A host
 * cannot own that lifecycle without a cancelable contract, so this service owns
 * it: the operation is registered synchronously, it is abortable, it appears in
 * `inventory`, and a quiesce joins it.
 */
interface AuxiliaryOperation {
  readonly id: string;
  readonly accountId: string;
  readonly kind: "link" | "delete" | "reconcile";
  readonly aborter: AbortController;
  readonly done: Promise<void>;
}

/** A journal note is a closed code this service wrote; anything else is read
 *  as `internal` rather than trusted into a typed field. */
function asFailureCode(note: string | null): UploadFailureCode {
  return note === null ? "internal" : (note as UploadFailureCode);
}

export class StoredUploadService {
  private readonly custody: UploadKeyCustody;
  private readonly journal: UploadJournal;
  private readonly jobs = new Map<string, Job>();
  private readonly auxiliary = new Map<string, AuxiliaryOperation>();
  private nextAuxiliary = 1;

  constructor(private readonly options: StoredUploadServiceOptions) {
    this.custody = new UploadKeyCustody(options.secrets);
    this.journal = new UploadJournal(options.journalDirectory, options.now);
  }

  private transportFor(authority: { origin: string; bearer: string }): UploadTransport {
    return (
      this.options.transportFactory?.(authority) ??
      new UploadTransport(authority.origin, authority.bearer)
    );
  }

  private sourceFor(origin: string): StoredObjectSource {
    return this.options.sourceFactory?.(origin) ?? new StoredTransport(origin);
  }

  /** Unresolved uploads and live jobs — the inventory a host needs to offer
   *  recovery, and the one RT binds a "finish this" affordance to. */
  async inventory(accountId: string): Promise<{
    readonly unresolved: readonly UploadRecord[];
    readonly liveJobs: readonly string[];
    /** Link, delete and reconcile calls in flight for this account. */
    readonly activeOperations: readonly string[];
  }> {
    return {
      unresolved: await this.journal.unresolved(accountId),
      // Filtered by identity. An unfiltered list disclosed one account's job
      // ids to another — jobs are per-account and so is this inventory.
      liveJobs: [...this.jobs.values()]
        .filter((job) => job.accountId === accountId)
        .map((job) => job.id),
      activeOperations: [...this.auxiliary.values()]
        .filter((operation) => operation.accountId === accountId)
        .map((operation) => operation.id),
    };
  }

  async history(accountId: string): Promise<readonly UploadRecord[]> {
    return this.journal.list(accountId);
  }

  async record(jobId: string): Promise<UploadRecord | null> {
    return this.journal.get(jobId);
  }

  /**
   * Begin one upload.
   *
   * Every refusal before step 4 costs nothing: no key exists, no record exists
   * and no request has been made.
   */
  async start(request: StartRequest): Promise<StartResult> {
    // ------------------------------------------------------------------
    // SYNCHRONOUS ADMISSION. Everything down to the first `await`.
    // ------------------------------------------------------------------
    //
    // The job is in the registry, behind a fence, before this function yields
    // to the event loop even once. That is what makes `reconcileAccount`,
    // `revoke` and `inventory` able to see and stop a start that is still
    // running — and what closes the window in which a sign-out during key
    // persistence could still let init go out under the old bearer and return a
    // content key to a document that had already gone away.
    let authority;
    try {
      authority = captureAuthority(request.authority);
    } catch {
      return this.refuse("authority");
    }
    // The active bound, checked HERE — before the runtime load, the key
    // generation and the seal — so an inadmissible start costs none of them.
    if (this.jobs.size >= MAX_ACTIVE_JOBS) return this.refuse("at-capacity");
    // Ours, generated here, and constrained to the alphabet both a secret slot
    // name and a journal id accept.
    const jobId = `u-${randomUUID().replace(/-/g, "")}`;
    const fence = new Fence(authority);
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job: Job = {
      id: jobId,
      accountId: authority.accountId,
      fence,
      engine: null,
      finished,
      settling: null,
    };
    this.jobs.set(jobId, job);

    // From here every step is followed by a fence re-check, because each of
    // them is an await and a revocation lands between awaits, not on them.
    try {
      let runtime: StoredRuntime;
      try {
        runtime = await (this.options.runtime ?? storedRuntime)();
      } catch {
        return this.abandon(jobId, "runtime-unavailable");
      }
      if (!fence.valid) return this.abandon(jobId, "authority");

      const planned = planUpload(request.descriptors, runtime.constants);
      if (!planned.ok) {
        this.jobs.delete(jobId);
        return this.refuseRefusal(planned.refusal);
      }
      const plan = planned.plan;

      // Wrapped: a throw from either of these used to escape `start` with the
      // registry entry still in place, leaving a job nothing would ever stop.
      let generated;
      let sealed;
      try {
        generated = await runtime.generateKey();
        sealed = await runtime.sealManifest(generated.key, { files: plan.manifest });
      } catch {
        return this.abandon(jobId, "internal");
      }
      if (!fence.valid) return this.abandon(jobId, "authority");
      const oversized = sealedManifestFits(sealed);
      if (oversized !== null) {
        this.jobs.delete(jobId);
        return this.refuseRefusal(oversized);
      }

      const digest = manifestDigest(sealed);
      try {
        await this.journal.admit({
          jobId,
          accountId: authority.accountId,
          manifestDigest: digest,
          fileCount: plan.manifest.length,
          totalBytes: plan.totalPlaintextBytes,
          cipherBytes: plan.cipherBytes,
          burnAfterRead: request.retention.burnAfterRead,
        });
      } catch (error) {
        this.jobs.delete(jobId);
        return this.refuse(
          error instanceof JournalError && error.code === "at-capacity" ? "at-capacity" : "journal",
        );
      }
      // A revocation that landed during the journal write: the record exists, so
      // it is closed rather than left pending, and no key was written yet.
      if (!fence.valid) {
        await this.journal.update(jobId, { state: "closed", note: "authority" });
        return this.abandon(jobId, "authority");
      }

      // BEFORE init. A key that reaches the disk after the first request is a
      // key a crash can lose while its ciphertext survives.
      try {
        await this.custody.hold(jobId, {
          encodedKey: generated.encoded,
          accountId: authority.accountId,
        });
      } catch (error) {
        await this.journal.update(jobId, { state: "closed", note: "key-custody" });
        this.jobs.delete(jobId);
        return this.refuse(error instanceof CustodyError ? "key-custody" : "internal");
      }
      // THE window root named: a sign-out or a document revocation that lands
      // while the key is being persisted must not go on to init. Nothing has
      // been sent, so no object can exist, and the key is retired on that proof.
      if (!fence.valid) {
        await this.journal.update(jobId, { state: "closed", note: "authority" });
        await this.custody.retire(jobId, "server-absent").catch(() => undefined);
        return this.abandon(jobId, "authority");
      }

      const transport = this.transportFor(authority);
      let engine: UploadEngine;
      try {
        engine = await UploadEngine.open({
          runtime,
          key: generated.key,
          sealedManifest: sealed,
          plan,
          retention: request.retention,
          transport,
          fence,
          hooks: {
            onProgress: (committed, total) => {
              // Fenced: a revoked job publishes no further progress.
              if (fence.valid) request.onProgress?.(committed, total);
            },
            onSession: async (uploadId) => {
              await this.journal.update(jobId, { uploadId });
            },
          },
        });
      } catch (error) {
        // An init that failed — or whose answer was lost — leaves at most a
        // session this client cannot address. Finalize is the only publisher and
        // it needs an id that never arrived, so NO object can exist: the record
        // closes and the key is retired on that proof rather than kept forever.
        await this.journal.update(jobId, { state: "closed", note: "init-unresolved" });
        await this.custody.retire(jobId, "server-absent").catch(() => undefined);
        this.jobs.delete(jobId);
        // The fence first: a revocation aborts the in-flight init, and the
        // rejection that surfaces may be an AbortError from any layer. What
        // explains the failure is that this job was revoked, not the shape the
        // abort happened to take.
        if (!fence.valid) return this.refuse("authority");
        const failure = error instanceof UploadFailure ? error : null;
        if (failure?.code === "cancelled" || failure?.code === "authority-revoked") {
          return this.refuse("authority");
        }
        if (failure?.code === "timeout") return this.refuse("timeout");
        if (failure?.code === "network") return this.refuse("network");
        return this.refuse("server-refused", failure?.status ?? null);
      }

      job.engine = engine;
      // A revocation that landed while init was in flight. The session exists,
      // so the outcome is NOT provably nothing — the engine's own teardown
      // decides, and it is joined here rather than left running.
      if (!fence.valid) {
        const outcome = await engine.cancel();
        await this.settle(jobId, outcome);
        return this.refuse("authority");
      }

      return {
        ok: true,
        jobId,
        // Released through the fence, so a document that is already gone cannot
        // be handed a key.
        contentKey: fence.exposeKey(authority.documentId, generated.encoded),
        expects: engine.expects,
        cipherBytes: plan.cipherBytes,
        fileCount: plan.manifest.length,
      };
    } catch (error) {
      // Nothing above should reach here — every step has its own refusal — but
      // an owned registry entry must not survive an unforeseen throw.
      this.jobs.delete(jobId);
      throw error;
    } finally {
      // Whatever happened, a revocation waiting on this start stops waiting.
      release();
    }
  }

  /** Drop a job whose start was abandoned before an engine existed. */
  private abandon(jobId: string, code: StartRefusalCode): StartResult {
    this.jobs.delete(jobId);
    return this.refuse(code);
  }

  /**
   * Hand over one ciphertext frame. Resolves once it is acknowledged.
   *
   * A refusal SETTLES the job here as well as throwing. Without that, a
   * producer or offset failure left the engine settled, the journal record
   * still `pending` and the key held with nothing that would ever resolve it —
   * a job that had definitively ended while its durable state said otherwise.
   */
  async feed(jobId: string, frame: CipherFrame): Promise<{ readonly expects: FrameExpectation | null }> {
    const engine = this.liveEngine(jobId);
    try {
      await engine.feed(frame);
    } catch (error) {
      const outcome = engine.outcome;
      if (outcome !== null) await this.settle(jobId, outcome);
      throw error;
    }
    return { expects: engine.expects };
  }

  /** What the producer must send next, or null when the schedule is complete. */
  expects(jobId: string): FrameExpectation | null {
    return this.liveEngine(jobId).expects;
  }

  progress(jobId: string): { readonly committed: number; readonly total: number } {
    return this.liveEngine(jobId).progress;
  }

  /**
   * The producer says that was everything. Settles the job.
   *
   * A refusal that leaves the engine UNSETTLED is rethrown, not synthesized.
   * The case that matters: `end()` arriving while a `feed` is still in flight
   * refuses with `concurrent-feed` and settles nothing — the job is still
   * running. Writing a `failed` record there would close the journal and retire
   * the key of an upload whose producer is still feeding it, which is the one
   * way this service could destroy a key that ciphertext on the server still
   * needs. So only an outcome the ENGINE reached is ever persisted.
   */
  async end(jobId: string): Promise<UploadOutcome> {
    const engine = this.liveEngine(jobId);
    try {
      const outcome = await engine.end();
      await this.settle(jobId, outcome);
      return outcome;
    } catch (error) {
      const outcome = engine.outcome;
      if (outcome === null) throw error;
      await this.settle(jobId, outcome);
      return outcome;
    }
  }

  /** Stop a job, joining whatever is in flight. */
  async cancel(jobId: string): Promise<UploadOutcome> {
    return this.stop(jobId, "cancelled");
  }

  /**
   * Revoke a job's authority.
   *
   * The host calls this on document destruction and on a sign-in change. It
   * quiesces the job — the fence refuses every further request, callback and
   * key exposure — and JOINS the teardown rather than leaving a live request.
   * A start that is still running is joined too: the fence is revoked
   * synchronously and its own re-checks abandon it.
   */
  async revoke(jobId: string, reason: RevocationReason): Promise<UploadOutcome | null> {
    if (!this.jobs.has(jobId)) return null;
    return this.stop(jobId, reason);
  }

  /**
   * The one teardown path.
   *
   * Fence first and SYNCHRONOUSLY, so nothing this job is in the middle of can
   * start another request. Then the join: a pending start is awaited through
   * `finished` (its own re-checks abandon it), and a live engine is cancelled.
   * Only after that is a durable outcome read or written.
   */
  private async stop(jobId: string, reason: RevocationReason): Promise<UploadOutcome> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return this.durableOutcome(jobId);
    job.fence.revoke(reason);
    // Joined, never abandoned: a start mid-flight owns awaits and possibly a
    // request, and resolving the caller while it runs would be a lie about what
    // has stopped. The DURABLE settlement is joined too — a record that is
    // still being written is not a record this can answer from.
    await job.finished.catch(() => undefined);
    if (job.settling !== null) {
      await job.settling.catch(() => undefined);
      this.jobs.delete(jobId);
      return this.durableOutcome(jobId);
    }
    const engine = job.engine;
    if (engine === null) {
      // The start abandoned itself and has already written its own record.
      this.jobs.delete(jobId);
      return this.durableOutcome(jobId);
    }
    const outcome = await engine.cancel();
    await this.settle(jobId, outcome);
    return outcome;
  }

  /**
   * What the journal says a settled job's outcome was.
   *
   * `cancelled` is a claim that NOTHING was published, and it used to be
   * returned for any job that was no longer live — including one that had
   * already settled `ambiguous`, where an object may well exist. That turned a
   * durable unknown into a false "provably absent" on a second cancel. The
   * record is now the authority.
   */
  private async durableOutcome(jobId: string): Promise<UploadOutcome> {
    const record = await this.journal.get(jobId);
    if (record === null) return { status: "cancelled" };
    if (record.state === "published" && record.objectId !== null) {
      return { status: "published", objectId: record.objectId, expiresAt: record.expiresAt };
    }
    if (record.state === "ambiguous") {
      return { status: "ambiguous", code: asFailureCode(record.note) };
    }
    if (record.state === "pending") {
      // Still pending with no live job: the start died without settling. Its
      // outcome is not knowable from here, and it is not "nothing happened".
      return { status: "ambiguous", code: "internal" };
    }
    return { status: "cancelled" };
  }

  /**
   * Revoke every job whose captured identity no longer matches the signed-in
   * one, and only then join their teardowns.
   *
   * TWO PHASES, deliberately. An earlier version awaited each revocation inside
   * the loop, so job two's fence stayed valid until job one's teardown had
   * finished — and in that gap job two could still send a request under the old
   * bearer. Every fence is now revoked before any join happens.
   */
  async reconcileAccount(current: { readonly accountId: string; readonly deviceId: string }): Promise<void> {
    const doomed: string[] = [];
    for (const [jobId, job] of this.jobs) {
      job.fence.reconcile(current);
      if (!job.fence.valid) doomed.push(jobId);
    }
    // Auxiliary operations belong to an account too, and each has a window
    // between its journal read and its use of the bearer or the key. Aborted in
    // the same synchronous pass as the fences, before any join.
    const strays = [...this.auxiliary.values()].filter(
      (operation) => operation.accountId !== current.accountId,
    );
    for (const operation of strays) operation.aborter.abort();
    for (const jobId of doomed) await this.stop(jobId, "account-changed");
    // Joined, so a caller of `reconcileAccount` knows nothing of the old
    // account's is still running.
    for (const operation of strays) await operation.done;
  }

  /**
   * Revoke every job owned by one renderer document.
   *
   * Same two phases, for the same reason: a reload destroys one document, and
   * every job it owned must stop being able to act before any of them is
   * joined.
   */
  async revokeDocument(documentId: string): Promise<void> {
    const doomed: string[] = [];
    for (const [jobId, job] of this.jobs) {
      if (job.fence.authority.documentId !== documentId) continue;
      job.fence.revoke("document-revoked");
      doomed.push(jobId);
    }
    for (const jobId of doomed) await this.stop(jobId, "document-revoked");
  }

  /**
   * Run one auxiliary operation under this service's lifetime.
   *
   * Registered SYNCHRONOUSLY, before the first await, for the same reason a
   * start is: each of these reads local state and only then uses the bearer or
   * exposes the key, so there is a window a sign-out must be able to close.
   * The operation gets an abort signal merged with the caller's, it appears in
   * `inventory`, and `reconcileAccount` aborts and JOINS it.
   *
   * `check()` is what the body calls immediately before an outward request or
   * a key exposure — the last moment at which stopping is still free.
   */
  private auxiliaryRun<T>(
    kind: AuxiliaryOperation["kind"],
    accountId: string,
    caller: AbortSignal | undefined,
    body: (signal: AbortSignal, check: () => void) => Promise<T>,
  ): Promise<T> {
    const id = `aux-${String(this.nextAuxiliary)}`;
    this.nextAuxiliary += 1;
    const aborter = new AbortController();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation: AuxiliaryOperation = { id, accountId, kind, aborter, done };
    this.auxiliary.set(id, operation);
    const signal = caller ? AbortSignal.any([aborter.signal, caller]) : aborter.signal;
    const check = (): void => {
      if (signal.aborted) throw new AuthorityRevoked("account-changed");
    };
    return (async () => {
      try {
        check();
        return await body(signal, check);
      } finally {
        this.auxiliary.delete(id);
        release();
      }
    })();
  }

  /**
   * The shareable link for a published record.
   *
   * Composed on demand from custody plus the server's object id, and never
   * stored: a link IS the key, so a persisted link would be a second copy of
   * the secret under a name that looks harmless. Refused for any record that is
   * not proven published — an ambiguous upload has no id to put in a link, and
   * inventing one would hand the user a URL that opens nothing.
   */
  async linkFor(
    jobId: string,
    accountId: string,
    origin: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return this.auxiliaryRun("link", accountId, signal, async (_signal, check) => {
      const record = await this.journal.get(jobId);
      if (record === null || record.accountId !== accountId) return null;
      if (record.state !== "published" || record.objectId === null) return null;
      const runtime = await (this.options.runtime ?? storedRuntime)();
      // Before the key is read, not only before the call: a sign-out that
      // landed during the journal read must not produce a link.
      check();
      const held = await this.custody.read(jobId, accountId);
      check();
      return `${origin}${runtime.downloadPrefix}${record.objectId}#k=${held.encodedKey}`;
    });
  }

  /**
   * Delete one published object this account owns, then retire its key.
   *
   * The order is the proof: the key is forgotten only after the server has
   * confirmed the object is gone (204) or absent (404). A key deleted while its
   * ciphertext still exists is a share the user can never open again.
   */
  async deleteObject(
    jobId: string,
    accountId: string,
    authority: { readonly origin: string; readonly bearer: string },
    signal?: AbortSignal,
  ): Promise<"deleted" | "absent" | "not-found" | "failed"> {
    return this.auxiliaryRun("delete", accountId, signal, async (aborted, check) =>
      this.deleteObjectInner(jobId, accountId, authority, aborted, check),
    );
  }

  private async deleteObjectInner(
    jobId: string,
    accountId: string,
    authority: { readonly origin: string; readonly bearer: string },
    signal: AbortSignal,
    check: () => void,
  ): Promise<"deleted" | "absent" | "not-found" | "failed"> {
    const record = await this.journal.get(jobId);
    if (record === null || record.accountId !== accountId) return "not-found";
    if (record.objectId === null) return "not-found";
    // The window root named: a request parked after the journal read must be
    // stoppable before it goes out under an old account's bearer.
    check();
    let result: "deleted" | "absent";
    try {
      result = await this.transportFor(authority).remove(record.objectId, signal);
    } catch {
      // Nothing is retired on a failure: the object may still be there.
      return "failed";
    }
    await this.journal.update(jobId, { state: "closed", note: "user-deleted" });
    await this.custody.retire(jobId, result === "deleted" ? "user-deleted" : "server-absent");
    return result;
  }

  /** Try to name the object an ambiguous record produced. Read-only. */
  async reconcile(
    jobId: string,
    accountId: string,
    authority: { readonly origin: string; readonly bearer: string },
    signal?: AbortSignal,
  ): Promise<ReconcileOutcome> {
    return this.auxiliaryRun("reconcile", accountId, signal, async (aborted, check) => {
      const record = await this.journal.get(jobId);
      if (record === null || record.accountId !== accountId) {
        return { result: "unavailable", code: "not-found" };
      }
      check();
      return reconcileUpload({
        record,
        transport: this.transportFor(authority),
        source: this.sourceFor(authority.origin),
        journal: this.journal,
        signal: aborted,
      });
    });
  }

  /** The engine of a job whose start has completed. A pending start has no
   *  engine to drive, and a producer cannot have been told to feed one yet. */
  private liveEngine(jobId: string): UploadEngine {
    const engine = this.jobs.get(jobId)?.engine;
    if (engine === undefined || engine === null) throw new UploadFailure("internal");
    return engine;
  }

  /**
   * Write the outcome down, and only then drop the live job.
   *
   * The order was the other way round, which meant a job stopped being
   * observable the instant it settled — while its journal write and its key
   * retirement were still in flight. A concurrent `revoke` or `cancel` then had
   * nothing to join and would answer from a record that had not been written
   * yet. One lifecycle owner has to cover start THROUGH durable settlement, so
   * the settlement promise is published on the job entry and the entry is
   * removed last.
   *
   * Idempotent: a second settle for the same job joins the first rather than
   * writing a second outcome.
   */
  private async settle(jobId: string, outcome: UploadOutcome): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job?.settling !== undefined && job.settling !== null) {
      await job.settling;
      return;
    }
    const work = this.persist(jobId, outcome);
    if (job !== undefined) job.settling = work;
    try {
      await work;
    } finally {
      this.jobs.delete(jobId);
    }
  }

  /** The durable half of a settlement. Never deletes a key on the strength of
   *  an unknown. */
  private async persist(jobId: string, outcome: UploadOutcome): Promise<void> {
    switch (outcome.status) {
      case "published":
        await this.journal.update(jobId, {
          state: "published",
          objectId: outcome.objectId,
          expiresAt: outcome.expiresAt,
          note: null,
        });
        return;
      case "ambiguous":
        // The key stays. The record stays. Neither is evicted on a lifetime.
        await this.journal.update(jobId, { state: "ambiguous", note: outcome.code });
        return;
      case "cancelled":
      case "failed": {
        // Provably nothing was published — finalize is the only publisher and a
        // `cancelled`/`failed` outcome means it was never attempted. The key is
        // retired on that proof, not on a generic error.
        const note = outcome.status === "failed" ? outcome.code : "cancelled";
        await this.journal.update(jobId, { state: "closed", note });
        await this.custody.retire(jobId, "server-absent").catch(() => undefined);
        return;
      }
    }
  }

  private refuse(code: StartRefusalCode, status: number | null = null): StartResult {
    return { ok: false, refusal: { code, refusal: null, status } };
  }

  private refuseRefusal(refusal: UploadRefusal): StartResult {
    return refusal.kind === "manifest"
      ? { ok: false, refusal: { code: "manifest-refused", refusal: refusal.refusal, status: null } }
      : { ok: false, refusal: { code: "manifest-too-large-to-send", refusal: null, status: null } };
  }
}
