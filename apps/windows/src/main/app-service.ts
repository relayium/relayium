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

import { MAX_ATTEMPT_NONCE_LENGTH } from "../shared/ipc-contract.js";
import { BEARER_KEY, approvalURL, type DeviceAuthClient } from "./account/device-auth.js";
import { loadOrMintInstallID } from "./account/install-id.js";
import { ReceiveLease, type ReceiveLeaseError } from "./io/receive-lease.js";
import { SecretStoreError, type SecretStore } from "./secrets.js";
import type { ManifestEntry } from "./io/plan.js";

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
  /** The native folder picker. `null` when the user cancelled. */
  pickDirectory(): Promise<string | null>;
  /** Hand the validated approval URL to the browser. */
  openApproval(url: string): Promise<boolean>;
  newId(): string;
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
  private readonly leases = new Map<string, { lease: ReceiveLease; epoch: number }>();
  private disposed = false;
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

  /** Cancel and forget every lease. Failures are surfaced, never swallowed. */
  private async cancelLeases(): Promise<void> {
    const retiring = [...this.leases.values()];
    this.leases.clear();
    const failures: unknown[] = [];
    for (const entry of retiring) {
      await entry.lease.cancel().catch((err: unknown) => failures.push(err));
    }
    if (failures.length > 0) {
      throw new ServiceRefusal(`could not clean up ${failures.length} transfer(s)`);
    }
  }

  /** The authority string a lease is fenced on. */
  private authorityFor(epoch: number): string {
    return `epoch-${epoch}`;
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
      this.accountEmail = "";
      // Any sign-in in flight belongs to the session being ended.
      if (this.attempt !== null) this.retire(this.attempt);
      await this.cancelLeases();
      // Only the bearer. The installation identity is a different key and is
      // never cleared, or signing back in would mint a third device row.
      await session.store.delete(BEARER_KEY);
      return { signedIn: false };
    });
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
  ): Promise<{ cancelled: true } | { leaseId: string; files: number }> {
    const captured = this.currentEpoch();
    await this.session();
    this.assertEpoch(captured);

    const directory = await this.deps.pickDirectory();
    this.assertEpoch(captured);
    if (directory === null) return { cancelled: true };

    const id = this.deps.newId();
    const lease = await ReceiveLease.open({
      id,
      authorityId: this.authorityFor(captured),
      rootPath: directory,
      manifest,
    });
    // Re-checked after the open, too: creating the staging directory is IO and
    // the account can change during it. A lease that survived to here under a
    // retired epoch is cancelled rather than registered.
    if (captured !== this.epoch || this.disposed) {
      await lease.cancel().catch(() => undefined);
      throw new ServiceRefusal("account changed");
    }
    this.leases.set(id, { lease, epoch: captured });
    return { leaseId: id, files: lease.files.length };
  }

  private leaseFor(leaseId: string): ReceiveLease {
    const entry = this.leases.get(leaseId);
    if (!entry) throw new ServiceRefusal("unknown lease");
    this.assertEpoch(entry.epoch);
    entry.lease.assertAuthority(this.authorityFor(entry.epoch));
    return entry.lease;
  }

  async beginFile(leaseId: string, index: number): Promise<void> {
    await this.leaseFor(leaseId).beginFile(index);
  }

  async writeChunk(leaseId: string, index: number, chunk: Uint8Array): Promise<void> {
    await this.leaseFor(leaseId).writeChunk(index, chunk);
  }

  async finishFile(leaseId: string, index: number): Promise<void> {
    await this.leaseFor(leaseId).finishFile(index);
  }

  async cancelReceive(leaseId: string): Promise<void> {
    const entry = this.leases.get(leaseId);
    if (!entry) throw new ServiceRefusal("unknown lease");
    this.leases.delete(leaseId);
    await entry.lease.cancel();
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
    this.disposal = (async () => {
      // Let an in-flight transition unwind before deleting what it is using.
      await this.transitionTail.catch(() => undefined);
      const open = [...this.leases.values()];
      this.leases.clear();
      const failures: unknown[] = [];
      for (const entry of open) {
        await entry.lease.cancel().catch((err: unknown) => failures.push(err));
      }
      if (failures.length > 0) {
        throw new ServiceRefusal(`could not clean up ${failures.length} transfer(s) on shutdown`);
      }
    })();
    return this.disposal;
  }

  /** Test/diagnostic only. */
  get openLeaseCount(): number {
    return this.leases.size;
  }
}

export type { ReceiveLeaseError };
