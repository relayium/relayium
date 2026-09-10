// One delivery, driven to exactly one task central holds.
//
// The order, and why it is this order (`InboxSendCoordinator.swift` states the
// same sequence for the same reasons):
//
//   1. a plan that already names a task is a previous attempt that succeeded
//      and died in its own tidy-up. Read the delivery; never create a second;
//   2. check the target is legal BEFORE a byte moves — a device that turned
//      receiving off refuses the create, and finding that out after an
//      encrypted upload costs the user the whole transfer;
//   3. upload the ciphertext as `purpose=device_task` — no link, no file-list
//      row, 404 on the public endpoints even for its owner;
//   4. re-read the device and seal the content key to its CURRENT public key.
//      Sealing last is deliberate: it is the cheap step, so a rotation during a
//      long upload is answered by re-wrapping ~80 bytes rather than resending;
//   5. persist the exact request, then create.
//
// ## The line everything here is organised around
//
//  * a DEFINITIVE non-success means central's transaction rolled back and no
//    task can own this ciphertext. A `device_task` object is invisible to its
//    own account, so what is left is storage nobody can see.
//
//    **Reclaiming it is central's, not this client's.** `handleDeleteFile`
//    refuses any object whose purpose is not `share`, and says why: "a
//    concurrent task create could bind it between that read and blob removal".
//    `reclaimableTaskObjectSQL` is the one definition of what may go, and the
//    GC applies it — unbound past the bind grace, or bound to a task that is
//    gone or terminal. So the release below is BEST EFFORT and its failure is
//    not an obligation this API can discharge; `InboxSendCoordinator.swift`
//    says the same of its own ("the server's own collector reclaims an unbound
//    task-purpose object anyway; this only shortens the window"). What must
//    never happen is claiming a release that did not happen.
//  * an AMBIGUOUS outcome means a delivery MAY be live. Release NOTHING — the
//    staged bytes, the content key, the plan and above all the idempotency key
//    are kept, so the next attempt converges on the same task instead of
//    queueing a second one.
//
// ## A RESUMED create is not a fresh one, and the difference is not cosmetic
//
// A plan found at `creating` in a new process carries an attempt whose answer
// nobody read. `CreateInboxTask` checks the idempotent replay FIRST — before
// device ownership, before the enrolment, before the key binding — precisely so
// "a client retrying a create it already succeeded at must converge even if the
// device has since been revoked or the key rotated". Two consequences this file
// is built on:
//
//  * The persisted request is repeated BYTE-IDENTICALLY. `sameInboxTaskRequest`
//    compares the wrapped key, so a reseal would arrive as a DIFFERENT request
//    under the same key — an `idempotency_key_conflict` instead of the
//    convergence it was meant to be. A target that rotated its key between the
//    attempts changes nothing about that: the rotation is not evidence about the
//    earlier attempt, and re-sealing to the new key would abandon the only
//    request that can converge.
//  * A refusal on that identical retry is therefore PROOF the earlier attempt
//    committed nothing: had a row existed, the replay check would have answered
//    it before any refusal was reachable. Only then may this side reseal, and
//    only then may it release the object.
//
// A client-side key comparison never earns either conclusion, so a resumed plan
// never reseals and never releases on one.
//
// ## Authority is captured, and cancellation is joined
//
// A job is registered SYNCHRONOUSLY, under a captured authority and a fence,
// before the first await. That ordering is the whole mechanism: a sign-out or a
// destroyed document that lands while an init, a key read, a persistence write
// or a create is in flight reaches a job that already exists, aborts the request
// through the fence's signal, and is joined rather than abandoned.
//
// ## This module owns the sequence, not just the steps
//
// `deliver` is the whole workflow: admission, eligibility, the ciphertext, the
// reseal, the durable request and the create, in that order and with the
// classification each stage owes. It is a deliberate refusal to publish a bag of
// helpers a host would have to re-assemble — a caller free to skip the
// eligibility read, or to reorder the persist and the create, is a caller free
// to reinvent every failure this file exists to prevent. The narrower methods
// remain public only because recovery genuinely needs them: `resume` for a plan
// found on disk in a later process, `cancel`, `discard` and `cleanup` for the
// decisions only a user or a host can make.
//
// ## One lifecycle, and a host that can actually await it
//
// EVERY entrypoint with a side effect is admitted into the same bounded registry
// SYNCHRONOUSLY, before its first await — `deliver` and `resume`, and equally
// `cancel`, `discard` and `cleanup` on a job this process never started. Work
// that is not in the registry cannot be reached by a sign-out, cannot be joined
// by a quit, and cannot be bounded by anything; a cancellation that quietly ran
// its own network request outside the registry would be exactly the leak the
// registry exists to prevent.
//
// Two independent lifetimes per job, because they answer to different owners:
//
//  * the **fence** is user intent plus account/document authority. `cancel` and
//    a sign-out revoke it, and it aborts the delivery's own requests;
//  * the **teardown** controller is the process's. It is aborted only by
//    `dispose`, so a release or a task cancellation issued under the ORIGINAL
//    captured authority still runs after the user cancelled or the account
//    changed — which is the only moment those requests are ever needed. Binding
//    them to the fence would abort the very request that removes the orphan.
//
// Draining is a FENCE first and a join second, in that order, because the other
// order cannot terminate. `fence()` closes ADMISSIONS ONLY — no new job, no new
// cancel, no new cleanup — and revokes nothing, so a host may close the gate
// before it asks the user for quit consent without having cancelled anything it
// may have to un-cancel. `quiesce()` is that fence plus a drain of the ACTUAL
// registry to settlement; because nothing can be admitted while it runs, the
// live set only shrinks and the drain terminates. `resumeAdmissions()` is the
// explicit "Stay". `dispose()` is terminal: it fences permanently, revokes,
// aborts every teardown and drains.
//
// A join over a snapshot taken at call time is not a drain, and a fixed round
// count can report quiet with work still running. Both were real: twenty
// `cleanup` calls on one job were all admitted past a `maxLiveJobs` of 1 and
// outlived a `quiesce` that had already returned.
//
// Per-job auxiliary work is COALESCED by kind. A second `cleanup` for a job that
// is already cleaning up joins the first rather than issuing a second release,
// so the registry bound cannot be walked around by asking the same question
// repeatedly. `release` refuses to forget a job while work is still live, so a
// job id cannot be reopened underneath its own owners.
//
// Nothing here persists or logs a content key. It is held by the accepted
// custody for the life of the job — encrypted at rest by the platform cipher —
// and sealed to the target through a host callback on the way out. Nothing here
// accepts a path, a URL or a bearer from a renderer: the origin and the bearer
// arrive as a captured authority from the host, and every URL is composed from
// them.
import {
  AuthorityRevoked,
  captureAuthority,
  Fence,
  type AuthorityInput,
  type UploadAuthority,
} from "../stored/upload/authority.js";
import { UploadEngine, type UploadOutcome } from "../stored/upload/engine.js";
import type { UploadByteTransport, UploadRetention } from "../stored/upload/transport.js";
import {
  classifyRefusal,
  SEND_REFUSALS,
  isLegalIdempotencyKey,
  isTerminalForSender,
  type CreateTaskRequest,
  type OutcomeClass,
  type SenderTask,
} from "./send-wire.js";
import { SendApiError, type SendTransport } from "./send-transport.js";
import { assertEligible, keyChanged, TargetIneligible, type EligibleTarget } from "./send-target.js";
import { safeToDrop, type SendPlanRecord, type SendPlanStore } from "./send-plan.js";

/**
 * Repeats of the SAME create request after an ambiguous answer.
 *
 * Small on purpose. Repeating a request whose answer was lost is a cheap guess;
 * the real convergence is the lookup that follows, which asks central what
 * exists instead of hoping.
 */
export const MAX_AMBIGUOUS_CREATE_ATTEMPTS = 3;

/** A positive match in the recent-task page can recover a lost create. */
export const CONVERGENCE_LOOKUP_LIMIT = 100;

export type SendOutcome =
  /** Central holds a task. `created` is a creation flag; `task.State` is truth. */
  | { readonly kind: "delivered"; readonly created: boolean; readonly task: SenderTask }
  /** The delivery was cancelled. `task` is central's own last word on it. */
  | { readonly kind: "cancelled"; readonly task: SenderTask | null }
  /**
   * The outcome is UNKNOWN and a delivery may be live.
   *
   * Nothing was released. The plan, its idempotency key and its object are
   * retained so a later attempt converges.
   */
  | { readonly kind: "unknown"; readonly reason: string }
  /** Definitively refused. What was released is stated, never assumed. */
  | {
      readonly kind: "refused";
      readonly reason: string;
      /** True ONLY for a release this side observed succeed. */
      readonly releasedObject: boolean;
      /** The SAME request could succeed later; the plan is retained for it. */
      readonly retryable: boolean;
      /**
       * An unbound `device_task` object was left behind.
       *
       * Not a client obligation: `DELETE /api/files/{id}` refuses a task-purpose
       * object by design, and central's collector reclaims it after the bind
       * grace. The plan keeps naming it so a host can report it and `cleanup`
       * can retry the best-effort attempt, but nothing here treats it as owed.
       */
      readonly orphanedObject: boolean;
    };

