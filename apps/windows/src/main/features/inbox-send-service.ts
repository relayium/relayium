// Inbox SEND, composed: the jobs a running app has, and their lifetime.
//
// `inbox-send.ts` states the contract this composes to — the account and
// target-list invariants, what may cross to a renderer, and why the outcome
// union is carried through rather than flattened. This file is the machinery:
// it builds the accepted `SendCoordinator` for one account, drives one delivery
// per target, and owns admission, cancellation and teardown.
//
// ## The division of labour, which is not this file's to change
//
// `src/main/inbox/send-*.ts` owns the durable plan, the idempotency key, the
// `device_task` session, the convergence of an ambiguous attempt, and the
// fences that make an account change safe. It does NOT own which jobs exist,
// which document asked for one, or when a quit may refuse a new one. That split
// is exactly the one `features/inbox.ts` draws for receive and
// `features/stored-send.ts` draws for stored, and the coordinator's own
// lifecycle vocabulary is adopted verbatim rather than re-invented:
//
//   * `fence()` closes admissions ONLY — nothing running stops — and
//     `resumeAdmissions()` is the user's "Stay";
//   * `invalidateAccount` returning `quiet: false` means RETAIN and JOIN, not a
//     successful disposal;
//   * an identity change closes a coordinator PERMANENTLY, so the next account
//     gets a new one rather than a reset one.
//
// ## Who produces the ciphertext, and what that buys
//
// The renderer does, exactly as it does for stored send: it holds the user's
// `File` objects — from `<input>`, `webkitdirectory` and drag-drop, none of
// which grant an arbitrary-path read channel — and runs the production shared
// `encryptFiles`. So the ciphertext flows renderer→main and the ONE secret that
// flows the other way is this job's content key. Main never reads a path, and
// for a TEXT delivery main never sees the message at all: it is told a byte
// LENGTH and receives frames.
//
// ## One selection, one content key
//
// `manifestDigest` is frozen at `start` from the canonical v3 manifest bytes,
// and the coordinator checks every later step against it. A re-pick is a NEW
// job with a NEW key rather than a re-run against changed plaintext, because
// AES-GCM under a repeated nonce with different plaintext is a break rather
// than a bug.

import type { AccountContext } from "../inbox/account.js";
import { AT_REST_KEY_BYTES } from "../inbox/atrest.js";
import { InboxFiles } from "../inbox/files.js";
import { SendCoordinator, type SendDelivery, type SendOutcome } from "../inbox/send-coordinator.js";
import { SendPlanStore } from "../inbox/send-plan.js";
import { SendTransport, SendApiError } from "../inbox/send-transport.js";
import { DeviceTaskByteTransport } from "../inbox/send-bytes.js";
import { buildSendManifest, encodeSendManifest, SendManifestError, type SendKind } from "../inbox/send-manifest.js";
import { SEND_REFUSALS } from "../inbox/send-wire.js";
import type { InboxRuntime } from "../inbox/runtime-contract.js";
import { UploadEngine, type CipherFrame } from "../stored/upload/engine.js";
import { frameLengthAt, planUpload, sealedManifestFits, type UploadPlan } from "../stored/upload/plan.js";
import { UploadTransport, type UploadByteTransport, type UploadRetention } from "../stored/upload/transport.js";
import type { AuthorityInput } from "../stored/upload/authority.js";
import { storedRuntime } from "../stored/runtime.js";
import type { StoredRuntime } from "../stored/runtime-contract.js";
import { describeSendOutcome, describeDevice, type InboxSendTargetView, type InboxSendView } from "./inbox-send.js";
import type { InboxAuthority } from "./inbox.js";
import type { FrameExpectation, InboxSendStart } from "../../shared/ipc-contract.js";

/**
 * The account identity a send runs under.
 *
 * Supplied by the Inbox feature rather than derived here, and that is
 * deliberate: the durable send plan lives in the SAME per-account directory as
 * the journal, the vault and the named history, keyed by the same digest. A
 * second derivation of that digest would be a second implementation of the rule
 * `features/inbox.ts` documents at length — and a mismatch would put a job's
 * plan somewhere the account's own key cannot open.
 */
export interface InboxSendIdentity {
  readonly context: AccountContext;
  /** Central's device row id for THIS device: the sender, never a target. */
  readonly deviceID: string;
  readonly epoch: number;
}

