// One delivery, end to end. Invariants 3, 4 and 6.
//
// ## The order is the design, and it is not this file's invention
//
// `server/internal/inboxclient/receive.go` is the canonical receiver — the one
// central's own tests drive — and its pipeline comment states the order:
//
//	unseal -> decrypt+validate manifest -> plan destinations -> journal the plan
//	  -> preflight -> stream ciphertext into STAGING -> verify the WHOLE
//	  authenticated stream -> report `verifying` -> commit -> report `saved`
//
// This is that order, with the native helper playing the part Go's staging
// directory and committer play: nothing the user can see exists until
// `publish()`, so a tampered, truncated or wrongly-keyed body can never leave an
// apparently complete file where they will find it.
//
// ## Four things that are easy to get wrong, and are not
//
//  - **`saved` is reachable only from `verifying`.** The server's transition
//    table says so and `wire.ts` records why: "the bytes arrived" is not "the
//    file is on disk". The report goes out before the commit.
//  - **A lease is renewed while the work runs**, not once at the end. Go renews
//    on a third of the lease during both the stream and the commit
//    (`receive.go`), and a failed renewal ABANDONS: committing under a lease
//    central may already have reassigned is how one task lands twice.
//  - **A publish that throws may still have saved files.** `publish()` rejects
//    with the validated receipt attached when only the TEARDOWN failed —
//    `NativeHelperClient.settleAfterPublish` says so in as many words: "Cleanup
//    failing does not un-publish anything." Discarding that receipt would tell
//    the user nothing was saved while their files sit on disk.
//  - **A failed cancel does not release the destination.** The helper's contract
//    is that an inconclusive teardown may mean the child is still live. Dropping
//    the handle there loses the only reference to a live process and its staging
//    directory, so failed handles are RETAINED and new admission is bounded.
//
// ## What the journal is for here
//
// Every irreversible step is recorded BEFORE it happens. The journal records
// counts, not destination identity, which is why a `publishing` record found at
// startup is `blocked` rather than replayable. That verdict belongs to the
// journal and this file honours it. It is also why a lost ACK is never a reason
// to re-download or re-publish: `published` is a full publish awaiting only its
// acknowledgement, and the fix is to replay the ACK.
import type { AccountContext } from "./account.js";
import { AccountChangedError, sameAccount } from "./account.js";
import type { InboxRuntime, RuntimeManifest, RuntimeStoreDecryptor } from "./runtime-contract.js";
import type { TaskJournal } from "./journal.js";
import type { MessageVault } from "./vault.js";
import type { DeliveryProgress } from "./state.js";
import type { InboxFailure, DeliveryReceipt, ResidueState } from "./receipts.js";
import { asFailure } from "./receipts.js";
import type { WireDelivery } from "./wire.js";
import { MAX_VAULT_TEXT_BYTES } from "./vault.js";

/**
 * Attempts at ONE delivery's body before it is given back to central.
 *
 * Matches Go's `streamAttempts`. Central owns the outer budget
 * (`inbox.MaxTaskAttempts`) and decides when a delivery is hopeless; a receiver
 * that out-retried it would be overriding that decision from the wrong side.
 */
export const MAX_BODY_ATTEMPTS = 5;

/** How long a body may stall with no bytes arriving. Go's `defaultIdleTimeout`. */
export const IDLE_BODY_TIMEOUT_MS = 60 * 1000;

/** Central's default lease, in seconds, when a claim advertised none. */
export const DEFAULT_LEASE_SECONDS = 300;

/**
 * Destinations retained because their cleanup did not conclude.
 *
 * Bounded, and the bound REFUSES new deliveries rather than dropping a handle.
 * A count would not do: the point is to keep the object that can still be
 * cancelled or handed on, because the helper's inconclusive teardown may mean
 * the child and its staging directory are still live.
 */
export const MAX_RETAINED_HANDLES = 4;

/**
 * The ONLY failures a body may be resumed after.
 *
 * A transport interruption leaves the ciphertext stream intact and resumable at
 * the byte offset already consumed. Everything else — an AEAD failure, a
 * malformed frame, a refused bound, a write that did not land — means the
 * delivery is wrong or this side is broken, and re-downloading would re-derive
 * the same verdict while asking central for the bytes again.
 */
const RESUMABLE_CODES: ReadonlySet<string> = new Set(["network", "timeout"]);

/**
 * Marks a failure as fatal to the delivery whatever its code says.
 *
 * A decrypt or a destination write can fail with a code that LOOKS transport
 * shaped. Once verification or IO has failed, the decryptor and the destination
 * hold state no resumed stream can be spliced onto, so the attempt loop must
 * not reconsider it.
 */
const FATAL = Symbol("inbox-fatal");

/** Carries a destination out of `publish` on a rejection, so it is not lost. */
const RETAIN = Symbol("inbox-retain-destination");

function fatal<T>(error: T): T {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, FATAL, { value: true, enumerable: false, configurable: true });
  }
  return error;
}

function isFatal(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[FATAL] === true
  );
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A validated receipt riding on a rejection. The helper's documented shape. */
function reportOn(error: unknown): PublishReport | null {
  const report = (error as { publishReport?: unknown } | null)?.publishReport;
  if (typeof report !== "object" || report === null) return null;
  const status = (report as { status?: unknown }).status;
  if (status !== "complete" && status !== "partial") return null;
  return report as PublishReport;
}

/**
 * What the peer said about bytes left behind.
 *
 * `unknown` when it said nothing, never `none`. The helper flags residue
 * explicitly and a missing flag is an absence of evidence, not evidence of a
 * clean teardown.
 */
