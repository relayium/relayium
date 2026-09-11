// The Device Inbox, as a resident feature of THIS process.
//
// `src/main/inbox/**` knows how to receive one delivery correctly. It does not
// know when to look for one, which account it belongs to, where the user said
// to put it, or what a quit should do about it — those are host questions, and
// this file is the host's answer. It is the same relationship
// `features/stored-receive.ts` has to `stored/receive.ts`, and the same
// relationship `InboxController.swift` has to `InboxReceiveEngine` on the Mac.
//
// ## The scheduler belongs to the application, not to a page
//
// This is the invariant the whole file is arranged around. On macOS the loop
// has a FOREGROUND gate — `InboxController.run` naps whenever the app is not
// frontmost — and that gate deliberately does not come across. Windows ships a
// resident app: hiding the window, minimising it to the tray, or clicking a
// different sidebar row must not stop receiving, because a person who enabled
// the Inbox asked for files to arrive while they were doing something else.
//
// What DOES stop it: an account change, an explicit disable, a quit the user
// agreed to, and disposal. Nothing else, and in particular nothing the renderer
// does to itself. A component that remounts finds the same scheduler; it cannot
// create a second one, because there is exactly one of these and the page has
// no channel that starts it.
//
// ## The cadence is the Mac's, restated rather than re-chosen
//
// `RelayiumAppKit/DeviceInbox/InboxScheduling.swift` sets 30s idle, 2s after
// work, 5s doubling to a 300s ceiling on failure, and 60s while locally
// blocked. Those are product decisions that were already made and shipped —
// picking different numbers here would make two clients behave differently for
// no reason anybody could state. The doubling is a loop rather than `pow` for
// the reason the Swift source gives: a long outage must not be able to produce
// a non-finite interval, which is a stopped inbox rather than a slow one.
//
// ## Ordering, and why the guards are in this order
//
// Also the Mac's: account → consent → folder → work. Each guard names what is
// missing rather than collapsing into a single "off", because the remedies are
// different — sign in, turn it on, choose a folder again, wait. Two behaviours
// carried across specifically:
//
//  - **Off is ANNOUNCED, once, not gone quiet.** Central keeps the last policy
//    it was told, so a device that stops polling without withdrawing is still
//    offered to senders and collects deliveries nobody will ever work. A
//    withdrawal that could not be delivered stays pending and is retried.
//  - **On with no folder is `folder-missing`, never `idle` and never silently
//    `disabled`.** The user's answer is still their answer.
//
// ## What never crosses out of here
//
// No claim token, no wrapped key, no manifest, no bearer and no path. The view
// this publishes is counts and closed codes; the destination the renderer
// learns about is the boolean `hasDestination`.

import { stat } from "node:fs/promises";

import { InboxApi } from "../inbox/api.js";
import type { AccountContext } from "../inbox/account.js";
import { InboxFacade, facadeFailure, type FacadeApi } from "../inbox/facade.js";
import type { AutoAcceptPolicy, ImplementedFeatures } from "../inbox/capabilities.js";
import type { DeliveredItems, ReceiveDestination } from "../inbox/receiver.js";
import type { InboxRuntime, RuntimeManifest } from "../inbox/runtime-contract.js";
import { inboxRuntime } from "../inbox/runtime.js";
import type { InboxFailureCode } from "../inbox/receipts.js";
import {
  NativeHelperClient,
  type NativeManifestEntry,
  type NativeReceiveDestination,
} from "../io/native-helper-client.js";
import type {
  InboxAcceptOutcome,
  InboxDisableOutcome,
  InboxEnableOutcome,
  InboxMessageView,
  InboxPendingView,
  InboxRenameOutcome,
  InboxRetainedView,
  InboxSimpleOutcome,
  InboxReceiptView,
  InboxNamedDeliveryView,
  InboxStatus,
  InboxView,
} from "../../shared/ipc-contract.js";
import { MAX_INBOX_PENDING } from "../../shared/ipc-contract.js";
import { resolveCurrentDevice, DeviceLookupError, type CurrentDevice } from "./inbox-device.js";
import { InboxGrantStore, type GrantSlot, type InboxGrant } from "./inbox-grant.js";
import { InboxFiles } from "../inbox/files.js";
import { importAtRestKey } from "../inbox/atrest.js";
import { InboxPresentationStore, PresentationError } from "./inbox-presentation.js";

/**
 * What this build actually implements, and therefore what it may advertise.
 *
 * NOT a literal that flips when someone feels the feature is finished. Each
 * flag names a path that is composed in THIS file:
 *
 *  - `files`: `destinationFor` below opens the packaged native helper against
 *    the folder the user chose. A file delivery is written by it and published
 *    by it, or it fails with a code.
 *  - `text`: a message delivery never reaches the helper at all — the receiver
 *    commits it to the encrypted vault and this file exposes list/open/delete
 *    for it, so the whole path exists end to end.
 *  - `autoAccept`: the scheduler's own drain saves an auto-accepted delivery
 *    with no renderer involved, the off/ask/auto choice is persisted per
 *    account in the same durable grant as consent and the destination, and the
 *    folder guard applies to an unattended save exactly as it does to an asked
 *    one. The CAPABILITY is gated here on the build; the POLICY is gated on the
 *    user's own choice by `autoAcceptFor(features, consent)`, so advertising it
 *    never means this device takes deliveries nobody consented to.
 *
 * `capabilities()` computes the advertised set from these; nothing anywhere
 * writes the capability strings by hand.
 */
export const COMPOSED_FEATURES: ImplementedFeatures = Object.freeze({
  files: true,
  text: true,
  // Composed now: the scheduler's own drain is what saves an auto-accepted
  // delivery, and it needs no renderer to do it. The capability is advertised
  // only when the user has actually chosen `auto` — `autoAcceptFor` gates the
  // POLICY on consent, and this gates the CAPABILITY on the build.
  autoAccept: true,
});

/**
 * How many accounts' presentation stores stay cached.
 *
 * An instance is a cache over a file, so evicting one loses nothing durable.
 * Two is the ordinary maximum — the account that is signed in, plus one still
 * being torn down — and four leaves room for a machine somebody switches
 * accounts on without letting the map grow for the life of the process.
 */
const MAX_CACHED_PRESENTATION_STORES = 4;

/**
 * How long a delivery waits for its names to be written.
 *
 * Shorter than the receiver's own bound on the hook, so the deadline that fires
 * in practice is this one — the host's, where the work is registered and can be
 * joined — rather than the receiver's, which only stops waiting.
 */
const CAPTURE_DEADLINE_MS = 3_000;

/** Seconds between passes. The Mac's `InboxBackoff`, value for value. */
export interface InboxBackoff {
  /** Nothing to do, everything healthy. */
  readonly idle: number;
  /** A delivery was just worked; the sender is usually still watching. */
  readonly afterWork: number;
  /** First retry after a failed pass. */
  readonly first: number;
  /** Ceiling for the doubling. Reached and then held. */
  readonly cap: number;
  /** A local blocker only a person can clear. Slower than a failure retry. */
  readonly blocked: number;
}

export const INBOX_BACKOFF: InboxBackoff = Object.freeze({
  idle: 30,
  afterWork: 2,
  first: 5,
  cap: 300,
  blocked: 60,
});

/**
 * The delay after `failures` consecutive failed passes.
 *
 * Doubled in a loop and clamped, never `Math.pow`: a device left offline for a
 * day reaches the ceiling in six steps, and the loop cannot overflow into
 * `Infinity` on its way there. `InboxBackoff.delay(afterFailures:)` is the same
 * function, and the Swift comment says the same thing about the same hazard.
 */
export function inboxRetryDelay(backoff: InboxBackoff, failures: number): number {
  if (failures <= 0) return backoff.idle;
  let value = backoff.first;
  for (let i = 1; i < failures; i += 1) {
    value *= 2;
    if (value >= backoff.cap) return backoff.cap;
  }
  return Math.min(value, backoff.cap);
}

/**
 * The account authority, as the host reads it.
 *
 * Three answers, not two. "The store could not be read" is emphatically not
 * "signed out": the enrolment may still be live on the server, and a UI that
 * offered to switch the feature on would be describing a device central already
 * lists. Every caller here branches on all three.
 */
export type InboxAuthority =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ok"; readonly bearer: string; readonly epoch: number };

/** How a destination is opened. Production is the packaged native helper. */
export type InboxDestinationFactory = (request: {
  readonly authorityId: string;
  readonly rootPath: string;
  readonly manifest: readonly NativeManifestEntry[];
}) => Promise<NativeReceiveDestination>;

