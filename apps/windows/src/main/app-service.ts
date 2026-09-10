// Everything the renderer can cause, with no Electron import.
//
// Kept separate from `handlers.ts` so the rules below can be driven by tests
// rather than described in comments: a withheld poll that lands after a sign-out
// is a five-line test here and an unreachable branch if this logic lives inside
// an `ipcMain.handle` closure.
//
// ## The account epoch
//
// Every operation that can outlive an account change captures the epoch it
// started under and re-checks it after each await. Sign-in and sign-out bump it.
// Three failures this removes, all of which are "a slow operation finishing into
// a world that changed":
//
//   * a poll whose response arrives after the user signed out, persisting a
//     bearer for a session they ended;
//   * a folder picker the user was looking at while another window signed out,
//     opening a lease under the previous account's authority;
//   * a lease still streaming when the account changed, committing the old
//     account's files into the new one's session.
//
// The ordering rule is the subtle half: the epoch is bumped BEFORE the awaited
// cleanup, so concurrent work is refused while the cleanup runs; and the cleanup
// is joined BEFORE the new authority is published, so nothing can attach to the
// new epoch while the old one is still tearing down.
//
// ## The sign-in attempt
//
// An epoch fences an ACCOUNT change. It does not fence a user pressing Cancel,
// because cancelling a sign-in must not disturb an account at all. That is what
// the attempt is for, and this process — not the renderer — is what decides
// whether a credential may be adopted.
//
// An attempt is named by a nonce the RENDERER creates before it calls `start`.
// That ordering is the whole point: a Cancel pressed while `start` is still in
// flight has to be able to name the thing it is cancelling, and if this process
// invented the name it would not exist yet. The nonce is CORRELATION, not
// authentication — the trust boundary is still `ipc.ts`'s sender check, and a
// nonce buys the renderer no authority it did not already have.
//
// Three rules make cancellation real rather than cosmetic:
//
//   1. **Ownership is established synchronously.** `startSignIn` installs the
//      attempt before its first await, so there is never a window in which a
//      start is in flight and nothing can invalidate it.
//   2. **Cancellation is a synchronous flag, re-checked after every await** —
//      including inside the adoption transition. Queueing the cancel as another
//      transition would put it BEHIND the adoption it exists to stop.
//   3. **Expiry is this process's own**, measured on actual time and re-checked
//      after every delayed await. A poll issued before the deadline can still
//      return after it, and adopting that success is precisely the hole a
//      renderer-side countdown cannot close.

import {
  MAX_ATTEMPT_NONCE_LENGTH,
  type PairMintResult,
  type PublishReport,
  type ReceiveAuthority,
} from "../shared/ipc-contract.js";
import { BEARER_KEY, approvalURL, type DeviceAuthClient } from "./account/device-auth.js";
import { loadOrMintInstallID } from "./account/install-id.js";
import { ReceiveLease, type ReceiveLeaseError } from "./io/receive-lease.js";
import {
  LeaseReceiveAdapter,
  NativeHelperDestination,
  type NativeReceiveAdapter,
} from "./net/native-receive-adapter.js";
import type { PairControl } from "./net/pair-control.js";
import { SecretStoreError, type SecretStore } from "./secrets.js";
import type { ManifestEntry } from "./io/plan.js";

/**
 * What a quiesce could not finish.
 *
 * Counts and a diagnostics string, kept apart on purpose: `firstReason` is a
 * filesystem error and routinely names a path, so it goes to a log. What reaches
 * a dialog is the counts and the closed reasons the caller derives from them.
 */
export interface CleanupOutcome {
  /** Leases still registered. Non-zero means something refused to let go. */
  readonly openLeases: number;
  /** Opens that had not finished being created. Counted separately because an
   *  open in flight is a destination that may or may not exist yet. */
  readonly opening: number;
  /** Destinations still owned because their cleanup has not succeeded. */
  readonly unresolved: number;
  /**
   * Owned network work that was asked to stop and was not SEEN to stop.
   *
   * Sockets whose close never arrived, ICE reads still settling. Filled in by
   * the caller that owns those — this object is what carries it to the user.
   */
  readonly networkUnsettled: number;
  /** Diagnostics only. Never rendered. */
  readonly firstReason: string | null;
}

export class ServiceRefusal extends Error {
  constructor(readonly reason: string) {
    super(`refused: ${reason}`);
    this.name = "ServiceRefusal";
  }
}

export interface AppServiceDeps {
  readonly origin: string;
  /** May throw — an unusable data root or cipher must surface, not be papered over. */
  makeStore(): Promise<SecretStore>;
  makeAuthClient(installationID: string): DeviceAuthClient;
  /** The pairing-code minter. Absent in tests that never mint. */
  makePairControl?(): PairControl;
  /**
   * Build the destination a batch is written into.
   *
   * Absent means the production choice below, which is deliberately NOT a
   * fallback chain: on Windows it is the native helper and only the native
   * helper. A build that quietly staged through `ReceiveLease` when the helper
   * failed to spawn would receive an entire transfer and then report a save it
   * never performed, and the failure would look like success to the user.
   *
   * The portable adapter is reachable two ways, both explicit: a test that
   * injects it, and the non-Windows path — where it exists to REFUSE truthfully
   * (`publish` answers `unsupported`) rather than to substitute.
   */
  makeDestination?(options: {
    readonly id: string;
    readonly authorityId: string;
    readonly rootPath: string;
    readonly manifest: readonly ManifestEntry[];
  }): Promise<NativeReceiveAdapter>;
  /** The native folder picker. `null` when the user cancelled. */
  pickDirectory(): Promise<string | null>;
  /** Hand the validated approval URL to the browser. */
  openApproval(url: string): Promise<boolean>;
  newId(): string;
  /**
   * Which DOCUMENT is currently allowed to hold state in this process.
   *
   * Separate from the account epoch, and neither substitutes for the other. The
   * epoch fences an ACCOUNT change; this fences the renderer's identity. A
   * reload keeps the same `WebContents` — so `destroyed` never fires and
   * `dispose()` never runs — but everything the previous document asked for is
   * gone, and the new one never asked for any of it. Without this, a reload or
   * a renderer crash mid-transfer leaves a lease holding an open handle and
   * staged bytes in the user's folder that nothing will ever finish or clean
   * up, and a picker the user was looking at can still register a lease into a
   * document that no longer exists.
   *
   * Absent means "one document, forever", which is what every existing test and
   * the accepted auth lifecycle assume.
   */
  documentGeneration?: () => number;
  /** Injectable so a test can drive a deadline without waiting for one. */
  now?: () => number;
}

/**
 * A sign-in the user abandoned, and whether abandoning it left a mess.
 *
 * `cleanupFailure` is deliberately separate from `state`. "You are signed in
 * because the token landed before you pressed Cancel" and "cancellation could
 * not remove the token it had already written" are different sentences, and
 * only the second one is a failure. Collapsing them would let a cancellation
 * that left a credential on disk report itself as a cancellation.
 */
export interface CancelSignInResult {
  readonly state: AuthStateReport;
  readonly cleanupFailure: string | null;
}

/** How many nonces are remembered. Bounded so a renderer cannot grow this
 *  process's memory by inventing them. */
const NONCE_MEMORY = 64;

/**
 * How many receives this process will own at once — open, being opened, or
 * still being cleaned up.
 *
 * The admission bound, and it exists because ownership never lapses. A cleanup
 * that keeps failing keeps its lease, which is correct — the adapter is the
 * only thing that can close the handle, and the lock it is waiting on usually
 * clears — but it means the owned set only ever shrinks by SUCCEEDING. Without
 * a bound, a renderer that opened receives in a loop against a failing disk
 * would accumulate helper child processes with no ceiling, in the privileged
 * process.
 *
 * The bound goes on ADMISSION rather than on retention. Evicting an owned entry
 * to save memory would release a live child process to keep a number small,
 * which is the failure this whole file is about; refusing to create a NEW one
 * costs the user a truthful error instead. It is checked before the folder
 * picker and again before the destination is created, so a refusal never spawns
 * a helper and never opens a dialog it was always going to reject.
 *
 * Sized for honesty about normal use rather than for tightness: one active
 * receive is the ordinary case and a handful of links is a plausible one, so a
 * user doing something reasonable never meets this. Meeting it means something
 * is wrong — dozens of pickers open, or destinations that will not close — and
 * saying so is better than growing quietly.
 */
export const MAX_OWNED_RECEIVES = 16;

/** A failure as a BOUNDED string. Never the `Error`: retaining one pins a stack
 *  and everything its closure captured, on a path a failing disk drives
 *  repeatedly, in the privileged process. */
