// The sign-in lifecycle the shell actually runs.
//
// ## Why this is not inside App.svelte
//
// It used to be, and that is where the defect lived: a `cancel` that cleared two
// timers and assigned `signedOut` while a poll was still in flight, so the poll's
// late `ok` ran `refresh()` and signed the user in after they had cancelled.
// Rules of that shape need a test that drives them through real interleavings,
// and a rule that only exists inside a component's `<script>` cannot be driven
// at all without a DOM.
//
// So the lifecycle lives here, as a plain class with injected timers and clock,
// and `App.svelte` owns exactly one thing: turning the phase it is handed into
// markup. This is the component's real implementation — not a replica of it.
// A test that drives this class is driving the shipped renderer's behaviour.
//
// ## The generation fence
//
// Every asynchronous step captures `generation` on entry and re-checks it after
// EVERY await. Cancel, expiry, a new sign-in, a terminal outcome and teardown
// all bump it. A step whose generation is stale returns without touching state:
// it publishes no success, no failure, and — the one that caused the bug — no
// rescheduled poll.
//
// ## The renderer is not the authority
//
// This fence stops a stale response from being *rendered*. It cannot stop a
// credential from being *kept*, because the credential never comes here: the
// main process holds it and decides. Cancel therefore calls main and renders
// what main reports. If the adoption legitimately beat the click, "signed in" is
// the truth and this shows it rather than a comfortable lie.

import type { AuthState } from "../shared/ipc-contract";

export type Phase =
  | { kind: "loading" }
  | { kind: "signedOut" }
  /** A `start` is in flight. Cancel is available here — that is the whole
   *  reason the nonce is minted before the call. */
  | { kind: "starting" }
  | { kind: "waiting"; userCode: string; secondsLeft: number }
  | { kind: "cancelling" }
  | { kind: "signedIn"; accountEmail: string }
  | { kind: "storeProblem"; health: "unreadable" | "unavailable" }
  | { kind: "failed"; message: string };

export interface AppInfoView {
  readonly origin: string;
  readonly version: string;
  readonly banner: string | null;
  /** Whether same-network discovery starts on its own. False only in an
   *  engineering build told to stay out of the room. */
  readonly lanAutoStart?: boolean;
}

export interface CancelResult {
  readonly state: AuthState;
  readonly cleanupFailure: string | null;
}

export interface SignInBridge {
  appInfo(): Promise<AppInfoView>;
  auth: {
    start(payload: { nonce: string }): Promise<{
      attemptNonce: string;
      userCode: string;
      interval: number;
      expiresIn: number;
    }>;
    poll(payload: { nonce: string }): Promise<{ status: string; accountEmail?: string }>;
    cancel(payload: { nonce: string }): Promise<CancelResult>;
    signOut(): Promise<unknown>;
    state(): Promise<AuthState>;
  };
}

export interface SignInControllerDeps {
  readonly bridge: SignInBridge;
  readonly onPhase: (phase: Phase) => void;
  readonly onInfo: (info: AppInfoView) => void;
  /** Injected so tests drive interleavings with barriers instead of real time. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** The attempt nonce. Injected only so a test can predict it. */
  readonly newNonce?: () => string;
}

/**
 * A name for one sign-in attempt, minted BEFORE `start` is called.
 *
 * `getRandomValues` rather than `randomUUID`: the latter needs a secure context
 * and this page is served over a custom `app:` scheme. Unguessability is not the
 * point — the nonce authorises nothing — but a collision between two attempts
 * would let one cancel the other, so it is random rather than a counter.
 */