/** What `begin` needs to own a job. None of it may originate in a renderer. */
export interface SendJobInput {
  readonly jobID: string;
  readonly targetDeviceID: string;
  readonly kind: "file" | "text";
  /** Chosen once by the host, reused verbatim by every attempt. */
  readonly idempotencyKey: string;
  /**
   * The digest of the sealed v3 manifest this job will upload.
   *
   * One content key belongs to ONE immutable selection. The digest is frozen
   * here and every later step is checked against it, so a job cannot be re-run
   * against changed plaintext under a key ciphertext already exists for.
   */
  readonly manifestDigest: string;
  readonly authority: AuthorityInput;
}

export interface SendCoordinatorOptions {
  readonly plans: SendPlanStore;
  readonly tasks: SendTransport;
  /** Built per job from the captured authority, with the device_task purpose. */
  bytesFor(jobID: string): UploadByteTransport;
  /**
   * The accepted engine, constructed by the caller around the transport.
   *
   * The job's own fence is handed in so the engine's requests — including the
   * `init` that runs before the engine exists — are reached by this job's
   * cancellation and by an account change.
   */
  engineFor(
    jobID: string,
    bytes: UploadByteTransport,
    fence: Fence,
    /**
     * The session recorder, valid ONLY for this call.
     *
     * Handed in rather than published as a method, because it writes to the
     * durable plan: a public `recordUploadSession` was persistence a host could
     * perform at any moment, outside any registered work and therefore outside
     * everything that joins it. Wired as the engine's `onSession` hook, it is
     * structurally subordinate to the tracked upload that created it.
     */
    onSession: (uploadID: string) => Promise<void>,
  ): Promise<UploadEngine>;
  /** Seal the job's content key to a target's current public key. */
  sealToTarget(jobID: string, target: EligibleTarget): Promise<string>;
  /**
   * Best-effort release of a `device_task` object nothing binds. OPTIONAL.
   *
   * Optional because on the current server it cannot succeed: `handleDeleteFile`
   * refuses a non-`share` purpose outright, so this exists only to shorten the
   * window if that ever changes, and its failure is never an obligation.
   *
   * The job's ORIGINAL captured authority is handed in, not read from whatever
   * is signed in now: the object belongs to the account that uploaded it, and a
   * cleanup that ran after a sign-out under the new account's bearer would be a
   * request for somebody else's object.
   */
  releaseObject?(objectID: string, authority: UploadAuthority, signal: AbortSignal): Promise<void>;
  /**
   * The account this coordinator speaks for.
   *
   * `tasks` is a transport built around ONE captured bearer, so a coordinator is
   * never shared across accounts. Stating the account here lets `admit` refuse a
   * job for a different one before any request, instead of discovering it as a
   * 403 after an upload.
   */
  readonly accountId: string;
  /** The sending device this coordinator's bearer belongs to. */
  readonly deviceId: string;
  /** Live jobs at once. A bound BEFORE any eligibility read, not after one. */
  readonly maxLiveJobs?: number;
  /** How long an invalidation waits for interrupted work before reporting. */
  readonly invalidationDrainMs?: number;
  readonly runtimeCaps: { readonly receiveV3: string; readonly textV1: string; readonly keyAlgorithm: string };
  readonly protocolVersion: number;
  readonly retention: UploadRetention;
  readonly now?: () => number;
}



/**
 * A live delivery.
 *
 * Returned SYNCHRONOUSLY by `deliver`, before the first await, so a sign-out, a
 * destroyed document or a cancel that lands in the same tick reaches a job that
 * already exists. `done` never rejects for a delivery outcome: every terminal
 * state — including a revoked authority — is one of the `SendOutcome` members,
 * because a caller that had to distinguish a thrown error from a returned
 * refusal would be re-deriving the classification this module owns.
 */
export interface SendDelivery {
  readonly jobID: string;
  /** The job's fence. Every request it makes is bound to this. */
  readonly fence: Fence;
  readonly done: Promise<SendOutcome>;
}

/** A cleanup or a cancellation gets its own deadline, never the job's fence. */
const RELEASE_TIMEOUT_MS = 15_000;

/**
 * How long a join will wait while ADMISSIONS ARE OPEN.
 *
 * A TIME budget, not a round count. A round count bounds how many times the
 * loop reads the registry and bounds nothing at all about how long one of those
 * operations takes — a single request that never returns blocked the whole join
 * regardless of the cap. What a host needs here is an answer within a known
 * period, plus the truth about whether it is complete.
 *
 * The drain that must actually finish (`quiesce`, `dispose`) closes admissions
 * first and waits without a budget, which is what lets it terminate.
 */
export const DEFAULT_INVALIDATION_DRAIN_MS = 2_000;

/**
 * Revoked document ids this coordinator will remember.
 *
 * A cap rather than an unbounded set, and admissions close when it is reached:
 * forgetting one would silently re-admit a job into a document that no longer
 * exists, which is the failure the set exists to prevent.
 */
export const MAX_REVOKED_DOCUMENTS = 64;

/** Live jobs at once, when the host names no other bound. */
export const DEFAULT_MAX_LIVE_SEND_JOBS = 64;

/**
 * The auxiliary operations a job can have, and therefore its own bound.
 *
 * Closed on purpose: the count of kinds IS the per-job ceiling, so no caller can
 * raise it by asking more often.
 */
export type AuxiliaryKind = "cancel" | "discard" | "cleanup";

interface JobRecord {
  readonly jobID: string;
  /** User intent and account/document authority. `cancel` revokes this. */
  readonly fence: Fence;
  /**
   * The process's own lifetime for this job's TEARDOWN requests.
   *
   * Aborted only by `dispose`. A release or a task cancellation is issued
   * precisely when the fence has already been revoked, so binding those to the
   * fence would abort them; and leaving them bound to nothing but a timeout
   * would hide them from the quit path that has to join them.
   */
  readonly teardown: AbortController;
  /**
   * The job's frozen intent, or `null` for a resume until its plan is read.
   *
   * A resume is admitted before its plan can be loaded — admission must not wait
   * on a disk read, or a sign-out during that read would reach nothing.
   */
  input: SendJobInput | null;
  /** The delivery in flight, so a cancel JOINS it rather than abandoning it. */
  primary: Promise<unknown> | null;
  /**
   * Cancellations, discards and cleanups, keyed by KIND.
   *
   * A map rather than a set, because that makes the bound structural: there are
   * three kinds, so one job can have at most three auxiliary operations, and a
   * repeated ask joins the one in flight instead of starting another. An
   * unbounded set let a caller admit any number of them for a single job and
   * walk straight past `maxLiveJobs`.
   */
  readonly auxiliary: Map<AuxiliaryKind, Promise<unknown>>;
  /**
   * Proof, held only for this process, that central definitively refused a
   * create — so the object named by the plan is bound to nothing.
   *
   * Deliberately NOT persisted. A later process has not seen that refusal and
   * must not act as though it had.
   */
  provablyUnbound: boolean;
}

export class SendCoordinator {
  private readonly now: () => number;
  private readonly maxLiveJobs: number;
  private readonly invalidationDrainMs: number;
  private readonly jobs = new Map<string, JobRecord>();
  /**
   * Admissions gate. Closed by `fence` and by `dispose`, reopened only by an
   * explicit `resumeAdmissions`.
   *
   * Separate from `disposed` because they answer different questions. This one
   * is the reversible "not right now" a host closes BEFORE it asks for quit
   * consent — it revokes nothing, so a user who chooses Stay has had nothing
   * cancelled out from under them.
   */
  private admissionsClosed = false;
  private disposed = false;
  /**
   * The signed-in identity stopped matching the one this coordinator's bearer
   * belongs to.
   *
   * Once true, no NEW job is admitted: `tasks` still carries the old account's
   * bearer, and admitting fresh work under it would create a task with a
   * credential that no longer belongs to the user in front of the machine.
   * Existing records keep working, because a release or a task cancellation
   * issued under their ORIGINAL captured authority is already-authorized work
   * for the account that actually owns the object.
   */
  private staleIdentity = false;
  /**
   * Documents whose jobs were revoked. BOUNDED, and fail-closed when full.
   *
   * A reloaded renderer document gets a new id, so a job arriving under a
   * revoked one means the host reused an id it should not have. Remembering is
   * therefore required — without it a fresh job under a revoked document was
   * simply re-admitted — but an unbounded tombstone set is its own leak, so this
   * has a hard cap and admissions close entirely when it is reached rather than
   * forgetting an id silently. `adoptDocument` is the host stating that an id
   * genuinely names a new document.
   */
  private readonly revokedDocuments = new Set<string>();
  /**
   * The revoked-document set filled up. TERMINAL.
   *
   * Reached when another document must be remembered and there is no room. The
   * two alternatives are both wrong: evicting a past revocation would silently
   * re-admit a job into a document that no longer exists, and growing the set
   * without limit is the leak the cap exists to prevent. So the coordinator
   * closes and the host builds a new one, which is the only outcome that
   * forgets nothing.
   */
  private documentsExhausted = false;