export interface InboxSendDeps {
  /** The one origin this feature may reach. The build's, never a payload's. */
  readonly origin: string;
  /**
   * The account authority, read FRESH at admission.
   *
   * A function because it changes underneath this feature: a sign-out is not
   * something the sender is asked about first. The bearer is held only for as
   * long as it takes to hand to the transport, and is never published.
   */
  authority(): Promise<InboxAuthority>;
  /** The bound account, or null when the Inbox has not adopted one. */
  identity(): InboxSendIdentity | null;
  /** The at-rest key for this account's local stores. */
  atRestKeyFor(context: AccountContext): Promise<Uint8Array>;
  runtime(): Promise<InboxRuntime>;
  /**
   * The STORED runtime, which is what `UploadEngine` is built against.
   *
   * Two artifacts, deliberately: the Inbox bundle owns the v3 manifest, the
   * sealed content key and the frame producer, and the stored bundle owns the
   * upload engine's geometry. Loading the accepted one rather than handing the
   * engine a hand-made object keeps a single source for the frame constants.
   * Memoised by `storedRuntime()` itself, so this costs one load per process.
   */
  storedRuntime?(): Promise<StoredRuntime>;
  /** The current account epoch, read synchronously by the change watcher. */
  accountEpoch(): number;
  /** The document generation on screen. One document, one job. */
  currentDocument(): number;
  /** Committed ciphertext bytes, emitted on the document that asked. */
  onProgress?(job: { readonly id: string; readonly document: number }, committed: number, total: number): void;
  /** How one send ended, pushed as soon as it does. */
  onOutcome?(job: { readonly id: string; readonly document: number }, view: InboxSendView): void;
  reportFailure?(err: unknown): void;
  now?(): number;
  /** Test seams. Production takes the defaults. */
  fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

/**
 * How long a delivery's object is asked to live.
 *
 * A `device_task` object's real lifetime is its TASK's — central clamps this
 * and applies the plan cap — so this is a floor for the window in which the
 * target can still claim it, not a retention the user chose. Burn and download
 * limits are refused outright by `resolveUploadRetention` for a task object,
 * which is why neither is offered anywhere on this path.
 */
export const DEVICE_TASK_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Live sends at once. A bound before any work, not after it. */
export const MAX_ACTIVE_INBOX_SENDS = 8;

/**
 * How many SETTLED deliveries keep their outcome.
 *
 * Enough that a page can ask about anything it saw in one session, bounded so
 * a long-running process does not accumulate one entry per delivery forever.
 * Evicting one loses an answer a page could still ask for, so the bound is
 * generous rather than tight — and the evicted job's content key is wiped with
 * it rather than left behind.
 */
export const MAX_REMEMBERED_SENDS = 64;

/**
 * How many UNRESOLVED deliveries this process will hold at once.
 *
 * A hard admission bound rather than an eviction bound: past it, a new send is
 * refused so the user can settle what is already unaccounted for. Dropping the
 * oldest instead would silently destroy the identity of a delivery that may be
 * live, which is the one thing this feature must never do.
 */
export const MAX_UNRESOLVED_SENDS = 16;

/** What this feature is holding, for the quit prompt and the risk snapshot. */
export interface InboxSendInventory {
  /** Jobs still in flight. Each is a delivery the user would lose. */
  readonly active: number;
  /** Sends whose outcome this process could not establish. */
  readonly unresolved: number;
}

export type InboxSendTargets =
  | { readonly ok: true; readonly targets: readonly InboxSendTargetView[] }
  | { readonly ok: false; readonly refusal: "signed-out" | "unavailable" | "transport" };

/**
 * The renderer's frames, handed to an engine that does not exist yet.
 *
 * ## Why a queue rather than a direct call
 *
 * `SendCoordinator.deliver` takes a `feed(engine)` callback and calls it only
 * after the eligibility read, the plan staging and the session `init` — three
 * network steps. The producer is a renderer that starts encrypting as soon as
 * `start` answers, so its first frames arrive BEFORE there is an engine to hand
 * them to. Dropping them would corrupt the object; refusing them would make the
 * page retry work it has already done.
 *
 * So a frame parks here until the engine exists, and exactly one frame is in
 * flight at a time — `UploadEngine.feed` refuses a concurrent call by design,
 * because a queue that ran ahead of the acknowledged offset would make the
 * retained replay window stop being a fact.
 */
/** Thrown out of `drive` when the frames will never arrive. See `stop`. */
class ProducerAbandoned extends Error {
  constructor() {
    super("inbox-send: the producer was abandoned");
    this.name = "ProducerAbandoned";
  }
}

/**
 * How many frames may be parked at once.
 *
 * The renderer's own loop awaits each `feed` before producing the next, so two
 * is the ordinary maximum. The bound exists for the case that is not ordinary:
 * a compromised or broken page pushing frames as fast as IPC accepts them would
 * otherwise grow this queue without limit inside the privileged process. Past
 * the bound the delivery is ABANDONED rather than truncated — a short object is
 * never finalized, and the page is told nothing more is owed.
 */
const MAX_PARKED_FRAMES = 8;

class FrameProducer {
  private readonly waiting: {
    readonly frame: CipherFrame;
    readonly resolve: (expects: FrameExpectation | null) => void;
  }[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  /** Set when the job settled. Every later frame is answered `null`. */
  private stopped = false;

  /**
   * Offer one frame and learn what is owed next.
   *
   * Answers `null` — never rejects — when the job has stopped. A rejection
   * would cross IPC as an opaque error and tell the page nothing; `null` is
   * what its producer loop already breaks on, and `end` then reports the
   * outcome this process actually recorded.
   */
  feed(frame: CipherFrame): Promise<FrameExpectation | null> {
    if (this.stopped || this.closed) return Promise.resolve(null);
    if (this.waiting.length >= MAX_PARKED_FRAMES) {
      // Abandoned, not buffered. See `MAX_PARKED_FRAMES`.
      this.stop();
      return Promise.resolve(null);
    }
    return new Promise<FrameExpectation | null>((resolve) => {
      this.waiting.push({ frame, resolve });
      this.wake?.();
      this.wake = null;
    });
  }

  /** The producer says it has sent everything. The upload may finalize. */
  end(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  /**
   * The job is being ABANDONED — a cancel, a sign-out, a destroyed document.
   *
   * Distinct from `end`, and the distinction is load-bearing. `end` means the
   * producer sent everything, so `drive` returns and the coordinator finalizes.
   * This means the frames will never arrive, so `drive` THROWS: `runUpload`
   * then cancels the engine and joins it, rather than finalizing an object that
   * is short by however much was never produced.
   */
  stop(): void {
    this.stopped = true;
    this.closed = true;
    for (const entry of this.waiting.splice(0)) entry.resolve(null);
    this.wake?.();
    this.wake = null;
  }

  /** Drive the engine until the producer is done. The coordinator's `feed`. */
  async drive(engine: UploadEngine): Promise<void> {
    for (;;) {
      const next = this.waiting.shift();
      if (next === undefined) {
        // Abandoned beats closed: `stop` sets both, and returning cleanly there
        // would hand the coordinator a finalize for an object nobody finished.
        if (this.stopped) throw new ProducerAbandoned();
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      // A throw here propagates into `runUpload`, which cancels the engine and
      // JOINS it — the engine holds the socket and its own settled outcome is
      // the authority on whether a finalize was reached. Answering the parked
      // caller first means the page is not left waiting on a promise nobody
      // will resolve.
      try {
        await engine.feed(next.frame);
      } catch (error) {
        next.resolve(null);
        this.stop();
        throw error;
      }
      next.resolve(engine.expects);
    }
  }
}

/** The upload material one job was staged with. */
interface Staged {
  readonly plan: UploadPlan;
  readonly sealedManifest: Uint8Array;
  readonly storeKey: CryptoKey;
  /** RAW content key material. Wiped when the delivery settles. */
  readonly key: Uint8Array;
}

/** One send this process owns. */
interface Job {
  readonly jobID: string;
  readonly targetDeviceID: string;
  readonly document: number;
  readonly epoch: number;
  readonly producer: FrameProducer;
  readonly delivery: SendDelivery;
  /** The plan's total, so progress can be reported against something. */
  readonly cipherBytes: number;
  /**
   * A cancel is running and owns the outcome.
   *
   * Set SYNCHRONOUSLY by `cancel`, before its first await. Cancelling revokes
   * the job's fence, so the interrupted primary settles with `unknown` — and
   * without this flag that raced the cancel's own, better-informed answer to
   * the page, which then showed "could not confirm" and corrected itself a
   * moment later over an operation that had cleanly stopped.
   */
  cancelling: boolean;
  /** Recorded when the delivery settles, so a late `end` still answers. */
  view: InboxSendView | null;
}

/** The coordinator and everything captured with one account identity. */
interface Bound {
  readonly accountKey: string;
  readonly deviceID: string;
  readonly epoch: number;
  readonly coordinator: SendCoordinator;
  readonly transport: SendTransport;
  readonly bearer: string;
  readonly runtime: InboxRuntime;
}

export class InboxSendService {
  #bound: Bound | null = null;
  #building: Promise<Bound | null> | null = null;
  readonly #jobs = new Map<string, Job>();
  /**
   * Everything one live job needs that is NOT the coordinator's.
   *
   * Held beside the job rather than inside it because `engineFor` and
   * `sealToTarget` are called BY the coordinator, asynchronously, with only a
   * job id to go on.
   */
  readonly #staged = new Map<string, Staged>();
  /**
   * Jobs with a DEFINITE outcome, bounded and evictable.
   *
   * What makes a second `end` answer with what happened rather than "no such
   * job". Losing one costs an answer a page could still have asked for, and
   * nothing else: the delivery is settled and its key is already wiped.
   */
  readonly #settled = new Map<string, Job>();
  /**
   * Jobs whose outcome is UNKNOWN. Bounded, and NEVER evicted.
   *
   * ## Why this is a separate map, and why nothing may push one out
   *
   * These were kept beside the settled ones in a single bounded map, and the
   * consequence was only reachable once the coordinator cap was released
   * properly: sixty-four later, completely ordinary sends evicted an unresolved
   * delivery from the front of it and wiped that job's content key. A converge
   * then answered `unknown` — permanently — for a delivery that had actually
   * been created. Ordinary use destroyed the only handle on the one thing in
   * this feature that cannot be recovered any other way.
   *
   * So an unresolved plan and its key leave here for exactly one reason: a
   * converge ESTABLISHED what happened. When this is full, a NEW send is
   * refused before it uploads anything — a refusal the user can act on, rather
   * than the silent loss of a delivery they already made.
   */
  readonly #unresolvedJobs = new Map<string, Job>();
  /** Sends whose outcome could not be established. Reported, never guessed. */
  #unresolved = 0;
  /**
   * Admissions that have not registered a job yet.
   *
   * The capacity bound counts these, because between the reservation and the
   * registration this admission is going to become a delivery — and a bound
   * that only counted registered jobs admitted one more than it advertised
   * under concurrent starts.
   */
  #reservations = 0;
  #fenced = false;
  #disposed = false;
  /** Documents this service has already declared new to the coordinator. */
  readonly #adopted = new Set<string>();
  /**
   * Reads that are not a delivery — the device list, today.
   *
   * Registered so a teardown can ABORT them rather than leaving a request
   * outstanding under a bearer the user has signed out of. A request in flight
   * holds the credential exactly as a job does, which is the rule
   * `StoredSendService` states for its own auxiliary operations.
   */
  readonly #auxiliary = new Set<AbortController>();
  /** Coordinator retirements still joining, so a teardown joins them too. */
  readonly #retiring = new Set<Promise<void>>();
  /**
   * Converges in flight, by job id.
   *
   * Coalesced rather than allowed to race. Two of them settled in whatever
   * order the network chose, and a LATE `unknown` overwrote an `delivered` that
   * had already been established — the UI going backwards from a definite
   * answer to an uncertain one, which is the opposite of what a re-check is
   * for.
   */
  readonly #converging = new Map<string, Promise<InboxSendView>>();

  constructor(private readonly deps: InboxSendDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // Lifecycle. The coordinator's vocabulary, adopted rather than re-invented.
  // -------------------------------------------------------------------------

  /** Close admissions before quit consent. Revokes nothing. */
  fence(): void {
    this.#fenced = true;
    this.#bound?.coordinator.fence();
  }

  /** The user chose Stay. */
  resume(): void {
    if (this.#disposed) return;
    this.#fenced = false;
    const bound = this.#bound;
    if (bound === null) return;
    try {
      bound.coordinator.resumeAdmissions();
    } catch {
      // Disposed, or permanently closed by an identity change or a document
      // overflow. Either way this coordinator is spent and the next admission
      // builds another; there is nothing to reopen.
      this.#bound = null;
    }
  }

  inventory(): InboxSendInventory {
    // ## Everything actually running, which is more than the sends
    //
    // This answers "is anything happening?" for a quit prompt, and three kinds
    // of work qualify:
    //
    //  * live jobs, obviously;
    //  * RESERVATIONS — an admission that has read the credential and is about
    //    to open an upload, which has no job id yet and would otherwise report
    //    as nothing;
    //  * CONVERGES and RETIREMENTS. A re-check makes a real request to central
    //    under this account's bearer, and a retirement is a join this feature
    //    started. Counting only sends made an app settling an unresolved
    //    delivery look idle at the moment a person was deciding whether to end
    //    it — the same omission as the outgoing sends, one layer down.
    //
    // The admission bound uses `reserved()` instead, on purpose: a re-check is
    // not a send and must not refuse one.
    return {
      active: this.reserved() + this.#converging.size + this.#retiring.size,
      unresolved: this.#unresolved,
    };
  }

  /**
   * Stop admitting, abandon every producer, and JOIN what is running.
   *
   * The producers are abandoned BEFORE the drain, and both parts matter. A
   * delivery is driven by a renderer that may never send another frame — the
   * page has been told to stop — so a drain that only closed admissions would
   * wait for frames nobody is going to produce. Abandoning makes `drive` throw,
   * which cancels each engine and joins it, and `quiesce` then terminates.
   *
   * Nothing here finalizes a short object: `stop` is abandonment, not `end`.
   */
  async quiesce(): Promise<InboxSendInventory> {
    this.#fenced = true;
    const bound = this.#bound;
    // Both, and both before either is joined: a device-list read in flight
    // holds the bearer just as a delivery does.
    for (const control of this.#auxiliary) control.abort();
    for (const job of this.#jobs.values()) job.producer.stop();
    if (bound !== null) await bound.coordinator.quiesce();
    await this.settleRevoked();
    // Retirements and converges are work this feature started; a drain that
    // reported without joining them would be reporting an inventory it had not
    // actually reached.
    await Promise.allSettled([...this.#retiring, ...this.#converging.values()]);
    return this.inventory();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#fenced = true;
    const bound = this.#bound;
    this.#bound = null;
    for (const control of this.#auxiliary) control.abort();
    for (const job of this.#jobs.values()) job.producer.stop();
    if (bound !== null) await bound.coordinator.dispose();
    // Joined before the registry is cleared: a job dropped while its delivery
    // is still running is work nothing would ever settle.
    await Promise.allSettled([
      ...[...this.#jobs.values()].map((job) => job.delivery.done),
      ...this.#retiring,
      ...this.#converging.values(),
    ]);
    this.#jobs.clear();
    this.#settled.clear();
    this.#unresolvedJobs.clear();
    // Every key this process still holds, wiped on the way out — including the
    // ones retained for a converge that will now never be asked for.
    for (const jobID of [...this.#staged.keys()]) this.wipe(jobID);
  }

  /**
   * The signed-in identity moved.
   *
   * The coordinator is told the CURRENT identity and compares; it never adopts
   * one. A mismatch closes it permanently, which is why `#bound` is dropped
   * here rather than kept for a fresh sign-in: a fresh bearer is a fresh
   * coordinator.
   */
  async onAccountChanged(): Promise<void> {
    const bound = this.#bound;
    if (bound === null) return;
    // A read issued under the outgoing account's bearer is aborted first.
    for (const control of this.#auxiliary) control.abort();
    for (const job of this.#jobs.values()) job.producer.stop();
    const identity = this.deps.identity();
    const quiet = await bound.coordinator.invalidateAccount({
      accountId: identity?.context.accountKey ?? "signed-out",
      deviceId: identity?.deviceID ?? "signed-out",
    });
    // `quiet: false` is RETAIN AND JOIN, not a disposal. The jobs stay
    // registered so a later teardown can still reach them; only the binding is
    // dropped, because its bearer is no longer the user's.
    if (identity === null || identity.context.accountKey !== bound.accountKey || identity.deviceID !== bound.deviceID) {
      this.#bound = null;
      this.#adopted.clear();
    }
    if (!quiet.quiet) this.deps.reportFailure?.(Object.assign(new Error("inbox-send: not quiet"), { code: "busy" }));
    await this.settleRevoked();
  }

  /** A renderer document was destroyed or reloaded. */
  async revokeDocument(generation: number): Promise<void> {
    const bound = this.#bound;
    const documentId = String(generation);
    this.#adopted.delete(documentId);
    if (bound === null) return;
    for (const job of this.#jobs.values()) {
      if (job.document === generation) job.producer.stop();
    }
    const result = await bound.coordinator.invalidateDocument(documentId);
    // An overflow closes the coordinator PERMANENTLY. Keeping it would re-admit
    // a job under a document id nothing remembers revoking.
    if (!result.remembered) {
      this.#bound = null;
      this.#adopted.clear();
    }
    await this.settleRevoked();
  }

  /** Answer every job whose delivery has already stopped. */
  private async settleRevoked(): Promise<void> {
    await Promise.allSettled(
      [...this.#jobs.values()].map(async (job) => {
        if (job.view !== null) return;
        // `done` never rejects for a delivery outcome, so this is a JOIN and
        // not a race: the coordinator has already classified whatever happened.
        const outcome = await job.delivery.done.catch(() => null);
        if (outcome !== null) this.record(job, describeSendOutcome(outcome));
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Choosing a target
  // -------------------------------------------------------------------------

  /**
   * This account's other devices, as the picker may see them.
   *
   * THIS device is excluded, always: central refuses a delivery to the sending
   * device, and offering it would be a control that cannot work.
   *
   * Eligibility here is read from the device ROW — capabilities, revocation and
   * the target's own off/ask/auto choice — and is a fail-fast for the picker,
   * not the decision. `SendCoordinator` re-reads the row AND the target's keys
   * immediately before it seals, because a device can turn receiving off, or
   * rotate its key, between being listed and being sent to.
   */
  async targets(): Promise<InboxSendTargets> {
    if (this.#disposed) return { ok: false, refusal: "unavailable" };
    const bound = await this.bind();
    if (bound === null) {
      const authority = await this.deps.authority();
      return { ok: false, refusal: authority.kind === "signed-out" ? "signed-out" : "unavailable" };
    }
    const control = new AbortController();
    this.#auxiliary.add(control);
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await bound.transport.devices(control.signal);
    } catch (err) {
      this.deps.reportFailure?.(err);
      return { ok: false, refusal: err instanceof SendApiError ? "transport" : "unavailable" };
    } finally {
      this.#auxiliary.delete(control);
    }
    // A sign-out during the read: these are the previous account's devices.
    if (control.signal.aborted || this.#bound !== bound) return { ok: false, refusal: "unavailable" };
    const caps = {
      receiveV3: bound.runtime.constants.capReceiveV3,
      textV1: bound.runtime.constants.capTextV1,
      keyAlgorithm: bound.runtime.constants.keyAlgorithm,
    };
    const targets: InboxSendTargetView[] = [];
    for (const row of rows) {
      const deviceID = typeof row["ID"] === "string" ? row["ID"] : "";
      if (deviceID.length === 0 || deviceID === bound.deviceID) continue;
      const inbox = (row["Inbox"] ?? null) as Record<string, unknown> | null;
      const name = typeof row["Name"] === "string" ? row["Name"] : "";
      targets.push(describeDevice(deviceID, name, rowRefusal(inbox, caps)));
    }
    return { ok: true, targets };
  }

  // -------------------------------------------------------------------------
  // One send
  // -------------------------------------------------------------------------

  /**
   * Begin a delivery to one target, or refuse.
   *
   * The gates are checked SYNCHRONOUSLY, before the first await; the authority
   * is captured once and travels with the job. Nothing downstream reads "the
   * current account" again — that is the whole point of `AuthorityInput`.
   */
  async start(input: {
    readonly target: string;
    readonly kind: SendKind;
    readonly entries: readonly { readonly path: string; readonly size: number }[];
    readonly document: number;
  }): Promise<InboxSendStart> {
    if (this.#disposed || this.#fenced) return { ok: false, refusal: "unavailable" };
    if (input.entries.length === 0) return { ok: false, refusal: "nothing-picked" };
    if (input.target.length === 0) return { ok: false, refusal: "no-target" };
    // ## The document that asked must be the one on screen
    //
    // Checked HERE and again after every wait below. A generation the host
    // supplies is a claim about which page asked, and a page that has been
    // replaced cannot be handed a content key: the key is released to ONE
    // document, and a reload gets a new generation precisely so the old one's
    // jobs can be revoked. Trusting the argument alone meant a caller could
    // name a document that no longer exists and be admitted under it.
    if (input.document !== this.deps.currentDocument()) return { ok: false, refusal: "unavailable" };

    // ## Capacity is RESERVED before the first await, not checked before it
    //
    // Every step below yields — the credential, the coordinator build, the
    // manifest seal — and a job only enters the registry at the very end. So a
    // burst of concurrent starts all passed a check that counted a registry
    // none of them had joined yet, and the cap admitted one more than it says.
    // The reservation is taken synchronously and released on EVERY path.
    if (this.reserved() >= MAX_ACTIVE_INBOX_SENDS) return { ok: false, refusal: "at-capacity" };
    // ## Refused rather than forgetting a delivery that may be live
    //
    // When the unresolved memory is full, the alternatives are to drop one — 
    // destroying the identity of a delivery that may have happened, with no way
    // to establish it afterwards — or to stop taking new ones. This takes the
    // second. The user is told, and "check the ones you have" is something they
    // can actually do; a silently forgotten delivery is not.
    if (this.#unresolvedJobs.size >= MAX_UNRESOLVED_SENDS) {
      return { ok: false, refusal: "at-capacity", code: "unresolved-full" };
    }
    this.#reservations += 1;
    try {
      return await this.admit(input);
    } finally {
      // Released whatever happened. A registered job counts itself from here.
      this.#reservations -= 1;
    }
  }

  /** A job this process still remembers, whichever memory it is in. */
  private remembered(jobID: string): Job | undefined {
    return this.#unresolvedJobs.get(jobID) ?? this.#settled.get(jobID);
  }

  /**
   * What counts against the ADMISSION bound: live jobs plus reservations.
   *
   * Deliberately not the same number as `inventory().active`. This one gates a
   * new send, and a re-check or a retirement is not a send — refusing a
   * delivery because two old outcomes are being settled would be a bound doing
   * the wrong job.
   */
  private reserved(): number {
    return this.#jobs.size + this.#reservations;
  }

  private async admit(input: {
    readonly target: string;
    readonly kind: SendKind;
    readonly entries: readonly { readonly path: string; readonly size: number }[];
    readonly document: number;
  }): Promise<InboxSendStart> {
    const epoch = this.deps.accountEpoch();
    const bound = await this.bind();
    if (bound === null) {
      const authority = await this.deps.authority();
      return { ok: false, refusal: authority.kind === "signed-out" ? "signed-out" : "unavailable" };
    }
    // The epoch this admission was taken under must still be the one the
    // binding speaks for, or the delivery would open under an account that
    // replaced the one the user was looking at. The document is re-checked for
    // the same reason: both can move while the credential is being read.
    if (bound.epoch !== epoch || this.#disposed || this.#fenced) return { ok: false, refusal: "unavailable" };
    if (input.document !== this.deps.currentDocument()) return { ok: false, refusal: "unavailable" };

    const descriptors = input.entries.map((entry) => ({ path: entry.path, size: entry.size }));
    const geometry = {
      storeChunkSize: bound.runtime.constants.storeChunkSize,
      frameOverhead: bound.runtime.constants.frameOverhead,
    };
    const planned = planUpload(descriptors, geometry);
    if (!planned.ok) {
      return {
        ok: false,
        refusal: "refused",
        code: planned.refusal.kind,
        manifest: planned.refusal.kind === "manifest" ? planned.refusal.refusal : null,
      };
    }

    let contentKey: Uint8Array | null = null;
    try {
      // The v3 document, built from the SAME descriptor array the frame
      // schedule was planned from and in the same order. Item i describes
      // payload frames i; re-sorting either would rename every file silently.
      const manifest = buildSendManifest(
        bound.runtime,
        input.kind,
        descriptors.map((entry) => ({ relativePath: entry.path, size: entry.size })),
      );
      const canonical = encodeSendManifest(bound.runtime, manifest);
      contentKey = crypto.getRandomValues(new Uint8Array(bound.runtime.constants.contentKeyBytes));
      const storeKey = await bound.runtime.importStoreKey(contentKey);
      const sealedManifest = await bound.runtime.sealManifestBytes(storeKey, canonical);
      const tooLarge = sealedManifestFits(sealedManifest);
      if (tooLarge !== null) {
        return { ok: false, refusal: "refused", code: tooLarge.kind, manifest: null };
      }
      // The digest is of the CANONICAL bytes, not the sealed ones: the seal is
      // randomized, so a digest of it would differ on every reseal and could
      // never establish that two attempts describe the same selection.
      const manifestDigest = await digestOf(canonical);

      const jobID = randomToken("job");
      const authority: AuthorityInput = {
        accountId: bound.accountKey,
        deviceId: bound.deviceID,
        documentId: String(input.document),
        origin: this.deps.origin,
        bearer: bound.bearer,
      };
      // ## The last synchronous gate, immediately before anything is created
      //
      // The seal above is the longest wait in this method, and a quit consent,
      // a dispose or a reload can all land inside it. Past this point a job
      // exists in the coordinator and a content key is handed to a page, so
      // every one of those has to be re-checked with nothing awaited in
      // between — and the DOCUMENT most of all, because `adoptDocument` below
      // would otherwise un-revoke an id whose page has just gone away.
      if (this.#disposed || this.#fenced) return { ok: false, refusal: "unavailable" };
      if (input.document !== this.deps.currentDocument()) return { ok: false, refusal: "unavailable" };
      if (this.deps.accountEpoch() !== bound.epoch) return { ok: false, refusal: "unavailable" };
      if (this.#jobs.size >= MAX_ACTIVE_INBOX_SENDS) return { ok: false, refusal: "at-capacity" };

      // A reload gives a document a new id, and the coordinator refuses one it
      // has seen revoked. Declaring it is the host stating that this id names a
      // genuinely new document — which only the host can know.
      if (!this.#adopted.has(authority.documentId)) {
        bound.coordinator.adoptDocument(authority.documentId);
        this.#adopted.add(authority.documentId);
      }

      const producer = new FrameProducer();
      const held = contentKey;
      const delivery = bound.coordinator.deliver(
        {
          jobID,
          targetDeviceID: input.target,
          kind: input.kind,
          idempotencyKey: randomToken("idem"),
          manifestDigest,
          authority,
        },
        (engine) => producer.drive(engine),
      );
      // Ownership of the key material moved into the job's closures; the
      // `finally` below must not wipe it.
      contentKey = null;

      const job: Job = {
        jobID,
        targetDeviceID: input.target,
        document: input.document,
        epoch: bound.epoch,
        producer,
        delivery,
        cipherBytes: planned.plan.cipherBytes,
        cancelling: false,
        view: null,
      };
      this.#jobs.set(jobID, job);
      this.#staged.set(jobID, { plan: planned.plan, sealedManifest, storeKey, key: held });
      // Settled by whatever ends it — the producer, a cancel, a sign-out — so a
      // page that navigated away still leaves a job that reaches an outcome.
      void delivery.done.then(
        (outcome) => {
          // A cancel in progress owns this job's answer. See `Job.cancelling`.
          if (!job.cancelling) this.record(job, describeSendOutcome(outcome));
        },
        (err: unknown) => {
          this.deps.reportFailure?.(err);
          if (!job.cancelling) this.record(job, { kind: "unknown", reason: "internal" });
        },
      );

      return {
        ok: true,
        jobId: jobID,
        // The one secret that crosses. The renderer is what encrypts.
        contentKey: bound.runtime.encodeKey(held),
        expects: firstExpectation(planned.plan),
        cipherBytes: planned.plan.cipherBytes,
        fileCount: planned.plan.manifest.length,
      };
    } catch (err) {
      if (err instanceof SendManifestError) {
        return { ok: false, refusal: "refused", code: err.code, manifest: null };
      }
      this.deps.reportFailure?.(err);
      return { ok: false, refusal: "internal" };
    } finally {
      // Wiped unless ownership moved into the job. A key generated for a send
      // that never started is the user's key material either way.
      if (contentKey !== null) contentKey.fill(0);
    }
  }

  /** Hand over one ciphertext frame and learn what is owed next. */
  async feed(jobID: string, frame: CipherFrame): Promise<{ readonly expects: FrameExpectation | null }> {
    const job = this.#jobs.get(jobID);
    // An unknown or settled job answers `null` rather than throwing: the page's
    // producer loop breaks on it and asks `end` what actually happened.
    if (job === undefined || job.view !== null) return { expects: null };
    // No progress is emitted here. What the producer has HANDED OVER is not
    // what the server has taken: the engine's own `onProgress` carries
    // committed bytes as the server acknowledged them, and publishing a
    // producer-side count beside it would race it backwards.
    return { expects: await job.producer.feed(frame) };
  }

  /** The producer has sent everything. Finalize, create the task, report. */
  async end(jobID: string): Promise<InboxSendView> {
    const job = this.#jobs.get(jobID);
    if (job === undefined) {
      // Already settled, or never existed. A remembered outcome is answered
      // with rather than a second "no such job" the page would have to read as
      // a failure of something that may well have succeeded.
      const remembered = this.remembered(jobID)?.view;
      return remembered ?? { kind: "unknown", reason: "no-such-job" };
    }
    if (job.view !== null) return job.view;
    job.producer.end();
    const outcome = await job.delivery.done.catch((err: unknown) => {
      this.deps.reportFailure?.(err);
      return { kind: "unknown", reason: "internal" } as const satisfies SendOutcome;
    });
    return this.record(job, describeSendOutcome(outcome));
  }

  /** The user pressed Cancel. */
  async cancel(jobID: string): Promise<InboxSendView> {
    const job = this.#jobs.get(jobID);
    if (job === undefined) {
      // A settled job is not cancellable, and reporting `cancelled` over a
      // delivery that actually landed would be false in the worst direction.
      // `?? null` rather than `?.`: a retained job whose view is null is a job
      // that is registered and NOT settled, which is not an answer either.
      const settled = this.remembered(jobID)?.view ?? null;
      if (settled !== null) return settled;
      // FORGOTTEN — evicted from the bounded memory, or never this process's.
      // "Cancelled" is a definite claim that nothing was delivered, and this
      // side has no basis for it: the delivery may well have happened. The
      // honest answer to "what became of it" is that this process cannot say.
      return { kind: "unknown", reason: "forgotten" };
    }
    // Set before ANY await, so the settlement this cancel is about to cause
    // cannot be reported by the `done` subscription first.
    job.cancelling = true;
    job.producer.stop();
    const bound = this.#bound;
    if (bound === null) {
      // No live coordinator to ask. The delivery is already revoked by whatever
      // dropped the binding; joining it is the honest answer.
      const outcome = await job.delivery.done.catch(() => ({ kind: "unknown", reason: "internal" }) as const);
      return this.record(job, describeSendOutcome(outcome as SendOutcome));
    }
    try {
      // `supersedeUnknown`: the coordinator's own cancel INSPECTED the plan and
      // asked central, so its answer beats the revoked primary's "I was
      // stopped". See `record`.
      const outcome = await bound.coordinator.cancel(jobID);
      return this.record(job, describeSendOutcome(outcome), true);
    } catch (err) {
      this.deps.reportFailure?.(err);
      // NOT reported as cancelled: a throw here means this process could not
      // establish what happened, and a delivery may be live.
      return this.record(job, { kind: "unknown", reason: "cancel-failed" });
    }
  }

  /**
   * Try again to establish what an UNKNOWN send did.
   *
   * The distinction the whole outcome union exists for. An `unknown` retains
   * its plan and its idempotency key precisely so the same attempt can be
   * replayed and CONVERGE on the task it may already have created; issuing a
   * fresh send would deliver the same thing twice. So this resumes, and there
   * is deliberately no path here that starts a new job for an old one.
   */
  converge(jobID: string): Promise<InboxSendView> {
    // ONE converge per job at a time. Two of them raced and the later answer
    // won by arrival order alone — so a re-check that had established
    // `delivered` was overwritten by a second re-check that could not, and the
    // page went backwards from a definite outcome to an uncertain one.
    const running = this.#converging.get(jobID);
    if (running !== undefined) return running;
    const attempt = this.convergeOnce(jobID).finally(() => this.#converging.delete(jobID));
    this.#converging.set(jobID, attempt);
    return attempt;
  }

  private async convergeOnce(jobID: string): Promise<InboxSendView> {
    // A job still running is not a job to converge: its own outcome is coming.
    if (this.#jobs.has(jobID)) return { kind: "unknown", reason: "still-running" };
    // The unresolved memory first: that is the only one with anything to
    // converge, and it is the one nothing may evict.
    const job = this.#unresolvedJobs.get(jobID) ?? this.#settled.get(jobID);
    if (job === undefined) return { kind: "unknown", reason: "no-such-job" };
    // Only an UNKNOWN has anything to converge. Replaying a delivery that was
    // definitively refused, cancelled or delivered would be a fresh attempt
    // wearing a converge's name.
    if (job.view !== null && job.view.kind !== "unknown") return job.view;
    const bound = await this.bind();
    if (bound === null) return { kind: "unknown", reason: "signed-out" };
    // The account that owns the plan must be the one signed in. Converging
    // under another account's bearer would be a request for somebody else's
    // task, and the coordinator refuses it anyway — refused here with a reason
    // the page can say out loud.
    if (job.epoch !== bound.epoch) return { kind: "unknown", reason: "account-changed" };
    try {
      // Released first: `resume` ADMITS a job id and the registry refuses one
      // that is already live. The delivery it names has settled by now — a
      // converge is only ever offered for an outcome that was reported.
      bound.coordinator.release(jobID);
      const resumed = bound.coordinator.resume(jobID, {
        accountId: bound.accountKey,
        deviceId: bound.deviceID,
        documentId: String(job.document),
        origin: this.deps.origin,
        bearer: bound.bearer,
      });
      const view = describeSendOutcome(await resumed.done);
      // The registry entry this converge admitted is finished with.
      this.releaseFromCoordinator(jobID);
      // ## A definite answer, once established, is never un-established
      //
      // Something else may have settled this while the request was in flight —
      // another converge, a teardown joining it. If what is recorded is already
      // definite, THAT is the answer; a later `unknown` says only that this
      // attempt could not establish anything, which is not news that can
      // overturn news.
      if (job.view !== null && job.view.kind !== "unknown") return job.view;
      if (view.kind !== "unknown") {
        // Established at last. The key retention existed for this moment; the
        // OUTCOME stays remembered, so a page asking again gets this answer —
        // and it moves into the evictable memory, which is also what frees the
        // admission this feature refuses new sends against.
        this.wipe(jobID);
        this.#unresolved = Math.max(0, this.#unresolved - 1);
        job.view = view;
        this.#unresolvedJobs.delete(jobID);
        this.#settled.set(jobID, job);
      }
      this.deps.onOutcome?.({ id: jobID, document: job.document }, view);
      return view;
    } catch (err) {
      this.deps.reportFailure?.(err);
      return { kind: "unknown", reason: "converge-failed" };
    }
  }

  /**
   * Record a terminal view once, emit it, and let the job go.
   *
   * Idempotent by construction: several paths can observe the same settlement —
   * the `done` subscription, an `end` the page issued, a teardown joining it —
   * and the FIRST one is the answer. A second write would emit a second outcome
   * for one delivery.
   */
  private record(job: Job, view: InboxSendView, supersedeUnknown = false): InboxSendView {
    if (job.view !== null) {
      // ## The one case where a second answer wins
      //
      // A cancel revokes the job's fence, so the interrupted primary reports
      // `unknown` — "this attempt was stopped and I cannot say what became of
      // it" — and it can win the race to be recorded. The cancel path then goes
      // on to ask central and gets a DEFINITE answer. Letting first-wins stand
      // there showed "Relayium could not confirm what happened" over a cancel
      // the user had just pressed and that had cleanly stopped.
      //
      // Only ever in this direction: a definite outcome may replace an unknown,
      // and nothing may replace a definite one.
      if (!supersedeUnknown || job.view.kind !== "unknown" || view.kind === "unknown") return job.view;
      this.#unresolved = Math.max(0, this.#unresolved - 1);
    }
    job.view = view;
    job.producer.stop();
    this.#jobs.delete(job.jobID);
    if (view.kind === "unknown") {
      // A delivery MAY be live. The key is retained so a converge can replay
      // the SAME attempt — never a fresh send, which would be a second delivery
      // of one thing.
      this.#unresolved += 1;
    } else {
      this.wipe(job.jobID);
    }
    // ## The coordinator is told too
    //
    // Deleting this from the host's registry is not enough: the COORDINATOR
    // keeps its own record until it is released, and that registry is what its
    // `maxLiveJobs` bound counts. Settled jobs accumulated there, so after 64
    // sends — however long ago, however completely finished — the 65th was
    // refused as "too many live jobs". The durable plan and the content-key
    // identity are untouched by this: `release` forgets an in-memory entry, and
    // a converge re-admits the same job id against the plan on disk.
    this.releaseFromCoordinator(job.jobID);
    // Remembered EITHER WAY, so a later `end` — from a page that asked twice,
    // or that asked after a teardown had already settled it — answers with what
    // actually happened rather than with "no such job", which a page would have
    // to interpret as a failure of something that succeeded.
    //
    // WHICH memory it goes into is the whole point: an unresolved delivery is
    // recovery state and is never evicted; a definite one is an answer and may
    // be. See `#unresolvedJobs`.
    if (view.kind === "unknown") {
      this.#unresolvedJobs.set(job.jobID, job);
    } else {
      this.#settled.set(job.jobID, job);
      while (this.#settled.size > MAX_REMEMBERED_SENDS) {
        const oldest = this.#settled.keys().next().value;
        if (oldest === undefined) break;
        this.#settled.delete(oldest);
        // Only an ANSWER is lost here. The key was wiped when it settled.
        this.wipe(oldest);
      }
    }
    this.deps.onOutcome?.({ id: job.jobID, document: job.document }, view);
    return view;
  }

  /**
   * Let the coordinator forget a job that has stopped.
   *
   * ONLY when it is quiescent. `release` refuses while anything is still
   * running for that id — a cancel, a cleanup — and forcing it would drop the
   * registry entry the running work is reported through. So a busy job is
   * RETIRED instead: `retire` joins it first and then forgets it, and the join
   * is tracked here so a teardown is not walking away from it.
   */
  private releaseFromCoordinator(jobID: string): void {
    const bound = this.#bound;
    if (bound === null) return;
    if (bound.coordinator.release(jobID)) return;
    const joining = bound.coordinator.retire(jobID).then(
      () => undefined,
      (err: unknown) => {
        this.deps.reportFailure?.(err);
      },
    );
    this.#retiring.add(joining);
    void joining.finally(() => this.#retiring.delete(joining));
  }

  /**
   * Wipe one job's staged material.
   *
   * The content key is spent the moment a delivery reaches a state no attempt
   * will use it again from. Wiped rather than dropped: key material with no
   * owner and no purpose is still key material.
   */
  private wipe(jobID: string): void {
    const staged = this.#staged.get(jobID);
    if (staged === undefined) return;
    staged.key.fill(0);
    this.#staged.delete(jobID);
  }

  // -------------------------------------------------------------------------
  // The coordinator, built once per account identity
  // -------------------------------------------------------------------------

  private bind(): Promise<Bound | null> {
    const held = this.#bound;
    if (held !== null) {
      const identity = this.deps.identity();
      if (identity !== null && identity.context.accountKey === held.accountKey && identity.epoch === held.epoch) {
        return Promise.resolve(held);
      }
      // The identity moved and nobody told this service. Dropped rather than
      // reused: its transport carries the previous account's bearer.
      this.#bound = null;
      this.#adopted.clear();
    }
    const pending = this.#building;
    if (pending !== null) return pending;
    const run = this.build().finally(() => {
      if (this.#building === run) this.#building = null;
    });
    this.#building = run;
    return run;
  }

  private async build(): Promise<Bound | null> {
    const identity = this.deps.identity();
    if (identity === null) return null;
    const authority = await this.deps.authority();
    if (authority.kind !== "ok") return null;
    if (authority.epoch !== identity.epoch || authority.epoch !== this.deps.accountEpoch()) return null;
    const runtime = await this.deps.runtime();
    const stored = await (this.deps.storedRuntime ?? storedRuntime)();
    const keyBytes = await this.deps.atRestKeyFor(identity.context);
    if (keyBytes.byteLength !== AT_REST_KEY_BYTES) return null;
    // Re-checked after every await: a sign-out during any of them would leave
    // this building a coordinator around a bearer that is no longer the user's.
    if (this.deps.accountEpoch() !== authority.epoch) return null;
    const current = this.deps.identity();
    if (current === null || current.context.accountKey !== identity.context.accountKey) return null;

    const files = new InboxFiles(identity.context);
    const plans = new SendPlanStore(
      identity.context,
      files,
      () => this.deps.atRestKeyFor(identity.context),
      runtime.constants.sealedBoxBytes,
    );
    const transport = new SendTransport({
      context: { origin: this.deps.origin, bearer: authority.bearer, epoch: authority.epoch },
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
      ...(this.deps.requestTimeoutMs === undefined ? {} : { timeoutMs: this.deps.requestTimeoutMs }),
    });
    const retention: UploadRetention = { burnAfterRead: false, ttlSeconds: DEVICE_TASK_TTL_SECONDS };
    const coordinator = new SendCoordinator({
      plans,
      tasks: transport,
      accountId: identity.context.accountKey,
      deviceId: identity.deviceID,
      runtimeCaps: {
        receiveV3: runtime.constants.capReceiveV3,
        textV1: runtime.constants.capTextV1,
        keyAlgorithm: runtime.constants.keyAlgorithm,
      },
      protocolVersion: runtime.constants.protocolVersion,
      retention,
      now: () => this.now(),
      // One adapter per job. Only `init` differs from the accepted transport;
      // `append`, `status` and `finalize` are delegated unchanged, because the
      // offset algebra and the bounded retries there are what `UploadEngine` is
      // built around.
      bytesFor: () =>
        new DeviceTaskByteTransport(
          this.innerTransport(authority.bearer),
          this.deps.origin,
          authority.bearer,
          this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl },
        ),
      engineFor: async (jobID, bytes, fence, onSession) => {
        const held = this.#staged.get(jobID);
        if (held === undefined) throw new Error("inbox-send: no staged upload for this job");
        return UploadEngine.open({
          runtime: stored,
          key: held.storeKey,
          sealedManifest: held.sealedManifest,
          plan: held.plan,
          retention,
          transport: bytes,
          fence,
          hooks: {
            onSession,
            onProgress: (committed, total) => {
              const job = this.#jobs.get(jobID);
              if (job !== undefined) this.deps.onProgress?.({ id: jobID, document: job.document }, committed, total);
            },
          },
        });
      },
      sealToTarget: async (jobID, target) => {
        const held = this.#staged.get(jobID);
        if (held === undefined) throw new Error("inbox-send: no content key for this job");
        // Sealed to the target's CURRENT key, read immediately before this by
        // the coordinator. The renderer never holds a target's public key: a
        // page that did could seal to it.
        return runtime.sealContentKey(held.key, target.key.algorithm, target.key.publicKey);
      },
    });
    if (this.#fenced) coordinator.fence();
    const bound: Bound = {
      accountKey: identity.context.accountKey,
      deviceID: identity.deviceID,
      epoch: identity.epoch,
      coordinator,
      transport,
      bearer: authority.bearer,
      runtime,
    };
    this.#bound = bound;
    return bound;
  }

  /** The accepted byte transport `DeviceTaskByteTransport` delegates to. */
  private innerTransport(bearer: string): UploadByteTransport {
    return new UploadTransport(
      this.deps.origin,
      bearer,
      this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl },
    );
  }
}

/** What the producer owes first, from the PLAN — there is no engine yet. */
function firstExpectation(plan: UploadPlan): FrameExpectation | null {
  for (let index = 0; index < plan.frames.length; index += 1) {
    const file = plan.frames[index];
    if (file === undefined) continue;
    const length = frameLengthAt(file, 0);
    if (length === null) continue;
    return { fileIndex: index, seq: 1, bytes: length };
  }
  return null;
}

/**
 * Why a device row cannot be sent to, from the ROW alone.
 *
 * The same verdicts `assertEligible` reaches and in the same order, minus the
 * key read — the picker lists devices, and a key read per device would be one
 * request per row every time the list is shown. The coordinator does the real
 * check, including the key, immediately before it seals.
 */
function rowRefusal(
  inbox: Record<string, unknown> | null,
  caps: { readonly receiveV3: string; readonly textV1: string; readonly keyAlgorithm: string },
): string | null {
  if (inbox === null) return SEND_REFUSALS.deviceCannotReceive;
  if (inbox["Revoked"] === true) return SEND_REFUSALS.deviceInboxRevoked;
  const capabilities = Array.isArray(inbox["Capabilities"])
    ? (inbox["Capabilities"] as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  if (!capabilities.includes(caps.receiveV3)) return SEND_REFUSALS.deviceCannotReceive;
  if (inbox["AutoAccept"] === "off") return SEND_REFUSALS.autoReceiveDisabled;
  return null;
}

/** A printable-ASCII token, which is what the idempotency key must be. */
function randomToken(prefix: string): string {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Buffer.from(raw).toString("hex")}`;
}

/** SHA-256 of the canonical manifest bytes, as hex. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Buffer.from(digest).toString("hex");
}