export interface InboxServiceDeps {
  /** The one origin this feature may reach. The build's, never a payload's. */
  readonly origin: string;
  /**
   * The host's OWN data root. Never a renderer value and never a user path.
   *
   * A function, resolved on FIRST USE rather than at construction. It can fail
   * — an unsupported platform, a missing `%LOCALAPPDATA%` — and a constructor
   * that resolved it eagerly would throw out of `registerHandlers`, taking the
   * whole app down before a window existed. Here the failure lands inside a
   * pass, becomes a published state, and is retried.
   */
  dataRoot(): string;
  readonly platform: string;
  readonly appVersion: string;
  /**
   * The account authority, read FRESH.
   *
   * A function rather than a value because it changes underneath this feature:
   * a sign-out is not something the Inbox is asked about first.
   */
  authority(): Promise<InboxAuthority>;
  /** The current account epoch, read synchronously by the change watcher. */
  accountEpoch(): number;
  /**
   * The document generation currently on screen.
   *
   * Used by exactly ONE thing: the clipboard copy. The scheduler is
   * deliberately document-independent — that is what makes receiving survive a
   * reload — but a copy is not background work. It is a side effect a specific
   * page asked for, visible outside the app, and a page that has been replaced
   * must not still be able to cause it.
   */
  currentDocument(): number;
  /** The encrypted-at-rest store, for the grant and the at-rest key. */
  grantSlot(): Promise<GrantSlot>;
  /** The per-account private key slot the Inbox key store writes into. */
  keySlot(): Promise<{
    get(key: string): Promise<string>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  }>;
  /**
   * The native folder dialog. `null` is a decline, not a failure.
   *
   * The host owns it because the window does. There is no channel in this app
   * that carries a path, which is what makes the renderer unable to answer this
   * question on the user's behalf.
   */
  pickDirectory(): Promise<string | null>;
  /** Pushed whenever the published view changes. */
  onState?(view: InboxView): void;
  /** Diagnostics sink. Never a UI, and never given a path. */
  reportFailure?(err: unknown): void;
  /**
   * Put text on the system clipboard.
   *
   * Injected because `src/main/inbox/**` and this file are unit-tested outside
   * Electron, and because a test asserting a copy must be able to read back
   * what was actually written. Production is Electron's own `clipboard`.
   *
   * The only caller is `copyMessage`, which supplies a message this account has
   * already received. Nothing here takes a caller-supplied string.
   */
  writeClipboard?(text: string): void;
  /**
   * Show a directory to the user.
   *
   * Main performs it and main supplies the path; the renderer names nothing.
   * Production is Electron's `shell.openPath`.
   */
  revealDirectory?(directory: string): Promise<void>;

  // ---- seams; production takes the defaults --------------------------------
  runtime?(): Promise<InboxRuntime>;
  makeDestination?: InboxDestinationFactory;
  resolveDevice?(bearer: string, signal: AbortSignal): Promise<CurrentDevice>;
  /** Whether the chosen folder is still there. Production is a `stat`. */
  directoryUsable?(path: string): Promise<boolean>;
  makeApi?(context: AccountContext, bearer: string): FacadeApi & PresenceApi;
  now?(): number;
  readonly backoff?: InboxBackoff;
}

/** The presence half `InboxFacade` does not use and the host must still send. */
export interface PresenceApi {
  heartbeat(receiveDirReady: boolean, signal: AbortSignal): Promise<unknown>;
}

/** What this feature is holding, for the quit prompt and the risk snapshot. */
export interface InboxInventory {
  /** 1 while a delivery is actually being received, else 0. */
  readonly active: number;
  /** Destinations whose teardown did not conclude. */
  readonly retained: readonly InboxRetainedView[];
}

/** One adopted account, and everything captured with it. */
interface Binding {
  readonly id: number;
  readonly epoch: number;
  readonly accountKey: string;
  /**
   * The account identity every per-account store is opened under.
   *
   * Captured here rather than re-derived, for the reason `bind` states about
   * `accountKey`: the digest the grant, the journal, the vault and the named
   * history live under must be the SAME string the facade's own stores used,
   * and deriving it a second time would be a second implementation of that rule.
   */
  readonly context: AccountContext;
  readonly deviceID: string;
  deviceName: string;
  grant: InboxGrant;
  /** The concrete client, so presence — which the facade never sends — is
   *  reachable under the same captured authority. */
  readonly api: PresenceApi;
  /**
   * Still the live binding.
   *
   * Cleared SYNCHRONOUSLY by the authority watcher, before any teardown is
   * awaited, so nothing can be admitted under an account that has gone away
   * while its abort is still propagating.
   */
  alive: boolean;
  /**
   * The policy this binding last successfully announced, or null.
   *
   * A boolean was not enough. `off` needs no destination, so it is announced
   * before the folder guard — and a stale `true` from an earlier `auto`
   * enrolment would suppress the retry that tells central about the change,
   * leaving it delivering automatically to a device whose user turned it off.
   * Comparing the POLICY makes any change re-announce, and only a matching one
   * counts as done.
   */
  announced: AutoAcceptPolicy | null;
  /** Whether the ACK replay has run since this binding started. */
  reconciled: boolean;
}

/** An operation this feature owns, so a teardown can abort it and join it. */
interface Operation {
  readonly control: AbortController;
  /** Never rejects. Joined by a teardown to know the work has STOPPED. */
  readonly settled: Promise<void>;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // Missing, unreadable, or not a directory. All three mean the grant cannot
    // be honoured, and none of them is something polling harder will fix.
    return false;
  }
}

/** A thrown value as a stable code. Never a message, never a path. */
function codeOf(error: unknown): InboxFailureCode {
  if (error instanceof DeviceLookupError) {
    return error.code === "unauthorized" ? "not-enrolled" : "transport";
  }
  return facadeFailure(error).code;
}

export class InboxService {
  #facade: InboxFacade | null = null;
  /** One presentation store per account digest. See `presentationFor`. */
  readonly #presentations = new Map<string, InboxPresentationStore>();
  #grants: InboxGrantStore | null = null;
  #bound: Binding | null = null;
  #nextBindingID = 1;

  /**
   * The authority `adopt` is about to bind, held for exactly that call.
   *
   * `InboxFacadeOptions.apiFor` is invoked by the facade from inside its own
   * serialised adoption, and it is handed the context but not the credential.
   * The bearer is captured HERE, immediately before the call, and the factory
   * refuses any context that is not the one it was captured for — so there is
   * no path that builds a client for an account whose bearer this process did
   * not read under that same account.
   */
  #binding: { deviceID: string; epoch: number; bearer: string } | null = null;

  /** The loop's lifetime. Aborted only by `quiesce` and `dispose`. */
  #running: AbortController | null = null;
  #loop: Promise<void> | null = null;
  /** Aborts the pass in flight without ending the loop. */
  #pass: AbortController | null = null;
  /** Ends the current nap early: "Try again now", and every teardown. */
  readonly #waiters = new Set<() => void>();
  /** Renderer-driven work in flight. Aborted and joined by every teardown. */
  readonly #operations = new Set<Operation>();
  /** Binding teardowns queued by the authority watcher. Joined by teardowns. */
  #transitions: Promise<void> = Promise.resolve();
  /** Set synchronously when the account moved; cleared by the loop's release. */
  #authorityDirty = false;

  /**
   * Which consent intent is current.
   *
   * ## The interleaving this closes
   *
   * `enable`, `disable` and `chooseFolder` all write the SAME durable record,
   * and `enable` parks in the middle of it — on a native dialog, for as long as
   * a person leaves it open. Tracking those operations so a teardown can join
   * them is not the same as ordering them: a picker suspended for a minute
   * comes back afterwards and writes `enabled: true` over a disable the user
   * made in between, and re-enrols a device they just withdrew.
   *
   * Serialising them instead would be worse: an enable holding the queue across
   * an open dialog means the user cannot turn the feature off until they answer
   * a question about turning it on.
   *
   * So each takes the next number at ADMISSION, synchronously, and re-checks it
   * after every await. A step that resumes against a stale number writes
   * nothing and publishes nothing — and does not force anything either, because
   * a newer intent may legitimately own the state by then. It is the same
   * mechanism `InboxFacade.intent` uses against the same hazard, for the same
   * reason.
   */
  #intent = 0;
  /** Serialises the whole read-modify-write of the durable grant. */
  #grantTail: Promise<unknown> = Promise.resolve();

  /**
   * Not admitting new work. Nothing running is affected.
   *
   * One flag for both reasons, exactly as `StoredReceiveService` has: a quit
   * being DECIDED and a quit being CARRIED OUT both mean "start nothing new",
   * and a quit asks a human a question and then waits for the answer. Cleared
   * only by `resume`.
   */
  #fenced = false;
  /**
   * The user asked this device to stop taking deliveries, for now.
   *
   * ## Three different "stops", and this is the third
   *
   *  * `grant.policy` is the user's STORED answer. Turning it off is a decision
   *    that persists and that central is told about.
   *  * `#fenced` is the quit fence. It belongs to the app's shutdown, not to
   *    the user's intent, and `resume()` clears it when they choose Stay.
   *  * this is neither. It stops new claims WITHOUT writing the policy, without
   *    announcing anything to central, and without touching a delivery already
   *    in flight — the user can pause and unpause all day and their answer,
   *    their enrolment and their folder are exactly as they left them.
   *
   * Sticky within the process: hiding the window, a Stay after a quit prompt
   * and a refresh of the same account all leave it set, because none of them is
   * the user changing their mind. It is deliberately NOT persisted — a restart
   * is a fresh process and starts receiving again, which is the same rule LAN
   * pause follows and the same one `InboxController.reset()` applies on the Mac
   * by clearing `isPaused` with the rest of an account's state.
   */
  #userPaused = false;
  #disposed = false;