  constructor(private readonly options: SendCoordinatorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxLiveJobs = options.maxLiveJobs ?? DEFAULT_MAX_LIVE_SEND_JOBS;
    this.invalidationDrainMs = options.invalidationDrainMs ?? DEFAULT_INVALIDATION_DRAIN_MS;
  }

  /**
   * Drive one delivery end to end.
   *
   * The registration is SYNCHRONOUS and the sequence starts after it, so the
   * returned handle is already cancellable and already reconciled by an account
   * change — including during the very first request, the `init` that runs
   * before an engine exists to hold its own controller.
   *
   * The order below is the contract, and it is not the caller's to vary:
   *
   *   1. eligibility, BEFORE a byte is encrypted. A device with receiving off
   *      refuses the create, and learning that after the upload costs the user
   *      the whole transfer;
   *   2. the plan is staged from the key that read returned;
   *   3. the ciphertext goes as `purpose=device_task`;
   *   4. the device is re-read and the content key sealed to its CURRENT key —
   *      the cheap step last, so a rotation during a long upload costs ~80 bytes
   *      rather than the file;
   *   5. the exact request is durable BEFORE the create leaves this process.
   */
  deliver(input: SendJobInput, feed: (engine: UploadEngine) => Promise<void>): SendDelivery {
    const job = this.admit(input.jobID, input.authority);
    try {
      this.validate(input);
      job.input = input;
      return {
        jobID: input.jobID,
        fence: job.fence,
        done: this.startPrimary(job, () => this.run(job, feed)),
      };
    } catch (error) {
      // Admission is reversed only because NOTHING has run: no request, no plan,
      // no held key. A job that got as far as starting is released by its owner.
      this.jobs.delete(input.jobID);
      throw error;
    }
  }

  /**
   * Pick a plan found on disk back up, in a later process.
   *
   * Create-side only, and deliberately: the ciphertext producer is a renderer
   * holding the user's `File` objects, and after a restart it is gone. A plan
   * that never reached `uploaded` therefore has no way forward here and is
   * reported unresolved rather than re-uploaded — a second upload would be a
   * second object under a content key the first one already used.
   */
  resume(jobID: string, authority: AuthorityInput): SendDelivery {
    const job = this.admit(jobID, authority);
    return {
      jobID,
      fence: job.fence,
      // Same contract as `deliver`: a terminal state is an outcome, never a
      // throw. A caller that had to tell a rejected promise from a returned
      // refusal would be re-deriving the classification this module owns.
      done: this.startPrimary(job, () =>
        this.runCreate(job).catch((error: unknown) => this.fromThrow(job, error, "resume-failed")),
      ),
    };
  }

  /**
   * Admit a NEW job. Synchronous, bounded, and refused rather than queued.
   *
   * Every gate here is checked before the eligibility read, before the key read
   * and before anything is staged, because a gate applied after the IO has
   * started gates nothing. A job id already in the registry is refused too: its
   * owners have not finished with it, and reopening it underneath them is how
   * one plan acquires two drivers.
   */
  private admit(jobID: string, authority: AuthorityInput): JobRecord {
    if (this.disposed) throw new Error("send: the coordinator is disposed");
    // The most specific reason first: an identity change is permanent, and
    // reporting it as the reversible "admissions are closed" would send a host
    // looking for a gate to reopen instead of building a new coordinator.
    if (this.staleIdentity) throw new Error("send: this coordinator's identity is closed");
    // Also permanent, and also more specific than the reversible gate below.
    if (this.documentsExhausted) {
      throw new Error("send: too many revoked documents; build a new coordinator");
    }
    if (this.admissionsClosed) throw new Error("send: admissions are closed");
    if (jobID.length === 0) throw new Error("send: a job needs an id");
    if (this.jobs.has(jobID)) throw new Error("send: that job is already live");
    if (this.jobs.size >= this.maxLiveJobs) throw new Error("send: too many live jobs");
    // Throws synchronously on a missing field or a non-origin. Discovering that
    // after a content key had been generated and persisted would leave custody
    // holding a key for a job that never legally existed.
    const captured = captureAuthority(authority);
    if (this.revokedDocuments.has(captured.documentId)) {
      throw new Error("send: that document was revoked");
    }
    if (captured.accountId !== this.options.accountId || captured.deviceId !== this.options.deviceId) {
      // `tasks` carries ONE account's bearer. A job for another identity would
      // create a task under the wrong credential.
      throw new Error("send: that authority is for another identity");
    }
    const record: JobRecord = {
      jobID,
      fence: new Fence(captured),
      teardown: new AbortController(),
      input: null,
      primary: null,
      auxiliary: new Map(),
      provablyUnbound: false,
    };
    this.jobs.set(jobID, record);
    return record;
  }

  /**
   * Find a live job, or admit one so a recovery entrypoint is registered too.
   *
   * A `cancel` or a `cleanup` for a plan this process never started still runs
   * network work, and work outside the registry is work `dispose` cannot join
   * and a sign-out cannot reach. The authority is required in that case for the
   * same reason a delivery needs one: the request goes out under a bearer, and
   * a bearer is never inferred.
   *
   * An EXISTING record is returned even when the identity has gone stale. Its
   * teardown work is already-authorized under the authority it captured, and
   * that authority is the only correct one for the object it names.
   */
  private attach(jobID: string, authority: AuthorityInput | undefined): JobRecord {
    const existing = this.jobs.get(jobID);
    if (existing !== undefined) return existing;
    if (authority === undefined) throw new Error("send: that job is not live and no authority was given");
    return this.admit(jobID, authority);
  }

  private validate(input: SendJobInput): void {
    // Checked here rather than at the create, so an unusable key is a refusal
    // before a byte is encrypted instead of a 400 after the whole upload.
    if (!isLegalIdempotencyKey(input.idempotencyKey)) {
      throw new Error("send: the idempotency key is not a printable ASCII token");
    }
    if (input.targetDeviceID.length === 0) throw new Error("send: a job needs a target");
    if (input.manifestDigest.length === 0) throw new Error("send: a job needs a manifest identity");
  }

  /** The fence a live job's requests are bound to. */
  fenceOf(jobID: string): Fence {
    return this.job(jobID).fence;
  }

  /** Whether a job is still admitted. */
  isLive(jobID: string): boolean {
    return this.jobs.has(jobID);
  }

  /** Whether a job still has work nobody has joined. */
  isBusy(jobID: string): boolean {
    const job = this.jobs.get(jobID);
    return job !== undefined && (job.primary !== null || job.auxiliary.size > 0);
  }

  /** Whether anything at all is still running. */
  get quiet(): boolean {
    for (const job of this.jobs.values()) {
      if (job.primary !== null || job.auxiliary.size > 0) return false;
    }
    return true;
  }

  /** Whether new work would be accepted right now. */
  get admitting(): boolean {
    return !this.disposed && !this.admissionsClosed && !this.staleIdentity && !this.documentsExhausted;
  }

  /**
   * Close admissions. Revokes NOTHING.
   *
   * The gate a host closes before it asks the user whether to quit: from here
   * the live set can only shrink, so a drain can finish, while a user who
   * chooses Stay has had no delivery cancelled on their behalf. Cancelling
   * before consent is exactly the thing this separation exists to prevent.
   */
  fence(): void {
    this.admissionsClosed = true;
  }

  /** The explicit "Stay". Refused after `dispose`, which is terminal. */
  resumeAdmissions(): void {
    if (this.disposed) throw new Error("send: the coordinator is disposed");
    this.admissionsClosed = false;
  }

  /**
   * Declare that a document id names a genuinely NEW document.
   *
   * The only way back from a document revocation, and deliberately explicit:
   * this side cannot tell a reload that reused an id from a stale job arriving
   * late, and guessing is how a destroyed document's authority gets handed to
   * whatever turns up next holding its name.
   */
  adoptDocument(documentId: string): void {
    if (this.disposed) throw new Error("send: the coordinator is disposed");
    this.revokedDocuments.delete(documentId);
  }