const defaultNonce = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export class SignInController {
  private phaseValue: Phase = { kind: "loading" };
  /** Bumped by every event that invalidates work in flight. */
  private generation = 0;
  private disposed = false;
  private starting = false;
  private pollTimer: unknown = null;
  private countdownTimer: unknown = null;
  /** Actual wall-clock deadline. NOT a decremented tick count: an interval that
   *  is throttled or starved drifts, and the drift is always in the direction of
   *  claiming a dead code is still alive. */
  private deadlineAt: number | null = null;
  private nonce: string | null = null;

  constructor(private readonly deps: SignInControllerDeps) {}

  get phase(): Phase {
    return this.phaseValue;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle === null) return;
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private startInterval(fn: () => void, ms: number): unknown {
    return this.deps.setInterval ? this.deps.setInterval(fn, ms) : setInterval(fn, ms);
  }

  private stopInterval(handle: unknown): void {
    if (handle === null) return;
    if (this.deps.clearInterval) this.deps.clearInterval(handle);
    else clearInterval(handle as ReturnType<typeof setInterval>);
  }

  private setPhase(next: Phase): void {
    this.phaseValue = next;
    this.deps.onPhase(next);
  }

  /**
   * The single fence. Everything that invalidates work in flight goes through
   * here, so there is one place to read and no way to bump the generation while
   * forgetting to stop a timer.
   */
  private bump(): number {
    this.generation += 1;
    this.clearTimer(this.pollTimer);
    this.stopInterval(this.countdownTimer);
    this.pollTimer = null;
    this.countdownTimer = null;
    this.deadlineAt = null;
    this.starting = false;
    return this.generation;
  }

  /** Re-checked after EVERY await. A stale step publishes nothing at all. */
  private alive(gen: number): boolean {
    return !this.disposed && gen === this.generation;
  }

  private applyState(state: AuthState): void {
    // A store that cannot be opened is NOT "signed out". Offering an ordinary
    // Sign in button here sends the user round a loop that cannot succeed,
    // because the credential could not be written even if they finished.
    if (state.store !== "ok") {
      this.setPhase({ kind: "storeProblem", health: state.store });
      return;
    }
    this.setPhase(
      state.signedIn
        ? { kind: "signedIn", accountEmail: state.accountEmail }
        : { kind: "signedOut" },
    );
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const gen = this.generation;
    try {
      const info = await this.deps.bridge.appInfo();
      if (!this.alive(gen)) return;
      this.deps.onInfo(info);
      const state = await this.deps.bridge.auth.state();
      if (!this.alive(gen)) return;
      this.applyState(state);
    } catch (err) {
      if (!this.alive(gen)) return;
      this.setPhase({ kind: "failed", message: String(err) });
    }
  }

  /**
   * Begin a sign-in.
   *
   * One starting action at a time, guarded here as well as by the disabled
   * button: a double-invoke from a keyboard repeat or a slow click must not open
   * two device codes, and the second would silently supersede the first in main.
   */
  async signIn(): Promise<void> {
    // Checked before a nonce is minted or an IPC call is made: a torn-down
    // component must not open a device code in the main process on its way out.
    if (this.disposed) return;
    if (this.starting || this.phaseValue.kind === "waiting") return;
    const gen = this.bump();
    this.starting = true;
    // Minted BEFORE the call, so Cancel has something to name while `start` is
    // still in flight. See `ipc-contract.ts`.
    const nonce = (this.deps.newNonce ?? defaultNonce)();
    this.nonce = nonce;
    this.setPhase({ kind: "starting" });

    let started: { userCode: string; interval: number; expiresIn: number };
    try {
      started = await this.deps.bridge.auth.start({ nonce });
    } catch (err) {
      // A failure for an attempt nobody is waiting on is not shown. Rendering it
      // would replace whatever the user is looking at NOW with the corpse of
      // something they already cancelled.
      if (!this.alive(gen)) return;
      this.starting = false;
      this.setPhase({ kind: "failed", message: String(err) });
      return;
    }

    if (!this.alive(gen)) {
      // Cancelled or torn down while `start` was in flight. Main was already
      // told — cancellation is synchronous there and the nonce was known before
      // the call — but the cancel may have overtaken the start on the way, so
      // this names the attempt one more time. Best effort: main is the
      // authority and enforces its own deadline regardless.
      void this.deps.bridge.auth.cancel({ nonce }).catch(() => undefined);
      return;
    }

    this.starting = false;
    this.deadlineAt = this.now() + started.expiresIn * 1000;
    this.setPhase({ kind: "waiting", userCode: started.userCode, secondsLeft: started.expiresIn });

    this.countdownTimer = this.startInterval(() => this.tickCountdown(gen), 1000);
    // The server's own interval, not one invented here: polling faster than it
    // asks for is what gets a client rate-limited.
    this.schedulePoll(gen, started.interval * 1000);
  }

  private tickCountdown(gen: number): void {
    if (!this.alive(gen) || this.deadlineAt === null) return;
    const left = Math.ceil((this.deadlineAt - this.now()) / 1000);
    if (left <= 0) {
      this.expire(gen);
      return;
    }
    if (this.phaseValue.kind === "waiting") {
      this.setPhase({ ...this.phaseValue, secondsLeft: left });
    }
  }

  private schedulePoll(gen: number, delayMs: number): void {
    this.pollTimer = this.setTimer(() => {
      void this.poll(gen, delayMs);
    }, delayMs);
  }

  private async poll(gen: number, intervalMs: number): Promise<void> {
    if (!this.alive(gen)) return;
    this.pollTimer = null;
    const nonce = this.nonce;
    if (nonce === null) return;
    // Checked here too, not only in the countdown: a starved or throttled timer
    // must not issue a poll for a code that has already expired.
    if (this.deadlineAt !== null && this.now() >= this.deadlineAt) {
      this.expire(gen);
      return;
    }

    let outcome: { status: string };
    try {
      outcome = await this.deps.bridge.auth.poll({ nonce });
    } catch (err) {
      if (!this.alive(gen)) return;
      this.bump();
      this.setPhase({ kind: "failed", message: String(err) });
      return;
    }

    // THE fence. Without it a late `ok` calls `refresh()` and signs in a user
    // who cancelled, and a late `pending` schedules another poll for an attempt
    // that no longer exists.
    if (!this.alive(gen)) return;

    if (outcome.status === "authorization_pending" || outcome.status === "pending") {
      this.schedulePoll(gen, intervalMs);
      return;
    }
    this.bump();
    this.nonce = null;
    if (outcome.status === "ok") {
      await this.refresh();
      return;
    }
    if (outcome.status === "denied") {
      this.setPhase({ kind: "failed", message: "That sign-in was declined." });
      return;
    }
    this.setPhase({ kind: "failed", message: "That code expired. Try signing in again." });
  }

  private expire(gen: number): void {
    if (!this.alive(gen)) return;
    const nonce = this.nonce;
    this.bump();
    this.nonce = null;
    this.setPhase({ kind: "failed", message: "That code expired. Try signing in again." });
    // Best effort, and allowed to be: the main process enforces the same
    // deadline itself and refuses to adopt a success that arrives after it, so
    // nothing depends on this call landing.
    if (nonce !== null) void this.deps.bridge.auth.cancel({ nonce }).catch(() => undefined);
  }

  /**
   * Abandon the attempt.
   *
   * The local fence is bumped FIRST and synchronously, so a poll already in
   * flight is dead before this function yields. Then main is asked — main is
   * what actually decides whether a credential may be kept — and what it reports
   * is what gets rendered.
   */
  async cancel(): Promise<void> {
    // `dispose` already abandoned the attempt in main; a further call here would
    // be a second cancellation for an attempt that no longer exists.
    if (this.disposed) return;
    const nonce = this.nonce;
    const gen = this.bump();
    this.nonce = null;
    if (nonce === null) {
      // Nothing to abandon. Asking main rather than asserting "signed out":
      // this button should be unreachable in that state, and if it ever is
      // reached, guessing would be how a signed-in user gets told otherwise.
      await this.refresh();
      return;
    }
    this.setPhase({ kind: "cancelling" });
    try {
      const result = await this.deps.bridge.auth.cancel({ nonce });
      if (!this.alive(gen)) return;
      if (result.cleanupFailure !== null) {
        // Cancellation that could not remove the credential it wrote is a
        // failure, and saying "cancelled" here would be the exact untruth this
        // revision exists to remove.
        this.setPhase({ kind: "failed", message: result.cleanupFailure });
        return;
      }
      this.applyState(result.state);
    } catch (err) {
      if (!this.alive(gen)) return;
      this.setPhase({ kind: "failed", message: String(err) });
    }
  }

  async signOut(): Promise<void> {
    if (this.disposed) return;
    const gen = this.bump();
    this.nonce = null;
    try {
      await this.deps.bridge.auth.signOut();
      if (!this.alive(gen)) return;
      await this.refresh();
    } catch (err) {
      if (!this.alive(gen)) return;
      this.setPhase({ kind: "failed", message: String(err) });
    }
  }

  /**
   * Teardown.
   *
   * Clearing timers is not enough: an attempt this component started is alive in
   * the MAIN process, and leaving it there is a device code that stays pollable
   * until it expires. Main also disposes its own service when the window is
   * destroyed; this covers the case where the component goes away and the window
   * does not.
   */
  dispose(): void {
    if (this.disposed) return;
    const nonce = this.nonce;
    this.bump();
    this.disposed = true;
    this.nonce = null;
    if (nonce !== null) void this.deps.bridge.auth.cancel({ nonce }).catch(() => undefined);
  }
}
