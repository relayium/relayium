// The Inbox, composed. One object the main process binds to, later.
//
// ## What this file is responsible for
//
// The stores each enforce their own rule. What none of them can see is ORDER
// ACROSS them: that an account change invalidates before it aborts and aborts
// before it joins, that a delivery is never started for a task the journal has
// already carried past the point of no return, and that turning the feature off
// stops the network without touching a single byte the user still owns.
//
// ## Three rules that look like policy and are not
//
//  1. **Disabling erases nothing.** It stops receiving and withdraws the server
//     enrolment. It does not delete the vault and it does not destroy the key
//     history, because a queued delivery names the key it was sealed to and a
//     message the user has not read is still theirs. `discardPendingDeliveries`
//     refers to deliveries CENTRAL still lists — not to local messages and not
//     to private keys.
//  2. **Deleting a message is its own act.** It never rides along with
//     disabling, signing out, or an account change.
//  3. **Reconciliation replays an acknowledgement and nothing else.** A
//     `blocked` record is a genuine stop. Re-driving it could duplicate files;
//     ACKing it would claim a save that may not exist, and a false ACK cannot
//     be taken back — it erases the only proof that the question is still open.
import { AccountJobs, captureAccount, type AccountContext } from "./account.js";
import { InboxFiles } from "./files.js";
import { TaskJournal, type Reconciliation, type TaskRecord } from "./journal.js";
import { InboxKeyStore, type SecretSlot } from "./keys.js";
import { MessageVault, type VaultRecordMeta } from "./vault.js";
import { Receiver, type DeliveredItems, type ReceiveDestination, type RetainedHandle } from "./receiver.js";
import { SourceLeaseRegistry } from "./source.js";
import {
  IMPLEMENTED,
  autoAcceptFor,
  capabilitiesFor,
  mayEnrol,
  type ImplementedFeatures,
  type InboxConsent,
} from "./capabilities.js";
import type { InboxRuntime, RuntimeManifest } from "./runtime-contract.js";
import type { DeliveryReceipt, InboxFailureCode } from "./receipts.js";
import { asFailure } from "./receipts.js";
import type { InboxRuntimeState } from "./state.js";
import type { WireTask } from "./wire.js";
import type { EnrolResult, PendingResult, WireDevice } from "./api.js";

/**
 * Deliveries claimed per request: ONE.
 *
 * A larger batch leases several deliveries at once, and anything the caller
 * does not consume sits leased until it expires. An earlier version claimed
 * four, took the requested task and handed the rest back as `alsoLeased` — a
 * value nobody consumed, carrying raw claim tokens and wrapped keys out of the
 * only place entitled to hold them. Claiming one at a time means every lease
 * this process takes is one it is about to drive.
 */
const CLAIM_ONE = 1;

/** Deliveries one drain will process before yielding. */
const MAX_DRAIN_ITEMS = 16;

/** The API surface the facade needs. Structurally `InboxApi`. */
export interface FacadeApi {
  enrol(request: EnrolRequestLike, signal: AbortSignal): Promise<EnrolResult>;
  deleteInbox(signal: AbortSignal): Promise<void>;
  registerKey(algorithm: string, publicKey: string, previousKeyID: string, signal: AbortSignal): Promise<{ readonly ID: string }>;
  listKeys(signal: AbortSignal): Promise<readonly {
    readonly ID: string;
    readonly PublicKey: string;
    readonly Generation: number;
    readonly RevokedAt: number;
  }[]>;
  pending(limit: number, signal: AbortSignal): Promise<PendingResult>;
  accept(taskID: string, accept: boolean, signal: AbortSignal): Promise<WireTask>;
  claim(max: number, signal: AbortSignal): Promise<{ readonly deliveries: readonly ClaimedDelivery[]; readonly leaseSeconds: number }>;
  report(
    taskID: string,
    claimToken: string,
    state: string,
    committed: boolean,
    errorCode: string,
    signal: AbortSignal,
  ): Promise<{ readonly State: string; readonly Terminal: boolean; readonly SavedAt: number }>;
  currentDevice(signal: AbortSignal): Promise<WireDevice>;
  blob(
    taskID: string,
    claimToken: string,
    offset: number,
    expectedTotal: number,
    signal: AbortSignal,
  ): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly partial: boolean }>;
  renameDevice(name: string, normalize: (value: string) => string, signal: AbortSignal): Promise<string>;
}

export interface EnrolRequestLike {
  readonly platform: string;
  readonly appVersion: string;
  readonly protocolVersions: readonly number[];
  readonly capabilities: readonly string[];
  readonly autoAccept: string;
  readonly receiveDirReady: boolean;
}

/** The delivery shape the receiver consumes. */
export type ClaimedDelivery = Parameters<Receiver["receive"]>[0];

export interface InboxHost {
  /** The host's OWN data root. Never a renderer value and never a user path. */
  readonly dataRoot: string;
  readonly platform: string;
  readonly appVersion: string;
}