  /** The last published view, so an unchanged pass pushes nothing. */
  #view: InboxView = {
    status: { kind: "starting" },
    capabilities: [],
    enabled: false,
    hasDestination: false,
    deviceName: "",
    withdrawalPending: false,
    policy: "off",
    epoch: 0,
    retained: [],
  };
  /**
   * What central last said is waiting.
   *
   * Held with the idempotency key central issued, which never crosses IPC: it
   * is what `accept` compares against the journal's dedup horizon, and a
   * renderer that could supply it could steer that decision.
   */
  #pending: readonly PendingRecord[] = [];
  /** Consecutive failed passes, for the backoff and for the published delay. */
  #failures = 0;
  /**
   * The client and the context the last adoption built.
   *
   * Written by `apiFor`, which the facade calls from inside its own serialised
   * adoption, and read by `bind` immediately afterwards. Cleared before every
   * adoption so a failed one cannot be mistaken for a fresh success.
   */
  #lastApi: (FacadeApi & PresenceApi) | null = null;
  #lastContext: AccountContext | null = null;

  constructor(private readonly deps: InboxServiceDeps) {}

  private get backoff(): InboxBackoff {
    return this.deps.backoff ?? INBOX_BACKOFF;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The view as last published. Read by the page's first request. */
  view(): InboxView {
    return this.#view;
  }

  /** What central was last seen to be holding. Claims nothing. */
  pending(): readonly InboxPendingView[] {
    return this.#pending.map(strip);
  }

  /** Everything this feature is holding, for the quit risk snapshot. */
  inventory(): InboxInventory {
    return {
      active: this.#facade?.state().kind === "receiving" ? 1 : 0,
      retained: this.retained(),
    };
  }

  /** True while a delivery is being received — for the quit risk snapshot. */
  get active(): number {
    return this.inventory().active;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin scheduling. Idempotent.
   *
   * Called once by the wiring, and again by `resume`. It does NOT enable
   * anything: the first pass reads the account and the stored grant, and a
   * grant that says the user has not consented keeps the loop parked at the
   * disabled guard.
   */
  start(): void {
    if (this.#disposed || this.#loop !== null) return;
    const running = new AbortController();
    this.#running = running;
    this.#loop = this.run(running.signal).finally(() => {
      if (this.#running === running) {
        this.#running = null;
        this.#loop = null;
      }
    });
  }

  /** End the current nap or pass and try again now. The "Try again" control. */
  wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  /**
   * Stop admitting new work. Nothing in flight is touched.
   *
   * Synchronous, and the partner of `HandlerControl.fence`: a quit fences every
   * feature in one tick and then asks a human, so the risk the prompt described
   * is still the risk when it is answered.
   */
  fence(): void {
    this.#fenced = true;
  }

  /**
   * Stop admitting, stop the loop, cancel what is running, and join it.
   *
   * Recoverable: the binding is left adopted and the facade is left enabled, so
   * a Stay resumes into a working feature rather than one that has to re-enrol.
   * The aborts all happen before the first await.
   */
  async quiesce(): Promise<InboxInventory> {
    this.fence();
    await this.stop();
    return this.inventory();
  }

  /** The user stayed. Admit work again and start scheduling again. */
  resume(): void {
    if (this.#disposed) return;
    this.#fenced = false;
    this.start();
    this.wake();
  }

  /**
   * Stop claiming new deliveries, at the user's request.
   *
   * Deliberately NOT named `pause`, because `resume` above already means the
   * other thing — the end of a quit fence — and a pair whose halves belong to
   * different mechanisms is how one gets called for the other.
   *
   * Nothing is written and nothing is told to central. A delivery already being
   * received keeps its lease and finishes; this is a refusal to admit more, not
   * a cancellation, and there is no path from here to one.
   */
  pauseReceiving(): void {
    if (this.#disposed || this.#userPaused) return;
    this.#userPaused = true;
    // Published so a surface can say so immediately rather than after the next
    // pass. The status itself is unchanged — see `receivingPaused`.
    this.publish();
  }

  /** Take deliveries again, and go and look now rather than at the next nap. */
  resumeReceiving(): void {
    if (this.#disposed || !this.#userPaused) return;
    this.#userPaused = false;
    this.publish();
    // The loop is parked in `nap` between passes; without this the first
    // delivery after a resume waits out an idle interval for no reason.
    this.wake();
  }

  /**
   * Whether the user has paused receiving.
   *
   * A method rather than a field on the published view: `InboxView` and
   * `InboxStatus` live in the IPC contract, which this change does not own. The
   * fact is truthful and readable here now, and the wiring that surfaces it can
   * add the field without this having guessed at its shape. See the handoff.
   */
  get receivingPaused(): boolean {
    return this.#userPaused;
  }

  /** Terminal. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#fenced = true;
    await this.stop();
    await this.releaseBinding();
  }

  /**
   * Stop the loop and everything it and the page started, then join.
   *
   * Aborted synchronously for every owner FIRST and only then joined. A loop
   * that awaited each teardown in turn would leave later operations running
   * under an authority the first teardown had already retired — the same rule
   * `StoredReceiveService.retire` states, for the same reason.
   */
  private async stop(): Promise<void> {
    this.#running?.abort();
    this.#pass?.abort();
    for (const operation of this.#operations) operation.control.abort();
    this.wake();
    await Promise.allSettled([
      this.#loop ?? Promise.resolve(),
      this.#transitions,
      ...[...this.#operations].map((operation) => operation.settled),
    ]);
  }

  /**
   * The account authority moved. Invalidate now; join afterwards.
   *
   * Called by the host's authority watcher, which also fires when a DOCUMENT is
   * replaced — a reload. That must not stop background receiving, so the epoch
   * is compared rather than trusted: a document change leaves this untouched,
   * which is the resident invariant this whole feature is arranged around.
   *
   * Everything up to and including the abort is synchronous, so no work can be
   * admitted under the outgoing account after this returns. The join is queued
   * on `#transitions`, which every teardown awaits, and the loop performs it at
   * the top of its next iteration — by which time the aborted pass has already
   * returned, because the loop is sequential.
   */
  onAuthorityChanged(): void {
    const epoch = this.deps.accountEpoch();
    const outgoing = this.#bound;
    if (outgoing === null) {
      // Nothing is bound. A sign-in is exactly the moment to look again rather
      // than sit out the remainder of a 30-second nap.
      this.wake();
      return;
    }
    if (outgoing.epoch === epoch) return; // a document changed, not an account
    outgoing.alive = false;
    this.#bound = null;
    this.#authorityDirty = true;
    // The pass, not the loop: the loop must survive to bind the new account.
    this.#pass?.abort();
    for (const operation of this.#operations) operation.control.abort();
    this.wake();
    // The next pass says what is actually true — signed out, or a different
    // account. Until it runs, this is a transition and says so.
    this.publish({ kind: "starting" });
    if (this.#loop === null) {
      // Fenced or disposed, so nobody is going to reach the release below on
      // its own. Queue it here rather than leaving a retired binding adopted.
      this.#transitions = this.#transitions.then(() => this.releaseBinding());
    }
  }

  /**
   * Let go of the outgoing binding, joining everything it owns.
   *
   * `shutdown()` is the facade's own invalidate → abort → JOIN, and it carries
   * retained handles forward rather than dropping them: a teardown that never
   * concluded is a process that may still hold the user's staging bytes, and an
   * account change is not evidence about it.
   */
  private async releaseBinding(): Promise<void> {
    this.#authorityDirty = false;
    const facade = this.#facade;
    this.#bound = null;
    this.#pending = [];
    // The pause belonged to the account that is going. A sign-out or a switch
    // hands the app to someone else, and carrying a decision the new account
    // never made — silently, with no control yet to undo it — would leave them
    // receiving nothing for a reason they cannot see. This is the same clearing
    // `InboxController.reset()` performs on the Mac, in the same place: with
    // the grant, the pending list and the binding, not separately from them.
    this.#userPaused = false;
    if (facade === null) return;
    try {
      await facade.shutdown();
    } catch (err) {
      this.deps.reportFailure?.(err);
    }
    this.publish();
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#disposed) {
      if (this.#authorityDirty) await this.releaseBinding();
      if (signal.aborted) return;
      if (this.#fenced) {
        // A quit is being decided. Nothing new starts, and the loop parks
        // rather than spinning; `resume` wakes it.
        await this.nap(this.backoff.idle, signal);
        continue;
      }
      const control = new AbortController();
      this.#pass = control;
      let wait: number;
      try {
        wait = await this.pass(AbortSignal.any([signal, control.signal]));
        this.#failures = 0;
      } catch (err) {
        if (signal.aborted || this.#disposed) return;
        if (control.signal.aborted) {
          // The pass was retired by an account change, not by a fault. Loop
          // straight back so the new authority is bound without a 5s penalty.
          continue;
        }
        this.#failures += 1;
        wait = inboxRetryDelay(this.backoff, this.#failures);
        // A failed pass invalidates the enrolment assumption too, exactly as
        // the Mac's `prepared = false` does: the next attempt re-announces this
        // device rather than assuming central still holds what the last
        // successful pass established.
        const bound = this.#bound;
        if (bound !== null) {
          bound.announced = null;
          bound.reconciled = false;
        }
        this.publish({ kind: "offline", reason: codeOf(err), retryInSeconds: wait });
        this.deps.reportFailure?.(err);
      } finally {
        if (this.#pass === control) this.#pass = null;
      }
      await this.nap(wait, signal);
    }
  }

  /** One pass. Returns how many seconds to wait before the next one. */
  private async pass(signal: AbortSignal): Promise<number> {
    // ---- 1. account ------------------------------------------------------
    const authority = await this.deps.authority();
    if (signal.aborted) return this.backoff.idle;
    if (authority.kind === "signed-out") {
      if (this.#bound !== null) await this.releaseBinding();
      this.publish({ kind: "needs-account" });
      return this.backoff.idle;
    }
    if (authority.kind === "unavailable") {
      // The encrypted store could not be read. NOT a sign-out, and emphatically
      // not a reason to drop a binding: doing so would let a later readable
      // moment adopt as though this were a first run.
      this.publish({ kind: "account-unreadable" });
      return this.backoff.blocked;
    }

    let bound = this.#bound;
    if (bound === null || !bound.alive || bound.epoch !== authority.epoch) {
      this.publish({ kind: "starting" });
      bound = await this.bind(authority, signal);
      if (bound === null) return this.backoff.idle;
    }

    const facade = this.require();

    // ---- 2. consent ------------------------------------------------------
    if (!bound.grant.enabled) {
      if (bound.grant.withdrawalPending) await this.retryWithdrawal(bound, signal);
      this.publish({ kind: "disabled" });
      return this.backoff.idle;
    }

    // ---- 3. announce the policy, BEFORE the destination guard ------------
    //
    // `off` needs no directory: it asks central to stop sending here, which is
    // meaningful with or without somewhere to put what arrives. Guarding it
    // behind the folder check meant a user who chose Off and whose folder had
    // gone missing could NEVER tell central — so central kept the last policy
    // it was told, which may well be `auto`, and kept delivering automatically
    // to a device whose user had turned it off. That is the worst direction
    // this ordering could fail in.
    //
    // So the announcement comes first for `off`, it is retried on every tick
    // until central confirms it, and it reports neither `folder-missing` nor a
    // ready heartbeat.
    if (bound.grant.policy === "off") {
      // The admission gate, preserved: an enrolment is a network effect a quit
      // has already been decided over, and this branch runs before the work
      // section's own check.
      if (this.admissionClosed()) return this.backoff.idle;
      if (bound.announced !== "off") {
        await facade.enable({ enabled: true, autoAccept: false, policy: "off" }, signal);
        this.assertLive(bound, signal);
        bound.announced = "off";
      }
      this.publish({ kind: "disabled" });
      return this.backoff.idle;
    }

    // ---- 4. destination --------------------------------------------------
    const usable = await (this.deps.directoryUsable ?? directoryExists)(bound.grant.directory);
    if (signal.aborted || !bound.alive) return this.backoff.idle;
    if (!usable) {
      // Receiving is on with nowhere to receive INTO. Never `idle`, and never
      // silently `disabled`: the policy the user set is still their answer, and
      // this names what is missing. Slower than a failure retry, because no
      // amount of polling reattaches a removed drive.
      this.publish({ kind: "folder-missing" });
      return this.backoff.blocked;
    }

    // ---- 5. work ---------------------------------------------------------
    //
    // ## The policy is re-read HERE, after the folder probe
    //
    // The probe above is awaited, and a `setPolicy("off")` can complete inside
    // it — announcing Off to central and leaving `announced === grant.policy`.
    // The continuation would then sail past the enrolment step, send a ready
    // heartbeat and claim, receiving deliveries the user has just told central
    // to stop sending. Checking `bound.alive` and the fence does not catch it:
    // the binding is fine and nothing is fenced; what changed is what the user
    // asked for.
    //
    // A delivery already in flight is untouched — it keeps its own joins — and
    // the next pass takes the Off branch above.
    // ## Off is re-checked before EVERY admission below, not once
    //
    // Checking it after the folder probe alone left every later await open: a
    // `setPolicy("off")` landing during the heartbeat, the reconcile or the
    // pending read still let this pass claim, because by then the earlier check
    // had already passed. Each of those is an await, and each is followed by
    // something that admits new work.
    //
    // Read off the LIVE binding rather than the narrowed local — the compiler
    // cannot see `bound.grant` being replaced across an await, and would call
    // these checks dead code. They are the opposite of dead.
    //
    // A delivery already in flight is untouched: it keeps its own joins, and
    // the next pass takes the Off branch above.
    if (this.receivingStopped()) return this.backoff.idle;
    // ## The fence is re-checked before every step that STARTS something
    //
    // Checking it once at the top of the loop is not enough, and the gap it
    // leaves is the one a quit cares about. A pass that was already past that
    // check can sit in `heartbeat` or in the folder probe for as long as the
    // network takes; a quit fences during that window, asks the user what is at
    // stake, and the pass then wakes up and goes on to claim and DOWNLOAD a
    // delivery the prompt said nothing about.
    //
    // So the fence is asserted immediately before each admission below, with no
    // await between the check and the call. `facade.drain` reserves its slot
    // synchronously before its own first await, so once it is entered the risk
    // snapshot already reports `receiving` — there is no window in which a
    // delivery is starting and `inventory()` says zero.
    //
    // Nothing already running is stopped by this. A fence is a refusal to
    // admit, not a cancellation: a delivery mid-flight keeps going, is counted
    // in the risk the user is being asked about, and survives a Stay.
    if (this.admissionClosed()) return this.backoff.idle;
    if (bound.announced !== bound.grant.policy) {
      // The stored policy, not a default: a restart must re-announce what the
      // user chose rather than quietly demoting them to `ask`. Captured before
      // the await so what is recorded as announced is what was actually sent.
      const announcing = bound.grant.policy;
      await facade.enable(
        { enabled: true, autoAccept: announcing === "auto", policy: announcing },
        signal,
      );
      this.assertLive(bound, signal);
      bound.announced = announcing;
    }
    // Presence, carrying the folder verdict this pass just measured. The facade
    // never sends this — it is not part of receiving a delivery — so the host
    // holds the concrete client for exactly this call.
    if (this.admissionClosed()) return this.backoff.idle;
    await bound.api.heartbeat(true, signal);
    this.assertLive(bound, signal);

    let worked = false;
    if (this.admissionClosed()) return this.backoff.idle;
    // After the heartbeat. This is the one root's probe caught.
    if (this.receivingStopped()) return this.backoff.idle;
    if (!bound.reconciled) {
      // Replays acknowledgements a crash left unsent, and drains whatever is
      // leasable while it is there. Once per binding, and again after any
      // failed pass, which is when a lost ACK is most likely to exist.
      const outcomes = await facade.reconcile(signal);
      this.assertLive(bound, signal);
      bound.reconciled = true;
      worked = outcomes.length > 0;
    } else {
      const report = await facade.drain(signal);
      this.assertLive(bound, signal);
      worked = report.processed.length > 0;
    }

    if (this.admissionClosed()) return this.backoff.idle;
    // After the reconcile or the drain, before asking central for more.
    if (this.receivingStopped()) return this.backoff.idle;
    const pending = await facade.listPending(MAX_INBOX_PENDING, signal);
    this.assertLive(bound, signal);
    this.#pending = pending.tasks.map(recordOfTask);

    this.publish();
    return worked ? this.backoff.afterWork : this.backoff.idle;
  }

  /**
   * Bind one account: resolve its device row, adopt it, and read its grant.
   *
   * The device id is central's, read under the bearer, and it is what every
   * Inbox endpoint is addressed by. It is also what scopes this account's local
   * state — see the note on `accountID` below.
   */
  private async bind(
    authority: { readonly bearer: string; readonly epoch: number },
    signal: AbortSignal,
  ): Promise<Binding | null> {
    if (this.#bound !== null) await this.releaseBinding();
    const facade = await this.ensureFacade();
    if (signal.aborted) return null;

    const device = await (this.deps.resolveDevice
      ? this.deps.resolveDevice(authority.bearer, signal)
      : resolveCurrentDevice({ origin: this.deps.origin, bearer: authority.bearer, signal }));
    if (signal.aborted || authority.epoch !== this.deps.accountEpoch()) return null;

    // Held for exactly the adoption below, and read by `apiFor`.
    this.#binding = { deviceID: device.id, epoch: authority.epoch, bearer: authority.bearer };
    this.#lastApi = null;
    this.#lastContext = null;
    try {
      await facade.adopt({
        // ## Why the DEVICE row id is the account identity here
        //
        // `captureAccount` digests this into the directory name and the secret
        // slot for the account's journal, vault and private keys, so it has to
        // be stable across restarts and distinct between accounts. The obvious
        // candidate — the account email — is neither: `AppService` holds it in
        // memory only, so a restart with a valid bearer reports it as empty,
        // and every account on the machine would then share one digest and one
        // directory.
        //
        // Central's device row is both. It is issued per (account, install), it
        // is the value every Inbox endpoint is already addressed by, and it is
        // the identity the private key history belongs to — the key IS this
        // device's key. Signing in as somebody else returns a different row
        // from a different account's list, so the two never collide.
        accountID: device.id,
        deviceID: device.id,
        epoch: authority.epoch,
      });
    } finally {
      this.#binding = null;
    }
    if (signal.aborted || authority.epoch !== this.deps.accountEpoch()) {
      await this.releaseBinding();
      return null;
    }

    // `apiFor` recorded both while the adoption ran. Read back rather than
    // re-derived: the account digest the grant and the at-rest key are stored
    // under must be the SAME string the facade's own stores used, and deriving
    // it a second time here would be a second implementation of that rule.
    const adopted = this.adopted();
    if (adopted === null) {
      throw Object.assign(new Error("inbox: adoption built no client"), { code: "internal" });
    }
    const { api, context } = adopted;

    const grants = await this.ensureGrants();
    const grant: InboxGrant = (await grants.read(context.accountKey)) ?? {
      directory: "",
      enabled: false,
      policy: "off",
      withdrawalPending: false,
    };
    if (signal.aborted || authority.epoch !== this.deps.accountEpoch()) {
      await this.releaseBinding();
      return null;
    }

    const bound: Binding = {
      id: this.#nextBindingID++,
      epoch: authority.epoch,
      accountKey: context.accountKey,
      context,
      deviceID: device.id,
      deviceName: device.name,
      grant,
      api,
      alive: true,
      announced: null,
      reconciled: false,
    };
    this.#bound = bound;
    return bound;
  }

  /**
   * Retry a withdrawal central never confirmed.
   *
   * Best-effort and kept pending on failure, exactly as the Mac's
   * `stopAnnouncementPending` is: the local answer is already off either way,
   * so an unreachable central is not a reason to spin or to fail the pass.
   */
  private async retryWithdrawal(bound: Binding, signal: AbortSignal): Promise<void> {
    try {
      const report = await this.require().disable(signal);
      if (!bound.alive || signal.aborted) return;
      if (report.withdrawn.kind === "withdrawn") {
        // The same narrow merge the interactive path uses, and for the same
        // reason: this pass may have been waiting on the network while the user
        // chose a new folder or turned receiving back on, and it owns one
        // boolean rather than the whole record.
        await this.mutateGrant(bound, (current) => ({ ...current, withdrawalPending: false }));
      }
    } catch (err) {
      // Not rethrown: a failed withdrawal must not put the loop into failure
      // backoff, because there is nothing else this pass wanted to do.
      this.deps.reportFailure?.(err);
    }
  }

  /**
   * Whether this process is refusing to START anything right now.
   *
   * One question for both reasons, because the answer is the same: a quit being
   * decided and a process going away both mean "admit nothing new". Read
   * immediately before an admission with no await in between; a value read
   * earlier in the same pass is a value that may already be stale.
   */
  private admissionClosed(): boolean {
    return this.#fenced || this.#disposed;
  }

  /**
   * Whether the user has told central to stop sending here.
   *
   * Read off the LIVE binding every time, with no caching: the whole point is
   * that it can change between two awaits in one pass. Publishing `disabled`
   * here rather than at the caller keeps the answer and the state together.
   */
  private receivingStopped(): boolean {
    const policy: AutoAcceptPolicy = this.#bound?.grant.policy ?? "off";
    if (policy !== "off") return false;
    this.publish({ kind: "disabled" });
    return true;
  }

  /** Throws unless `bound` is still live and this operation still wanted. */
  private assertLive(bound: Binding, signal: AbortSignal): void {
    if (!bound.alive || this.#bound !== bound) {
      throw Object.assign(new Error("inbox: account changed"), { code: "account-changed" });
    }
    if (signal.aborted) {
      throw Object.assign(new Error("inbox: cancelled"), { code: "cancelled" });
    }
  }

  /**
   * Wait, or stop waiting early.
   *
   * `unref` so a parked scheduler never keeps the process alive on its own;
   * the app's lifetime is the window's and the tray's, not this timer's.
   */
  private nap(seconds: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted || seconds <= 0) {
        resolve();
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, seconds * 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.#waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------

  /**
   * What the adoption just built, if it built anything.
   *
   * Read through a method rather than inline, because `bind` clears both fields
   * immediately before the awaited adoption that fills them in — and the
   * compiler carries that `null` narrowing across the await, so an inline read
   * types as `never` no matter how it is annotated. Here there is no assignment
   * to narrow from.
   */
  private adopted(): { api: FacadeApi & PresenceApi; context: AccountContext } | null {
    const api = this.#lastApi;
    const context = this.#lastContext;
    return api === null || context === null ? null : { api, context };
  }

  /**
   * Change the durable grant, as a read-modify-write nobody can interleave.
   *
   * ## Why a merge, and why a serialised one
   *
   * Every consent path writes the SAME record, and each of them owns different
   * fields of it: `enable` owns all three, `chooseFolder` owns the destination,
   * `disable` owns consent, and a withdrawal acknowledgement owns exactly one
   * boolean. A caller that wrote a snapshot it took before its own network call
   * silently reverts whatever the others did in between — which is how a
   * withdrawal that central finally confirmed could overwrite a folder the user
   * had just chosen, and how a folder change could carry a stale `enabled:
   * true` back over a disable.
   *
   * `SecretStore` serialises each read and each write for a key, but not a read
   * and a write TOGETHER: two concurrent read-modify-writes can both read the
   * old record and the second write wins outright. So the whole cycle runs on
   * one chain here.
   *
   * The chain is never held across anything slow. The folder dialog and the
   * network calls happen OUTSIDE it, precisely so a person leaving a dialog
   * open cannot block a disable.
   *
   * `mutate` therefore receives what is durably true right now and returns the
   * whole record; `myIntent`, when given, is re-checked inside the chain so a
   * consent decision the user has since replaced writes nothing at all.
   */
  private mutateGrant(
    bound: Binding,
    mutate: (current: InboxGrant) => InboxGrant,
    myIntent?: number,
  ): Promise<InboxGrant | null> {
    const run = this.#grantTail.then(async () => {
      const grants = await this.ensureGrants();
      if (myIntent !== undefined && this.superseded(bound, myIntent)) return null;
      if (!bound.alive || this.#bound !== bound) return null;
      const current = (await grants.read(bound.accountKey)) ?? bound.grant;
      if (myIntent !== undefined && this.superseded(bound, myIntent)) return null;
      const next = mutate(current);
      await grants.write(bound.accountKey, next);
      if (!bound.alive || this.#bound !== bound) return null;
      bound.grant = next;
      return next;
    });
    this.#grantTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureGrants(): Promise<InboxGrantStore> {
    this.#grants ??= new InboxGrantStore(await this.deps.grantSlot());
    return this.#grants;
  }

  private require(): InboxFacade {
    const facade = this.#facade;
    if (facade === null) {
      throw Object.assign(new Error("inbox: runtime unavailable"), { code: "internal" });
    }
    return facade;
  }

  private async ensureFacade(): Promise<InboxFacade> {
    if (this.#facade !== null) return this.#facade;
    const runtime = await (this.deps.runtime ?? inboxRuntime)();
    // Built once and reused: the facade owns adoption, and building a second
    // one per account would give two objects ownership of one set of retained
    // handles.
    this.#facade ??= new InboxFacade({
      host: {
        dataRoot: this.deps.dataRoot(),
        platform: this.deps.platform,
        appVersion: this.deps.appVersion,
      },
      runtime,
      features: COMPOSED_FEATURES,
      apiFor: (context) => this.apiFor(context),
      secretsFor: () => this.keySlotProxy(),
      atRestKeyFor: (context) => this.atRestKeyFor(context),
      destinationFor: (manifest, context) => this.destinationFor(manifest, context),
      onDelivered: (delivered, context) => this.captureDelivered(delivered, context),
      // Asked between items of a drain, not once before it. Only the user pause
      // is here: the fence and the policy have their own checks on the pass,
      // and folding them in would make one answer cover three questions.
      mayClaim: () => !this.#userPaused,
      now: () => this.now(),
    });
    return this.#facade;
  }

  /**
   * Build the account's client, under the authority captured for it.
   *
   * Refuses a context that is not the one `bind` captured a bearer for. Without
   * that check this is a factory that would attach whatever credential happened
   * to be held to whatever account it was asked about.
   */
  private apiFor(context: AccountContext): FacadeApi & PresenceApi {
    const held = this.#binding;
    if (held === null || held.epoch !== context.epoch || held.deviceID !== context.deviceID) {
      throw Object.assign(new Error("inbox: no captured authority for this account"), {
        code: "account-changed",
      });
    }
    const api =
      this.deps.makeApi?.(context, held.bearer) ??
      new InboxApi({
        context: {
          origin: this.deps.origin,
          deviceID: context.deviceID,
          bearer: held.bearer,
          epoch: context.epoch,
        },
      });
    this.#lastApi = api;
    this.#lastContext = context;
    return api;
  }

  /**
   * The private-key slot, narrowed to the names the key store actually uses.
   *
   * The store this comes from also holds the bearer and the installation
   * identity. Handing the whole object over would make those reachable from a
   * module that has no business with them, so the proxy refuses every key that
   * is not the Inbox key slot — `keys.ts` derives that name from the account
   * digest and uses no other.
   */
  private keySlotProxy(): { get(k: string): Promise<string>; put(k: string, v: string): Promise<void>; delete(k: string): Promise<void> } {
    const allowed = (key: string): boolean => key.startsWith("inbox-keys-");
    const refuse = (): never => {
      throw Object.assign(new Error("inbox: key slot refused"), { code: "internal" });
    };
    const slot = this.deps.keySlot();
    return {
      async get(key) {
        if (!allowed(key)) refuse();
        return (await slot).get(key);
      },
      async put(key, value) {
        if (!allowed(key)) refuse();
        return (await slot).put(key, value);
      },
      async delete(key) {
        if (!allowed(key)) refuse();
        return (await slot).delete(key);
      },
    };
  }

  private async atRestKeyFor(context: AccountContext): Promise<Uint8Array> {
    return (await this.ensureGrants()).atRestKey(context.accountKey);
  }

  /**
   * The seam a sibling Inbox feature composes against.
   *
   * ## Why this exists rather than three public getters
   *
   * SEND needs three things this feature already resolves: the bound account
   * identity, that account's at-rest key, and the protocol runtime. Re-deriving
   * any of them elsewhere would be a second implementation of a rule this file
   * documents at length — the account DIGEST in particular, which names the
   * directory and the AEAD associated data every per-account store uses. A send
   * plan written under a second derivation of it would be a plan the account's
   * own key cannot open.
   *
   * Returned as one object so the seam is a single reviewable surface rather
   * than three members that drift apart, and so it reads as what it is: the
   * composition point, not an invitation to reach into this feature.
   */
  composition(): {
    identity(): { readonly context: AccountContext; readonly deviceID: string; readonly epoch: number } | null;
    atRestKeyFor(context: AccountContext): Promise<Uint8Array>;
    runtime(): Promise<InboxRuntime>;
  } {
    return {
      identity: () => {
        const bound = this.#bound;
        // Only while the binding is ALIVE. A retired one names an account this
        // process is no longer entitled to act for.
        if (bound === null || !bound.alive) return null;
        return { context: bound.context, deviceID: bound.deviceID, epoch: bound.epoch };
      },
      atRestKeyFor: (context) => this.atRestKeyFor(context),
      runtime: () => (this.deps.runtime ?? inboxRuntime)(),
    };
  }

  // -------------------------------------------------------------------------
  // The named history: what arrived, by name
  // -------------------------------------------------------------------------

  /**
   * One presentation store per account, memoised.
   *
   * Keyed by the account digest, because that is what the store's directory and
   * its AEAD associated data are keyed by: two contexts with the same digest
   * ARE the same account's store, and giving them separate instances would give
   * one file two caches that could disagree about what is in it.
   *
   * Bounded, and the bound is safe to enforce by eviction — unlike a record,
   * an instance holds no state of its own that is not on disk. Evicting one
   * drops a cache and nothing else.
   */
  private presentationFor(context: AccountContext): InboxPresentationStore {
    const held = this.#presentations.get(context.accountKey);
    if (held !== undefined) return held;
    const store = new InboxPresentationStore(context, new InboxFiles(context), async () =>
      importAtRestKey(await this.atRestKeyFor(context)),
    );
    this.#presentations.set(context.accountKey, store);
    while (this.#presentations.size > MAX_CACHED_PRESENTATION_STORES) {
      const oldest = this.#presentations.keys().next().value;
      if (oldest === undefined) break;
      this.#presentations.delete(oldest);
    }
    return store;
  }

  /**
   * Record what one delivery saved, by name.
   *
   * Called by the receiver after the publish is durable, under the account the
   * delivery RAN under — which the facade captured and handed through, so a
   * sign-out during a long download cannot land this account's file names in
   * the next account's history. That is the whole reason the context is a
   * parameter here rather than something this method looks up.
   *
   * Never throws. The files are on disk by the time this runs, so a failure
   * here costs the NAMES for one delivery and nothing else: the journal still
   * has the delivery, the history still lists it, and the row says its names
   * were not recorded rather than presenting it as an empty success.
   */
  private async captureDelivered(delivered: DeliveredItems, context: AccountContext): Promise<void> {
    // ## The write is OWNED, and the wait on it is bounded
    //
    // Two separate properties, and the delivery needs both.
    //
    // Owned: `own()` registers this in the same operation set every other
    // renderer-driven call uses, so `quiesce` and `dispose` abort and JOIN it.
    // A metadata write left running past a teardown would be a write into a
    // store whose account has gone away, and nothing would be waiting for it.
    //
    // Bounded: the receiver awaits this hook, and at that point the files are
    // on disk and the ACK has NOT been sent. A store that never settled would
    // hold a committed delivery unacknowledged and central would redeliver a
    // task that had already landed — so the delivery stops waiting on the
    // deadline below while the write itself stays registered and joinable. The
    // caller is told nothing either way: a name that has not been written yet
    // is a history that is briefly incomplete, which the page renders as such.
    const write = this.own(async () => {
      await this.presentationFor(context).record({
        taskID: delivered.taskID,
        receivedAt: this.now(),
        text: delivered.text,
        declared: delivered.declared,
        items: delivered.items,
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CAPTURE_DEADLINE_MS);
    });
    try {
      await Promise.race([write, deadline]);
    } catch (err) {
      // Reported to the host's diagnostics sink, which is where a capture
      // failure belongs — never to the receipt, and never as a delivery
      // failure. `PresentationError` carries a closed code and a reason that
      // names a FIELD; a name never reaches it.
      this.deps.reportFailure?.(
        err instanceof PresentationError ? Object.assign(new Error(`presentation: ${err.code}`), { code: err.code }) : err,
      );
    } finally {
      clearTimeout(timer);
      // The registered write may still be running. Its rejection is observed
      // HERE rather than left unhandled — an unhandled rejection is fatal in
      // this process — and it is reported once, not twice.
      void write.catch(() => undefined);
    }
  }

  /**
   * What arrived, by name.
   *
   * Returned BESIDE `receipts()` rather than merged into it. The journal is the
   * authoritative list of deliveries — it is written before anything
   * irreversible and it survives a capture that failed — and this is the
   * presentation metadata for the ones that have it. A page joins them by task
   * id, so a delivery with no record is rendered as a delivery whose names were
   * not recorded rather than being dropped or shown as empty.
   *
   * `null` means the record could not be READ, which is not the same as having
   * received nothing and is rendered differently.
   */
  history(): Promise<readonly InboxNamedDeliveryView[] | null> {
    if (this.#disposed) return Promise.resolve(null);
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve([]);
    return this.own(async () => {
      try {
        const records = await this.presentationFor(bound.context).list();
        // The account that was live when this was issued must still be the one
        // live now, or these are the previous account's file names.
        if (!bound.alive || this.#bound !== bound) return null;
        return records.map((record) => ({
          taskID: record.taskID,
          receivedAt: record.receivedAt,
          text: record.text,
          declared: record.declared,
          items: record.items.map((item) => ({ name: item.name, size: item.size })),
        }));
      } catch (err) {
        this.deps.reportFailure?.(err);
        return null;
      }
    });
  }

  /**
   * Forget one delivery's names, because the user asked for that.
   *
   * The ONLY caller. Nothing else deletes from this store: not disabling, not
   * signing out, not an account change — the same rule the message vault
   * follows, and for the same reason. A history that quietly disappeared when
   * the feature was turned off would be a product that destroys the user's
   * record of what they received as a side effect of a settings toggle.
   */
  forgetDelivery(taskID: string): Promise<InboxSimpleOutcome> {
    if (this.#disposed || this.#fenced) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "failed", reason: "account-changed" });
    return this.own(async () => {
      try {
        await this.presentationFor(bound.context).remove(taskID);
        if (!bound.alive || this.#bound !== bound) return { kind: "refused" } as const;
        return { kind: "ok" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { kind: "failed", reason: "storage-unreadable" } as const;
      }
    });
  }

  /**
   * Open the folder the user chose, for one file delivery.
   *
   * Reached only for a FILE delivery: a message never touches the helper. The
   * grant is re-read from the live binding rather than captured at enable time,
   * so a folder that was changed since is the one written into — and a binding
   * that has gone away refuses rather than writing under a retired account.
   *
   * The manifest handed on is the one the receiver already decoded and
   * validated. The helper validates it again, which is the point of it being
   * the only thing in this app that writes files.
   */
  private async destinationFor(
    manifest: RuntimeManifest,
    context: AccountContext,
  ): Promise<ReceiveDestination> {
    const bound = this.#bound;
    if (bound === null || !bound.alive || bound.accountKey !== context.accountKey) {
      throw Object.assign(new Error("inbox: account changed"), { code: "account-changed" });
    }
    if (bound.grant.directory.length === 0) {
      throw Object.assign(new Error("inbox: no destination"), { code: "storage-unreadable" });
    }
    const entries: NativeManifestEntry[] = manifest.items
      .filter((item) => item.kind === "file")
      .map((item) => ({ name: item.name ?? "", size: item.size }));
    const open = this.deps.makeDestination ?? ((request) => NativeHelperClient.open(request));
    return open({
      // The binding's own identity, so a handle driven under another account's
      // delivery is caught by the destination rather than writing into it.
      authorityId: `inbox-${String(bound.id)}-${bound.accountKey}`,
      rootPath: bound.grant.directory,
      manifest: entries,
    });
  }

  // -------------------------------------------------------------------------
  // What the page asks for
  // -------------------------------------------------------------------------

  /**
   * Run one renderer-driven operation, owned so a teardown can stop it.
   *
   * The fence is checked SYNCHRONOUSLY, before the first await and before any
   * consent is asked for: an operation admitted while a quit prompt is on
   * screen is one the quit never mentioned. Registration is synchronous too, so
   * an abort that arrives during the awaited body finds it.
   */
  private own<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const control = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const operation: Operation = { control, settled };
    this.#operations.add(operation);
    return body(control.signal).finally(() => {
      this.#operations.delete(operation);
      markSettled();
    });
  }

  /** The live binding, or the reason there is not one. */
  private live(): Binding | "needs-account" {
    const bound = this.#bound;
    return bound !== null && bound.alive ? bound : "needs-account";
  }

  /**
   * Turn receiving on.
   *
   * The order is the product's consent model: ask for the folder, verify it,
   * record the grant, and only then enrol. A declined dialog writes nothing and
   * enrols nothing, so there is no state in which this device is advertised as
   * a target with no destination behind it.
   */
  enable(policy: AutoAcceptPolicy = "ask"): Promise<InboxEnableOutcome> {
    if (this.admissionClosed()) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "needs-account" });
    // Taken at admission, before the dialog and before the first await.
    const myIntent = ++this.#intent;
    return this.own(async (signal) => {
      try {
        const chosen = await this.choose(signal);
        if (chosen === null) return { kind: "declined" } as const;
        // A dialog answered after the user changed their mind writes NOTHING.
        // The intent is re-checked inside the serialised write, so a disable
        // that lands while this one is queued still wins.
        const grant = await this.mutateGrant(
          bound,
          // Consent, destination and the withdrawal marker are all determined
          // by this act, so nothing is carried over from the old record.
          () => ({ directory: chosen, enabled: true, policy, withdrawalPending: false }),
          myIntent,
        );
        if (grant === null) return { kind: "superseded" } as const;
        bound.announced = null;
        // Published as soon as the CONSENT is durable, before the enrolment is
        // attempted. The user's answer is recorded at this point and a restart
        // would honour it; showing "off" until a network call returns would
        // describe the network rather than what they asked for, and an
        // enrolment that fails is a `starting`/`offline` state rather than a
        // silent reversal of the switch they just pressed.
        this.publish();
        await this.require().enable(
          { enabled: true, autoAccept: policy === "auto", policy },
          signal,
        );
        if (this.superseded(bound, myIntent)) return { kind: "superseded" } as const;
        bound.announced = policy;
        this.publish();
        this.wake();
        return { kind: "enabled" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        // The consent stands even though the enrolment did not land: the user's
        // answer is theirs, and the scheduler retries. What is published is the
        // truth about the attempt, not a rollback of what they asked for.
        this.publish();
        this.wake();
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /**
   * Whether a newer intent, or a different account, owns the state now.
   *
   * Both, in one call, because a step resuming after an await has to ask both
   * and answering only one of them is how each of these bugs happened once.
   */
  private superseded(bound: Binding, myIntent: number): boolean {
    return this.#intent !== myIntent || !bound.alive || this.#bound !== bound;
  }

  /**
   * Ask for a folder without waiting for a human indefinitely.
   *
   * The dialog is raced against this operation's abort, exactly as the stored
   * receive path does: a quit or an account change must not hang on a dialog
   * nobody has answered. The dialog's own promise is retained only so its
   * rejection is handled — a folder chosen after the abort opens nothing.
   */
  private async choose(signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return null;
    const picked = this.deps.pickDirectory();
    picked.catch(() => undefined);
    const abandoned = new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const chosen = await Promise.race([picked, abandoned]);
    if (signal.aborted || chosen === null || chosen.length === 0) return null;
    // A folder that is not there is not a destination. Refused BEFORE the grant
    // is written, so a failure preparing it cannot enrol a fictitious receiver.
    const usable = await (this.deps.directoryUsable ?? directoryExists)(chosen);
    return usable && !signal.aborted ? chosen : null;
  }

  /**
   * Change the policy without re-asking for a folder.
   *
   * `off` needs no destination — it asks central to stop sending here, which is
   * meaningful with or without a folder. `ask` and `auto` do, so a caller with
   * no destination recorded is sent through `enable`, which opens the dialog.
   *
   * Switching AWAY from `auto` stops future admission — the next pass enrols
   * with the new policy and central stops delivering unattended — and does not
   * touch a delivery already in flight. A policy change is not a teardown: the
   * user asked about what happens NEXT, and cancelling what they are already
   * receiving would lose it.
   */
  setPolicy(policy: AutoAcceptPolicy): Promise<InboxEnableOutcome> {
    if (this.admissionClosed()) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "needs-account" });
    if (policy !== "off" && bound.grant.directory.length === 0) return this.enable(policy);
    const myIntent = ++this.#intent;
    return this.own(async (signal) => {
      try {
        const grant = await this.mutateGrant(
          bound,
          (current) => ({
            ...current,
            // `off` keeps the enrolment and keeps the folder: it is a policy,
            // not a withdrawal, and the user has not asked to forget anything.
            enabled: true,
            policy,
            withdrawalPending: current.withdrawalPending,
          }),
          myIntent,
        );
        if (grant === null) return { kind: "superseded" } as const;
        // Re-announced now rather than on the next tick, so the change the user
        // just made is the one central is acting on.
        bound.announced = null;
        this.publish();
        await this.require().enable(
          { enabled: true, autoAccept: policy === "auto", policy },
          signal,
        );
        if (this.superseded(bound, myIntent)) return { kind: "superseded" } as const;
        bound.announced = policy;
        this.publish();
        this.wake();
        return { kind: "enabled" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        // The choice stands and the scheduler retries; what is published is the
        // truth about the attempt, not a rollback of what they asked for.
        this.publish();
        this.wake();
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /**
   * Show the user their receiving folder.
   *
   * MAIN owns the path and main performs the action: the renderer asks, and
   * there is no argument on this call that could name a directory. Refused when
   * nothing is recorded, when a quit is being decided, and when the account or
   * the document that asked has gone away.
   */
  revealFolder(document: number): Promise<InboxSimpleOutcome> {
    if (this.admissionClosed()) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "failed", reason: "account-changed" });
    const reveal = this.deps.revealDirectory;
    if (reveal === undefined) return Promise.resolve({ kind: "failed", reason: "internal" });
    const directory = bound.grant.directory;
    if (directory.length === 0) return Promise.resolve({ kind: "failed", reason: "storage-unreadable" });
    return this.own(async () => {
      try {
        const usable = await (this.deps.directoryUsable ?? directoryExists)(directory);
        if (!bound.alive || this.#bound !== bound) {
          return { kind: "failed", reason: "account-changed" } as const;
        }
        if ((this.deps.currentDocument?.() ?? document) !== document) {
          return { kind: "failed", reason: "cancelled" } as const;
        }
        if (this.admissionClosed()) return { kind: "refused" } as const;
        // Refused rather than opening whatever is at a stale path.
        if (!usable) return { kind: "failed", reason: "storage-unreadable" } as const;
        await reveal(directory);
        return { kind: "ok" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /**
   * What this account has received. Counts and outcomes; never a name.
   *
   * The journal carries no filenames or paths by design, and this exposes it
   * unchanged. `null` means the record could not be READ, which is not the same
   * as having received nothing.
   */
  receipts(): Promise<readonly InboxReceiptView[] | null> {
    if (this.#disposed) return Promise.resolve(null);
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve([]);
    return this.own(async () => {
      try {
        const records = await this.require().receipts();
        if (!bound.alive || this.#bound !== bound) return null;
        return records.map((record) => ({
          taskID: record.taskID,
          phase: record.phase,
          total: record.manifestTotal,
          published: record.publishedCount,
          text: record.text,
          updatedAt: record.updatedAt,
          serverTerminal: record.serverTerminal,
        }));
      } catch (err) {
        this.deps.reportFailure?.(err);
        return null;
      }
    });
  }

  /** Choose a different destination. Consent is unchanged either way. */
  chooseFolder(): Promise<InboxSimpleOutcome> {
    if (this.#disposed || this.#fenced) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "failed", reason: "account-changed" });
    const myIntent = ++this.#intent;
    return this.own(async (signal) => {
      try {
        const chosen = await this.choose(signal);
        if (chosen === null) return { kind: "refused" } as const;
        // ONLY the destination. Merged against what is durably true rather than
        // against the snapshot this operation opened with, which may be a
        // minute old and may still say `enabled: true` after a disable.
        const grant = await this.mutateGrant(
          bound,
          (current) => ({ ...current, directory: chosen }),
          myIntent,
        );
        if (grant === null) return { kind: "superseded" } as const;
        this.publish();
        this.wake();
        return { kind: "ok" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /**
   * Turn receiving off.
   *
   * The local stop is durable FIRST — grant written with the withdrawal marked
   * pending — and only then is central told. A crash in between leaves a record
   * that says exactly what is true: this device is not receiving, and central
   * may still think it is. Nothing local is erased: not the vault, not the key
   * history, not the journal.
   */
  disable(): Promise<InboxDisableOutcome> {
    if (this.admissionClosed()) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "needs-account" });
    // Bumped at admission, which is what SUPERSEDES a picker still on screen:
    // an enable that resumes after this writes nothing and re-enrols nothing.
    const myIntent = ++this.#intent;
    return this.own(async (signal) => {
      try {
        // ONLY consent and the withdrawal marker. The destination is left
        // exactly as it is: turning receiving off is not "forget where my files
        // go", and turning it back on should not have to ask again.
        const stopped = await this.mutateGrant(
          bound,
          (current) => ({ ...current, enabled: false, policy: "off", withdrawalPending: true }),
          myIntent,
        );
        if (stopped === null) return { kind: "refused" } as const;
        bound.announced = null;
        this.publish();

        const report = await this.require().disable(signal);
        if (!bound.alive) return { kind: "failed", reason: "account-changed" } as const;
        if (report.withdrawn.kind === "withdrawn") {
          // ## The acknowledgement owns ONE boolean and nothing else
          //
          // Written as a fresh merge rather than as `{...stopped, ...}`. The
          // network call above takes as long as it takes, and a `chooseFolder`
          // that persisted a new destination while it was in flight would be
          // reverted by a record snapshotted before it — a folder the user
          // chose, silently replaced by an acknowledgement about something
          // else.
          //
          // Not gated on the intent either, and deliberately: this reports what
          // CENTRAL did, not what the user last asked for. If a newer enable
          // owns the state the facade reports `superseded` and this branch is
          // never reached; if it does not, clearing the marker is true whatever
          // else has changed.
          await this.mutateGrant(bound, (current) => ({ ...current, withdrawalPending: false }));
          this.publish();
          return { kind: "disabled" } as const;
        }
        if (report.withdrawn.kind === "superseded") {
          // A later enable owns the state. Reporting "disabled" would be false.
          this.publish();
          return { kind: "failed", reason: "internal" } as const;
        }
        this.publish();
        return { kind: "still-enrolled", reason: report.withdrawn.failure.code } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        this.publish();
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /** What central says is waiting, read now rather than from the last pass. */
  refreshPending(): Promise<readonly InboxPendingView[]> {
    if (this.#disposed || this.#fenced) return Promise.resolve(this.pending());
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve([]);
    return this.own(async (signal) => {
      try {
        const result = await this.require().listPending(MAX_INBOX_PENDING, signal);
        if (!bound.alive) return this.pending();
        this.#pending = result.tasks.map(recordOfTask);
        this.publish();
        return this.pending();
      } catch (err) {
        this.deps.reportFailure?.(err);
        return this.pending();
      }
    });
  }

  /** Accept one held delivery and receive it. */
  accept(taskID: string): Promise<InboxAcceptOutcome> {
    if (this.#disposed || this.#fenced) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "not-enabled" });
    // Read from what central last told us, never from the caller: the dedup
    // horizon compares against the idempotency key and creation time central
    // issued, and a renderer-supplied pair would let a page steer that decision.
    const known = this.#pending.find((task) => task.taskID === taskID);
    if (known === undefined) return Promise.resolve({ kind: "already-settled" });
    return this.own(async (signal) => {
      try {
        const outcome = await this.require().accept(
          { taskID, idempotencyKey: known.idempotencyKey, createdAt: known.createdAt },
          signal,
        );
        if (!bound.alive) return { kind: "failed", reason: "account-changed" } as const;
        this.publish();
        this.wake();
        if (outcome.kind === "received") return { kind: "received", receipt: outcome.receipt } as const;
        if (outcome.kind === "queued") return { kind: "queued" } as const;
        if (outcome.kind === "blocked") return { kind: "blocked", reason: outcome.reason } as const;
        if (outcome.kind === "already-settled") return { kind: "already-settled" } as const;
        if (outcome.kind === "busy") return { kind: "busy" } as const;
        return { kind: "not-enabled" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /** Decline one held delivery. */
  reject(taskID: string): Promise<InboxSimpleOutcome> {
    return this.simple(async (signal) => {
      await this.require().reject(taskID, signal);
      await this.refreshPendingQuietly(signal);
    });
  }

  /** Messages already saved. Metadata only; no message bytes are opened. */
  messages(): Promise<readonly InboxMessageView[]> {
    if (this.#disposed) return Promise.resolve([]);
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve([]);
    return this.own(async () => {
      try {
        const records = await this.require().messages();
        return bound.alive ? records.map((record) => ({ ...record })) : [];
      } catch (err) {
        this.deps.reportFailure?.(err);
        return [];
      }
    });
  }

  /**
   * One message's text.
   *
   * The one payload this feature returns that is content rather than a code —
   * and it is the user's own message, received on their behalf, which is the
   * entire reason it was received. Decoded here so the renderer is handed a
   * string rather than bytes it would have to decode itself.
   */
  openMessage(id: string): Promise<{ readonly text: string } | { readonly failed: InboxFailureCode }> {
    if (this.#disposed) return Promise.resolve({ failed: "cancelled" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ failed: "account-changed" });
    return this.own(async () => {
      try {
        const bytes = await this.require().openMessage(id);
        if (!bound.alive) return { failed: "account-changed" } as const;
        return { text: new TextDecoder().decode(bytes) } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { failed: codeOf(err) } as const;
      }
    });
  }

  /**
   * Put one saved message on the clipboard.
   *
   * Main reads it and main writes it. The renderer names the message and never
   * supplies its text, so this cannot be used to put anything on the clipboard
   * except a message this account has already received — the same thing
   * `openMessage` already returns to the page.
   *
   * Fenced and account-checked like every other operation: a copy that resumed
   * after a sign-out would put the previous account's message on the clipboard
   * of whoever is using the app now.
   */
  copyMessage(id: string, document: number): Promise<InboxSimpleOutcome> {
    if (this.admissionClosed()) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "failed", reason: "account-changed" });
    const write = this.deps.writeClipboard;
    if (write === undefined) return Promise.resolve({ kind: "failed", reason: "internal" });
    // Captured, not read back later: the question is not "is there a document?"
    // but "is it still the one that asked?".
    const asking = document;
    return this.own(async () => {
      try {
        const bytes = await this.require().openMessage(id);
        // The account, the DOCUMENT and the fence — re-read after the store and
        // immediately before the write, which is the irreversible half.
        //
        // A copy that resumed after a sign-out would put the previous account's
        // message on the clipboard of whoever is using the app now. A copy that
        // resumed after a reload is the same shape with a different owner: the
        // page that asked is gone, and a retired document must not still be
        // able to reach outside the app. The background loop stays
        // document-independent on purpose — receiving survives a reload — but
        // this is not background work.
        if (!bound.alive || this.#bound !== bound) {
          return { kind: "failed", reason: "account-changed" } as const;
        }
        if (this.deps.currentDocument() !== asking) {
          return { kind: "failed", reason: "cancelled" } as const;
        }
        if (this.admissionClosed()) return { kind: "refused" } as const;
        write(new TextDecoder().decode(bytes));
        return { kind: "ok" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /** Delete one message, because the user asked for that and nothing else. */
  deleteMessage(id: string): Promise<InboxSimpleOutcome> {
    return this.simple(async () => {
      await this.require().deleteMessage(id);
    });
  }

  /** Rename this device. The server judges the name. */
  rename(name: string): Promise<InboxRenameOutcome> {
    if (this.#disposed || this.#fenced) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "failed", reason: "account-changed" });
    return this.own(async (signal) => {
      try {
        const accepted = await this.require().rename(name, signal);
        if (!bound.alive) return { kind: "failed", reason: "account-changed" } as const;
        bound.deviceName = accepted;
        this.publish();
        return { kind: "renamed", name: accepted } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /** Everything still owned because its cleanup never concluded. */
  retained(): readonly InboxRetainedView[] {
    const facade = this.#facade;
    if (facade === null) return [];
    return facade.retainedHandles().map((handle) => ({
      key: handle.key,
      taskID: handle.taskID,
      residue: handle.residue,
      reason: handle.reason,
    }));
  }

  /**
   * Ask a retained destination to tear down again.
   *
   * A failure KEEPS the handle: the next attempt may be the one that works, and
   * releasing on failure is the silent drop the retention exists to prevent.
   */
  releaseRetained(key: string): Promise<InboxSimpleOutcome> {
    if (this.#disposed || this.#fenced) return Promise.resolve({ kind: "refused" });
    return this.own(async () => {
      try {
        const released = await this.require().releaseRetained(key);
        this.publish();
        return released ? ({ kind: "ok" } as const) : ({ kind: "failed", reason: "internal" } as const);
      } catch (err) {
        this.deps.reportFailure?.(err);
        this.publish();
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  /** The shared shape of the operations that answer ok/refused/failed. */
  private simple(body: (signal: AbortSignal) => Promise<void>): Promise<InboxSimpleOutcome> {
    if (this.#disposed || this.#fenced) return Promise.resolve({ kind: "refused" });
    const bound = this.live();
    if (bound === "needs-account") return Promise.resolve({ kind: "failed", reason: "account-changed" });
    return this.own(async (signal) => {
      try {
        await body(signal);
        if (!bound.alive) return { kind: "failed", reason: "account-changed" } as const;
        this.publish();
        return { kind: "ok" } as const;
      } catch (err) {
        this.deps.reportFailure?.(err);
        return { kind: "failed", reason: codeOf(err) } as const;
      }
    });
  }

  private async refreshPendingQuietly(signal: AbortSignal): Promise<void> {
    try {
      const result = await this.require().listPending(MAX_INBOX_PENDING, signal);
      this.#pending = result.tasks.map(recordOfTask);
    } catch {
      // The operation that mattered already succeeded. A refresh that failed is
      // not a reason to report it as one; the next pass corrects the list.
    }
  }

  // -------------------------------------------------------------------------
  // Publication
  // -------------------------------------------------------------------------

  /**
   * Recompute the view and push it if it changed.
   *
   * `status` may be supplied by a caller that knows something the facade cannot
   * — signed out, folder missing, waiting out a backoff. When it is not, the
   * facade's own state is translated, which is the only place `receiving` and
   * `blocked` can come from.
   */
  private publish(status?: InboxStatus): void {
    const facade = this.#facade;
    const bound = this.#bound;
    const next: InboxView = {
      status: status ?? this.statusFromFacade(),
      capabilities: facade?.capabilities().capabilities ?? [],
      enabled: bound?.grant.enabled ?? false,
      policy: bound?.grant.policy ?? "off",
      epoch: bound?.epoch ?? 0,
      hasDestination: (bound?.grant.directory.length ?? 0) > 0,
      deviceName: bound?.deviceName ?? "",
      withdrawalPending: bound?.grant.withdrawalPending ?? false,
      retained: this.retained(),
    };
    if (sameView(this.#view, next)) return;
    this.#view = next;
    try {
      this.deps.onState?.(next);
    } catch (err) {
      // One listener's failure must not stop the scheduler.
      this.deps.reportFailure?.(err);
    }
  }

  private statusFromFacade(): InboxStatus {
    const facade = this.#facade;
    if (facade === null) return { kind: "starting" };
    const bound = this.#bound;
    if (bound === null) return { kind: "needs-account" };
    const state = facade.state();
    switch (state.kind) {
      case "unavailable":
        return { kind: "unavailable", reason: state.reason };
      case "disabled":
        // The facade says disabled for two different situations: the user has
        // not consented, and the enrolment has not happened yet. Only the grant
        // can tell them apart, and telling a user "off" while their own answer
        // was "on" is the one thing the folder/consent split exists to prevent.
        return bound.grant.enabled ? { kind: "starting" } : { kind: "disabled" };
      case "receiving":
        return { kind: "receiving" };
      case "blocked":
        return {
          kind: "blocked",
          reason: state.reason,
          residue: state.residue,
          pending: this.#pending.length,
        };
      case "idle":
        return { kind: "idle", pending: this.#pending.length };
      default:
        return { kind: "starting" };
    }
  }
}

/**
 * A pending task as the host holds it: the page's view plus the one field that
 * stays here.
 */
type PendingRecord = InboxPendingView & { readonly idempotencyKey: string };

/** The IPC boundary's narrowing: everything except the idempotency key. */
function strip(record: PendingRecord): InboxPendingView {
  return {
    taskID: record.taskID,
    sourceDeviceID: record.sourceDeviceID,
    bytes: record.bytes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    state: record.state,
  };
}

/** One pending task, narrowed to what this process keeps about it. */
function recordOfTask(task: {
  readonly ID: string;
  readonly SourceDeviceID: string;
  readonly IdempotencyKey: string;
  readonly CiphertextBytes: number;
  readonly CreatedAt: number;
  readonly ExpiresAt: number;
  readonly State: string;
}): PendingRecord {
  return {
    taskID: task.ID,
    sourceDeviceID: task.SourceDeviceID,
    bytes: task.CiphertextBytes,
    createdAt: task.CreatedAt,
    expiresAt: task.ExpiresAt,
    state: task.State,
    // Kept host-side for the dedup horizon and stripped at the IPC boundary.
    idempotencyKey: task.IdempotencyKey,
  };
}

/** Structural equality, so an unchanged pass pushes nothing to the page. */
function sameView(a: InboxView, b: InboxView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