function residueOn(error: unknown): ResidueState {
  const flagged = (error as { residue?: unknown } | null)?.residue;
  if (flagged === true) return "present";
  if (flagged === false) return "none";
  return "unknown";
}

/**
 * The destination a delivery's bytes are written into.
 *
 * Structurally the native helper's `NativeReceiveDestination`, declared here
 * rather than imported so this module does not depend on the IO layer it is
 * handed. Indices, never paths.
 */
export interface ReceiveDestination {
  readonly fileCount: number;
  begin(index: number): Promise<void>;
  write(index: number, chunk: Uint8Array): Promise<void>;
  finish(index: number): Promise<void>;
  publish(): Promise<PublishReport>;
  cancel(): Promise<void>;
}

export type PublishReport =
  | { readonly status: "complete"; readonly publishedCount: number; readonly total: number }
  | {
      readonly status: "partial";
      readonly publishedCount: number;
      readonly total: number;
      readonly failedIndex: number;
      readonly reason: string;
    };

/** A destination whose cleanup did not conclude. Owned, not forgotten. */
export interface RetainedHandle {
  /**
   * The map key, which is the task id unless one was already retained under it.
   *
   * Separate from `taskID` so that nothing can ever be dropped by collision.
   * `releaseRetained` takes THIS.
   */
  readonly key: string;
  readonly taskID: string;
  readonly destination: ReceiveDestination;
  readonly residue: ResidueState;
  /** The stable code the teardown failed with. */
  readonly reason: string;
}

/** Why an admission was refused. Closed, so a caller can branch on it. */
export type AdmissionVerdict = "ok" | "duplicate" | "at-bound";

/** The API surface a receiver uses. Narrow on purpose. */
export interface ReceiverApi {
  report(
    taskID: string,
    claimToken: string,
    state: string,
    committed: boolean,
    errorCode: string,
    signal: AbortSignal,
  ): Promise<{ readonly State: string; readonly Terminal: boolean; readonly SavedAt: number }>;
  blob(
    taskID: string,
    claimToken: string,
    offset: number,
    expectedTotal: number,
    signal: AbortSignal,
  ): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly partial: boolean }>;
}

/** The key half a receiver uses. */
export interface ReceiverKeys {
  openSealedContentKey(keyID: string, sealed: Uint8Array): Promise<Uint8Array>;
}

/**
 * Presentation metadata for one delivered object. Never a path, never a key.
 *
 * ## Why the receiver hands this out at all
 *
 * The foreground history names files, and this is the only place the names
 * exist: `TaskJournal` is a diagnostic record and carries none by design,
 * `DeliveryReceipt` may not hold a path, and re-reading the receiving folder
 * would report what is there NOW rather than what this delivery wrote. So the
 * names are captured here, from the manifest that has already been decoded and
 * validated, and handed to a store whose whole purpose is presentation.
 *
 * `items` is what was CONFIRMED PUBLISHED — the prefix a partial actually
 * landed, never the whole manifest — and `declared` is kept beside it so a
 * partial is describable as a partial rather than presented as everything.
 */
export interface DeliveredItems {
  readonly taskID: string;
  /** True for a message, which lands in the vault and has no names at all. */
  readonly text: boolean;
  /** How many items the manifest declared. */
  readonly declared: number;
  /** Relative names and sizes, exactly as the validated manifest declared. */
  readonly items: readonly { readonly name: string; readonly size: number }[];
}

export interface ReceiverOptions {
  readonly context: AccountContext;
  readonly runtime: InboxRuntime;
  readonly api: ReceiverApi;
  readonly keys: ReceiverKeys;
  readonly journal: TaskJournal;
  readonly vault: MessageVault;
  /** Built per delivery, from the validated manifest. Indices, never paths. */
  destinationFor(manifest: RuntimeManifest): Promise<ReceiveDestination>;
  /**
   * The account context as it is NOW.
   *
   * Compared against the captured one at every fence. A sign-out mid-delivery
   * must stop the work, not finish it under the account that replaced it.
   */
  currentAccount(): AccountContext;
  readonly now?: () => number;
  readonly onProgress?: (progress: DeliveryProgress) => void;
  /**
   * What this delivery saved, by name. OPTIONAL, and never load-bearing.
   *
   * Called once per delivery, after the publish is DURABLE and before the
   * receipt is returned — the same position as the post-commit journal markers
   * and for the same reason: the files are on disk by then, so nothing this
   * hook does may change what the receipt says. A failure in it is swallowed
   * exactly as `tryJournal` swallows a failed marker; a presentation record
   * that could not be written is a worse history, not a lost delivery.
   *
   * ## It is awaited, and the wait is BOUNDED
   *
   * Awaited, because a write fired and forgotten is a write no teardown can
   * join. Bounded, because by the time this runs the files are on disk and the
   * ACK has not been sent: a metadata store that never settles would hold a
   * committed delivery unacknowledged, and central would eventually redeliver a
   * task that had already landed. Presentation metadata may not have that
   * power over a delivery, so `DELIVERED_HOOK_TIMEOUT_MS` ends the wait.
   *
   * **What the timeout does NOT mean.** This side stops waiting; it does not
   * cancel the hook and it does not claim the hook has finished. The promise
   * belongs to the HOST that supplied it, and the host is what must own and
   * join it — `features/inbox.ts` registers the write as one of its tracked
   * operations, so `quiesce` and `dispose` join it there. A host that installs
   * a hook it does not track is leaving untracked work behind, and this
   * receiver cannot fix that for it.
   *
   * Absent, behaviour is identical: nothing here is consulted again.
   */
  onDelivered?(delivered: DeliveredItems): Promise<void>;
  /** Overrides `DELIVERED_HOOK_TIMEOUT_MS`, for a test that holds the hook. */
  readonly deliveredTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** What central advertised for this claim. Followed, never assumed. */
  readonly leaseSeconds?: number;
}