  /** Forget a job whose work is finished. Refused while anything is live. */
  release(jobID: string): boolean {
    if (this.isBusy(jobID)) return false;
    return this.jobs.delete(jobID);
  }

  /** Join a job's work, then forget it. */
  async retire(jobID: string): Promise<boolean> {
    const job = this.jobs.get(jobID);
    if (job === undefined) return false;
    await this.drain([job], this.invalidationDrainMs);
    if (this.isBusy(jobID)) return false;
    return this.jobs.delete(jobID);
  }

  /**
   * The signed-in identity changed. Compare, never adopt — and then STOP.
   *
   * An identity change closes this coordinator PERMANENTLY. `tasks` is built
   * around one captured bearer, so there is no state in which it may serve
   * another identity — and none in which it should quietly resume for the same
   * one either, because a fresh sign-in is a fresh bearer and a fresh bearer is
   * a fresh coordinator. That is the whole rule, and it is simpler than any flag
   * a host could get wrong.
   *
   * Admissions close SYNCHRONOUSLY, before this returns, so nothing new can
   * attach in the same tick. What is already in flight — including teardown
   * running under a job's ORIGINAL captured authority — is then drained.
   *
   * The result is NOT void. The drain is bounded, so it can honestly fail to
   * reach quiet, and a host deciding whether to sign the next account in has to
   * be told which happened. Discarding that boolean is what made the previous
   * version's own comment false.
   */
  async invalidateAccount(current: {
    readonly accountId: string;
    readonly deviceId: string;
  }): Promise<{ readonly quiet: boolean }> {
    for (const job of this.jobs.values()) job.fence.reconcile(current);
    if (current.accountId !== this.options.accountId || current.deviceId !== this.options.deviceId) {
      this.staleIdentity = true;
      this.admissionsClosed = true;
    }
    return { quiet: await this.drain(this.revokedJobs(), this.invalidationDrainMs) };
  }

  /**
   * The renderer document that owns these jobs was destroyed or reloaded.
   *
   * The id is REMEMBERED, so a job arriving under it afterwards is refused
   * rather than admitted into a document that no longer exists. The remembering
   * is BOUNDED AT THE ADD: when there is no room for a new id the set is left
   * exactly as it is and the coordinator closes instead. Capping only the
   * admission check left the set itself growing without limit, one invalidation
   * at a time, which is the leak the cap was for.
   *
   * `remembered: false` means this coordinator is now closed and the host must
   * build another. The jobs are revoked either way — that part is never skipped,
   * whatever happens to the bookkeeping.
   */
  async invalidateDocument(
    documentId: string,
  ): Promise<{ readonly quiet: boolean; readonly remembered: boolean }> {
    let remembered = true;
    if (!this.revokedDocuments.has(documentId)) {
      if (this.revokedDocuments.size >= MAX_REVOKED_DOCUMENTS) {
        // Never evict a past revocation to make room for this one.
        this.documentsExhausted = true;
        this.admissionsClosed = true;
        remembered = false;
      } else {
        this.revokedDocuments.add(documentId);
      }
    }
    for (const job of this.jobs.values()) {
      if (job.fence.authority.documentId === documentId) job.fence.revoke("document-revoked");
    }
    return { quiet: await this.drain(this.revokedJobs(), this.invalidationDrainMs), remembered };
  }

  private revokedJobs(): JobRecord[] {
    return [...this.jobs.values()].filter((job) => !job.fence.valid);
  }

  /**
   * Close admissions and drain the registry to settlement.
   *
   * Fence FIRST. A join over a snapshot taken at call time is not a drain: work
   * admitted while it ran outlived it, and the caller was told everything had
   * stopped. With admissions closed nothing new can start, so the live set only
   * shrinks and this terminates without needing a round cap to make it.
   *
   * Nothing is revoked and admissions are NOT reopened: a host that decides to
   * stay says so with `resumeAdmissions`.
   */
  async quiesce(): Promise<void> {
    this.fence();
    await this.drain([...this.jobs.values()], null);
  }