export interface InboxFacadeOptions {
  readonly host: InboxHost;
  readonly runtime: InboxRuntime;
  /** Built per account, because the bearer is captured with the context. */
  apiFor(context: AccountContext): FacadeApi;
  secretsFor(context: AccountContext): SecretSlot;
  /** The at-rest key for this account's local stores. */
  atRestKeyFor(context: AccountContext): Promise<Uint8Array>;
  destinationFor(manifest: RuntimeManifest, context: AccountContext): Promise<ReceiveDestination>;
  /**
   * What a delivery saved, by name, for the account it saved it under.
   *
   * ## Why the context is a parameter and not something the host looks up
   *
   * The same rule `destinationFor` follows. A delivery belongs to the account
   * it began under, and by the time this is called that may no longer be the
   * account signed in — a sign-out during a long download is exactly the case.
   * Handing the CAPTURED context through means the host writes this delivery's
   * names into the store of the account that received them, and structurally
   * cannot write them into the account that replaced it.
   *
   * Optional, awaited, and never load-bearing: the receiver swallows a failure
   * here because the files are already on disk. See `DeliveredItems`.
   */
  onDelivered?(delivered: DeliveredItems, context: AccountContext): Promise<void>;
  readonly features?: ImplementedFeatures;
  readonly now?: () => number;
}

export interface InboxCapabilityReport {
  readonly features: ImplementedFeatures;
  readonly capabilities: readonly string[];
  readonly mayEnrol: boolean;
  /** Present when the build cannot receive, so the caller can say WHY. */
  readonly reason?: InboxFailureCode;
}

/** A retained handle as the caller sees it: releasable by `key`. */
export interface FacadeRetainedHandle extends RetainedHandle {
  /** Which binding still owns it. */
  readonly bindingID: number;
}

export interface AdoptReport {
  /** Handles from the OUTGOING account that could not be cleaned up. */
  readonly carriedOver: readonly FacadeRetainedHandle[];
}

export interface ShutdownReport {
  readonly carriedOver: readonly FacadeRetainedHandle[];
}

export interface DisableReport {
  /** What central actually did, not what was asked for. */
  readonly withdrawn:
    | { readonly kind: "withdrawn" }
    | { readonly kind: "still-enrolled"; readonly failure: ReturnType<typeof asFailure> }
    /** A later explicit enable was admitted; this disable no longer speaks. */
    | { readonly kind: "superseded" };
  readonly carriedOver: readonly FacadeRetainedHandle[];
}

export type ReconcileOutcome =
  | { readonly kind: "acked"; readonly taskID: string }
  /** Central did not lease it back this pass; it stays recorded and is retried. */
  | { readonly kind: "ack-pending"; readonly taskID: string }
  | { readonly kind: "blocked"; readonly taskID: string; readonly reason: string };

/** Why a delivery was not started. `blocked` is never re-driven from here. */
export type AcceptRefusal =
  | { readonly kind: "not-enabled" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "already-settled" }
  | { readonly kind: "busy" };

/** What the caller knows about the delivery it is accepting. */
export interface AcceptRequest {
  readonly taskID: string;
  /** Central's idempotency key, for the dedup horizon. */
  readonly idempotencyKey: string;
  /** Central's creation time, compared against the journal's watermark. */
  readonly createdAt: number;
}

export type AcceptOutcome =
  | { readonly kind: "received"; readonly receipt: DeliveryReceipt }
  /**
   * Accepted on the server and not reached in this drain.
   *
   * Not a failure and not "already settled": the drain processes what central
   * hands back, one lease at a time, and this task was not among them yet. It
   * stays accepted and a later drain picks it up.
   */
  | { readonly kind: "queued" }
  | AcceptRefusal;

/** What one drain did. Closed types only — no delivery, token or key escapes. */
export interface DrainReport {
  readonly processed: readonly { readonly taskID: string; readonly outcome: DrainOutcome }[];
  /** True when the drain stopped because the receiver had no capacity left. */
  readonly stoppedAtCapacity: boolean;
}