function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * Renews the lease while long work runs, and can be JOINED.
 *
 * Go renews on a third of the lease during the stream and again during the
 * commit. Reporting `verifying` once after minutes of downloading is not a
 * renewal — by then the lease may already have been reassigned, and the commit
 * that follows would be the second delivery of one task.
 *
 * `stop()` clears the timer AND awaits any renewal already in flight, so no
 * timer and no request outlives the job that owns them.
 */
class LeaseRenewer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<unknown> | null = null;
  private failure: unknown = null;
  private state = "downloading";

  constructor(
    private readonly run: (state: string) => Promise<unknown>,
    private readonly intervalMs: number,
  ) {}

  start(state: string): void {
    this.state = state;
    if (this.timer !== undefined || this.intervalMs <= 0) return;
    this.timer = setInterval(() => this.renewOnce(), this.intervalMs);
    // Never hold the process open for a renewal timer.
    this.timer.unref?.();
  }

  /**
   * One renewal, tracked by the EXACT promise that is stored.
   *
   * An earlier version stored `job.finally(...)` while the callback compared
   * against `job` — two different promises, so the guard never matched and
   * `inflight` was never cleared. One renewal then blocked every later one, and
   * `stop()` spun awaiting an already-resolved promise forever, starving the
   * event loop. The identity is captured in a local, and both the store and the
   * comparison use it.
   */
  private renewOnce(): void {
    if (this.inflight !== null || this.failure !== null) return;
    const tracked: Promise<void> = (async () => {
      try {
        await this.run(this.state);
      } catch (error) {
        // Recorded, not thrown from a timer where nothing could catch it.
        // `check()` is what turns it into the delivery's failure.
        this.failure = error;
      }
    })();
    this.inflight = tracked;
    void tracked.then(() => {
      if (this.inflight === tracked) this.inflight = null;
    });
  }

  /** Follow the delivery's reported state, so a renewal never regresses it. */
  advance(state: string): void {
    this.state = state;
  }

  /** Throws the renewal failure, if there was one. Checked at every fence. */
  check(): void {
    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      throw fatal(error);
    }
  }

  /**
   * Stop and JOIN. Awaited before any commit and before adoption.
   *
   * The timer is cleared FIRST, so no further renewal can start, which is what
   * makes a single await sufficient: at most one can be in flight. A loop here
   * would be a way to spin forever if the tracking were ever wrong again.
   */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const pending = this.inflight;
    this.inflight = null;
    if (pending !== null) await pending.catch(() => undefined);
  }
}

/**
 * Writes a delivery's plaintext into a destination, item by item.
 *
 * ## Why the cursor is not driven by chunk arrival
 *
 * An earlier version advanced only inside the loop over an incoming chunk, so
 * an item of size zero was never begun and never finished — it produced no
 * bytes, so nothing ever visited it. A folder send containing an empty file, or
 * one ending in empty files, silently lost those entries: the manifest declared
 * them and the destination never heard of them.
 *
 * The cursor is therefore advanced explicitly. A zero-size item is begun and
 * finished the moment the cursor reaches it, whether or not another byte ever
 * arrives, and `end()` drains any that trail the last byte of content.
 */
class ItemCursor {
  private index = 0;
  private intoItem = 0;
  private opened = false;

  constructor(
    private readonly sizes: readonly number[],
    private readonly destination: ReceiveDestination,
  ) {}

  get published(): number {
    return this.index;
  }

  /** Begin and finish every zero-size item at the cursor. */
  private async drainEmpties(): Promise<void> {
    while (!this.opened && this.index < this.sizes.length && this.sizes[this.index] === 0) {
      await this.destination.begin(this.index);
      await this.destination.finish(this.index);
      this.index += 1;
    }
  }

  async accept(chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      await this.drainEmpties();
      const declared = this.sizes[this.index];
      if (declared === undefined) {
        throw Object.assign(new Error("body exceeded the manifest total"), {
          code: "length-exceeded",
        });
      }
      if (!this.opened) {
        await this.destination.begin(this.index);
        this.opened = true;
      }
      const take = Math.min(declared - this.intoItem, chunk.byteLength - offset);
      if (take > 0) {
        await this.destination.write(this.index, chunk.subarray(offset, offset + take));
        offset += take;
        this.intoItem += take;
      }
      if (this.intoItem === declared) {
        await this.destination.finish(this.index);
        this.index += 1;
        this.intoItem = 0;
        this.opened = false;
      }
    }
  }

  /** Finish the trailing empties and assert the manifest was satisfied exactly. */
  async end(): Promise<void> {
    await this.drainEmpties();
    if (this.index !== this.sizes.length || this.intoItem !== 0 || this.opened) {
      throw Object.assign(new Error("body ended inside an item"), { code: "length-short" });
    }
  }
}

interface PublishOutcome {
  readonly report: PublishReport;
  readonly residue: ResidueState;
  /** Non-null when the teardown did not conclude and the handle is still ours. */
  readonly handle: ReceiveDestination | null;
}