  /**
   * Stop everything and join it. The quit path, and terminal.
   *
   * The teardown controllers are aborted too, so a release still in flight ends
   * rather than holding the process open — and because a release is recorded
   * only when it is OBSERVED to succeed, an orphan interrupted here stays named
   * in its `abandoned` plan for the next run to clean up.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.admissionsClosed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) {
      job.fence.revoke("cancelled");
      job.teardown.abort();
    }
    await this.drain(jobs, null);
    this.jobs.clear();
  }

  /**
   * Wait for these jobs to have nothing running.
   *
   * `budgetMs === null` means wait to settlement, which is only correct once
   * admissions are closed — then the live set can only shrink and the loop is
   * guaranteed to end. Otherwise the wait is bounded IN TIME and the answer is
   * the truth about what it reached, because a caller can keep adding work and
   * because one request that never returns is not something a round count can
   * bound.
   *
   * The wall clock is deliberately `Date.now`, not this coordinator's injected
   * plan clock: a test that freezes the plan's timestamps must not thereby
   * freeze a real deadline.
   */
  private async drain(jobs: readonly JobRecord[], budgetMs: number | null): Promise<boolean> {
    const deadline = budgetMs === null ? null : Date.now() + budgetMs;
    for (;;) {
      const live: Promise<unknown>[] = [];
      for (const job of jobs) {
        if (job.primary !== null) live.push(job.primary);
        for (const task of job.auxiliary.values()) live.push(task);
      }
      if (live.length === 0) return true;
      if (deadline === null) {
        await Promise.allSettled(live);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = await Promise.race([
        Promise.allSettled(live).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
        }),
      ]);
      // Cleared whichever way the race went: an owned timer left running keeps
      // the event loop alive past the answer.
      clearTimeout(timer);
      if (expired) return false;
    }
  }

  private job(jobID: string): JobRecord {
    const record = this.jobs.get(jobID);
    if (record === undefined) throw new Error("send: no such job");
    return record;
  }

  /** A teardown request's signal: the process's lifetime, plus its own deadline. */
  private teardownSignal(job: JobRecord): AbortSignal {
    return AbortSignal.any([job.teardown.signal, AbortSignal.timeout(RELEASE_TIMEOUT_MS)]);
  }

  /** Refuse to start anything once the gate is shut. */
  private assertAdmitting(): void {
    if (this.disposed) throw new Error("send: the coordinator is disposed");
    if (this.staleIdentity) throw new Error("send: this coordinator's identity is closed");
    if (this.documentsExhausted) {
      throw new Error("send: too many revoked documents; build a new coordinator");
    }
    if (this.admissionsClosed) throw new Error("send: admissions are closed");
  }

  /**
   * Refuse a NEW outward operation on a job whose AUTHORITY was withdrawn.
   *
   * Holding a record is not authorization. An account change or a destroyed
   * document ends the standing to act for that job, and a `cancel` or `cleanup`
   * requested AFTERWARDS is a new external request under a credential the user
   * has revoked — not the already-authorized teardown that was in flight when it
   * happened. That teardown keeps running and is drained; this is the door it is
   * not allowed back through.
   */
  private assertAuthorityIntact(job: JobRecord): void {
    // MEMBERSHIP, not the fence's first reason.
    //
    // `Fence.revoke` keeps the FIRST reason, deliberately: a cancel that races a
    // sign-out must not have its diagnosis overwritten. The consequence is that
    // a job cancelled BEFORE its document was revoked still reads `cancelled`
    // afterwards — so asking the fence cannot answer "does this job's authority
    // still stand". It answered yes, and admitted a cleanup for a destroyed
    // document. The registry is what actually knows.
    if (this.staleIdentity) {
      throw new Error("send: that job's authority was withdrawn (account-changed)");
    }
    if (this.revokedDocuments.has(job.fence.authority.documentId)) {
      throw new Error("send: that job's authority was withdrawn (document-revoked)");
    }
    const reason = job.fence.reason;
    if (reason === "account-changed" || reason === "document-revoked") {
      throw new Error(`send: that job's authority was withdrawn (${reason})`);
    }
  }

  /**
   * The job's ONE delivery. A second is refused rather than queued.
   */
  private startPrimary<T>(job: JobRecord, body: () => Promise<T>): Promise<T> {
    this.assertAdmitting();
    if (job.primary !== null) throw new Error("send: that job is already running");
    let run: Promise<T>;
    run = Promise.resolve()
      .then(body)
      .finally(() => {
        if (job.primary === run) job.primary = null;
      });
    job.primary = run;
    return run;
  }

  /**
   * One auxiliary operation per kind per job, COALESCED.
   *
   * Asking twice while the first is in flight returns the first. That is both
   * the bound — three kinds, so three at most for a job — and the correct
   * answer: two concurrent cleanups for one job would issue two releases for
   * one object, and twenty of them slipped past a `maxLiveJobs` of one.
   */
  private startAuxiliary<T>(job: JobRecord, kind: AuxiliaryKind, body: () => Promise<T>): Promise<T> {
    this.assertAdmitting();
    const inFlight = job.auxiliary.get(kind);
    if (inFlight !== undefined) return inFlight as Promise<T>;
    let run: Promise<T>;
    run = Promise.resolve()
      .then(body)
      .finally(() => {
        if (job.auxiliary.get(kind) === run) job.auxiliary.delete(kind);
      });
    job.auxiliary.set(kind, run);
    return run;
  }

  /** The whole sequence, with every terminal state expressed as an outcome. */
  private async run(job: JobRecord, feed: (engine: UploadEngine) => Promise<void>): Promise<SendOutcome> {
    try {
      await this.prepare(job);
    } catch (error) {
      if (error instanceof TargetIneligible) {
        // Nothing was staged and nothing was encrypted: the read that refused is
        // the one this order exists to do first.
        return { kind: "refused", reason: error.refusal, releasedObject: false, retryable: true, orphanedObject: false };
      }
      return this.fromThrow(job, error, "eligibility-failed");
    }
    let outcome: UploadOutcome;
    try {
      outcome = await this.runUpload(job, feed);
    } catch (error) {
      return this.fromThrow(job, error, "upload-failed");
    }
    switch (outcome.status) {
      case "published":
        break;
      case "ambiguous":
        // An object may exist that this side cannot name. Nothing is released
        // and the plan stays `upload-unknown`, which `discard` is the only exit
        // from and which never claims the object is gone.
        return { kind: "unknown", reason: `upload-unresolved:${outcome.code}` };
      case "cancelled":
        return { kind: "cancelled", task: null };
      case "failed":
        // Provably nothing was finalized: finalize is the only publisher and it
        // was never called. The plan stays `uploading` — an initiated upload is
        // not a plan to drop — and the caller may `discard` it.
        return { kind: "refused", reason: `upload-failed:${outcome.code}`, releasedObject: false, retryable: false, orphanedObject: false };
    }
    try {
      return await this.runCreate(job);
    } catch (error) {
      return this.fromThrow(job, error, "create-failed");
    }
  }

  /**
   * Turn a throw into an outcome without ever converting an unknown into a
   * clean failure.
   *
   * A revoked authority is the case that matters: the request it interrupted may
   * have been answered, so it is `unknown` — never a refusal, and never a claim
   * that anything was released.
   */
  private fromThrow(job: JobRecord, error: unknown, reason: string): SendOutcome {
    if (error instanceof AuthorityRevoked) return { kind: "unknown", reason: `revoked:${error.reason}` };
    // A revocation aborts the request in flight, so what surfaces is usually the
    // transport's own "the request was aborted" rather than the revocation. The
    // fence is the authority on WHY the job stopped; reporting the symptom would
    // send a host looking for a network fault that never happened.
    if (!job.fence.valid) return { kind: "unknown", reason: `revoked:${job.fence.reason ?? "unknown"}` };
    return { kind: "unknown", reason };
  }

  /**
   * Read the target as central currently describes it.
   *
   * Both reads are JOINED. `Promise.all` rejects on the first failure and leaves
   * the other request's rejection unobserved — a live socket and an unhandled
   * rejection, in a process where an unhandled rejection is fatal.
   */
  private async eligible(
    targetDeviceID: string,
    kind: "file" | "text",
    signal: AbortSignal,
  ): Promise<EligibleTarget> {
    const [rowsResult, keysResult] = await Promise.allSettled([
      this.options.tasks.devices(signal),
      this.options.tasks.targetKeys(targetDeviceID, signal),
    ]);
    if (rowsResult.status === "rejected") throw rowsResult.reason;
    if (keysResult.status === "rejected") throw keysResult.reason;
    const row = rowsResult.value.find((r) => r["ID"] === targetDeviceID);
    const inboxRaw = (row?.["Inbox"] ?? null) as Record<string, unknown> | null;
    if (inboxRaw === null) {
      throw new TargetIneligible(SEND_REFUSALS.deviceCannotReceive, "the target has no inbox");
    }
    const caps = inboxRaw["Capabilities"];
    return assertEligible(
      targetDeviceID,
      {
        capabilities: Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : [],
        autoAccept: typeof inboxRaw["AutoAccept"] === "string" ? (inboxRaw["AutoAccept"] as string) : "",
        presence: typeof inboxRaw["Presence"] === "string" ? (inboxRaw["Presence"] as string) : "",
        protocolVersion:
          typeof inboxRaw["ProtocolVersion"] === "number" ? (inboxRaw["ProtocolVersion"] as number) : 0,
        revoked: inboxRaw["Revoked"] === true,
      },
      keysResult.value.map((k) => ({
        keyID: String(k["ID"] ?? ""),
        generation: typeof k["Generation"] === "number" ? (k["Generation"] as number) : 0,
        publicKey: String(k["PublicKey"] ?? ""),
        algorithm: String(k["Algorithm"] ?? ""),
      })),
      kind,
      this.options.runtimeCaps,
    );
  }

  /**
   * Check the target and stage the plan, before a byte is encrypted.
   *
   * The fence is asserted on BOTH sides of every await: before the reads, so a
   * job already revoked makes no request; and after them, so a sign-out that
   * landed while central was answering does not go on to write a plan under an
   * authority that no longer exists.
   */
  private async prepare(job: JobRecord): Promise<EligibleTarget> {
    const input = job.input;
    if (input === null) throw new Error("send: this job has no staged intent");
    job.fence.assert();
    const target = await this.eligible(input.targetDeviceID, input.kind, job.fence.signal);
    job.fence.assert();
    await this.options.plans.stage({
      jobID: job.jobID,
      targetDeviceID: input.targetDeviceID,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      targetKeyID: target.key.keyID,
      targetKeyGeneration: target.key.generation,
      now: this.now(),
    });
    // A plan written under an authority that died during the write is still a
    // `staged` plan: nothing was attempted, so it is safe to drop and `cancel`
    // will settle it. Reported rather than swallowed.
    job.fence.assert();
    return target;
  }

  /**
   * Record the upload session id the moment the server names one.
   *
   * Handed to `engineFor` for the duration of ONE upload and wired there as the
   * engine's `onSession` hook. Private, because as a public method it was
   * durable persistence a host could perform at any moment, outside every piece
   * of work that joins it. It is not required for
   * recovery — `uploading` is entered before `init` precisely so a LOST init
   * response still leaves a plan that knows something may exist — but when there
   * is an id, having it on disk is the difference between resuming a session and
   * starting a second one.
   */
  private async recordUploadSession(job: JobRecord, uploadFence: Fence, uploadID: string): Promise<void> {
    // The UPLOAD's fence, not the job's: this recorder is scoped to the one
    // upload that produced it, and that fence is spent the moment the engine
    // settles. So a recorder that outlived its upload — kept by a host, or
    // called late — is refused by the authority rather than by luck.
    uploadFence.assert();
    await this.options.plans.advance(job.jobID, "uploading", { uploadID }, this.now());
  }

  /**
   * Upload the ciphertext, recording that something may exist BEFORE it can.
   *
   * `uploading` is entered before the engine touches the network. A response
   * that never arrives still leaves a plan that knows an object may exist, and
   * `upload-unknown` records a finalize whose outcome was not observed — which
   * is never reported as "no object" and never settled on a guess.
   */
  private async runUpload(job: JobRecord, feed: (engine: UploadEngine) => Promise<void>): Promise<UploadOutcome> {
    const input = job.input;
    if (input === null) throw new Error("send: this job has no staged intent");
    job.fence.assert();
    const plan = await this.options.plans.find(job.jobID);
    if (plan === null) throw new Error("send: no such job");
    // One content key, one immutable selection. A second run of this job under a
    // different document would produce ciphertext under a key the first run
    // already used, which is a nonce repeat over different plaintext.
    if (plan.manifestDigest.length > 0 && plan.manifestDigest !== input.manifestDigest) {
      throw new Error("send: this job's selection changed under its content key");
    }
    switch (plan.phase) {
      case "staged":
      case "uploading":
        break;
      case "upload-unknown":
        // A second upload would be a second object under a key whose first
        // object cannot be named. Resolving it is not this method's to guess:
        // `discard` is the caller's explicit decision, and a fresh delivery is a
        // NEW job with a NEW key.
        throw new Error("send: this job's upload outcome is unresolved");
      default:
        throw new Error(`send: this job's upload is past ${plan.phase}`);
    }
    job.fence.assert();
    // BEFORE any effect.
    await this.options.plans.advance(job.jobID, "uploading", { manifestDigest: input.manifestDigest }, this.now());

    const bytes = this.options.bytesFor(job.jobID);
    // The engine gets a CHILD fence, not the job's own.
    //
    // `UploadEngine.settle` revokes the fence it was handed — the upload's
    // authority is spent the moment the object is published. The job's is not:
    // the reseal and the create still have to happen under it. Handing the job's
    // fence straight to the engine made a SUCCESSFUL upload revoke the delivery
    // that had just earned the right to continue.
    //
    // The child carries the same captured authority and is revoked by anything
    // that revokes the parent, so a sign-out or a cancel still reaches the init
    // that runs before the engine exists.
    const uploadFence = new Fence(job.fence.authority);
    const inherit = (): void => uploadFence.revoke(job.fence.reason ?? "cancelled");
    if (!job.fence.valid) inherit();
    job.fence.signal.addEventListener("abort", inherit, { once: true });
    let outcome: UploadOutcome;
    let engine: UploadEngine | null = null;
    try {
      // `init` runs inside here and is bound to the child fence, so a revocation
      // during it aborts the request rather than being noticed afterwards.
      engine = await this.options.engineFor(job.jobID, bytes, uploadFence, (uploadID) =>
        this.recordUploadSession(job, uploadFence, uploadID),
      );
      await feed(engine);
      outcome = await engine.end();
    } catch (error) {
      if (engine !== null) {
        // Joined, not abandoned: the engine holds the socket, and its own
        // settled outcome is the authority on whether a finalize was reached.
        outcome = await engine.cancel();
      } else if (error instanceof AuthorityRevoked) {
        // Revoked before or during init. Nothing this side can name exists, but
        // an init answered after the abort still might, so this is ambiguous
        // rather than a clean failure.
        outcome = { status: "ambiguous", code: "authority-revoked" };
      } else {
        outcome = { status: "ambiguous", code: "internal" };
      }
    } finally {
      job.fence.signal.removeEventListener("abort", inherit);
    }
    if (outcome.status === "published") {
      await this.options.plans.advance(job.jobID, "uploaded", { storedObjectID: outcome.objectId }, this.now());
    } else if (outcome.status === "ambiguous") {
      await this.options.plans.advance(job.jobID, "upload-unknown", {}, this.now());
    }
    // `failed` and `cancelled` leave the plan at `uploading`: provably nothing
    // was finalized, but an initiated upload is still not a plan to drop.
    return outcome;
  }

  /**
   * Seal, persist the exact request, then create.
   *
   * The randomized sealed box is durable BEFORE the create leaves this process.
   * Reusing that exact value is what makes a retry the SAME request rather than
   * a different one under the same idempotency key.
   */
  private async runCreate(job: JobRecord): Promise<SendOutcome> {
    const jobID = job.jobID;
    job.fence.assert();
    let plan = await this.options.plans.find(jobID);
    if (plan === null) throw new Error("send: no such job");
    job.fence.assert();

    // A plan that already names a task succeeded and died in its tidy-up.
    if (plan.taskID.length > 0) return this.finishRecorded(job, plan);
    if (plan.phase === "settled" || plan.phase === "abandoned") {
      return {
        kind: "refused",
        reason: "job-terminal",
        releasedObject: false,
        retryable: false,
        orphanedObject: plan.storedObjectID.length > 0,
      };
    }
    if (plan.storedObjectID.length === 0) {
      // Nothing to bind. `upload-unknown` in particular must be resolved against
      // the server first; guessing here could create a task for an object that
      // does not exist, or a second one for an object that does.
      return { kind: "unknown", reason: "upload-outcome-unresolved" };
    }

    // A plan already at `creating` with a persisted request carries an attempt
    // whose answer nobody read. See the header: the persisted request is
    // repeated byte-identically and NOTHING is resealed or released on a
    // client-side key comparison, because a rotation is not evidence about that
    // earlier attempt.
    const resumed = plan.phase === "creating" && plan.wrappedKey.length > 0;
    if (resumed && !this.recordsCompleteRequest(plan)) {
      // A plan from a build that did not record the whole request. It cannot be
      // repeated verbatim, and re-deriving the missing fields from THIS build
      // would compose a different request under an idempotency key whose
      // outcome is unknown. The honest answer is that it stays unknown: nothing
      // is altered, nothing is released, nothing is dropped.
      return { kind: "unknown", reason: "incomplete-recorded-request" };
    }
    if (resumed) {
      const converged = await this.converge(job, plan);
      if (converged.kind === "delivered") return converged;
      job.fence.assert();
    } else {
      let target: EligibleTarget;
      try {
        target = await this.eligible(plan.targetDeviceID, plan.kind, job.fence.signal);
      } catch (error) {
        if (error instanceof TargetIneligible) {
          // The target stopped accepting deliveries during the upload. No create
          // has been attempted, so nothing is bound — but the refusal is one the
          // user can undo on that device, and releasing here would charge them a
          // second upload for it. The plan keeps the object for the retry;
          // `cancel` is how they give it back.
          return {
            kind: "refused",
            reason: error.refusal,
            releasedObject: false,
            retryable: true,
            orphanedObject: false,
          };
        }
        throw error;
      }
      job.fence.assert();
      const rotated =
        plan.wrappedKey.length > 0 &&
        keyChanged(
          { keyID: plan.targetKeyID, generation: plan.targetKeyGeneration, publicKey: "", algorithm: "" },
          target.key,
        );
      if (plan.wrappedKey.length === 0 || rotated) {
        if (rotated && plan.resealed) {
          // A second rotation on a send that already followed one. No create has
          // been attempted from this plan — it is not `creating` — so the object
          // is bound to nothing and this is a definitive dead end.
          return this.abandon(job, plan, "stale-target-key", { release: true, retryable: false });
        }
        const wrapped = await this.options.sealToTarget(jobID, target);
        job.fence.assert();
        plan = await this.options.plans.advance(
          jobID,
          "creating",
          {
            wrappedKey: wrapped,
            // The COMPLETE request goes down together. A plan that recorded the
            // sealed box but not the version and algorithm could not be repeated
            // verbatim by a build whose own had moved.
            protocolVersion: this.options.protocolVersion,
            wrapAlgorithm: this.options.runtimeCaps.keyAlgorithm,
            targetKeyID: target.key.keyID,
            targetKeyGeneration: target.key.generation,
            resealed: plan.wrappedKey.length > 0,
          },
          this.now(),
        );
      } else if (plan.phase !== "creating") {
        plan = await this.options.plans.advance(jobID, "creating", {}, this.now());
      }
      job.fence.assert();
    }

    let resealAllowed = !plan.resealed;
    for (let attempt = 0; attempt < MAX_AMBIGUOUS_CREATE_ATTEMPTS; attempt += 1) {
      job.fence.assert();
      const request = this.requestFrom(plan);
      try {
        const result = await this.options.tasks.createTask(plan.targetDeviceID, request, job.fence.signal);
        // The task id is recorded BEFORE anything is released, so a crash here
        // leaves a plan that converges rather than one that creates a second.
        await this.options.plans.advance(jobID, "created", { taskID: result.task.ID }, this.now());
        return { kind: "delivered", created: result.created, task: result.task };
      } catch (error) {
        if (!(error instanceof SendApiError)) throw error;
        const verdict = this.classify(error);
        if (verdict === "ambiguous") continue;
        if (verdict === "converge") return this.converge(job, plan);
        if (verdict === "refused-before-replay") {
          // Refused by a check that runs BEFORE the idempotent replay, so this
          // says nothing about an earlier attempt under the same key. Release
          // nothing, claim nothing, and keep the exact request for a build or a
          // configuration that can carry it.
          return {
            kind: "refused",
            reason: error.serverCode ?? error.code,
            releasedObject: false,
            retryable: true,
            orphanedObject: false,
          };
        }
        if (verdict === "definitive-keep-object") {
          // `stored_object_already_bound` says a task WE DID NOT CREATE owns
          // these bytes; deleting them would destroy somebody else's delivery.
          // `unauthorized`'s remedy is local, and a release issued with the
          // bearer just rejected would fail and orphan the object anyway.
          return {
            kind: "refused",
            reason: error.serverCode ?? error.code,
            releasedObject: false,
            retryable: true,
            orphanedObject: false,
          };
        }
        // Every remaining verdict comes from INSIDE `CreateInboxTask`, which
        // checks the idempotent replay before any of them. Reaching one
        // therefore proves no row exists under this key — including for the
        // earlier attempt a resumed plan was repeating. That is the only thing
        // that earns a reseal or a release, and it is a server verdict from
        // past the replay, never a local key comparison and never one of the
        // handler's own pre-transaction validations.
        job.provablyUnbound = true;
        if (verdict === "definitive-retain") {
          // Rolled back, but the identical request could succeed later: the
          // target's queue drains, the sender finishes enrolling. The plan stays
          // at `creating` so the retry is the same request.
          return {
            kind: "refused",
            reason: error.serverCode ?? error.code,
            releasedObject: false,
            retryable: true,
            orphanedObject: false,
          };
        }
        if (error.serverCode === SEND_REFUSALS.staleTargetKey && resealAllowed) {
          resealAllowed = false;
          const target = await this.eligible(plan.targetDeviceID, plan.kind, job.fence.signal);
          job.fence.assert();
          const resealedKey = await this.options.sealToTarget(jobID, target);
          job.fence.assert();
          plan = await this.options.plans.advance(
            jobID,
            "creating",
            {
              wrappedKey: resealedKey,
              // `stale_target_key` comes from INSIDE the transaction, after the
              // replay check, so nothing exists under this key and composing a
              // fresh request from current options is legitimate here.
              protocolVersion: this.options.protocolVersion,
              wrapAlgorithm: this.options.runtimeCaps.keyAlgorithm,
              targetKeyID: target.key.keyID,
              targetKeyGeneration: target.key.generation,
              resealed: true,
            },
            this.now(),
          );
          // Not counted against the ambiguous budget: this is a different
          // request, refused for a reason that has now been fixed.
          attempt -= 1;
          continue;
        }
        return this.abandon(job, plan, error.serverCode ?? error.code, { release: true, retryable: false });
      }
    }
    // Every attempt was ambiguous. Ask central what exists rather than guess.
    return this.converge(job, plan);
  }

  /**
   * The request, rebuilt from the PLAN alone.
   *
   * Every field comes off disk. Reading the protocol version or the wrap
   * algorithm from the CURRENT options here would mean a build whose negotiated
   * version or algorithm had moved composed a different request under the same
   * idempotency key — and because the handler validates both BEFORE the
   * idempotent replay, that retry would be refused without central ever being
   * asked whether the first attempt had already succeeded.
   */
  private requestFrom(plan: SendPlanRecord): CreateTaskRequest {
    return {
      idempotencyKey: plan.idempotencyKey,
      storedFileId: plan.storedObjectID,
      protocolVersion: plan.protocolVersion,
      wrapAlgorithm: plan.wrapAlgorithm,
      wrappedKey: plan.wrappedKey,
      targetKeyId: plan.targetKeyID,
      targetKeyGeneration: plan.targetKeyGeneration,
    };
  }

  /** Does this plan record a request complete enough to repeat verbatim? */
  private recordsCompleteRequest(plan: SendPlanRecord): boolean {
    return (
      plan.wrappedKey.length > 0 &&
      plan.wrapAlgorithm.length > 0 &&
      plan.protocolVersion > 0 &&
      plan.storedObjectID.length > 0 &&
      plan.targetKeyID.length > 0 &&
      plan.targetKeyGeneration > 0
    );
  }

  /**
   * How a create failure must be treated.
   *
   * `classifyRefusal` reads a SERVER VERDICT. A create whose answer was never
   * read is not a verdict, and passing one through would map it onto
   * `definitive-refused` — releasing an object a task may already own. Every
   * transport-level failure is therefore ambiguous here, and the two local
   * refusals release nothing: a client that will not compose its own URL has
   * proven something about itself, not about the server.
   */
  private classify(error: SendApiError): OutcomeClass {
    switch (error.code) {
      case "network":
      case "timeout":
      case "too-large":
      // A 2xx whose body would not parse. The task may well have been created.
      case "malformed":
        return "ambiguous";
      case "origin-refused":
      case "redirect-refused":
        return "definitive-keep-object";
      case "server-refused":
        return classifyRefusal(error.serverCode, error.status ?? 0);
    }
  }

  /**
   * Ask central what actually exists.
   *
   * ## Absence here is NOT proof
   *
   * This is a bounded, paginated recent-task view, not a lookup by idempotency
   * key. A missing row can mean it fell outside the window or that a timed-out
   * create is still committing. And the account's ordinary share list EXCLUDES
   * `device_task` objects entirely, so it can never be used to conclude the
   * object is gone either. Destroying anything here could strand a live
   * delivery, so the only honest answer is unknown.
   *
   * A positive match must be OUR request, not merely our key: central refuses a
   * reused key with `idempotency_key_conflict` precisely because a row can carry
   * the same key and a different request, and adopting one would record another
   * delivery as this job's.
   */
  private async converge(job: JobRecord, plan: SendPlanRecord): Promise<SendOutcome> {
    let recent: readonly SenderTask[];
    try {
      recent = await this.options.tasks.tasks(plan.targetDeviceID, CONVERGENCE_LOOKUP_LIMIT, job.fence.signal);
    } catch {
      return { kind: "unknown", reason: "lookup-failed" };
    }
    const found = recent.find(
      (t) =>
        t.IdempotencyKey.length > 0 &&
        t.IdempotencyKey === plan.idempotencyKey &&
        t.StoredFileID === plan.storedObjectID,
    );
    if (found !== undefined) {
      job.fence.assert();
      await this.options.plans.advance(plan.jobID, "created", { taskID: found.ID }, this.now());
      return { kind: "delivered", created: false, task: found };
    }
    return { kind: "unknown", reason: "not-in-recent-window" };
  }

  /** A previous attempt created the task and died before finishing cleanup. */
  private async finishRecorded(job: JobRecord, plan: SendPlanRecord): Promise<SendOutcome> {
    try {
      const task = await this.options.tasks.task(plan.targetDeviceID, plan.taskID, job.fence.signal);
      if (plan.phase === "created") {
        await this.options.plans.advance(plan.jobID, "settled", {}, this.now());
      }
      return { kind: "delivered", created: false, task };
    } catch (error) {
      if (error instanceof SendApiError && error.code === "server-refused" && error.status === 404) {
        // Central says the task is gone. Its ciphertext went with it inside the
        // same transaction (`handleDeleteInboxTask` removes both rows), so
        // nothing is owed and only the local remains are ours to close.
        if (plan.phase === "created") {
          await this.options.plans.advance(plan.jobID, "settled", {}, this.now());
        }
        return { kind: "refused", reason: "no-task", releasedObject: false, retryable: false, orphanedObject: false };
      }
      return { kind: "unknown", reason: "task-read-failed" };
    }
  }

  /**
   * End this job, releasing only what is proven unbound, and say what happened.
   *
   * The order is the point:
   *
   *  1. the intent is invalidated FIRST — the fence is revoked, so no create can
   *     follow a release and any request still in flight is aborted;
   *  2. the plan becomes `abandoned`, still naming the object. `abandoned` is
   *     deliberately not `settled`: it claims only that this side stopped;
   *  3. the release is attempted. Only a release this side OBSERVED succeed
   *     clears the object id, so a failed one leaves a record `cleanup` can
   *     retry rather than an orphan nothing can find.
   */
  private async abandon(
    job: JobRecord,
    plan: SendPlanRecord,
    reason: string,
    options: { readonly release: boolean; readonly retryable: boolean },
  ): Promise<SendOutcome> {
    job.fence.revoke("job-settled");
    const releasable = options.release && plan.storedObjectID.length > 0 && !safeToDrop(plan.phase);
    const abandoned = await this.options.plans.advance(job.jobID, "abandoned", {}, this.now());
    if (!releasable) {
      return {
        kind: "refused",
        reason,
        releasedObject: false,
        retryable: options.retryable,
        orphanedObject: abandoned.storedObjectID.length > 0,
      };
    }
    const released = await this.tryRelease(job, abandoned);
    return {
      kind: "refused",
      reason,
      releasedObject: released,
      retryable: options.retryable,
      orphanedObject: !released,
    };
  }

  /**
   * Attempt the release and record only an OBSERVED success.
   *
   * Two deliberate choices about who this request answers to. Its authority is
   * the job's ORIGINAL captured one, because the object belongs to the account
   * that uploaded it — issuing it under whatever is signed in now would be a
   * request for somebody else's object. And its signal is the job's TEARDOWN
   * controller, not its fence: by here the fence has been revoked, and binding
   * the cleanup to it would abort the very request that removes the orphan.
   * Binding it to a bare timeout instead would hide it from the quit path that
   * has to join it.
   */
  private async tryRelease(job: JobRecord, plan: SendPlanRecord): Promise<boolean> {
    const release = this.options.releaseObject;
    // No hook, or none that can succeed on this server. Not an error: the object
    // is left to central's collector, and the plan keeps naming it.
    if (release === undefined) return false;
    try {
      await release.call(this.options, plan.storedObjectID, job.fence.authority, this.teardownSignal(job));
    } catch {
      // A failed release leaves invisible storage, which is a cost — but not one
      // this client can settle, because central refuses a task-purpose delete
      // and reclaims the object itself. Reporting it as released would be a lie;
      // the plan keeps naming it so a host can say what was left.
      return false;
    }
    await this.options.plans.observeRelease(plan.jobID);
    return true;
  }

  /**
   * Retry the release an abandoned plan still owes.
   *
   * Registered like every other side effect, so `quiesce` and `dispose` join it.
   * Bounded and explicit: it refuses any plan that is not `abandoned`, so it can
   * never be pointed at a delivery whose outcome is merely unknown.
   *
   * `supported` is false when this build has no release hook — which is the
   * ordinary case, because central refuses a task-purpose delete. A host must
   * not put a retry button on something that answers false forever; the object
   * is central's to reclaim, on central's own schedule.
   */
  cleanup(
    jobID: string,
    authority?: AuthorityInput,
  ): Promise<{ readonly released: boolean; readonly supported: boolean }> {
    // Per-JOB checks run against the record first, so a caller asking about one
    // job is told the reason that concerns it rather than a coarser one.
    const job = this.attach(jobID, authority);
    this.assertAuthorityIntact(job);
    this.assertAdmitting();
    const supported = this.options.releaseObject !== undefined;
    return this.startAuxiliary(job, "cleanup", async () => {
      const plan = await this.options.plans.find(jobID);
      if (plan === null) return { released: false, supported };
      if (plan.phase !== "abandoned" || plan.storedObjectID.length === 0) {
        return { released: false, supported };
      }
      return { released: await this.tryRelease(job, plan), supported };
    });
  }

  /**
   * Stop a delivery the user changed their mind about.
   *
   * Cancellation invalidates the intent SYNCHRONOUSLY — before this method's
   * first await, so a job admitted in the same tick is reached — and the work it
   * then does is registered like any other, so a quit joins it rather than
   * racing it. It JOINS the delivery before reading anything: an abandoned
   * promise still holds a socket and a server-side append, and answering the
   * user while it runs would be a claim about a thing that has not stopped. Only
   * once the delivery has recorded its own outcome is the plan read, so
   * cancellation can never race the bookkeeping into losing an uploaded object
   * or an exact request.
   *
   * `authority` is required only for a job this process never started — a plan
   * found on disk. The requests below go out under a bearer, and a bearer is
   * never inferred.
   */
  cancel(jobID: string, authority?: AuthorityInput): Promise<SendOutcome> {
    // Checked BEFORE the revoke: closing the gate must not leave a delivery
    // cancelled by a call that then refused to run. "No cancellation before
    // consent" is only true if the refusal comes first.
    const job = this.attach(jobID, authority);
    this.assertAuthorityIntact(job);
    this.assertAdmitting();
    job.fence.revoke("cancelled");
    return this.startAuxiliary(job, "cancel", () => this.runCancel(job));
  }

  private async runCancel(job: JobRecord): Promise<SendOutcome> {
    const jobID = job.jobID;
    await Promise.allSettled([job.primary ?? Promise.resolve()]);
    const plan = await this.options.plans.find(jobID);
    if (plan === null) return { kind: "cancelled", task: null };

    // A created task is central's to cancel, and `DELETE` takes the ciphertext
    // with it. The request runs on the teardown signal for the same reason a
    // release does: the fence is revoked by now, and cancelling through it would
    // abort the cancellation.
    if (plan.taskID.length > 0) {
      try {
        // Read the state FIRST. `DeleteInboxTask` refuses a task that is being
        // received, but it does NOT refuse a terminal one — a `saved` row is
        // deleted like any other. So "the receiver already wrote the files" is a
        // fact only this side can check before asking, and calling that outcome
        // a cancellation would tell the user their transfer was stopped when it
        // had already landed. The window between this read and the delete is
        // real and cannot be closed from here; what can be avoided is reporting
        // a delivery that was ALREADY terminal as cancelled.
        let before: SenderTask;
        try {
          before = await this.options.tasks.task(plan.targetDeviceID, plan.taskID, this.teardownSignal(job));
        } catch (error) {
          if (error instanceof SendApiError && error.code === "server-refused" && error.status === 404) {
            // Central no longer holds it, and `handleDeleteInboxTask` takes a
            // task-purpose object's ciphertext with the row. Already stopped —
            // reporting that as a failed cancel would invite a pointless retry.
            if (plan.phase === "created") {
              await this.options.plans.advance(jobID, "settled", {}, this.now());
            }
            return { kind: "cancelled", task: null };
          }
          throw error;
        }
        if (isTerminalForSender(before.State)) {
          if (plan.phase === "created") {
            await this.options.plans.advance(jobID, "settled", {}, this.now());
          }
          return { kind: "delivered", created: false, task: before };
        }
        const answer = await this.options.tasks.cancelTask(
          plan.targetDeviceID,
          plan.taskID,
          this.teardownSignal(job),
        );
        if (answer.outcome === "in-progress") {
          // A live lease. Not a failure and not a cancellation: the remedy is to
          // ask again once the receiver's lease lapses or its transfer ends.
          return {
            kind: "refused",
            reason: "task_in_progress",
            releasedObject: false,
            retryable: true,
            orphanedObject: false,
          };
        }
        if (plan.phase === "created") {
          await this.options.plans.advance(jobID, "settled", {}, this.now());
        }
        if (answer.outcome === "cancelled") return { kind: "cancelled", task: answer.task };
        // `terminal`: it ended between the read and the delete.
        return answer.task === null
          ? { kind: "unknown", reason: "cancel-raced-terminal" }
          : { kind: "delivered", created: false, task: answer.task };
      } catch {
        return { kind: "unknown", reason: "cancel-failed" };
      }
    }

    switch (plan.phase) {
      case "staged":
        // Nothing was ever attempted.
        await this.options.plans.advance(jobID, "settled", {}, this.now());
        return { kind: "cancelled", task: null };
      case "uploaded": {
        // A finalized object no create has been attempted against. Provably
        // bound to nothing — but reclaiming it is central's, not this client's,
        // so the release below is best effort and the plan keeps naming the
        // object whether or not it succeeded.
        const abandoned = await this.options.plans.advance(jobID, "abandoned", {}, this.now());
        const released = await this.tryRelease(job, abandoned);
        return {
          kind: "refused",
          reason: "cancelled",
          releasedObject: released,
          retryable: false,
          orphanedObject: !released,
        };
      }
      case "creating":
        // A create was attempted and its outcome is not known. Releasing here
        // could destroy the ciphertext of a delivery that is already queued.
        return { kind: "unknown", reason: "create-outcome-unresolved" };
      case "uploading":
      case "upload-unknown":
        // An object may exist that this side cannot name, so there is nothing to
        // release and nothing to claim about it.
        return { kind: "unknown", reason: "upload-outcome-unresolved" };
      default:
        return { kind: "cancelled", task: null };
    }
  }


  /**
   * Give up on a delivery whose upload outcome can never be resolved.
   *
   * The caller's explicit decision, and the only way an `upload-unknown` plan
   * ends. It releases NOTHING: the object — if one exists at all — was never
   * named, a `device_task` object is invisible in the account's own file list,
   * and there is no endpoint that could find it. Saying so is the honest result;
   * a fresh delivery is a NEW job with a NEW content key.
   */
  discard(jobID: string, authority?: AuthorityInput): Promise<SendOutcome> {
    // Checked BEFORE the revoke: a gate that refuses after the fence is already
    // down has cancelled a delivery it then declined to carry out.
    const job = this.attach(jobID, authority);
    this.assertAuthorityIntact(job);
    this.assertAdmitting();
    job.fence.revoke("cancelled");
    return this.startAuxiliary(job, "discard", async () => {
      await Promise.allSettled([job.primary ?? Promise.resolve()]);
      const plan = await this.options.plans.find(jobID);
      if (plan === null) {
        return { kind: "refused", reason: "no-plan", releasedObject: false, retryable: false, orphanedObject: false };
      }
      if (plan.phase !== "uploading" && plan.phase !== "upload-unknown") {
        throw new Error(`send: a ${plan.phase} plan is not an unresolved upload`);
      }
      await this.options.plans.advance(jobID, "abandoned", {}, this.now());
      return {
        kind: "refused",
        reason: "upload-outcome-unresolved",
        releasedObject: false,
        retryable: false,
        orphanedObject: false,
      };
    });
  }
}