export type DrainOutcome =
  | { readonly kind: "received"; readonly receipt: DeliveryReceipt }
  | { readonly kind: "acknowledged" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * The authority a revoked binding reports.
 *
 * `currentAccount` must NEVER fall back to the outgoing context. During
 * invalidation `this.bound` is null, and returning the old context there would
 * tell an in-flight receiver that its account is still current at exactly the
 * moment it is not — so it would publish under an account that has gone away.
 * This value matches nothing: `sameAccount` compares accountKey, deviceID and
 * epoch, and no real capture has a negative epoch.
 */
const REVOKED_AUTHORITY: AccountContext = Object.freeze({
  accountKey: "revoked",
  deviceID: "",
  epoch: -1,
  directory: "",
});

let nextBindingID = 1;

interface Bound {
  /** Identity, so a method can tell whether ITS binding is still the live one. */
  readonly id: number;
  alive: boolean;
  readonly context: AccountContext;
  /** Replaced after `disable` joins them, so local reads still have a home. */
  jobs: AccountJobs;
  /**
   * Serialises the REMOTE authority calls of this binding.
   *
   * `enrol` and `deleteInbox` both change what central believes about this
   * device. Run concurrently, a withdrawal already in flight can land after a
   * fresh enrolment and delete server state the user just asked for.
   */
  remoteTail: Promise<unknown>;
  readonly files: InboxFiles;
  readonly journal: TaskJournal;
  readonly vault: MessageVault;
  readonly keys: InboxKeyStore;
  readonly api: FacadeApi;
  readonly receiver: Receiver;
  enabled: boolean;
}

export class InboxFacade {
  private bound: Bound | null = null;
  private consent: InboxConsent = { enabled: false };
  private readonly leases = new SourceLeaseRegistry();
  private readonly features: ImplementedFeatures;
  private readonly now: () => number;
  /**
   * Receivers from bindings that have been retired but still own handles.
   *
   * ## One owner, always
   *
   * An earlier version COPIED `RetainedHandle` values out of the receiver into
   * a second registry. That gave one destination two owners: the copy could be
   * cancelled while the receiver's own entry stayed, so the receiver remained
   * at its admission bound forever even though the cleanup had succeeded — and
   * a repeated disable absorbed the same handles again, listing them twice.
   *
   * So nothing is copied. The RECEIVER stays the owner of everything it
   * retained; what is kept here is the retired receiver itself, under its
   * binding id. Release is delegated back to it, and public keys are namespaced
   * by binding id so a caller has one unique, stable key per handle.
   */
  private readonly retired = new Map<number, Receiver>();
  /** Serialises adopt/shutdown against everything, including each other. */
  private tail: Promise<unknown> = Promise.resolve();
  /** One delivery at a time, on top of the receiver's own per-task guard. */
  private receiving = false;
  /**
   * Which enable/disable intent is current.
   *
   * Binding identity is NOT enough. `disable` leaves the binding live and alive
   * — that is the whole point of it — so an `enable` that parked in a step which
   * does not honour an abort, a key write to the secret store being the obvious
   * one, comes back afterwards and republishes `enabled` and consent that
   * `disable` had just cleared. The account never changed, so every
   * identity-based check passes.
   *
   * Every enable and every disable takes the next number. A step that resumes
   * against a stale number publishes nothing — and does not force anything
   * either, because a NEWER intent may legitimately own the state by then.
   */
  private intent = 0;

  constructor(private readonly options: InboxFacadeOptions) {
    this.features = options.features ?? IMPLEMENTED;
    this.now = options.now ?? (() => Date.now());
  }

  /** Serialise a whole operation against every other serialised one. */
  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * What this build can actually do.
   *
   * Computed from the feature switches, never written as a literal. Both remain
   * false until the receiver is accepted end to end, so nothing enrols and the
   * caller is told why rather than being shown a switch that does nothing.
   */
  capabilities(): InboxCapabilityReport {
    const capabilities = capabilitiesFor(this.options.runtime, this.features);
    const enrolable = mayEnrol(this.features);
    return enrolable
      ? { features: this.features, capabilities, mayEnrol: true }
      : { features: this.features, capabilities, mayEnrol: false, reason: "not-enrolled" };
  }

  state(): InboxRuntimeState {
    if (!mayEnrol(this.features)) return { kind: "unavailable", reason: "not-enrolled" };
    if (this.bound === null || !this.bound.enabled || !this.consent.enabled) {
      return { kind: "disabled" };
    }
    if (this.receiving) {
      return {
        kind: "receiving",
        progress: { total: 0, published: 0, totalBytes: 0, receivedBytes: 0, text: false },
      };
    }
    return { kind: "idle", pending: 0 };
  }

  /**
   * Adopt an account. Invalidate, abort ALL, then join.
   *
   * The order is the point. Marking the old context dead first means nothing
   * new can be admitted while the abort is still propagating; aborting every
   * job before joining any means the last job is not still running while the
   * first is being waited on. Only when the join completes is the new context
   * installed, so no work under the new account can begin while a write under
   * the old one is still in flight.
   *
   * Retained handles from the outgoing account are CARRIED, not dropped: a
   * teardown that never concluded is still a process that may be holding the
   * user's staging bytes, and an account change is not evidence about it.
   */
  adopt(args: { readonly accountID: string; readonly deviceID: string; readonly epoch: number }): Promise<AdoptReport> {
    return this.serialize(async () => {
      const previous = this.bound;
      if (previous !== null) {
        // 1. invalidate, so nothing new is admitted
        previous.enabled = false;
        previous.alive = false;
        this.bound = null;
        // 2. abort every job, 3. only then join them
        await previous.jobs.close();
        // 4. inherit what could not be cleaned up
        this.retire(previous);
      }
      this.leases.clear();
      this.receiving = false;

      const context = captureAccount({
        accountID: args.accountID,
        deviceID: args.deviceID,
        epoch: args.epoch,
        // The host's own root. Not a renderer value, not a user path, and not
        // an invented sibling folder.
        inboxRoot: `${this.options.host.dataRoot}/inbox`,
      });
      this.bound = this.bind(context);
      this.consent = { enabled: false };
      return { carriedOver: this.retainedHandles() };
    });
  }

  /**
   * Retire a binding, keeping its receiver as the owner of anything unreleased.
   *
   * Only called when a binding genuinely goes away — an adoption or a shutdown.
   * NOT on `disable`: the binding is still adopted there, and its receiver is
   * still the one owner of its handles.
   */
  private retire(bound: Bound): void {
    if (bound.receiver.retainedHandles().length > 0) this.retired.set(bound.id, bound.receiver);
  }

  /** The public key for a handle: unique across bindings, and stable. */
  private static publicKey(bindingID: number, handleKey: string): string {
    return `${String(bindingID)}:${handleKey}`;
  }

  private static splitKey(key: string): { bindingID: number; handleKey: string } | null {
    const at = key.indexOf(":");
    if (at <= 0) return null;
    const bindingID = Number(key.slice(0, at));
    if (!Number.isSafeInteger(bindingID)) return null;
    return { bindingID, handleKey: key.slice(at + 1) };
  }

  /** Every owner, retired and live. */
  private owners(): readonly (readonly [number, Receiver])[] {
    const out: (readonly [number, Receiver])[] = [...this.retired.entries()];
    if (this.bound !== null) out.push([this.bound.id, this.bound.receiver] as const);
    return out;
  }

  private bind(context: AccountContext): Bound {
    const hook = this.options.onDelivered;
    const delivered =
      hook === undefined ? undefined : (items: DeliveredItems): Promise<void> => hook(items, context);
    const files = new InboxFiles(context);
    const atRest = () => this.options.atRestKeyFor(context);
    const journal = new TaskJournal(context, files, atRest);
    const vault = new MessageVault(context, files, atRest);
    const keys = new InboxKeyStore(context, this.options.secretsFor(context), this.options.runtime);
    const api = this.options.apiFor(context);
    const receiver = new Receiver({
      context,
      runtime: this.options.runtime,
      api,
      keys,
      journal,
      vault,
      destinationFor: (manifest) => this.options.destinationFor(manifest, context),
      // Bound to THIS binding's context, captured when the binding was built.
      // A hook installed by the host receives the account the delivery ran
      // under, whatever is signed in by the time it fires.
      //
      // Spread rather than assigned, because `exactOptionalPropertyTypes` makes
      // an explicit `undefined` a different thing from an absent member — and
      // the receiver's own contract is that ABSENT means "behaviour is
      // identical", not "a hook that is undefined".
      ...(delivered === undefined ? {} : { onDelivered: delivered }),
      // Only while THIS binding is still the live, alive one. Anything else is
      // revoked authority, and the receiver fences on it.
      currentAccount: () => {
        const live = this.bound;
        return live !== null && live.alive && live.context === context ? context : REVOKED_AUTHORITY;
      },
      now: this.now,
    });
    return {
      id: nextBindingID++,
      alive: true,
      context,
      jobs: new AccountJobs(context),
      files,
      journal,
      vault,
      keys,
      api,
      receiver,
      enabled: false,
      remoteTail: Promise.resolve(),
    };
  }

  /** Stop everything and report what could not be released. */
  shutdown(): Promise<ShutdownReport> {
    return this.serialize(async () => {
      const bound = this.bound;
      if (bound !== null) {
        bound.enabled = false;
        bound.alive = false;
        this.bound = null;
        await bound.jobs.close();
        this.retire(bound);
      }
      this.leases.clear();
      this.receiving = false;
      return { carriedOver: this.retainedHandles() };
    });
  }

  /**
   * Turn the Inbox on, with explicit consent.
   *
   * Refuses while the build cannot receive: enrolling would advertise a device
   * that deliveries could be queued against and never completed. A key is
   * appended DURABLY before it is published, because a key central knows about
   * and this device cannot reproduce makes every delivery sealed to it
   * permanently unopenable.
   */
  enable(consent: InboxConsent, signal: AbortSignal): Promise<EnrolResult> {
    // NOT under the authority lock. Holding it across a network call would put
    // `adopt` and `shutdown` behind a stalled enrolment — so the very thing
    // that is supposed to abort it could not run until it finished. The
    // operation is registered with the account's own job registry instead,
    // which is what `adopt` aborts and joins.
    const bound = this.require();
    if (!consent.enabled) {
      return Promise.reject(new Error("inbox: enable requires consent"));
    }
    if (!mayEnrol(this.features)) {
      return Promise.reject(
        Object.assign(new Error("inbox: this build cannot receive yet"), { code: "not-enrolled" }),
      );
    }
    // Taken at admission. Anything that resumes against a stale number is
    // reporting on an intent the user has since replaced.
    const myIntent = ++this.intent;
    {
      return bound.jobs.run(async (jobSignal) => {
        const both = AbortSignal.any([signal, jobSignal]);
        const record = (await bound.keys.current()) ?? (await bound.keys.append(this.now()));
        this.assertIntact(bound, myIntent, both);
        const agreed = await this.remote(bound, () => bound.api.enrol(
          {
            platform: this.options.host.platform,
            appVersion: this.options.host.appVersion,
            protocolVersions: [this.options.runtime.constants.protocolVersion],
            capabilities: capabilitiesFor(this.options.runtime, this.features),
            autoAccept: autoAcceptFor(this.features, consent),
            receiveDirReady: true,
          },
          both,
        ));
        this.assertIntact(bound, myIntent, both);
        if (record.keyID.length === 0) {
          const keyID = await this.publishOrReconcileKey(bound, record.publicKey, both);
          this.assertIntact(bound, myIntent, both);
          // A SECRET-STORE WRITE. It has no reason to honour a fetch abort, so
          // it can complete long after a disable landed — which is exactly how
          // an enable used to republish state that had just been cleared.
          await bound.keys.bindKeyID(record.publicKey, keyID);
        }
        // The last fence before anything is published. Identity, liveness,
        // cancellation and intent, all of them, because the step above proves
        // none of the first three alone is sufficient.
        this.assertIntact(bound, myIntent, both);
        this.consent = consent;
        bound.enabled = true;
        return agreed;
      });
    }
  }

  /**
   * Publish this device's public key, or find the id central already gave it.
   *
   * ## The case this exists for
   *
   * A register response that was lost leaves central holding the key while this
   * side has no id for it. Registering again is refused — `stale_key_rotation`
   * — and the device can then never enable, even though the key it holds is the
   * one central is sealing to.
   *
   * So a refusal is not treated as failure: central's history is READ, and if
   * its active key is the public key this device already holds, the id is bound
   * and nothing is minted. That is `InboxEnrolment.reconcile`'s recoverable
   * case, and it is the only one taken here.
   *
   * What this deliberately does NOT do is rotate onto a new key when no match is
   * found. Central's active key would then be one whose private half this device
   * does not have, and rotating away from it makes every delivery already queued
   * against it permanently undecryptable. That is invariant 2, and it is a
   * product decision rather than a recovery.
   *
   * Bounded: one registration attempt, then at most one read.
   */
  private async publishOrReconcileKey(
    bound: Bound,
    publicKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const published = await this.remote(bound, () =>
        bound.api.registerKey(this.options.runtime.constants.keyAlgorithm, publicKey, "", signal),
      );
      return published.ID;
    } catch (error) {
      const server = (error as { serverCode?: unknown }).serverCode;
      if (server !== "stale_key_rotation" && server !== "device_key_reused") throw error;
      // Central's history disagrees with ours and the truth is on its side.
      const history = await this.remote(bound, () => bound.api.listKeys(signal));
      const active = history
        .filter((k) => k.RevokedAt === 0)
        .sort((a, b) => b.Generation - a.Generation)[0];
      if (active === undefined) {
        throw Object.assign(new Error("inbox: central holds no active key"), {
          code: "key-unavailable",
        });
      }
      if (active.PublicKey !== publicKey) {
        // Not ours. Minting onto it would discard the private half of the key
        // pending deliveries name.
        throw Object.assign(new Error("inbox: central's active key is not this device's"), {
          code: "key-unavailable",
        });
      }
      return active.ID;
    }
  }

  /** Throws unless `bound` is still the live, alive binding. */
  private assertStillLive(bound: Bound): void {
    if (this.bound !== bound || !bound.alive) {
      throw Object.assign(new Error("inbox: account changed"), { code: "account-changed" });
    }
  }

  /**
   * The full fence for an authority operation resuming after an await.
   *
   * Identity, liveness, cancellation AND intent. A filesystem or key-store write
   * has no reason to honour a fetch abort, so "my signal is still open" is not
   * evidence that what I am about to publish is still wanted.
   */
  private assertIntact(bound: Bound, myIntent: number, signal: AbortSignal): void {
    this.assertStillLive(bound);
    if (signal.aborted) {
      throw Object.assign(new Error("inbox: cancelled"), { code: "cancelled" });
    }
    if (this.intent !== myIntent) {
      throw Object.assign(new Error("inbox: superseded by a later intent"), {
        code: "superseded",
      });
    }
  }

  /** Serialise remote authority operations for one binding. */
  private remote<T>(bound: Bound, body: () => Promise<T>): Promise<T> {
    const run = bound.remoteTail.then(body, body);
    bound.remoteTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Turn it off. Stops the network; erases nothing local.
   *
   * The vault, the key history and the journal are all untouched: a queued
   * delivery names the key it was sealed to, and an unread message is the
   * user's. Destroying either is a separate, explicit act.
   *
   * The binding is NOT retired. It is still adopted, and its receiver remains
   * the one owner of anything it retained.
   */
  async disable(signal: AbortSignal): Promise<DisableReport> {
    // ---- local stop: an authority transition, so it holds the lock ---------
    const myIntent = ++this.intent;
    const bound = await this.serialize(async () => {
      const live = this.require();
      live.enabled = false;
      this.consent = { enabled: false };
      // Abort and JOIN, so nothing is still receiving while the enrolment is
      // withdrawn.
      await live.jobs.close();
      this.receiving = false;
      // A fresh registry: the old one refuses everything now, but the account
      // is still adopted and its local stores must stay readable.
      live.jobs = new AccountJobs(live.context);
      return live;
    });

    // ---- remote withdrawal: OUTSIDE the authority lock ---------------------
    // Held inside it, a stalled `deleteInbox` would block `adopt` and
    // `shutdown` exactly as a stalled `enrol` once did. It runs under the
    // account's job registry instead, so an account transition aborts it.
    let withdrawn: DisableReport["withdrawn"];
    try {
      await bound.jobs.run(async (jobSignal) => {
        const both = AbortSignal.any([signal, jobSignal]);
        // Serialised with `enrol` on this binding, and re-checked immediately
        // before it is issued. A withdrawal that raced a fresh enable would
        // otherwise delete server state the user had just asked for.
        await this.remote(bound, async () => {
          this.assertIntact(bound, myIntent, both);
          await bound.api.deleteInbox(both);
        });
      });
      withdrawn = { kind: "withdrawn" };
    } catch (error) {
      if ((error as { code?: unknown }).code === "superseded") {
        // A later enable owns the state. Reporting this as "disabled" would be
        // false, and forcing it would undo what the user just asked for.
        return { withdrawn: { kind: "superseded" }, carriedOver: this.retainedHandles() };
      }
      // Reported truthfully. Swallowing a refusal would show a disabled Inbox
      // that central still lists as a live target, and deliveries would keep
      // being queued against it.
      withdrawn = { kind: "still-enrolled", failure: asFailure(error, "none") };
    }
    return { withdrawn, carriedOver: this.retainedHandles() };
  }

  /** What central says is waiting. Claims nothing and takes no lease. */
  listPending(limit: number, signal: AbortSignal): Promise<PendingResult> {
    const bound = this.require();
    return bound.jobs.run((jobSignal) =>
      bound.api.pending(limit, AbortSignal.any([signal, jobSignal])),
    );
  }

  /** Messages already saved. Metadata only; no message bytes are opened. */
  messages(): Promise<readonly VaultRecordMeta[]> {
    const bound = this.require();
    // Under the registry like everything else: a read started before an
    // adoption must not resolve into a UI that has already moved on.
    return bound.jobs.run(async () => {
      const list = await bound.vault.list();
      this.assertStillLive(bound);
      return list;
    });
  }

  /**
   * This account's delivery records. Counts and phases; never a name.
   *
   * The journal is deliberately free of filenames and paths — see its header —
   * and this exposes it unchanged rather than enriching it. Under the account's
   * own job registry with the same liveness fence `messages()` uses, so a read
   * started before an adoption cannot resolve into a UI that has moved on.
   */
  receipts(): Promise<readonly TaskRecord[]> {
    const bound = this.require();
    return bound.jobs.run(async () => {
      const all = await bound.journal.all();
      this.assertStillLive(bound);
      return all;
    });
  }

  openMessage(id: string): Promise<Uint8Array> {
    const bound = this.require();
    return bound.jobs.run(async () => {
      const bytes = await bound.vault.openText(id);
      this.assertStillLive(bound);
      return bytes;
    });
  }

  /**
   * Delete one message, because the user asked for that and nothing else.
   *
   * Never reached by `disable`, `adopt` or `shutdown`.
   */
  deleteMessage(id: string): Promise<void> {
    const bound = this.require();
    return bound.jobs.run(() => bound.vault.remove(id));
  }

  /** Decline a held delivery. `accept: false` is the server's decline. */
  reject(taskID: string, signal: AbortSignal): Promise<void> {
    const bound = this.require();
    return bound.jobs.run(async (jobSignal) => {
      await bound.api.accept(taskID, false, AbortSignal.any([signal, jobSignal]));
    });
  }

  /**
   * Accept a held delivery and receive it.
   *
   * The journal is consulted FIRST, and its verdict is final. A record already
   * at `published` needs its acknowledgement replayed, not its bytes fetched
   * again. `publishing` and `partial` are stops: this side cannot establish
   * what landed, and both re-driving and auto-ACKing would assert something it
   * does not know. `unknown` from the dedup horizon is the same answer for the
   * same reason — the records that could have said are gone.
   */
  accept(args: AcceptRequest, signal: AbortSignal): Promise<AcceptOutcome> {
    const bound = this.require();
    if (!bound.enabled) return Promise.resolve({ kind: "not-enabled" });
    // RESERVED SYNCHRONOUSLY, before the first await.
    if (this.receiving) return Promise.resolve({ kind: "busy" });
    this.receiving = true;
    return bound.jobs
      .run(async (jobSignal) => {
        const both = AbortSignal.any([signal, jobSignal]);
        const existing = await bound.journal.find(args.taskID);
        const verdict = journalVerdict(existing);
        if (verdict !== null) return verdict;
        if (existing === null) {
          // No record is NOT "never happened". `unknown` means the records that
          // could have said were pruned, which is a stop.
          const settled = await bound.journal.isSettled(
            args.taskID,
            args.idempotencyKey,
            args.createdAt,
          );
          if (settled === "settled") return { kind: "already-settled" } as const;
          if (settled === "unknown") {
            return { kind: "blocked", reason: "unknown-horizon" } as const;
          }
        }

        // Tell central this delivery is wanted, then DRIVE whatever it leases.
        await bound.api.accept(args.taskID, true, both);
        const report = await this.drainOwned(bound, both);
        const mine = report.processed.find((p) => p.taskID === args.taskID);
        if (mine === undefined) return { kind: "queued" } as const;
        if (mine.outcome.kind === "received") {
          return { kind: "received", receipt: mine.outcome.receipt } as const;
        }
        if (mine.outcome.kind === "blocked") {
          return { kind: "blocked", reason: mine.outcome.reason } as const;
        }
        return { kind: "already-settled" } as const;
      })
      .finally(() => {
        this.receiving = false;
      });
  }

  /**
   * Drive every lease this process takes, one at a time.
   *
   * ## Why the loop owns what it claims
   *
   * A claim is a LEASE. Anything claimed and not driven sits leased until it
   * expires, so a receiver that claimed a batch to pick one task out of it
   * would be quietly delaying every other delivery the user had already
   * accepted. This claims ONE, decides what to do with it, and only then asks
   * for another — so there is never a lease in hand that nothing is driving.
   *
   * The journal's verdict is applied PER ITEM. A record already at `published`
   * is acknowledged and its body is never fetched; the fresh claim exists only
   * to supply the token that `handleReportInboxTask` requires. Anything the
   * journal blocks is reported and left alone.
   *
   * Bounded by the receiver's own capacity and by `MAX_DRAIN_ITEMS`, and it
   * runs inside the account's job registry, so an account change stops it.
   */
  private async drainOwned(bound: Bound, signal: AbortSignal): Promise<DrainReport> {
    const processed: { taskID: string; outcome: DrainOutcome }[] = [];
    let stoppedAtCapacity = false;
    for (let i = 0; i < MAX_DRAIN_ITEMS; i += 1) {
      if (!bound.receiver.canAdmit()) {
        stoppedAtCapacity = true;
        break;
      }
      this.assertStillLive(bound);
      const claimed = await bound.api.claim(CLAIM_ONE, signal);
      const delivery = claimed.deliveries[0];
      if (delivery === undefined) break;

      const record = await bound.journal.find(delivery.ID);
      if (record === null) {
        // The SAME horizon check `accept` makes, applied to every item the
        // drain claims. Without it the automatic path bypassed the protection
        // entirely: an `unknown` verdict means the records that could have
        // answered were pruned, and receiving again could duplicate a delivery
        // that already landed. Checked BEFORE any destination or body.
        const settled = await bound.journal.isSettled(
          delivery.ID,
          delivery.IdempotencyKey,
          delivery.CreatedAt,
        );
        if (settled !== "not-settled") {
          processed.push({
            taskID: delivery.ID,
            outcome: {
              kind: "blocked",
              reason: settled === "settled" ? "already-settled" : "unknown-horizon",
            },
          });
          continue;
        }
      }
      if (record !== null && record.phase === "published") {
        // ACK ONLY. The files are already on disk; the body is not fetched.
        const acked = await this.acknowledge(bound, delivery, record.publishedCount, signal);
        processed.push({
          taskID: delivery.ID,
          outcome: acked ? { kind: "acknowledged" } : { kind: "blocked", reason: "ack-failed" },
        });
        continue;
      }
      const verdict = journalVerdict(record);
      if (verdict !== null) {
        processed.push({
          taskID: delivery.ID,
          outcome: {
            kind: "blocked",
            reason: verdict.kind === "blocked" ? verdict.reason : verdict.kind,
          },
        });
        continue;
      }
      const receipt = await bound.receiver.receive(delivery, signal);
      processed.push({ taskID: delivery.ID, outcome: { kind: "received", receipt } });
    }
    return { processed: Object.freeze(processed), stoppedAtCapacity };
  }

  /**
   * Acknowledge a delivery whose files already exist, using a FRESH token.
   *
   * `handleReportInboxTask` rejects an empty `claimToken` with `stale_claim`
   * before anything else, and the original token died with the process. The
   * claim that produced this delivery is the only thing that can supply one —
   * and it supplies a token, not a reason to fetch the bytes again.
   */
  private async acknowledge(
    bound: Bound,
    delivery: ClaimedDelivery,
    publishedCount: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      // `saved` is reachable ONLY from `verifying`, and `ClaimInboxTasks` sets a
      // freshly claimed task to `downloading` — so a replay must assert
      // `verifying` first or the server refuses the transition outright. This is
      // the step macOS's `InboxReceiveEngine.reportSaved` makes for exactly the
      // same reason, and no body is fetched for either report.
      //
      // Reporting the state a task is already in is an idempotent no-op, which
      // is what makes this safe on a retry.
      await bound.api.report(delivery.ID, delivery.ClaimToken, "verifying", false, "", signal);
      const saved = await bound.api.report(delivery.ID, delivery.ClaimToken, "saved", true, "", signal);
      // Central's answer is the authority. A 2xx alone is not it.
      if (saved.State !== "saved" || !saved.Terminal) return false;
      await bound.journal.recordServerState(
        delivery.ID,
        { terminal: saved.Terminal, expiresAt: delivery.ExpiresAt },
        this.now(),
      );
      await bound.journal.advance(delivery.ID, "acked", publishedCount, this.now());
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "task-terminal") return false;
      // `task_terminal` does NOT mean "already saved". `deviceinbox_task_test.go`
      // at 925 and 943 shows it answered with `State: expired` — and `revoked`
      // and `failed_terminal` are terminal too. Converging on the code alone
      // would claim an acknowledgement central never gave, for a delivery it
      // has written off.
      //
      // The 409 echoes the task, and only an exact `saved` + `Terminal` is the
      // retry converging.
      const echoed = (error as { task?: { ID?: string; State?: string; Terminal?: boolean } }).task;
      // The echoed task must BE this delivery. A 409 carrying some other task —
      // a server bug, a proxy replaying a body, a future endpoint that echoes
      // more than one — would otherwise close or mark terminal a record it says
      // nothing about. Identity first, then state.
      if (echoed?.ID !== delivery.ID) return false;
      if (echoed.State === "saved" && echoed.Terminal === true) {
        await this.tryJournalAck(bound, delivery.ID, publishedCount);
        return true;
      }
      // Terminal, but not saved. The record is NOT acked: what is recorded is
      // that central is finished with it, which is what lets retention evict it
      // without anyone claiming the delivery was acknowledged.
      if (echoed.Terminal === true) {
        try {
          await bound.journal.recordServerState(
            delivery.ID,
            { terminal: true, expiresAt: delivery.ExpiresAt },
            this.now(),
          );
        } catch {
          // Retried on the next pass; nothing is weakened by it not landing.
        }
      }
      return false;
    }
  }

  /** Close a record whose delivery central reports already terminal. */
  private async tryJournalAck(bound: Bound, taskID: string, publishedCount: number): Promise<void> {
    try {
      await bound.journal.recordServerState(taskID, { terminal: true, expiresAt: 0 }, this.now());
      await bound.journal.advance(taskID, "acked", publishedCount, this.now());
    } catch {
      // The files exist and central is terminal; a marker that did not land is
      // retried, never re-delivered.
    }
  }

  /**
   * Drive whatever is leasable right now. MAIN-ONLY.
   *
   * Exposed so the host can run it on a schedule alongside heartbeat/pending
   * polling. It returns closed outcomes; no delivery, claim token or wrapped
   * key ever leaves this object.
   */
  drain(signal: AbortSignal): Promise<DrainReport> {
    const bound = this.require();
    if (!bound.enabled) return Promise.resolve({ processed: [], stoppedAtCapacity: false });
    if (this.receiving) return Promise.resolve({ processed: [], stoppedAtCapacity: true });
    this.receiving = true;
    return bound.jobs
      .run((jobSignal) => this.drainOwned(bound, AbortSignal.any([signal, jobSignal])))
      .finally(() => {
        this.receiving = false;
      });
  }

  /**
   * Replay acknowledgements that a crash left unsent. Nothing else.
   *
   * A `blocked` reconciliation is reported and left alone. There is no path
   * here that publishes, re-downloads, or marks a task acked without central
   * having said so, because a false acknowledgement destroys the record that
   * the delivery is still unresolved.
   */
  reconcile(signal: AbortSignal): Promise<readonly ReconcileOutcome[]> {
    const bound = this.require();
    return bound.jobs.run(async (jobSignal) => {
      const both = AbortSignal.any([signal, jobSignal]);
      const outcomes: ReconcileOutcome[] = [];
      // The drain is what can actually acknowledge, and it CLAIMS and can
      // DOWNLOAD — so it runs only under the same admission gate `drain` uses.
      // A disabled Inbox reconciles from metadata alone: it must not reach for
      // the network, and two concurrent reconciles must not both drain.
      const acked = new Set<string>();
      if (bound.enabled && !this.receiving) {
        this.receiving = true;
        try {
          const drained = await this.drainOwned(bound, both);
          for (const item of drained.processed) {
            if (item.outcome.kind === "acknowledged") {
              outcomes.push({ kind: "acked", taskID: item.taskID });
              acked.add(item.taskID);
            }
          }
        } finally {
          this.receiving = false;
        }
      }
      for (const item of await bound.journal.needsReconcile()) {
        if (acked.has(item.task.taskID)) continue;
        outcomes.push(this.replay(bound, item));
      }
      return Object.freeze(outcomes);
    });
  }

  /**
   * Report what reconciliation cannot resolve on its own.
   *
   * The ACK replay itself now happens in `drainOwned`, which holds a real claim
   * token for the delivery it is acknowledging and never fetches its body. This
   * only surfaces the records that are genuinely stuck: a `publishing` record
   * is a stop, because nothing on this side establishes what landed, and both
   * re-driving it and auto-ACKing it would assert something unknown.
   */
  private replay(_bound: Bound, item: Reconciliation): ReconcileOutcome {
    if (item.kind === "blocked") {
      return { kind: "blocked", taskID: item.task.taskID, reason: item.reason };
    }
    // `replay-ack` is handled by the drain, where a token exists.
    return { kind: "ack-pending", taskID: item.task.taskID };
  }

  /** Rename this device. Whitespace is collapsed; the server judges the rest. */
  rename(name: string, signal: AbortSignal): Promise<string> {
    const bound = this.require();
    return bound.jobs.run((jobSignal) =>
      bound.api.renameDevice(
        name,
        (value) => this.options.runtime.normalizeDeviceName(value),
        AbortSignal.any([signal, jobSignal]),
      ),
    );
  }

  currentDevice(signal: AbortSignal): Promise<WireDevice> {
    const bound = this.require();
    return bound.jobs.run((jobSignal) => bound.api.currentDevice(AbortSignal.any([signal, jobSignal])));
  }

  /** Send-side leases, so the renderer never names a path. */
  get sourceLeases(): SourceLeaseRegistry {
    return this.leases;
  }

  /** Everything still owned because its cleanup never concluded. */
  /**
   * Everything still owned, with a key the caller can actually release by.
   *
   * The receiver's own key is unique only within that receiver, so it is
   * namespaced by binding id here. Nothing is copied: these are views of what
   * their owning receivers still hold.
   */
  retainedHandles(): readonly FacadeRetainedHandle[] {
    const out: FacadeRetainedHandle[] = [];
    for (const [bindingID, receiver] of this.owners()) {
      for (const handle of receiver.retainedHandles()) {
        out.push({ ...handle, key: InboxFacade.publicKey(bindingID, handle.key), bindingID });
      }
    }
    return Object.freeze(out);
  }

  /**
   * Total live adapters this facade is responsible for.
   *
   * Retired owners count: they are processes that may still be running, and a
   * bound that ignored them would let account churn multiply what is open.
   */
  owned(): number {
    let total = 0;
    for (const [, receiver] of this.owners()) total += receiver.retainedHandles().length;
    return total;
  }

  /**
   * Release one, on OBSERVED cleanup success only.
   *
   * Delegated to the receiver that owns it, which is the only thing that can
   * both cancel the destination AND clear its own admission slot. A registry
   * that cancelled on its own would leave the owner permanently full.
   */
  async releaseRetained(key: string): Promise<boolean> {
    const parts = InboxFacade.splitKey(key);
    if (parts === null) return false;
    const live = this.bound;
    if (live !== null && live.id === parts.bindingID) {
      return live.receiver.releaseRetained(parts.handleKey);
    }
    const owner = this.retired.get(parts.bindingID);
    if (owner === undefined) return false;
    const released = await owner.releaseRetained(parts.handleKey);
    // A retired owner with nothing left is no longer anything to track.
    if (released && owner.retainedHandles().length === 0) this.retired.delete(parts.bindingID);
    return released;
  }

  private require(): Bound {
    if (this.bound === null) {
      throw Object.assign(new Error("inbox: no account is adopted"), { code: "account-changed" });
    }
    return this.bound;
  }
}

/**
 * The journal's verdict on a task, before any network call.
 *
 * `null` means "nothing on record; go ahead".
 */
export function journalVerdict(record: TaskRecord | null): AcceptRefusal | null {
  if (record === null) return null;
  switch (record.phase) {
    case "claimed":
      return null;
    case "published":
      // The files exist and only the acknowledgement is missing. `reconcile`
      // owns that and sends it WITHOUT fetching the body; coming through here
      // would re-download and re-publish what is already on disk.
      return { kind: "blocked", reason: "ack-pending" };
    case "publishing":
      return { kind: "blocked", reason: "publish-outcome-unknown" };
    case "partial":
      return { kind: "blocked", reason: "partial-publish" };
    case "acked":
    case "failed":
      return { kind: "already-settled" };
    default:
      return { kind: "blocked", reason: "unknown-phase" };
  }
}

/** Map a thrown value for a caller that renders failures. */
export function facadeFailure(error: unknown): ReturnType<typeof asFailure> {
  return asFailure(error, "unknown");
}