interface ManifestPlan {
  readonly total: number;
  readonly totalBytes: number;
  readonly text: boolean;
  readonly sizes: readonly number[];
  /**
   * The manifest's own RELATIVE names, in manifest order. Empty for text.
   *
   * Carried so `onDelivered` can report what actually landed WITHOUT any
   * caller re-deriving it: the names are already decoded and already validated
   * at this point, and the alternative — reading the receiving folder
   * afterwards — reports whatever is there now rather than what this delivery
   * wrote. They are user content: they go to the presentation hook and nowhere
   * else, and in particular into no journal record, receipt or diagnostic.
   */
  readonly names: readonly string[];
}

/**
 * How long a delivery waits for the presentation hook before proceeding.
 *
 * Short on purpose. The only thing after this point is the ACK, and the ACK is
 * what stops central redelivering a task whose files are already on the user's
 * disk. Naming the files is worth a few seconds of that; it is not worth the
 * delivery.
 */
export const DELIVERED_HOOK_TIMEOUT_MS = 5_000;

export class Receiver {
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly deliveredTimeoutMs: number;
  private readonly leaseIntervalMs: number;
  /** Destinations whose teardown did not conclude. Owned until released. */
  private readonly retained = new Map<string, RetainedHandle>();
  /**
   * Tasks with a delivery running right now.
   *
   * Reserved SYNCHRONOUSLY, before the first await. Two concurrent calls that
   * each checked a bound and then awaited would both pass, and the second would
   * build a destination for a task the first already owns.
   */
  private readonly inflight = new Set<string>();
  /** Entries with a cleanup attempt running, so two cannot race one handle. */
  private readonly releasing = new Set<string>();