function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? (err.message ?? err.name) : String(err);
  return raw.slice(0, 200);
}

/**
 * The most recent N strings, oldest evicted first.
 *
 * `Set` iterates in insertion order, so the first key is the oldest — no second
 * structure is needed to find it.
 */
class RecentNonces {
  private readonly seen = new Set<string>();
  constructor(private readonly limit: number) {}
  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }
  add(nonce: string): void {
    this.seen.delete(nonce);
    this.seen.add(nonce);
    while (this.seen.size > this.limit) {
      const oldest: string | undefined = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

/** Why an attempt may no longer act. Ordered by precedence in `attemptFault`. */
type AttemptFault = "disposed" | "cancelled" | "superseded" | "expired";

const FAULT_REASON: Record<AttemptFault, string> = {
  disposed: "service disposed",
  cancelled: "sign-in cancelled",
  superseded: "sign-in superseded",
  expired: "sign-in expired",
};

interface Attempt {
  readonly nonce: string;
  /** The account epoch this attempt began under. */
  readonly epoch: number;
  readonly abort: AbortController;
  /** Set synchronously by `cancelSignIn`, `signOut`, `dispose` and supersession.
   *  Never unset: a cancelled attempt stays cancelled. */
  cancelled: boolean;
  deviceCode: string | null;
  /**
   * Fixed the moment the server's `start` response arrives — BEFORE the browser
   * open is awaited, so a slow `openExternal` cannot quietly extend the life of
   * a code the server is already counting down.
   */
  deadline: number | null;
  /** Only after the approval page actually reached the browser. A poll before
   *  that is a renderer asking about a code the user has not been shown. */
  pollable: boolean;
  /**
   * One outstanding poll per attempt.
   *
   * UI pacing is not request admission: a renderer that fired ten `poll`
   * invocations would otherwise become ten concurrent HTTP requests from a
   * privileged process. This bounds it here, where the authority is.
   */
  pollInFlight: boolean;
  /** Set when a refused adoption could not remove the credential it wrote. */
  compensation: string | null;
}

export type StoreHealth = "ok" | "unreadable" | "unavailable";

export interface AuthStateReport {
  readonly signedIn: boolean;
  readonly accountEmail: string;
  /** Distinguished from `signedIn: false`. "No session" and "I cannot open my
   *  own storage" are different problems and only one is fixed by signing in. */
  readonly store: StoreHealth;
}

interface Session {
  readonly store: SecretStore;
  readonly installID: string;
}

/**
 * One open receive lease and everything that owns it.
 *
 * `terminal` is the publication barrier. A lease whose files are being moved to
 * their final names is still THIS process's responsibility, so it stays
 * registered until that operation actually settles — an account transition, a
 * revocation or a quit that could not see it would return while a publication
 * was still writing to the user's disk, and would then report a clean teardown
 * it had not performed. Deleting the entry first is the shape that reads as
 * tidy and is wrong; with the native helper integrated it becomes real files
 * appearing after the app believed it had finished with them.
 */
/** What a teardown selects on, shared by an open lease and one still opening. */
interface ReceiveOwner {
  readonly authority: ReceiveAuthority;
  readonly epoch: number;
  /** The renderer document that asked for this. */
  readonly document: number;
}

/**
 * A receive that has been ASKED for but does not exist yet.
 *
 * Registered before the first await — before the picker, before
 * `ReceiveLease.open` — because otherwise a quit or a document revocation that
 * runs while the user is looking at the folder dialog finds nothing, returns,
 * and reports a clean teardown. The destination it was opening then lands
 * afterwards, holding a handle and staged bytes that nothing will ever finish.
 *
 * With a native helper behind the adapter that becomes worse than untidy: the
 * helper is a child process, and one spawned after quit outlives the app.
 */
interface PendingOpen extends ReceiveOwner {
  /**
   * How far along this is, and therefore whether a teardown must WAIT for it.
   *
   * `picking` — a native folder dialog is on screen. Nothing has been created:
   * no helper process, no staging directory, no handle. There is nothing to
   * clean up and nothing to wait for, and waiting would mean quit hangs until a
   * human dismisses a dialog. So teardown fences it and moves on.
   *
   * `creating` — the picker returned and a destination is actually being
   * built. This window is bounded and it can leave something behind, so
   * teardown joins it.
   *
   * The fence is what makes that safe: `cancelled` is set on every matching
   * entry BEFORE the first await, so an open still in `picking` when a teardown
   * starts re-checks it after the dialog closes and cleans up instead of
   * creating anything.
   */
  phase: "picking" | "creating";
  /** Resolves once the creation window has finished — either registered, or
   *  cleaned up. Never rejects; teardown joins it to know the work has STOPPED. */
  readonly settled: Promise<void>;
  /** Set by a teardown. Re-checked after every await. */
  cancelled: boolean;
}

interface LeaseEntry extends ReceiveOwner {
  readonly adapter: NativeReceiveAdapter;
  /** Non-null while a terminal publication is running. Never rejects — the
   *  caller gets the real error; this exists only to be JOINED. */
  terminal: Promise<void> | null;
  /**
   * The ONE retirement of this lease, shared by every caller that asks for it.
   *
   * Removing an entry from the map is not the end of ownership — it is only the
   * point after which no NEW work is accepted. An explicit cancel that removed
   * the entry and then awaited its own cleanup left a concurrent quit or
   * account transition with nothing to find, so those returned reporting a
   * teardown that was still running. The promise lives on the entry and the
   * entry stays reachable through `retiring` until it settles, so every
   * teardown caller joins the same operation instead of missing it.
   *
   * Null again after a FAILED attempt, which is the difference between a lease
   * that has been closed and one that merely had closing attempted. Retaining
   * the rejected promise here made every later teardown join a failure that had
   * already finished: it re-reported the old error, never touched the still-open
   * destination, and — because the entry had also been dropped from `retiring`
   * by then — usually did not even find it to re-report. Cleared, so the next
   * teardown starts a real attempt against the resource this process still owns.
   */
  retirement: Promise<void> | null;
  /**
   * Failed cleanup attempts so far, and WHEN the last one started.
   *
   * Diagnostic, and a fence — never a budget. Ownership does not expire: a
   * counter that dropped a still-live adapter after N failures would recreate
   * exactly the bug this file is correcting, only later and with a tidier
   * excuse. A destination is released when it has been observed CLOSED, and a
   * lock that outlasts three attempts is precisely the case where the fourth,
   * after the indexer or the helper process finally lets go, is the one that
   * works.
   *
   * `lastAttemptAt` is a monotonic stamp from `cleanupSeq`, and it exists so a
   * teardown can tell an attempt that predates it from one that ran inside it.
   */
  cleanupAttempts: number;
  lastAttemptAt: number;
  /**
   * Why the last attempt failed — the MESSAGE, truncated, not the `Error`.
   *
   * An entry can outlive several attempts, and a retained `Error` pins a stack
   * and everything its closure captured, in the privileged process, on a path a
   * failing disk drives repeatedly. The string is what a teardown message and a
   * diagnosis both need.
   */
  lastCleanupReason: string | null;
}

/** A lease entry that has not been through a cleanup attempt yet. */
function newLeaseEntry(fields: ReceiveOwner & { readonly adapter: NativeReceiveAdapter }): LeaseEntry {
  return {
    ...fields,
    terminal: null,
    retirement: null,
    cleanupAttempts: 0,
    lastAttemptAt: 0,
    lastCleanupReason: null,
  };
}

export class AppService {
  private sessionPromise: Promise<Session> | null = null;
  private epoch = 0;
  private accountEmail = "";
  /** At most one sign-in attempt exists at a time. */
  private attempt: Attempt | null = null;
  /** Nonces that have named an attempt. A nonce is single-use, so a replayed
   *  `start` cannot quietly take over the identity of a live attempt. */
  private readonly usedNonces = new RecentNonces(NONCE_MEMORY);
  /** Nonces cancelled before their `start` arrived. Without this, a Cancel that
   *  overtook its own `start` would be a no-op and the start would proceed. */
  private readonly cancelledNonces = new RecentNonces(NONCE_MEMORY);
  /**
   * Every open receive lease, and WHICH authority owns it.
   *
   * ## Why a lease has an authority kind at all
   *
   * `openReceive` used to await `session()` unconditionally, so a signed-out
   * LAN transfer needed usable encrypted account storage before it could pick a
   * folder — and an account transition cancelled every lease, so signing in
   * mid-transfer killed a transfer between two machines that never had an
   * account in it. Neither is what the product does: `LanTransferDestination`
   * on Mac holds no `AccountSession` at all.
   *
   * The existing account fencing is NOT weakened to fix that. It stays exactly
   * as accepted and stays the DEFAULT, so every guarantee it established — a
   * picker that returned after a sign-out is refused, an account change retires
   * in-flight leases — applies unchanged to anything that does not explicitly
   * ask otherwise. `direct` is an opt-out for the two flows that genuinely have
   * no account in them, and it opts out of the account fence ONLY: a direct
   * lease is still cancelled by its own room, by an explicit cancel, and by
   * quit.
   */
  private readonly leases = new Map<string, LeaseEntry>();
  /**
   * Leases removed from the map whose cleanup has not SUCCEEDED.
   *
   * The reason a teardown cannot simply read `leases`. An explicit cancel
   * removes an entry immediately — correctly, so no further work is accepted —
   * but the files are still this process's responsibility until the cancel
   * finishes. A quit that consulted only the map would find nothing and return.
   *
   * "Not succeeded" rather than "not settled", and that is the whole retry
   * mechanism. An entry leaves this set on exactly ONE event: a cleanup that
   * actually closed the destination. A cleanup that REJECTED leaves the entry
   * here — the handle is open, the staged bytes are on disk, the adapter is the
   * only thing that can still close them — so the next teardown finds it and
   * tries again. Dropping it on the first rejection is what let a second
   * revocation return clean over a live destination.
   *
   * There is deliberately no attempt budget after which an entry is dropped
   * anyway. A count and a reason string cannot close a handle; releasing the
   * adapter that can, because three tries did not work, is the same forgetting
   * one failure later, and the case it forgets is the realistic one — a lock
   * held by an indexer or a helper that had not exited yet, which clears on its
   * own and makes a LATER attempt succeed. That was reproduced: with a budget,
   * a destination whose lock cleared after five failures was never closed
   * again. What is bounded is the work per attempt and the number of attempts
   * per requested teardown — one — not the lifetime of the ownership.
   *
   * The set therefore grows only with destinations that genuinely could not be
   * closed, one entry per transfer the user actually started, each retaining a
   * truncated reason string rather than an `Error`. If that ever needs a hard
   * ceiling it belongs on ADMISSION — refusing to open a new receive while too
   * many are unclosed — not on forgetting the ones already open.
   */
  private readonly retiring = new Set<LeaseEntry>();
  /** Receives that have been asked for and do not exist yet. See `PendingOpen`. */
  private readonly opening = new Set<PendingOpen>();
  /** In-flight operations that captured an authority and want telling when it
   *  moves. A mint holds no lease, so it cannot be found through `leases`. */
  private readonly authorityWatchers = new Set<() => void>();
  /**
   * A monotonic stamp for cleanup attempts.
   *
   * Only ever compared, never counted against a limit. A teardown captures it
   * before it starts and uses it to tell an attempt that already ran inside its
   * own window from one that predates it — see `retireLeases`.
   */
  private cleanupSeq = 0;
  private disposed = false;
  /**
   * Quiesced, and REVERSIBLE — which is the whole difference from `disposed`.
   *
   * A quit the user may still cancel cannot use `dispose()`: that latches, so
   * "Stay" would leave an app that refuses every future transfer and sign-in.
   * This refuses new work the same way and is cleared by `resume()`.
   */
  private quiescing = false;
  /**
   * New receives refused, existing work untouched.
   *
   * Set while a quit is deciding — including while the risk snapshot is being
   * taken — so a receive cannot start between "nothing at stake" and the quit
   * that answer authorised. Cancelling the quit clears it; nothing else does.
   */
  private admissionFenced = false;
  /** Transitions run one at a time, in order. See `runTransition`. */
  private transitionTail: Promise<unknown> = Promise.resolve();
  private inTransition = false;
  /** The whole teardown, cached, so a second `dispose()` waits for the first. */
  private disposal: Promise<void> | null = null;

  constructor(private readonly deps: AppServiceDeps) {}

  /**
   * One initialisation, however many callers arrive at once.
   *
   * The promise is cached, not the resolved value, so two concurrent first
   * calls await the SAME work. Caching only the result would let both see
   * `null`, both build a `SecretStore`, and both race to mint an installation
   * identity — two identities for one machine.
   */
  private session(): Promise<Session> {
    if (this.disposed) return Promise.reject(new ServiceRefusal("service disposed"));
    if (this.quiescing) return Promise.reject(new ServiceRefusal("shutting down"));
    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        const store = await this.deps.makeStore();
        const installID = await loadOrMintInstallID(store);
        return { store, installID };
      })().catch((err: unknown) => {
        // A failed initialisation must not be cached as a permanent failure:
        // the data root may become readable, and the user should be able to
        // retry rather than restart the app.
        this.sessionPromise = null;
        throw err;
      });
    }
    return this.sessionPromise;
  }

  /** The value an operation captures at entry and re-checks after every await. */
  private currentEpoch(): number {
    return this.epoch;
  }

  /** Which document may hold state right now. */
  private currentDocument(): number {
    return this.deps.documentGeneration ? this.deps.documentGeneration() : 0;
  }

  /**
   * Refuse if the document that started this operation is gone.
   *
   * Applied to BOTH authorities, unlike the epoch. A `direct` lease opts out of
   * the account fence because it has no account; it does not opt out of
   * belonging to the page that asked for it.
   */
  private assertDocument(captured: number): void {
    if (this.disposed) throw new ServiceRefusal("service disposed");
    if (captured !== this.currentDocument()) throw new ServiceRefusal("document changed");
  }

  private assertEpoch(captured: number): void {
    if (this.disposed) throw new ServiceRefusal("service disposed");
    // Refused DURING a transition too, not merely after one. An operation that
    // slipped in while the epoch was being rotated would see a consistent epoch
    // and still be acting on state that is half torn down.
    if (this.inTransition) throw new ServiceRefusal("account transition in progress");
    if (captured !== this.epoch) throw new ServiceRefusal("account changed");
  }

  /**
   * Run a state transition with exclusive, ordered ownership.
   *
   * ## The race this exists to close
   *
   * Bumping the epoch before an awaited cleanup is not enough on its own. A
   * successful poll would bump to E+1 and then await a lease cancel that was
   * slow; a sign-out could run to completion through that window — bumping to
   * E+2 and deleting the bearer — and the poll, resuming after its cleanup,
   * would then `put` the bearer it had already been told not to keep. The
   * account was signed out and a token was on disk.
   *
   * Two things fix it, and both are needed. Transitions are QUEUED rather than
   * interleaved, so a sign-out runs after the poll's transition rather than
   * through it. And every transition re-checks its own identity after each
   * await, so one that was superseded while suspended undoes its own work
   * instead of publishing it.
   *
   * Queued rather than refused: a user who clicks sign out while a poll is
   * completing must end up signed out, not looking at an error.
   */
  private runTransition<T>(body: () => Promise<T>): Promise<T> {
    const run = this.transitionTail.then(async () => {
      this.inTransition = true;
      try {
        return await body();
      } finally {
        this.inTransition = false;
      }
    });
    this.transitionTail = run.catch(() => undefined);
    return run;
  }

  /**
   * Retire the leases an ACCOUNT change invalidates. Failures are surfaced,
   * never swallowed.
   *
   * `account` leases only, and this is the single line where the authority
   * split has any effect on the accepted cancellation behaviour. An account
   * lease is cancelled exactly as before. A `direct` lease is left alone
   * because nothing about it changed: it was opened without a session, it is
   * fenced on no epoch, and its files are going to a folder the user chose for
   * a transfer that has no account in it. Cancelling it on sign-in would be the
   * bug, not the safeguard.
   */
  private async cancelLeases(): Promise<void> {
    await this.retireLeases((entry) => entry.authority === "account");
  }

  /**
   * Cancel and forget every lease the predicate selects.
   *
   * The join is the part that must not be skipped. A lease with a publication
   * in flight is moving files on the user's disk right now, and cancelling
   * around it would race the teardown against the write — so the terminal
   * operation is awaited FIRST, and only then is the staging residue removed.
   * A transition that returned before that join would report a completed
   * cleanup while a publication it could not see was still running.
   *
   * Entries are removed from the map before anything is awaited, so a
   * concurrent caller cannot start a second teardown of the same lease.
   *
   * Named apart from the sign-in `retire` below: they retire different things.
   */
  private async retireLeases(select: (owner: ReceiveOwner) => boolean): Promise<void> {
    // Captured BEFORE anything is fenced or awaited. Every cleanup attempt
    // stamps its entry from this counter, so the rescan below can tell an
    // attempt that ran INSIDE this teardown's window from one that predates it.
    const startedAt = this.cleanupSeq;

    // Pending opens FIRST, and marked before anything is awaited: an open that
    // is still inside the picker must not register a live destination into a
    // teardown that has already begun. Fencing every match is what lets the
    // wait below be narrow.
    const pending = [...this.opening].filter(select);
    for (const open of pending) open.cancelled = true;

    // A Set, not an array: an entry can be reachable through more than one
    // registry — the map, the retirement registry before the join, and the same
    // registry again after it — and this teardown is worth ONE attempt against
    // it, not one per registry it happened to appear in. Two attempts from the
    // same sweep would race each other for the same files, and would spend on a
    // single moment in time the attempts whose whole value is being spread
    // across separate teardowns, with whatever holds the lock given a chance to
    // let go in between.
    const chosen = new Set<LeaseEntry>();
    for (const [id, entry] of [...this.leases]) {
      if (!select(entry)) continue;
      // Removed first, so no NEW work is accepted while the cleanup runs.
      this.leases.delete(id);
      chosen.add(entry);
    }
    // And the ones an explicit cancel already removed from the map, or a
    // previous teardown failed to close. This is the half that was missing:
    // ownership does not end at map removal, so a teardown that only looked at
    // the map returned while a publication it should have joined was still
    // writing — and, once cleanup could fail, while a destination it should
    // have retried was still open.
    for (const entry of this.retiring) {
      if (select(entry)) chosen.add(entry);
    }

    // STARTED before anything is awaited, and that ordering is the point.
    //
    // These entries have just been deleted from `leases`. Until a retirement is
    // started they are in NO registry this object exposes — only in the local
    // Set above — and the very next line used to be an await. A concurrent
    // teardown with a DIFFERENT filter ran through that window and found
    // nothing: a sign-out selects `account` leases, so it does not fence or
    // join a `direct` open, and it would return clean and publish the new
    // authority while an account destination this sweep had picked up was still
    // live. `retireEntry` registers into `retiring` synchronously, so after
    // this loop every selected lease is findable again.
    //
    // One attempt per teardown survives: each entry is visited once, and
    // `retireEntry` joins an in-flight retirement rather than starting a second
    // one. The terminal join is inside that attempt, unchanged — a publication
    // is still awaited before its staging is removed.
    const attempts = new Map<LeaseEntry, Promise<void>>();
    for (const entry of chosen) attempts.set(entry, this.retireEntry(entry));

    // Joined only where something can actually exist. An open still showing a
    // folder dialog has created nothing, and waiting for it would hang quit
    // until a human dismissed the dialog; the fence above already guarantees it
    // cannot create anything afterwards. One that has passed the picker is in a
    // bounded window that CAN leave a destination behind, so it is awaited.
    await Promise.all(pending.filter((open) => open.phase === "creating").map((open) => open.settled));

    // RESCANNED after that join, because the join is exactly when the registry
    // grows. An open that lands into a teardown hands its destination to the
    // retirement registry and tries to close it; if that close fails, the
    // adapter is still live and is now this sweep's to account for. The
    // snapshot taken before the join could not contain it, so a sweep that
    // trusted the snapshot returned reporting a clean teardown over a
    // destination that had been created, had failed to close, and was sitting
    // in `retiring`.
    //
    // `attempts` is what keeps this from double-attempting: an entry this sweep
    // already started or joined is not touched again, so the rescan can only
    // ADD what appeared during the join.
    //
    // What it adds is accounted for but NOT attempted again here. Such an entry
    // has just had its cleanup attempted BY the open that landed — inside this
    // sweep's own window, moments ago, against the same lock. Trying again
    // immediately is not a retry, it is the same attempt twice: nothing has
    // changed on the disk in between, and it would let one teardown consume the
    // recovery that belongs to the next one while reporting only the second
    // outcome. So its failure is REPORTED, the entry stays owned, and the retry
    // is the next teardown's.
    //
    // An entry whose cleanup is in FLIGHT is different: it is joined, which is
    // the accepted behaviour a publication depends on.
    const alreadyFailed: LeaseEntry[] = [];
    for (const entry of this.retiring) {
      if (!select(entry) || attempts.has(entry)) continue;
      if (entry.retirement === null && entry.lastAttemptAt > startedAt) alreadyFailed.push(entry);
      else attempts.set(entry, this.retireEntry(entry));
    }

    const outcomes = await Promise.allSettled([...attempts.values()]);
    const rejections = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    const total = rejections.length + alreadyFailed.length;
    if (total > 0) {
      const first = rejections[0];
      const reason = first ? reasonOf(first.reason) : alreadyFailed[0]?.lastCleanupReason;
      throw new ServiceRefusal(`could not clean up ${total} transfer(s)${reason ? `: ${reason}` : ""}`);
    }
  }

  /**
   * Cancel one lease, exactly once at a time, however many callers ask.
   *
   * Idempotent by construction rather than by convention: the promise is stored
   * on the entry, so a second caller joins the first operation instead of
   * starting a competing one against the same files.
   *
   * "At a time" rather than "ever", which is the correction. A cleanup that
   * SUCCEEDED is final and its resolved promise is what every later caller
   * gets — the destination is closed, and cancelling a closed destination twice
   * is the double-cleanup this exists to prevent. A cleanup that FAILED closed
   * nothing, and treating its rejection as final meant the one object that
   * could still release the handle was dropped while the handle stayed open.
   */
  private retireEntry(entry: LeaseEntry): Promise<void> {
    if (entry.retirement) return entry.retirement;
    return this.startCleanup(entry, async () => {
      // Never rejects; the publisher's own caller owns that error. What this
      // await buys is that the cancel below does not race a publication for the
      // same files.
      await entry.terminal;
      await entry.adapter.cancel();
    });
  }

  /**
   * Run one cleanup attempt against a lease, holding ownership across it.
   *
   * The entry is in `retiring` for the whole attempt and stays there unless the
   * attempt actually closed the destination, so a teardown arriving at any
   * point in between finds it — mid-attempt it joins, after a failed attempt it
   * starts the next one.
   */
  private startCleanup(entry: LeaseEntry, body: () => Promise<void>): Promise<void> {
    // OWNERSHIP FIRST, and the deferral is the reason. `body()` called here
    // could throw synchronously — an adapter whose `cancel` is not the async
    // function it is typed as, a destroyed handle raising on entry — and a
    // synchronous throw never produces a promise, so the entry would be left
    // registered nowhere with a destination that may well still exist. The
    // attempt is scheduled instead, so registration is complete before anything
    // in `body` runs and a synchronous throw arrives as an ordinary rejection
    // through the failure path below.
    entry.lastAttemptAt = ++this.cleanupSeq;
    this.retiring.add(entry);
    const run = Promise.resolve().then(body);
    entry.retirement = run;
    void run.then(
      () => {
        // The ONE event that ends ownership: the destination is closed, and the
        // resolved `retirement` now answers every later caller.
        this.retiring.delete(entry);
      },
      (err: unknown) => {
        entry.cleanupAttempts += 1;
        entry.lastCleanupReason = reasonOf(err);
        // Cleared, so the next teardown makes a real attempt rather than
        // joining a failure that already happened. The entry stays in
        // `retiring`: the handle is open, and the adapter is the only thing
        // that can close it. However many attempts have failed.
        entry.retirement = null;
      },
    );
    return run;
  }

  /**
   * The renderer document that asked for this went away.
   *
   * Reached from a main-frame navigation and from a renderer crash — neither of
   * which destroys the `WebContents`, so neither reaches `dispose()`. Both
   * authorities are retired: a `direct` lease survives an ACCOUNT change, which
   * is the whole point of it, but it does not survive the document that owns it
   * ceasing to exist. Hiding the window is not this: it navigates nothing and
   * kills nothing, so a hidden window keeps receiving.
   */
  async revokeDocument(generation: number): Promise<void> {
    // Before the awaited cleanup: an in-flight mint belonging to the retired
    // document has nobody left to hand a code to.
    this.notifyAuthorityChange();
    await this.retireLeases((entry) => entry.document === generation);
  }

  /**
   * The authority string a lease is fenced on.
   *
   * A direct lease is fenced on a constant, not on an epoch: it has no account
   * to be invalidated by. The string still exists — `ReceiveLease.assertAuthority`
   * is what stops one lease's handle being driven under another's identity — it
   * simply names an authority that does not rotate.
   */
  private authorityFor(authority: ReceiveAuthority, epoch: number): string {
    return authority === "direct" ? "direct" : `epoch-${epoch}`;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * The first reason this attempt may no longer act, or `null`.
   *
   * Every delayed await in the sign-in path funnels through this, so a new
   * reason cannot be added in one place and forgotten in another.
   */
  private attemptFault(mine: Attempt): AttemptFault | null {
    if (this.disposed) return "disposed";
    if (mine.cancelled) return "cancelled";
    // Identity, not a counter. A superseding `start` installs a different
    // object, so "am I still the current attempt" is an === and cannot be
    // spoofed by a wrapped-around number.
    if (this.attempt !== mine) return "superseded";
    if (mine.deadline !== null && this.now() >= mine.deadline) return "expired";
    return null;
  }

  private assertAttempt(mine: Attempt): void {
    const fault = this.attemptFault(mine);
    if (fault !== null) throw new ServiceRefusal(FAULT_REASON[fault]);
  }

  /**
   * End an attempt: no further poll, no adoption, and stop waiting on the
   * network for a decision that has already been made.
   *
   * Synchronous on purpose — everything it sets is re-read by `attemptFault`
   * after an await, so a caller that yielded first would be leaving exactly the
   * window this closes.
   */
  private retire(mine: Attempt): void {
    if (this.attempt === mine) this.attempt = null;
    mine.cancelled = true;
    mine.abort.abort();
  }

  async authState(): Promise<AuthStateReport> {
    let session: Session;
    try {
      session = await this.session();
    } catch (err) {
      const unavailable =
        err instanceof SecretStoreError && err.code === "encryption-unavailable";
      return { signedIn: false, accountEmail: "", store: unavailable ? "unavailable" : "unreadable" };
    }
    try {
      await session.store.get(BEARER_KEY);
      return { signedIn: true, accountEmail: this.accountEmail, store: "ok" };
    } catch (err) {
      if (err instanceof SecretStoreError && err.code === "not-found") {
        return { signedIn: false, accountEmail: "", store: "ok" };
      }
      // Present but unopenable, or the cipher went away. Reporting "signed out"
      // would invite the user to sign in again over bytes that are still there.
      const unavailable =
        err instanceof SecretStoreError && err.code === "encryption-unavailable";
      return { signedIn: false, accountEmail: "", store: unavailable ? "unavailable" : "unreadable" };
    }
  }

  /**
   * Begin a sign-in the renderer has already named.
   *
   * `nonce` comes from the renderer because Cancel must work DURING this call.
   * See the header: a name this process invents when the call returns is a name
   * that does not exist while the call is in flight.
   *
   * Refuses while a bearer is held. One account at a time is a deliberate
   * simplification for this slice — switching accounts is an explicit sign out
   * followed by a sign in — and it removes a whole token backup/restore
   * subsystem whose failure modes would be worse than the feature.
   */
  async startSignIn(
    nonce: string,
  ): Promise<{ attemptNonce: string; userCode: string; interval: number; expiresIn: number }> {
    if (this.disposed) throw new ServiceRefusal("service disposed");
    if (nonce.length === 0 || nonce.length > MAX_ATTEMPT_NONCE_LENGTH) {
      throw new ServiceRefusal("malformed sign-in nonce");
    }
    // A Cancel can overtake its own `start` — they are separate IPC calls and
    // the renderer fires the second without waiting for the first. Refusing
    // here means that race ends with no attempt, rather than with one nobody
    // is watching.
    if (this.cancelledNonces.has(nonce)) throw new ServiceRefusal("sign-in cancelled");
    // Single-use. A replayed `start` must not be able to name — and therefore
    // to have cancelled or polled — the attempt that is already running.
    if (this.usedNonces.has(nonce)) throw new ServiceRefusal("sign-in nonce reused");

    const captured = this.currentEpoch();

    // ---- Everything above and below this line is synchronous. -------------
    // Ownership is established BEFORE the first await, so there is no window in
    // which a start is in flight and nothing can invalidate it.
    this.usedNonces.add(nonce);
    const previous = this.attempt;
    if (previous !== null) this.retire(previous);
    const mine: Attempt = {
      nonce,
      epoch: captured,
      abort: new AbortController(),
      cancelled: false,
      deviceCode: null,
      deadline: null,
      pollable: false,
      pollInFlight: false,
      compensation: null,
    };
    this.attempt = mine;
    // ----------------------------------------------------------------------

    try {
      const session = await this.session();
      this.assertEpoch(captured);
      this.assertAttempt(mine);

      await this.refuseWhenSignedIn(session);
      this.assertEpoch(captured);
      this.assertAttempt(mine);

      const start = await this.deps.makeAuthClient(session.installID).start(mine.abort.signal);
      this.assertEpoch(captured);
      this.assertAttempt(mine);

      // The deadline is fixed HERE, from the response that carries it — not
      // after the browser open below. `openExternal` can take seconds on a cold
      // default browser, and every one of them is a second the server has
      // already counted against this code.
      mine.deviceCode = start.deviceCode;
      mine.deadline = this.now() + start.expiresIn * 1000;

      const opened = await this.deps.openApproval(approvalURL(start, this.deps.origin));
      this.assertEpoch(captured);
      this.assertAttempt(mine);
      if (!opened) throw new ServiceRefusal("approval page refused");

      mine.pollable = true;
      return {
        attemptNonce: nonce,
        userCode: start.userCode,
        interval: start.interval,
        // What is LEFT, not what the server originally granted. Opening the
        // browser consumed part of it, and a renderer told the original figure
        // would count down past the moment this process stops accepting polls —
        // showing minutes remaining on a code that is already refused here.
        expiresIn: Math.max(0, Math.ceil((mine.deadline - this.now()) / 1000)),
      };
    } catch (err) {
      // A start that did not finish leaves nothing behind. Guarded on identity
      // so a failing superseded start cannot clear the attempt that replaced it.
      this.retire(mine);
      throw err;
    }
  }

  /**
   * Refuse a second sign-in over a held credential.
   *
   * `not-found` is the ordinary path. Every other `SecretStoreError` is
   * re-thrown UNCHANGED, so an unreadable or unencryptable store still reaches
   * the renderer as the store problem it is rather than being flattened into
   * "already signed in" — the distinction the whole `StoreHealth` type exists
   * to keep.
   */
  private async refuseWhenSignedIn(session: Session): Promise<void> {
    try {
      await session.store.get(BEARER_KEY);
    } catch (err) {
      if (err instanceof SecretStoreError && err.code === "not-found") return;
      throw err;
    }
    throw new ServiceRefusal("already signed in");
  }

  async pollSignIn(nonce: string): Promise<{ status: string; accountEmail?: string }> {
    const mine = this.attempt;
    if (
      mine === null ||
      mine.nonce !== nonce ||
      mine.cancelled ||
      !mine.pollable ||
      mine.deviceCode === null
    ) {
      throw new ServiceRefusal("no sign-in in progress");
    }
    const captured = mine.epoch;
    this.assertEpoch(captured);

    // Before the poll is issued: no request is ever sent for a code this
    // process already considers dead.
    if (this.attemptFault(mine) === "expired") return this.expire(mine);

    // "No outcome yet" is the truth for an overlapping call, and it is the
    // answer the renderer's own pacing already knows how to handle. Bounded
    // here rather than trusted to the UI: admission is a privileged decision.
    if (mine.pollInFlight) return { status: "pending" };

    const session = await this.session();
    this.assertEpoch(captured);
    if (this.attemptFault(mine) === "expired") return this.expire(mine);
    this.assertAttempt(mine);
    if (mine.pollInFlight) return { status: "pending" };

    let outcome;
    mine.pollInFlight = true;
    try {
      outcome = await this.deps
        .makeAuthClient(session.installID)
        .poll(mine.deviceCode, mine.abort.signal);
    } finally {
      // Only this attempt's flag. A superseding attempt is a different object,
      // so a slow poll unwinding here cannot clear the new one's admission.
      mine.pollInFlight = false;
    }
    this.assertEpoch(captured);
    // And again after it returns. A poll ISSUED before the deadline can still
    // RETURN after it; adopting that success is the hole no renderer countdown
    // can close, because by then the renderer has already stopped counting.
    if (this.attemptFault(mine) === "expired") return this.expire(mine);
    this.assertAttempt(mine);

    if (outcome.status !== "ok") {
      // `denied` and `expired` are terminal: nothing further can come of this
      // code, so the attempt ends here rather than waiting to be cancelled.
      if (outcome.status !== "pending") this.retire(mine);
      return { status: outcome.status };
    }
    return this.adopt(mine, captured, session, outcome.accessToken, outcome.accountEmail);
  }

  /** An expiry this process detected itself. A truthful outcome, not an error. */
  private expire(mine: Attempt): { status: "expired" } {
    this.retire(mine);
    return { status: "expired" };
  }

  /**
   * Keep the credential — or refuse to, and leave nothing behind either way.
   *
   * Runs as a queued transition (see `runTransition`) so a sign-out cannot
   * interleave with it, and re-checks the attempt at every point where it could
   * have been cancelled while suspended.
   */
  private adopt(
    mine: Attempt,
    captured: number,
    session: Session,
    accessToken: string,
    accountEmail: string,
  ): Promise<{ status: string; accountEmail?: string }> {
    return this.runTransition(async () => {
      // Re-checked at the head: this may have waited behind another transition
      // that already changed the account, or behind the user's Cancel.
      if (captured !== this.epoch) throw new ServiceRefusal("account changed");
      this.assertAttempt(mine);

      const mineEpoch = ++this.epoch;
      // Anything that captured the old epoch is told immediately, before the
      // awaited cleanup below — an in-flight mint must stop waiting for an
      // answer it is no longer allowed to install.
      this.notifyAuthorityChange();
      await this.cancelLeases();
      if (this.epoch !== mineEpoch || this.disposed) throw new ServiceRefusal("account changed");
      // A Cancel that landed while the lease cleanup was running must stop the
      // write, not merely be noticed after it.
      this.assertAttempt(mine);

      await session.store.put(BEARER_KEY, accessToken);
      const changed = this.epoch !== mineEpoch || this.disposed;
      const fault = changed ? "account changed" : this.faultReason(mine);
      if (fault !== null) {
        // Superseded, cancelled or expired while the write was in flight.
        // Leaving the bearer is the exact "signed out with a token on disk"
        // state this whole path guards against.
        await this.compensate(mine, session, accessToken);
        throw new ServiceRefusal(mine.compensation ?? fault);
      }
      this.attempt = null;
      this.accountEmail = accountEmail;
      return { status: "ok", accountEmail };
    });
  }

  private faultReason(mine: Attempt): string | null {
    const fault = this.attemptFault(mine);
    return fault === null ? null : FAULT_REASON[fault];
  }

  /**
   * Remove the credential a refused adoption had already written — and say so
   * when that cannot be done.
   *
   * Two properties, both required:
   *
   *   * **It cannot delete an unrelated newer bearer.** Transitions are
   *     serialized, so no other adoption can have run since the `put` above.
   *     The value is nevertheless read back and compared, so ownership is
   *     PROVEN rather than argued from the scheduler's behaviour.
   *   * **Failure is recorded, never swallowed.** A cancellation that leaves a
   *     token on disk is not a cancellation, and reporting it as one is the
   *     precise lie this revision exists to remove. `cancelSignIn` joins this
   *     work and surfaces whatever it records.
   */
  private async compensate(mine: Attempt, session: Session, written: string): Promise<void> {
    let stored: string;
    try {
      stored = await session.store.get(BEARER_KEY);
    } catch (err) {
      // Already absent is the good case: there is nothing left to remove.
      if (err instanceof SecretStoreError && err.code === "not-found") return;
      mine.compensation = `cancelled sign-in could not read back its own credential: ${String(err)}`;
      return;
    }
    if (stored !== written) {
      // Unreachable while transitions are serialized, which is why it is
      // reported rather than assumed away: deleting a credential this attempt
      // cannot prove it wrote is worse than reporting that one is there.
      mine.compensation = "cancelled sign-in found a different stored credential and left it alone";
      return;
    }
    try {
      await session.store.delete(BEARER_KEY);
    } catch (err) {
      mine.compensation = `cancelled sign-in could not remove the credential it wrote: ${String(err)}`;
    }
  }

  /**
   * Abandon a sign-in attempt.
   *
   * This is NOT sign-out wearing another name. It never bumps the epoch and
   * never deletes a bearer, so it cannot disturb an account that is already
   * signed in — including the account of an adoption that legitimately beat the
   * user's click, which is reported as the signed-in state it truthfully is.
   *
   * A nonce that does not name the current attempt is a safe no-op: a renderer
   * that raced its own state must not be able to kill a NEWER attempt.
   */
  async cancelSignIn(nonce: string): Promise<CancelSignInResult> {
    if (nonce.length === 0 || nonce.length > MAX_ATTEMPT_NONCE_LENGTH) {
      throw new ServiceRefusal("malformed sign-in nonce");
    }
    const mine = this.attempt;
    const mineIsCurrent = mine !== null && mine.nonce === nonce && !mine.cancelled;
    if (mineIsCurrent) {
      // Synchronous, before any await: an adoption suspended in its own await,
      // or already queued behind another transition, fails its next re-check
      // rather than racing this call.
      this.retire(mine);
    }
    // Recorded whether or not it matched, so a Cancel that overtook its own
    // `start` still refuses that start when it arrives.
    this.cancelledNonces.add(nonce);

    // Join a racing adoption, so this call does not return while a transition
    // it just invalidated is still unwinding — including its compensating
    // deletion, whose failure is the thing the caller most needs to hear about.
    await this.transitionTail.catch(() => undefined);

    return {
      state: await this.authState(),
      cleanupFailure: mine !== null && mine.nonce === nonce ? mine.compensation : null,
    };
  }

  async signOut(): Promise<{ signedIn: false }> {
    const session = await this.session();
    return this.runTransition(async () => {
      // Bump first, so anything mid-await fails its next re-check; and because
      // this runs as a queued transition, a poll that was adopting an account
      // has already finished and this deletion lands after its write.
      this.epoch += 1;
      this.notifyAuthorityChange();
      this.accountEmail = "";
      // Any sign-in in flight belongs to the session being ended.
      if (this.attempt !== null) this.retire(this.attempt);
    this.notifyAuthorityChange();
      await this.cancelLeases();
      // Only the bearer. The installation identity is a different key and is
      // never cleared, or signing back in would mint a third device row.
      await session.store.delete(BEARER_KEY);
      return { signedIn: false };
    });
  }

  /**
   * Mint a pairing code, under the authority that asked for it.
   *
   * ## The stale-result rule, and why it is the whole point of this method
   *
   * Minting is a privileged authenticated request that takes network time, and
   * two things can change while it is in flight: the account (sign-out, or a
   * different account signing in) and the document (a reload). A code minted
   * under the old account and installed into the new one's screen is that
   * account's pairing code, offered to whoever is looking at the app now — and
   * it is a live credential admitting a peer to a room.
   *
   * So both identities are captured BEFORE the first await and re-checked
   * after every one, exactly as `openReceive` does. A result that survives to a
   * retired authority is REFUSED rather than returned: the code is already
   * minted server-side and will expire on its own, and handing it to a screen
   * that should not have it is the failure being prevented.
   *
   * The bearer is read here and passed to the transport, so nothing that holds
   * a store also holds a URL.
   */
  async createPairCode(): Promise<PairMintResult> {
    const control = this.deps.makePairControl?.();
    if (!control) return { ok: false, refusal: "unavailable" };

    const captured = this.currentEpoch();
    const document = this.currentDocument();

    let session: Session;
    try {
      session = await this.session();
    } catch {
      // An unusable store is not "signed out" — but for THIS action the user's
      // next step is the same, and claiming a session state we cannot read
      // would be worse than the honest generic answer.
      return { ok: false, refusal: "unavailable" };
    }
    this.assertEpoch(captured);
    this.assertDocument(document);

    let bearer: string | null;
    try {
      bearer = await session.store.get(BEARER_KEY);
    } catch {
      return { ok: false, refusal: "unavailable" };
    }
    this.assertEpoch(captured);
    this.assertDocument(document);
    // Preflight, so the user is told to sign in instead of watching a request
    // fail. Truthful about what it checked: this is "no credential held", not
    // "the server rejected you".
    if (!bearer) return { ok: false, refusal: "signed-out" };

    const abort = new AbortController();
    // The request is abandoned if the authority that started it goes away,
    // rather than left running for an answer nobody may install.
    const release = this.onAuthorityChange(captured, document, () => abort.abort());
    let result: PairMintResult;
    try {
      result = await control.mint(bearer, abort.signal);
    } finally {
      release();
    }

    // The re-check that matters. A code that arrived after a sign-out, an
    // account switch or a reload is not this screen's to install.
    if (this.disposed || captured !== this.epoch || document !== this.currentDocument()) {
      throw new ServiceRefusal("authority changed");
    }
    return result;
  }

  /**
   * Call `onChange` when the account or the document moves away from what an
   * in-flight operation captured. Returns its own release.
   *
   * Polling-free and cheap: transitions already funnel through `runTransition`
   * and revocation through `revokeDocument`, so this only has to be woken by
   * those. It is registered as a lease-independent watcher because a mint holds
   * no lease.
   */
  private onAuthorityChange(epoch: number, document: number, onChange: () => void): () => void {
    const watcher = () => {
      if (epoch !== this.epoch || document !== this.currentDocument() || this.disposed) onChange();
    };
    this.authorityWatchers.add(watcher);
    return () => this.authorityWatchers.delete(watcher);
  }

  /** Wake every in-flight operation that captured an authority. */
  private notifyAuthorityChange(): void {
    for (const watcher of [...this.authorityWatchers]) {
      try {
        watcher();
      } catch {
        // One watcher's failure must not strand the others.
      }
    }
  }

  /**
   * Everything this process currently owns a receive resource for, or is about
   * to: registered leases, opens in flight, and cleanups that have not
   * succeeded. `exclude` is the caller's own pending open, which is already
   * registered by the time the second check runs.
   */
  private ownedReceives(exclude?: PendingOpen): number {
    const opening = exclude && this.opening.has(exclude) ? this.opening.size - 1 : this.opening.size;
    return this.leases.size + opening + this.retiring.size;
  }

  /** Refuse rather than grow. See `MAX_OWNED_RECEIVES`. */
  private assertAdmission(exclude?: PendingOpen): void {
    if (this.disposed) throw new ServiceRefusal("service disposed");
    if (this.quiescing) throw new ServiceRefusal("shutting down");
    if (this.admissionFenced) throw new ServiceRefusal("quit in progress");
    const owned = this.ownedReceives(exclude);
    if (owned >= MAX_OWNED_RECEIVES) {
      throw new ServiceRefusal(
        `too many transfers are still open (${owned}); finish or cancel one first`,
      );
    }
  }

  /**
   * Choose a destination and open a validated lease.
   *
   * The authority is captured BEFORE the picker opens. Reading it afterwards
   * would stamp a lease begun under the old account with the new account's
   * authority — the picker is a dialog the user can sit in front of for minutes.
   */
  async openReceive(
    manifest: readonly ManifestEntry[],
    authority: ReceiveAuthority = "account",
  ): Promise<{ cancelled: true } | { leaseId: string; files: number }> {
    const captured = this.currentEpoch();
    // Captured BEFORE any await, both of them. The picker is a dialog the user
    // can sit in front of for minutes, and either identity can change while
    // they do: the account, and the document. Reading either afterwards would
    // stamp a lease begun under the old one with the new one's authority.
    const document = this.currentDocument();

    // Registered before the first await, so a teardown running while the picker
    // is open has something to find and to join. Without it, `dispose` returns
    // clean and the destination lands afterwards with nothing left to finish
    // it — and with a native helper behind the adapter, that is a child process
    // spawned after quit.
    // Before the pending open is registered and therefore before the picker:
    // a refusal must not put a native folder dialog on screen that it was
    // always going to reject.
    this.assertAdmission();

    let markSettled!: () => void;
    const pending: PendingOpen = {
      authority,
      epoch: captured,
      document,
      phase: "picking",
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
      cancelled: false,
    };
    this.opening.add(pending);

    try {
      // The account path is untouched, down to the ordering: the session is
      // required before the picker opens, and the epoch is re-checked after
      // every await. `direct` skips exactly this — it needs no store, no
      // installation identity and no bearer, which is what lets a signed-out
      // LAN transfer work even when encrypted account storage is unreadable.
      if (authority === "account") {
        await this.session();
        this.assertEpoch(captured);
      }
      this.assertDocument(document);
      if (pending.cancelled) throw new ServiceRefusal("receive cancelled");

      const directory = await this.deps.pickDirectory();
      if (authority === "account") this.assertEpoch(captured);
      this.assertDocument(document);
      if (pending.cancelled) throw new ServiceRefusal("receive cancelled");
      if (directory === null) return { cancelled: true };

      // From here a destination can exist, so a teardown must wait for this.
      // Set AFTER the fence checks above, so an open that was already cancelled
      // never enters the window at all.
      pending.phase = "creating";

      // Re-checked immediately before the destination is built, because that is
      // where a helper child process is spawned and the picker is a dialog the
      // user can sit in front of for minutes — long enough for other transfers
      // to open, or for cleanups to start failing.
      this.assertAdmission(pending);

      const id = this.deps.newId();
      const adapter = await this.openDestination({
        id,
        authorityId: this.authorityFor(authority, captured),
        rootPath: directory,
        manifest,
      });

      // Re-checked after the open, too: creating the destination is IO and both
      // identities can change during it. Anything that survived to here under a
      // retired authority is cleaned up rather than registered.
      const accountStale = authority === "account" && captured !== this.epoch;
      const documentStale = document !== this.currentDocument();
      if (accountStale || documentStale || this.disposed || pending.cancelled) {
        // REGISTERED before the cancel is awaited, not cancelled-and-forgotten.
        //
        // This destination exists on disk and holds a handle, and the cancel
        // about to run against it can fail. A bare `await adapter.cancel()`
        // here — however carefully its error was recorded — was the last
        // reference to the only object that can close it: the lease was never
        // in `leases`, so nothing else could find it, and a later teardown had
        // no way to try again. It reported a clean sweep over a live resource.
        //
        // Handing it to the retirement registry first means the failure leaves
        // an OWNED entry behind. The teardown that fenced this open rescans
        // after joining it and retries; so does any later one.
        const stale = newLeaseEntry({ adapter, authority, epoch: captured, document });
        await this.retireEntry(stale).catch(() => undefined);
        throw new ServiceRefusal(
          accountStale ? "account changed" : documentStale ? "document changed" : "service disposed",
        );
      }
      this.leases.set(id, newLeaseEntry({ adapter, authority, epoch: captured, document }));
      return { leaseId: id, files: adapter.fileCount };
    } finally {
      this.opening.delete(pending);
      markSettled();
    }
  }

  /**
   * The production destination, or the one a caller injected.
   *
   * One or the other, never both: opening a `ReceiveLease` alongside a native
   * client would create a staging directory nothing writes to and nothing
   * cleans up.
   */
  private openDestination(options: {
    readonly id: string;
    readonly authorityId: string;
    readonly rootPath: string;
    readonly manifest: readonly ManifestEntry[];
  }): Promise<NativeReceiveAdapter> {
    if (this.deps.makeDestination) return this.deps.makeDestination(options);
    if (process.platform === "win32") {
      // No `spawnHelper`: the client defaults to the bundled executable, and an
      // injectable spawn reachable from here would be a way to point a
      // privileged child process somewhere else.
      return NativeHelperDestination.open({
        authorityId: options.authorityId,
        rootPath: options.rootPath,
        manifest: options.manifest.map((entry) => ({ name: entry.name, size: entry.size })),
      });
    }
    // Not Windows. Staging is real and publication refuses, truthfully.
    return ReceiveLease.open(options).then((lease) => new LeaseReceiveAdapter(lease));
  }

  private entryFor(leaseId: string): LeaseEntry {
    const entry = this.leases.get(leaseId);
    if (!entry) throw new ServiceRefusal("unknown lease");
    // An account lease is fenced exactly as before, INCLUDING the refusal while
    // a transition is running. A direct lease is not, and must not be: the
    // whole point is that a sign-in happening elsewhere does not interrupt it.
    if (entry.authority === "account") this.assertEpoch(entry.epoch);
    // Both authorities are fenced on the document, and a lease whose terminal
    // publication has begun accepts no further work of any kind.
    this.assertDocument(entry.document);
    if (entry.terminal) throw new ServiceRefusal("publication in progress");
    entry.adapter.assertAuthority(this.authorityFor(entry.authority, entry.epoch));
    return entry;
  }

  private leaseFor(leaseId: string): NativeReceiveAdapter {
    return this.entryFor(leaseId).adapter;
  }

  async beginFile(leaseId: string, index: number): Promise<void> {
    await this.leaseFor(leaseId).begin(index);
  }

  async writeChunk(leaseId: string, index: number, chunk: Uint8Array): Promise<void> {
    await this.leaseFor(leaseId).write(index, chunk);
  }

  async finishFile(leaseId: string, index: number): Promise<void> {
    await this.leaseFor(leaseId).finish(index);
  }

  /**
   * The terminal step, and the only one that means "saved".
   *
   * ## The lease stays registered until this actually settles
   *
   * Not until it is STARTED. A publication is the one operation that writes to
   * the user's chosen names, so while it runs this process still owns files —
   * and an account transition, a document revocation or a quit that could not
   * see the lease would join nothing, cancel nothing, and return reporting a
   * teardown it had not performed. `terminal` is what those three join, and
   * removing the entry only in the `finally` is what keeps it joinable for the
   * whole operation rather than for the instant before it.
   *
   * The id is forgotten afterwards whatever the outcome: a `partial` has moved
   * some files under their final names and cannot be retried against the same
   * staging set, and a rejection has already run its own cleanup.
   */
  async publishReceive(leaseId: string): Promise<PublishReport> {
    const entry = this.entryFor(leaseId);
    const run = (async (): Promise<PublishReport> => {
      // Always resolves — with a receipt, a truthful `partial`, or a typed
      // `failed`. It does not reject, because an Error crossing Electron IPC
      // arrives as its message with every named field gone, and the fields here
      // are what a person acts on: was anything saved, is anything left behind.
      const report = await entry.adapter.publish();
      if (report.status !== "complete") {
        // Whatever is still staged is this app's to remove. The report is what
        // the caller is told; a cleanup that ALSO fails leaves the lease OWNED
        // and is surfaced — and retried — by the next teardown rather than
        // replacing the report.
        //
        // Through the retirement registry, so a failure here is not the end of
        // the adapter. `entry` has already left `leases` by the time this
        // settles, so a bare `cancel()` whose rejection was merely recorded
        // dropped the last reference to a destination that was still open: the
        // report said `failed`/`partial` with residue, and every later
        // revocation and quit reported a clean teardown over it.
        //
        // Skipped entirely if a teardown already owns this lease's retirement.
        // That retirement is awaiting `terminal` — this very run — and will
        // cancel the moment it resolves, so running our own cancel would race
        // it for the same files, and JOINING it would be this run waiting on a
        // promise that is waiting on this run.
        if (!entry.retirement) {
          await this.startCleanup(entry, () => entry.adapter.cancel()).catch(() => undefined);
        }
      }
      return report;
    })();
    // Never rejects. A teardown joins this to know the write has STOPPED.
    entry.terminal = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.leases.delete(leaseId);
    }
  }

  async cancelReceive(leaseId: string): Promise<void> {
    const entry = this.leases.get(leaseId);
    if (!entry) throw new ServiceRefusal("unknown lease");
    this.leases.delete(leaseId);
    // The SHARED retirement, not a private one. A cancel that arrives during a
    // publication waits for it rather than racing it for the same files — and,
    // because the entry stays in `retiring` until this settles, a quit or an
    // account transition that starts meanwhile joins this exact operation
    // instead of finding an empty map and returning.
    await this.retireEntry(entry);
  }

  /**
   * Stop admitting new receives. Nothing in flight is touched.
   *
   * Held across the risk snapshot and the confirmation, so a "nothing at stake"
   * answer cannot be overtaken by a transfer that started while the user was
   * reading the dialog — the quit that follows would stop it unannounced.
   * Idempotent; `admitReceives()` is the only thing that clears it.
   */
  fenceReceives(): void {
    this.admissionFenced = true;
  }

  /** The user stayed. New receives are allowed again. */
  admitReceives(): void {
    this.admissionFenced = false;
  }

  /**
   * Recoverable teardown: cancel, join, and stay usable.
   *
   * Everything `dispose()` does except the part that cannot be undone. New work
   * is refused, the in-flight sign-in is retired, every lease is cancelled and
   * joined, and the secret store's queued operations are joined — in that
   * order, because a cancel can write, and joining before the cancels would
   * return with a write still to come.
   *
   * A human-held folder dialog is FENCED, never awaited: quit must not hang
   * until someone clicks, and the fence already stops that open registering
   * anything (see `retireLeases`).
   *
   * Never throws. What could not be closed comes back as counts; those
   * destinations stay owned and a later attempt retries them.
   */
  async quiesce(): Promise<CleanupOutcome> {
    this.quiescing = true;
    this.admissionFenced = true;
    // Synchronously, so a poll suspended in an await fails its next re-check.
    if (this.attempt !== null) this.retire(this.attempt);

    // An adoption or a sign-out that is mid-flight is main's own work, and it
    // WRITES: letting it run past this point is how a bearer lands on disk
    // after a teardown said everything had stopped.
    await this.transitionTail.catch(() => undefined);

    let firstReason: string | null = null;
    try {
      await this.retireLeases(() => true);
    } catch (err) {
      firstReason = reasonOf(err);
    }

    // The initialisation itself, even when no session exists yet: a store being
    // built right now is active work, and skipping it because `session()` has
    // not resolved is how a join returns before the identity is written.
    const pending = this.sessionPromise;
    if (pending) {
      const session = await pending.catch(() => null);
      // Joined, never started. Building a store here would be new work at the
      // exact moment new work is being refused.
      if (session) await session.store.waitIdle().catch(() => undefined);
    }

    return this.cleanupOutcome(firstReason);
  }

  /**
   * The user stayed. Be usable again.
   *
   * Deliberately does NOT restore anything that was cancelled: the rooms are
   * the renderer's and were told to stop, the sign-in was retired, and a lease
   * that was cancelled is gone. What returns is the ability to start new work.
   */
  resume(): void {
    if (this.disposed) return;
    this.quiescing = false;
    this.admissionFenced = false;
  }

  /** What is still held right now. Safe to call at any point. */
  cleanupOutcome(firstReason: string | null = null): CleanupOutcome {
    let reason = firstReason;
    if (reason === null) {
      for (const entry of this.retiring) {
        if (entry.lastCleanupReason !== null) {
          reason = entry.lastCleanupReason;
          break;
        }
      }
    }
    return {
      openLeases: this.leases.size,
      opening: this.opening.size,
      unresolved: this.retiring.size,
      // The service owns no sockets; whoever does adds its own count.
      networkUnsettled: 0,
      firstReason: reason,
    };
  }

  /**
   * Everything main holds a receive resource for, or might.
   *
   * Deliberately conservative and deliberately not `openLeaseCount`: an open
   * still inside the picker, and a destination whose cleanup failed, are both
   * work this process is responsible for. A quit prompt that counted only
   * registered leases would call that "nothing at stake".
   */
  get heldReceiveCount(): number {
    return this.ownedReceives();
  }

  /**
   * Owned teardown, for window destruction and quit.
   *
   * Without it, a quit during a transfer leaves staged bytes in the user's
   * chosen folder and a pending sign-in that nothing will ever complete.
   */
  dispose(): Promise<void> {
    // Cached in full, like the lease's own cancellation: a second caller must
    // wait for the CLEANUP, not merely observe that a first caller started one.
    if (this.disposal) return this.disposal;
    this.disposed = true;
    // Synchronously, like every other cancellation: a start or poll suspended
    // in an await must fail its next re-check rather than complete into a
    // service that is going away.
    if (this.attempt !== null) this.retire(this.attempt);
    const disposal = (async () => {
      // Let an in-flight transition unwind before deleting what it is using.
      await this.transitionTail.catch(() => undefined);
      // EVERY lease, both authorities, INCLUDING any whose cleanup an explicit
      // cancel already started. Quit is the one teardown a direct lease does
      // not survive: the app is going away, and staged bytes with no process to
      // finish them are exactly the residue `dispose` exists to remove.
      try {
        await this.retireLeases(() => true);
      } catch (err) {
        throw new ServiceRefusal(`could not clean up transfers on shutdown: ${reasonOf(err)}`);
      }
    })();
    this.disposal = disposal;
    // A SUCCESSFUL disposal stays cached forever: the leases are closed, and a
    // second caller must see that one teardown happened, not start another.
    //
    // A FAILED one is not cached, and this is deliberately not the same thing
    // as staying alive. The service remains disposed — `disposed` is already
    // true, nothing new is accepted, and this is not a resume. What the cleared
    // cache buys is that the destinations this teardown could not close, which
    // are still owned in `retiring`, can be attempted again: a caller that
    // reacts to a failed quit by trying once more used to be handed the same
    // stale rejection, with no attempt made and the handles still open. One
    // attempt per call is what keeps this a retry rather than a spin: a caller
    // that asks twice gets two attempts, not a loop.
    void disposal.catch(() => {
      if (this.disposal === disposal) this.disposal = null;
    });
    return disposal;
  }

  /** Test/diagnostic only. */
  get openLeaseCount(): number {
    return this.leases.size;
  }
}

export type { ReceiveLeaseError };