  constructor(private readonly options: ReceiverOptions) {
    this.now = options.now ?? (() => Date.now());
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_BODY_TIMEOUT_MS;
    this.deliveredTimeoutMs = options.deliveredTimeoutMs ?? DELIVERED_HOOK_TIMEOUT_MS;
    // A third of the lease, like Go: two renewals may be lost before the lease
    // is at risk.
    this.leaseIntervalMs = Math.floor(((options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000) / 3);
  }

  /** Destinations still owned because their cleanup was inconclusive. */
  retainedHandles(): readonly RetainedHandle[] {
    return Object.freeze([...this.retained.values()]);
  }

  /**
   * Whether another delivery may be started.
   *
   * False once the retention bound is reached: taking more work would mean
   * losing track of a process that may still hold the user's staging bytes,
   * which is exactly what retaining the handles exists to prevent.
   */
  canAdmit(): boolean {
    return this.occupancy() < MAX_RETAINED_HANDLES;
  }

  /**
   * Live adapters, counted without double-counting one task.
   *
   * Every retained handle is a destination, and every in-flight task is about
   * to build one — so the bound has to cover BOTH. Counting only the retained
   * ones let N distinct tasks start concurrently and open N destinations before
   * any of them finished, which is exactly the bound not existing.
   *
   * A task that is in flight AND already retained is one adapter, not two: it
   * is in both sets only during the window between `retain` and the `finally`
   * that clears the reservation. So retained handles are counted whole, and an
   * in-flight task is added only when no retained handle already speaks for it.
   */
  private occupancy(): number {
    let count = this.retained.size;
    for (const taskID of this.inflight) {
      let alreadyRetained = false;
      for (const handle of this.retained.values()) {
        if (handle.taskID === taskID) {
          alreadyRetained = true;
          break;
        }
      }
      if (!alreadyRetained) count += 1;
    }
    return count;
  }

  /**
   * Reserve a task, atomically.
   *
   * Fully synchronous on purpose. `canAdmit()` followed by an await is a
   * check-then-act: two callers both pass, and the second builds a destination
   * for a task the first is already streaming. The reservation and both checks
   * happen in one turn, before anything can interleave.
   *
   * A task with a RETAINED handle is a duplicate too. Starting it again would
   * reach `retain` a second time for the same id, and a map keyed by task id
   * would then overwrite — silently dropping a destination that may still be a
   * live process holding the user's staging bytes.
   */
  private admit(taskID: string): AdmissionVerdict {
    if (this.inflight.has(taskID)) return "duplicate";
    for (const handle of this.retained.values()) {
      if (handle.taskID === taskID) return "duplicate";
    }
    // Counted BEFORE the reservation, so this task's own slot is the one being
    // tested for, and in the same synchronous turn as the reservation itself.
    if (this.occupancy() >= MAX_RETAINED_HANDLES) return "at-bound";
    this.inflight.add(taskID);
    return "ok";
  }

  /**
   * Give up a retained handle — only on OBSERVED cleanup success.
   *
   * A caller asking is not evidence. The handle exists precisely because the
   * teardown did not conclude, so releasing it on request would launder an
   * unknown into a `none`. Cleanup is attempted again; ownership is given up
   * only if that attempt actually succeeds, and a fresh failure updates the
   * recorded residue rather than dropping the handle.
   */
  async releaseRetained(key: string): Promise<boolean> {
    const handle = this.retained.get(key);
    if (handle === undefined) return false;
    // One cleanup attempt per entry at a time. Two concurrent cancels on one
    // destination is a second teardown of a process the first may already be
    // tearing down.
    if (this.releasing.has(key)) return false;
    this.releasing.add(key);
    try {
      await handle.destination.cancel();
    } catch (error) {
      // Identity-checked. An unconditional `set` here RESURRECTS an entry that
      // a concurrent attempt already released successfully — putting a handle
      // back that is genuinely gone, and blocking the task id forever.
      if (this.retained.get(key) === handle) {
        this.retained.set(key, {
          ...handle,
          residue: residueOn(error),
          reason: codeOf(error) ?? handle.reason,
        });
      }
      return false;
    } finally {
      this.releasing.delete(key);
    }
    // Only a release that observed success removes the entry, and only its own.
    if (this.retained.get(key) === handle) this.retained.delete(key);
    return true;
  }

  /**
   * A key that cannot collide.
   *
   * `admit` already makes a same-id collision unreachable. This is the second
   * lock on the same door: no path may overwrite an entry, because the value
   * being overwritten could be a live child process and there is no rule under
   * which discarding one is acceptable.
   */
  private retainKey(taskID: string): string {
    if (!this.retained.has(taskID)) return taskID;
    let n = 2;
    while (this.retained.has(`${taskID}#${String(n)}`)) n += 1;
    return `${taskID}#${String(n)}`;
  }

  private retain(taskID: string, destination: ReceiveDestination, error: unknown): ResidueState {
    const residue = residueOn(error);
    const key = this.retainKey(taskID);
    this.retained.set(key, {
      key,
      taskID,
      destination,
      residue,
      reason: codeOf(error) ?? "cleanup-uncertain",
    });
    return residue;
  }

  /**
   * The fence. Account, cancellation and lease, checked together.
   *
   * Called immediately before every irreversible step — never merely at the top
   * of the operation. A journal write can be held for an arbitrary time, and a
   * sign-out or a cancel that lands during it must stop the publish that was
   * about to follow.
   */
  private fence(signal: AbortSignal, renewer?: LeaseRenewer): void {
    if (!sameAccount(this.options.context, this.options.currentAccount())) {
      throw fatal(new AccountChangedError());
    }
    if (signal.aborted) {
      throw fatal(Object.assign(new Error("cancelled"), { code: "cancelled" }));
    }
    renewer?.check();
  }

  /**
   * Receive one delivery.
   *
   * Returns a closed receipt rather than throwing for outcomes the user has to
   * be told about truthfully — a partial publish is neither success nor failure,
   * and calling it either one is a lie in one direction.
   */
  async receive(delivery: WireDelivery, signal: AbortSignal): Promise<DeliveryReceipt> {
    // Reserved before ANY await, and released in the finally below.
    const verdict = this.admit(delivery.ID);
    if (verdict !== "ok") {
      return {
        kind: "refused",
        failure: { code: verdict === "duplicate" ? "internal" : "retention-full", residue: "unknown" },
      };
    }
    let contentKey: Uint8Array | null = null;
    let destination: ReceiveDestination | null = null;
    const renewer = new LeaseRenewer(
      (state) => this.options.api.report(delivery.ID, delivery.ClaimToken, state, false, "", signal),
      this.leaseIntervalMs,
    );
    try {
      this.fence(signal);

      // ---- unseal ---------------------------------------------------------
      // Selected by the key id the TASK names, never "the current key": a task
      // queued before a rotation was sealed to the older one.
      const sealed = this.options.runtime.decodeKey(delivery.WrappedKey);
      contentKey = await this.options.keys.openSealedContentKey(delivery.TargetKeyID, sealed);
      const storeKey = await this.options.runtime.importStoreKey(contentKey);

      // ---- manifest -------------------------------------------------------
      // Frame 0 is the DEDICATED v3 Inbox document, opened to raw bytes and
      // handed to its own strict canonical decoder.
      const encManifest = new Uint8Array(Buffer.from(delivery.EncManifest, "base64"));
      const rawManifest = await this.options.runtime.openManifestBytes(storeKey, encManifest);
      const manifest = this.options.runtime.decodeInboxManifest(rawManifest);
      const plan = describeManifest(manifest);

      // ---- journal the intent BEFORE anything irreversible -----------------
      this.fence(signal);
      await this.options.journal.recordClaimed({
        taskID: delivery.ID,
        idempotencyKey: delivery.IdempotencyKey,
        manifestTotal: plan.total,
        text: plan.text,
        now: this.now(),
        serverExpiresAt: delivery.ExpiresAt,
      });

      this.fence(signal);
      await this.options.api.report(delivery.ID, delivery.ClaimToken, "downloading", false, "", signal);
      renewer.start("downloading");

      if (plan.text) {
        return await this.receiveText(delivery, storeKey, plan, renewer, signal);
      }

      destination = await this.options.destinationFor(manifest);
      if (destination.fileCount !== plan.total) {
        throw fatal(
          Object.assign(new Error("destination disagrees with the manifest"), {
            code: "manifest-refused",
          }),
        );
      }
      const cursor = new ItemCursor(plan.sizes, destination);
      let receivedBytes = 0;
      await this.streamBody(delivery, storeKey, plan, renewer, signal, async (chunk) => {
        await cursor.accept(chunk);
        receivedBytes += chunk.byteLength;
        this.options.onProgress?.({
          total: plan.total,
          published: cursor.published,
          totalBytes: plan.totalBytes,
          receivedBytes,
          text: false,
        });
      });
      // Trailing zero-size items are finished here, and the manifest is
      // asserted satisfied exactly.
      await cursor.end();

      // ---- verifying, then commit -----------------------------------------
      this.fence(signal, renewer);
      await this.options.api.report(delivery.ID, delivery.ClaimToken, "verifying", false, "", signal);
      renewer.advance("verifying");

      // Durable BEFORE the publish, because the publish is irreversible.
      await this.options.journal.advance(delivery.ID, "publishing", 0, this.now());

      // Renewals joined: nothing may be in flight while the commit decides
      // whether it still holds the lease.
      await renewer.stop();
      // THE fence that matters. After the awaited journal write and immediately
      // before the irreversible call, so a sign-out or a cancel that landed
      // while the journal was held stops here with nothing published.
      this.fence(signal, renewer);

      const outcome = await this.publish(destination);
      destination = null; // ownership moved into `outcome`
      return await this.settle(delivery, plan, outcome, signal);
    } catch (error) {
      await renewer.stop();
      return { kind: "refused", failure: await this.abandon(delivery.ID, destination, error) };
    } finally {
      await renewer.stop();
      if (contentKey !== null) zero(contentKey);
      // Released last: a task that got retained is still a duplicate, because
      // `admit` also refuses anything with a retained handle.
      this.inflight.delete(delivery.ID);
    }
  }

  /**
   * Publish, preserving a receipt that arrives on a rejection.
   *
   * `NativeHelperClient.settleAfterPublish` rejects with `residue` or
   * `cleanup-uncertain` when publication SUCCEEDED and only the teardown did
   * not, attaching the validated report because "Cleanup failing does not
   * un-publish anything." Treating that as a plain failure would tell the user
   * nothing landed while their files are on disk.
   */
  private async publish(destination: ReceiveDestination): Promise<PublishOutcome> {
    try {
      return { report: await destination.publish(), residue: "none", handle: null };
    } catch (error) {
      const report = reportOn(error);
      if (report === null) {
        // No receipt: publication itself failed. The handle stays ours, because
        // an inconclusive teardown may mean the child is still live.
        if (typeof error === "object" && error !== null) {
          Object.defineProperty(error, RETAIN, {
            value: destination,
            enumerable: false,
            configurable: true,
          });
        }
        throw error;
      }
      return { report, residue: residueOn(error), handle: destination };
    }
  }

  /**
   * Record and acknowledge a publication that happened.
   *
   * ## A lost ACK is not a lost delivery
   *
   * The files exist. `published` is written before the ACK precisely so a
   * failure here replays the acknowledgement later rather than re-downloading
   * or re-publishing anything. An ACK failure therefore returns a truthful
   * receipt — committed, acknowledgement pending — and never `refused`.
   */
  private async settle(
    delivery: WireDelivery,
    plan: ManifestPlan,
    outcome: PublishOutcome,
    signal: AbortSignal,
  ): Promise<DeliveryReceipt> {
    const { report, residue } = outcome;
    if (outcome.handle !== null) {
      // Published, but the teardown did not conclude. The handle is retained
      // rather than dropped; the files it published are still real.
      this.retain(delivery.ID, outcome.handle, { residue: residue === "present" });
    }

    if (report.status === "partial") {
      // `partial -> acked` is not a legal journal move: telling central a
      // partial batch was complete is the one thing this path must never do.
      const recorded = await this.tryJournal(() =>
        this.options.journal.advance(delivery.ID, "partial", report.publishedCount, this.now()),
      );
      // Only the prefix that actually landed. See `DeliveredItems`.
      await this.tryDelivered(delivery, plan, report.publishedCount);
      return {
        kind: "partial",
        savedCount: report.publishedCount,
        total: report.total,
        failedIndex: report.failedIndex,
        reason: report.reason,
        residue,
        journalRecorded: recorded,
      };
    }
    if (report.publishedCount !== plan.total || report.total !== plan.total) {
      // Invariant 4's third number. The helper's receipt, this side's count and
      // the manifest total must all agree; two of them do not. The prefix the
      // receipt claims is still recorded rather than discarded.
      const recorded = await this.tryJournal(() =>
        this.options.journal.advance(delivery.ID, "partial", report.publishedCount, this.now()),
      );
      await this.tryDelivered(delivery, plan, report.publishedCount);
      return {
        kind: "partial",
        savedCount: report.publishedCount,
        total: plan.total,
        failedIndex: report.publishedCount,
        reason: "total-mismatch",
        residue,
        journalRecorded: recorded,
      };
    }

    const recorded = await this.tryJournal(() =>
      this.options.journal.advance(delivery.ID, "published", report.publishedCount, this.now()),
    );
    await this.tryDelivered(delivery, plan, report.publishedCount);
    // Acknowledged even when the marker did not land: the files ARE saved, so
    // the report is truthful, and it is what stops central redelivering a task
    // this side can no longer prove it completed.
    const acked = await this.tryAck(delivery, signal);
    return {
      kind: "saved",
      total: report.total,
      residue,
      ackPending: !acked,
      journalRecorded: recorded,
    };
  }

  /**
   * Hand the published names to the presentation hook, if there is one.
   *
   * Runs at the same point as the post-commit journal markers, and fails the
   * same way they do: never. The files are on disk by the time this is called,
   * so a hook that throws must not turn a real delivery into a refusal — the
   * user would be told nothing was saved while their files exist. What is lost
   * is the NAMES for this delivery, and the history reports that gap rather
   * than presenting the delivery as though it had arrived empty.
   *
   * `publishedCount` bounds the slice: a partial reports the prefix that landed
   * and never the whole manifest.
   */
  private async tryDelivered(delivery: WireDelivery, plan: ManifestPlan, publishedCount: number): Promise<void> {
    const hook = this.options.onDelivered;
    if (hook === undefined) return;
    const count = Math.max(0, Math.min(publishedCount, plan.names.length));
    const items: { readonly name: string; readonly size: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      items.push({ name: plan.names[i] ?? "", size: plan.sizes[i] ?? 0 });
    }
    let running: Promise<void>;
    try {
      running = hook({ taskID: delivery.ID, text: plan.text, declared: plan.total, items });
    } catch {
      // A hook that threw SYNCHRONOUSLY. Nothing is running and nothing is owed.
      return;
    }
    // Never unhandled, whichever way the race below goes. An unhandled
    // rejection is fatal in this process.
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.deliveredTimeoutMs);
    });
    try {
      await Promise.race([settled, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Write a post-commit journal marker, reporting whether it landed.
   *
   * These markers run AFTER the files exist. Letting one throw would turn a real
   * commit into `refused` and tell the user nothing was saved while their files
   * are on disk — the same mistake as discarding a publish receipt, one step
   * later.
   *
   * A marker that did NOT land is reported as such rather than papered over.
   * `published` is what makes "replay the ACK" safe on a later run; without it
   * there is no durable record of the full publish, so this side must not claim
   * that recovery is available.
   */
  private async tryJournal(body: () => Promise<void>): Promise<boolean> {
    try {
      await body();
      return true;
    } catch {
      return false;
    }
  }

  /** Acknowledge, reporting whether it landed rather than throwing it away. */
  private async tryAck(delivery: WireDelivery, signal: AbortSignal): Promise<boolean> {
    try {
      const saved = await this.options.api.report(
        delivery.ID,
        delivery.ClaimToken,
        "saved",
        true,
        "",
        signal,
      );
      await this.options.journal.recordServerState(
        delivery.ID,
        { terminal: saved.Terminal, expiresAt: delivery.ExpiresAt },
        this.now(),
      );
      const record = await this.options.journal.find(delivery.ID);
      await this.options.journal.advance(delivery.ID, "acked", record?.publishedCount ?? 0, this.now());
      return true;
    } catch {
      // Left at `published`, which is exactly the state whose reconciliation is
      // "replay the ACK". Nothing is re-downloaded and nothing is re-published.
      return false;
    }
  }

  /**
   * Abort and JOIN, then report residue truthfully. Invariant 6.
   *
   * A cancel that FAILS does not release the handle: the helper's contract says
   * an inconclusive teardown may mean the child is still running, so the
   * destination is retained and new admission is bounded instead. Dropping it
   * would leave a live process and its staging bytes with nothing referring to
   * them.
   */
  private async abandon(
    taskID: string,
    destination: ReceiveDestination | null,
    error: unknown,
  ): Promise<InboxFailure> {
    const carried = (error as Record<symbol, unknown> | null)?.[RETAIN];
    const handle = destination ?? ((carried as ReceiveDestination | undefined) ?? null);
    let residue: ResidueState = "none";
    if (handle !== null) {
      try {
        await handle.cancel();
      } catch (cleanupError) {
        residue = this.retain(taskID, handle, cleanupError);
      }
    }
    return asFailure(error, residue);
  }

  /**
   * A message delivery. No helper, no disk, no name.
   *
   * The manifest carries only the message's length — `inbox-manifest.ts` keeps
   * the text out of it deliberately — so the bytes arrive in the frames like any
   * other body, bounded by the same ceiling the vault enforces.
   */
  private async receiveText(
    delivery: WireDelivery,
    storeKey: CryptoKey,
    plan: ManifestPlan,
    renewer: LeaseRenewer,
    signal: AbortSignal,
  ): Promise<DeliveryReceipt> {
    if (plan.totalBytes > MAX_VAULT_TEXT_BYTES) {
      throw fatal(
        Object.assign(new Error("message exceeds the vault bound"), { code: "manifest-refused" }),
      );
    }
    const chunks: Uint8Array[] = [];
    let plaintext: Uint8Array | null = null;
    try {
      let seen = 0;
      await this.streamBody(delivery, storeKey, plan, renewer, signal, async (chunk) => {
        seen += chunk.byteLength;
        if (seen > plan.totalBytes) {
          throw Object.assign(new Error("message body exceeded its declared length"), {
            code: "length-exceeded",
          });
        }
        chunks.push(chunk);
      });

      this.fence(signal, renewer);
      await this.options.api.report(delivery.ID, delivery.ClaimToken, "verifying", false, "", signal);
      renewer.advance("verifying");
      await this.options.journal.advance(delivery.ID, "publishing", 0, this.now());

      await renewer.stop();
      // The fence after the held journal write, before the irreversible save.
      this.fence(signal, renewer);

      plaintext = new Uint8Array(seen);
      let at = 0;
      for (const chunk of chunks) {
        plaintext.set(chunk, at);
        at += chunk.byteLength;
      }
      await this.options.vault.saveText({
        id: delivery.ID,
        taskID: delivery.ID,
        sourceDeviceID: delivery.SourceDeviceID,
        plaintext,
        now: this.now(),
      });

      const recorded = await this.tryJournal(() =>
        this.options.journal.advance(delivery.ID, "published", 1, this.now()),
      );
      // A message has no names: `describeManifest` refuses a text item that
      // carries one, so this records THAT a message arrived and nothing else.
      await this.tryDelivered(delivery, plan, 0);
      const acked = await this.tryAck(delivery, signal);
      return {
        kind: "saved-message",
        residue: "none",
        ackPending: !acked,
        journalRecorded: recorded,
      };
    } finally {
      // Wiped whatever happened. A FAILED save leaves the message in memory just
      // as surely as a successful one, and it is the user's plaintext either way.
      if (plaintext !== null) zero(plaintext);
      for (const chunk of chunks) zero(chunk);
    }
  }

  /**
   * Fetch and decrypt the whole body, with bounded resumption.
   *
   * ## Why a resume keeps the decryptor and a restart does not
   *
   * The decryptor consumes CIPHERTEXT in order, so resuming at the exact
   * ciphertext offset already consumed is the same stream continued.
   *
   * A resume answered `200` is not that: it is the whole object from zero, and
   * splicing it onto what was already decrypted would produce plaintext nobody
   * sent. `api.blob` refuses it as `resume-restart`, and this loop additionally
   * requires the response to declare itself partial at any non-zero offset — so
   * a transport that reported otherwise could not be taken as a continuation.
   */
  private async streamBody(
    delivery: WireDelivery,
    storeKey: CryptoKey,
    plan: ManifestPlan,
    renewer: LeaseRenewer,
    signal: AbortSignal,
    sink: (chunk: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const decryptor: RuntimeStoreDecryptor = this.options.runtime.createStoreDecryptor(storeKey);
    let consumed = 0;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_BODY_ATTEMPTS; attempt += 1) {
      this.fence(signal, renewer);
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const stream = await this.options.api.blob(
          delivery.ID,
          delivery.ClaimToken,
          consumed,
          delivery.CiphertextBytes,
          signal,
        );
        if (consumed > 0 && stream.partial !== true) {
          // Not a continuation, whatever it claims to be.
          throw fatal(
            Object.assign(new Error("a resume was not answered as a range"), {
              code: "resume-restart",
            }),
          );
        }
        reader = stream.body.getReader();
        for (;;) {
          const { done, value } = await this.readBounded(reader, signal);
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          consumed += value.byteLength;
          if (consumed > delivery.CiphertextBytes) {
            throw fatal(
              Object.assign(new Error("body exceeded CiphertextBytes"), { code: "length-exceeded" }),
            );
          }
          try {
            for await (const plaintext of decryptor.push(value)) {
              await sink(plaintext);
            }
          } catch (error) {
            // An AEAD failure, a malformed frame, or a sink write that did not
            // land. The decryptor and the destination now hold state that no
            // resumed stream can be spliced onto, so this is never retried.
            throw fatal(error);
          }
          renewer.check();
        }
        if (consumed !== delivery.CiphertextBytes) {
          // A short body IS a transport interruption, and the only one this
          // loop resumes after.
          throw Object.assign(new Error("body ended early"), { code: "network" });
        }
        // The whole authenticated stream, verified. A stream truncated ON a
        // frame boundary is otherwise indistinguishable from a clean end.
        try {
          for await (const trailing of decryptor.end(plan.totalBytes)) {
            await sink(trailing);
          }
        } catch (error) {
          throw fatal(error);
        }
        return;
      } catch (error) {
        lastError = error;
        if (isFatal(error)) throw error;
        if (error instanceof AccountChangedError) throw error;
        const code = codeOf(error);
        if (code === undefined || !RESUMABLE_CODES.has(code)) throw error;
        // Resumable: what was decrypted stays decrypted, and the next attempt
        // asks for the ciphertext offset actually consumed.
      } finally {
        if (reader !== null) {
          try {
            await reader.cancel();
          } catch {
            // Already closed or errored; nothing further to release.
          }
        }
      }
    }
    throw lastError ?? Object.assign(new Error("body could not be read"), { code: "network" });
  }

  /**
   * One read, bounded by the idle timeout as well as the caller's signal.
   *
   * The abort listener is REMOVED in the finally. Added once per read and never
   * removed, they accumulate one per chunk across a large delivery — a leak on
   * a signal that outlives this call, and a listener-limit warning storm well
   * before that.
   */
  private async readBounded(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal.aborted) {
      throw fatal(Object.assign(new Error("cancelled"), { code: "cancelled" }));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("body stalled"), { code: "timeout" })),
          this.idleTimeoutMs,
        );
      });
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(fatal(Object.assign(new Error("cancelled"), { code: "cancelled" })));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([reader.read(), idle, aborted]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * What the manifest says, checked before a byte is accepted.
 *
 * One kind per delivery is the manifest codec's own invariant; it is re-checked
 * here because a decoder that changed would otherwise silently widen what this
 * receiver acts on.
 */
export function describeManifest(manifest: RuntimeManifest): ManifestPlan {
  if (manifest.items.length === 0) {
    throw fatal(Object.assign(new Error("a manifest with no items"), { code: "manifest-refused" }));
  }
  const kinds = new Set(manifest.items.map((item) => item.kind));
  if (kinds.size !== 1) {
    throw fatal(Object.assign(new Error("a mixed-kind manifest"), { code: "manifest-refused" }));
  }
  const text = kinds.has("text");
  if (text && manifest.items.length !== 1) {
    throw fatal(
      Object.assign(new Error("a text manifest with more than one item"), {
        code: "manifest-refused",
      }),
    );
  }
  let totalBytes = 0;
  const sizes: number[] = [];
  const names: string[] = [];
  for (const item of manifest.items) {
    if (!Number.isSafeInteger(item.size) || item.size < 0) {
      throw fatal(
        Object.assign(new Error("an item size is not an exact non-negative integer"), {
          code: "manifest-refused",
        }),
      );
    }
    if (!text && (item.name === undefined || item.name.length === 0)) {
      throw fatal(Object.assign(new Error("a file item with no name"), { code: "manifest-refused" }));
    }
    if (text && item.name !== undefined) {
      // The codec says text has no name so a receiver is never handed a string
      // it could treat as a destination.
      throw fatal(
        Object.assign(new Error("a text item carrying a name"), { code: "manifest-refused" }),
      );
    }
    sizes.push(item.size);
    // `undefined` only for text, which is refused a name above and reports an
    // empty list. A file item without one has already thrown.
    if (!text) names.push(item.name ?? "");
    totalBytes += item.size;
    if (!Number.isSafeInteger(totalBytes)) {
      throw fatal(
        Object.assign(new Error("the item sizes overflow an exact integer"), {
          code: "manifest-refused",
        }),
      );
    }
  }
  return { total: manifest.items.length, totalBytes, text, sizes, names };
}
