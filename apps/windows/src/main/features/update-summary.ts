// The update pane's view of the accepted update core, and nothing more.
//
// `src/main/update/service.ts` owns the whole mechanism: the feed signature, the
// staged bytes, the publisher verdict, the single slot, the consent transaction
// and the journal. None of that is re-implemented, re-decided or wrapped in a
// second opinion here. This file does three things and stops:
//
//   1. REDUCES `UpdateState` to the renderer-safe contract, mapping every
//      free-form string onto a closed code;
//   2. computes the action gates from the core's OWN predicates, so a page never
//      infers an affordance from a state name;
//   3. owns the admission fence, the observer and the teardown that belong to a
//      host rather than to the mechanism.
//
// Construction, IPC, the daily timer and the resident consent adapter stay with
// RT. This offers the seam; it does not duplicate the wiring.
//
// ## The fence and the quit question are two steps
//
// `UpdateService.quiesce()` sets its fence AND aborts in one call. That is right
// for a quit that has already been agreed to, and wrong for the moment BEFORE
// the user has answered: aborting a download to ask "are you sure you want to
// quit?" cancels work the user may be about to keep.
//
// So this file holds its own admission fence. `fence()` refuses new actions and
// touches the core not at all — nothing in flight stops, nothing is aborted.
// Only `quiesce()`, after consent, calls the core's own quiesce, which aborts
// and joins and reports whether it actually reached quiet.
//
// ## Nothing free-form reaches a renderer
//
// Most of the core's reasons are closed codes, but not all: a consent decision's
// `reason` and a lease's `not-resumed:` detail are strings the HOST's adapter
// chooses. `reasonOf` maps against an allowlist and answers `other` for anything
// it does not recognise, so no adapter message, host name or path can arrive on
// screen or in a renderer log by accident.

import { canInstall, canReveal, type UpdateState } from "../update/state.js";
import type { UpdateService } from "../update/service.js";
import { FEED_URL } from "../update/trust.js";
import {
  UPDATE_SUMMARY_LOADING,
  isUpdateExternalTarget,
  type UpdateAction,
  type UpdateCandidateView,
  type UpdateExternalTarget,
  type UpdateReason,
  type UpdateResidueView,
  type UpdateStateView,
  type UpdateSummaryView,
} from "../../shared/update-summary.js";

/**
 * What this facade needs from the accepted core.
 *
 * A narrow structural `Pick`, so a signature change in the core is a compile
 * error HERE rather than a runtime shape mismatch. Nothing in this file
 * constructs an `UpdateService`, reads its private state, or reaches past these
 * eleven members.
 */
export type UpdateCore = Pick<
  UpdateService,
  | "current"
  | "subscribe"
  | "check"
  | "download"
  | "install"
  | "reveal"
  | "reverifyStaged"
  | "residue"
  | "automaticCheckDue"
  | "quiesce"
  | "resume"
>;

export interface UpdateSummaryDeps {
  readonly core: UpdateCore;
  /** This build's version, for "you are running X". Never from a renderer. */
  readonly currentVersion: string;
  /**
   * A new snapshot is available.
   *
   * Called AFTER the state is installed, and defensively: an observer may throw
   * and may re-enter. The core already isolates listener failures; this does the
   * same for its own so one bad observer cannot abandon a teardown.
   */
  onView?(view: UpdateSummaryView): void;
  /**
   * Open one already-validated URL. RT wires `openApprovedExternal`.
   *
   * The facade validates first and hands over a string it built from the SIGNED
   * manifest. There is no path by which a renderer supplies this value.
   */
  openExternal?(url: string): Promise<boolean>;
  /** Test seam. Production is the pinned `FEED_URL`. */
  readonly feedUrl?: string;
  reportFailure?(err: unknown): void;
}

/** What a teardown actually managed to stop. */
export interface UpdateSummaryInventory {
  /** An action was admitted when the teardown began. */
  readonly busy: boolean;
  /**
   * The core reported reaching quiet.
   *
   * `false` is weaker than "stopped": the fence is set and nothing new can
   * start, but in-flight work has not been observed to finish. Reported rather
   * than rounded up, because a quit prompt told "everything stopped" over a
   * running download is the failure this boolean exists to prevent.
   */
  readonly joined: boolean;
}

// ---------------------------------------------------------------------------
// Reason mapping. An allowlist, never a pass-through.
// ---------------------------------------------------------------------------

/**
 * Every closed code the core can actually produce, from its own unions.
 *
 * `JournalFailure`, `FeedFailure`, `ArtifactFailure`, `InstallRefusal` and the
 * service's own literals. Anything outside this set — including a reason a
 * consent adapter invented — becomes `other`.
 */
const KNOWN_REASONS: ReadonlySet<string> = new Set<UpdateReason>([
  "network",
  "timeout",
  "cancelled",
  "http",
  "redirect",
  "too-large",
  "untrusted-host",
  "malformed",
  "integrity",
  "staging",
  "corrupt",
  "unreadable",
  "unwritable",
  "unowned",
  "identity-changed",
  "publisher",
  "not-lockable",
  "no-expected-publisher",
  "no-consent-adapter",
  "cancelled-late-grant",
  "not-resumed",
  "platform-error",
]);

/**
 * One closed code for whatever the core said.
 *
 * `not-resumed:` is the one prefixed form the service builds
 * (`service.ts:1134`), and its suffix is a lease detail the host's adapter
 * wrote — so the prefix is recognised and the suffix is DROPPED rather than
 * carried. Everything unrecognised is `other`, which is what makes this a
 * mapping rather than a leak with an allowlist bolted on.
 */
export function reasonOf(raw: unknown): UpdateReason {
  if (typeof raw !== "string") return "other";
  if (raw.startsWith("not-resumed:") || raw === "not-resumed") return "not-resumed";
  return KNOWN_REASONS.has(raw) ? (raw as UpdateReason) : "other";
}

/**
 * Whether release notes may be opened, and at what address.
 *
 * Three checks, each for its own reason: HTTPS because an update note fetched
 * over plaintext is a downgrade on the one surface that talks about integrity;
 * the production feed's ORIGIN because the manifest is only as trustworthy as
 * the place it was pinned to; and no embedded credentials because
 * `shell.openExternal` hands whatever it is given to the OS.
 *
 * Returns `null` rather than throwing, and `hasNotes` is false in exactly that
 * case — the page does the same thing whether there were no notes or an address
 * this build will not open.
 */
export function releaseNotesUrl(raw: string | null, feedUrl: string): string | null {
  if (raw === null || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  let feed: URL;
  try {
    parsed = new URL(raw);
    feed = new URL(feedUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.origin !== feed.origin) return null;
  return parsed.toString();
}

/**
 * States that offer NO further action of any kind until this app is restarted or
 * reconfigured.
 *
 * All four are trust outcomes, and the rule is deliberately blunt: a client that
 * quietly re-offers a check after one of them is relaxing a trust decision to
 * avoid a dead-looking screen, which is the wrong trade on this surface.
 *
 *   * `disabled` — updates are off for this build.
 *   * `feed-untrusted` — the feed was not signed by a pinned key. Terminal by
 *     design (`signatureFailureIsTerminal`); no retry and no override.
 *   * `publisher-mismatch` — the installer carries somebody else's identity.
 *   * `verifier-unavailable` — the publisher check could not RUN, so this build
 *     cannot say what it downloaded and offers nothing.
 *
 * Recovery is a restart or a reconfiguration, not a button.
 */
const TERMINAL_KINDS: ReadonlySet<UpdateState["kind"]> = new Set([
  "disabled",
  "feed-untrusted",
  "publisher-mismatch",
  "verifier-unavailable",
]);

/**
 * Whether a check — manual or automatic — may run from this state.
 *
 * Refused from every terminal kind, and from a `check-failed` the core itself
 * marked non-retryable.
 */
export function checkAllowed(state: UpdateState): boolean {
  if (TERMINAL_KINDS.has(state.kind)) return false;
  if (state.kind === "check-failed") return state.retryable;
  return true;
}

/** Whether this state offers any affordance at all. */
export function terminalState(state: UpdateState): boolean {
  return TERMINAL_KINDS.has(state.kind);
}

/**
 * The total time a teardown will wait, matching the core's own join budget.
 *
 * ONE budget for the whole teardown, not one per phase.
 */
export const QUIESCE_BUDGET_MS = 10_000;

/**
 * Await something, but only until the deadline.
 *
 * Resolves `true` if it settled in time and `false` if the budget ran out. The
 * work is NOT cancelled and NOT untracked — a bounded wait is a statement about
 * this teardown's patience, never about the operation, and reporting a browser
 * open as abandoned because we stopped waiting would be a false cancellation.
 *
 * The timer is cleared on the settling path, so a fast join leaves nothing
 * pending, and unref'd so a slow one cannot hold the process open by itself.
 */
function joinedWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

/** Deep-frozen, so a held snapshot cannot be edited by whoever received it. */
function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
  return value;
}

export class UpdateSummaryService {
  #view: UpdateSummaryView = UPDATE_SUMMARY_LOADING;
  #residue: UpdateResidueView = { kind: "unread" };
  /** The address for the CURRENT candidate's notes, held in main only. */
  #notesUrl: string | null = null;
  /** An action is admitted. Mirrors the core's single slot for the page. */
  #busy = false;
  #fenced = false;
  #disposed = false;
  /** One teardown at a time, so a re-entrant call joins rather than recurses. */
  #stopping: Promise<UpdateSummaryInventory> | null = null;
  /**
   * External opens in flight.
   *
   * `core.quiesce()` joins the core's work and knows nothing about these, so a
   * teardown that reported `joined` while a browser open was still outstanding
   * was describing half the process. Tracked here and joined below.
   */
  readonly #external = new Set<Promise<unknown>>();
  readonly #release: () => void;

  constructor(private readonly deps: UpdateSummaryDeps) {
    // Subscribed in the CONSTRUCTOR, before anything can await: the core
    // publishes on every transition and a subscription taken after the first
    // action would miss the transition that action caused.
    this.#release = deps.core.subscribe((state) => this.#onState(state));
    this.#install(deps.core.current);
  }

  /**
   * Whether this facade may start anything at all.
   *
   * ONE gate, checked by every entry point including the reads. A residue read
   * or a re-verification issued after a teardown is a call into a core that has
   * been told to stop — and even where the core refuses it itself, a facade that
   * made the call has already broken its own contract.
   */
  #admitting(): boolean {
    return !this.#disposed && !this.#fenced && this.#stopping === null;
  }

  /** The current snapshot. Deep-frozen; safe to hand across a channel. */
  view(): UpdateSummaryView {
    return this.#view;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close admissions. The core is NOT touched and nothing is aborted.
   *
   * This is the state to be in while a quit prompt is on screen: no new check,
   * download, install or reveal may start, and a download the user is about to
   * decide to keep is still running. Aborting here would cancel work in order to
   * ask whether to cancel it.
   */
  fence(): void {
    this.#fenced = true;
    this.#publish();
  }

  /** The user chose Stay. */
  resume(): void {
    if (this.#disposed) return;
    this.#fenced = false;
    try {
      this.deps.core.resume();
    } catch (err) {
      this.deps.reportFailure?.(err);
    }
    this.#publish();
  }

  /**
   * Consent has been given: stop, and JOIN.
   *
   * Single-flight so two callers join one teardown rather than starting two.
   * That is bookkeeping only — it does NOT prevent the install self-join
   * deadlock. Only RT honouring the core's `excludeToken`, by not joining the
   * update job when the consent adapter quiesces the app, prevents that.
   *
   * The join covers the core's work AND this facade's own external opens, which
   * the core knows nothing about.
   */
  async quiesce(timeoutMs?: number): Promise<UpdateSummaryInventory> {
    this.#fenced = true;
    const running = this.#stopping;
    if (running !== null) return running;
    const run = (async (): Promise<UpdateSummaryInventory> => {
      const busy = this.#busy || this.#external.size > 0;
      // ONE deadline for the whole teardown. An earlier shape passed the budget
      // to the core and then awaited the external opens with no bound at all,
      // so `quiesce(10)` never returned while a browser open was held — the
      // caller asked for an answer within 10ms and got none.
      const budget = timeoutMs ?? QUIESCE_BUDGET_MS;
      const deadline = Date.now() + budget;
      try {
        const result = await this.deps.core.quiesce(budget);
        // The REMAINDER of the same deadline, never a fresh one: two budgets in
        // sequence is twice the wait the caller asked for.
        const opens = [...this.#external];
        const remaining = Math.max(0, deadline - Date.now());
        const externalsJoined =
          opens.length === 0 ? true : await joinedWithin(Promise.allSettled(opens), remaining);
        // Still tracked, still running, not cancelled. `joined: false` says this
        // teardown stopped waiting — not that the work stopped.
        const joined = result.joined && externalsJoined && this.#external.size === 0;
        return { busy, joined };
      } catch (err) {
        // A throwing teardown is not a quiet one. Reported as unjoined rather
        // than as success, because the caller is deciding whether to exit.
        this.deps.reportFailure?.(err);
        return { busy, joined: false };
      } finally {
        this.#stopping = null;
      }
    })();
    this.#stopping = run;
    return run;
  }

  /** Terminal. The subscription is released and no observer is called again. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#fenced = true;
    try {
      this.#release();
    } catch (err) {
      // An unsubscribe is a function this object was handed. A throw here would
      // abandon the join below.
      this.deps.reportFailure?.(err);
    }
    // Admissions are closed BEFORE the join, and the join is the core's own —
    // which aborts and waits. A teardown that returned without it would leave a
    // download running past the process's last word about it.
    await this.quiesce();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Re-authenticate anything already staged. RT calls this once at launch.
   *
   * No network. It re-verifies the stored signed bytes against the pinned key
   * and produces the right state, which is why a restart does not begin by
   * claiming there is nothing to install.
   */
  async reverifyStaged(): Promise<UpdateSummaryView> {
    if (!this.#admitting()) return this.#view;
    await this.#run("reverify", () => this.deps.core.reverifyStaged());
    return this.#view;
  }

  /** Read the residue counts. Bounded, and reported rather than resolved. */
  async refreshResidue(): Promise<UpdateSummaryView> {
    if (!this.#admitting()) return this.#view;
    try {
      const entries = await this.deps.core.residue();
      if (this.#disposed) return this.#view;
      let ambiguous = 0;
      for (const entry of entries) if (!entry.owned) ambiguous += 1;
      // Counts only. A nonce names a file in the staging directory and a detail
      // is free-form; neither belongs in a page.
      this.#residue = { kind: "read", total: entries.length, ambiguous };
    } catch (err) {
      this.deps.reportFailure?.(err);
      // NOT zero. "Nothing outstanding" is the one thing an unread residue
      // cannot claim, and it is exactly the claim that would hide a blocked
      // installation behind a clean-looking pane.
      if (!this.#disposed) this.#residue = { kind: "failed" };
    }
    if (!this.#disposed) this.#publish();
    return this.#view;
  }

  /** Whether the daily automatic check is due. The TIMER is RT's. */
  async automaticCheckDue(): Promise<boolean> {
    if (!this.#admitting()) return false;
    // The daily timer is refused from a terminal state as firmly as the button
    // is: re-checking on a schedule would relax the same trust decision, just
    // more quietly.
    if (!checkAllowed(this.deps.core.current)) return false;
    try {
      return await this.deps.core.automaticCheckDue();
    } catch (err) {
      this.deps.reportFailure?.(err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Perform one named action, or refuse.
   *
   * The action is a closed token and carries NOTHING else — no version, no URL,
   * no digest, no path. Every fact a delivery is made of comes from the
   * re-verified signed manifest inside the core.
   *
   * The gate is the core's own predicate, checked here so a page cannot reach an
   * install from a state that may not install even if its buttons were wrong.
   */
  async act(action: UpdateAction, trigger: "manual" | "automatic" = "manual"): Promise<UpdateSummaryView> {
    if (!this.#admitting()) return this.#view;
    const state = this.deps.core.current;
    switch (action) {
      case "check":
        if (!checkAllowed(state)) return this.#view;
        await this.#run("check", () => this.deps.core.check(trigger));
        return this.#view;
      case "download":
        if (state.kind !== "update-available") return this.#view;
        await this.#run("download", () => this.deps.core.download());
        return this.#view;
      case "install":
        // The core's own predicate. Exactly one state may install, and this is
        // not the place to have a second opinion about which.
        if (!canInstall(state)) return this.#view;
        await this.#run("install", () => this.deps.core.install());
        return this.#view;
      case "reveal":
        if (!canReveal(state)) return this.#view;
        await this.#run("reveal", () => this.deps.core.reveal());
        return this.#view;
    }
  }

  /**
   * Open the release notes for the current candidate.
   *
   * The renderer names a closed TOKEN; the address is held here, taken from the
   * signed manifest and re-validated immediately before it is handed over. A
   * channel that accepted a URL would be script-triggered browser navigation
   * carrying the user's real session.
   */
  async openExternal(target: UpdateExternalTarget): Promise<boolean> {
    if (!this.#admitting()) return false;
    if (!isUpdateExternalTarget(target)) return false;
    const held = this.#notesUrl;
    if (held === null) return false;
    // Re-validated at the moment of use, not only when it was published: the
    // state may have moved on to a different candidate since.
    const url = releaseNotesUrl(held, this.deps.feedUrl ?? FEED_URL);
    if (url === null) return false;
    const open = this.deps.openExternal;
    if (open === undefined) return false;
    // Registered BEFORE the await, so a teardown starting in the same tick
    // finds it rather than an empty set.
    const run = open(url);
    this.#external.add(run);
    try {
      return await run;
    } catch (err) {
      this.deps.reportFailure?.(err);
      return false;
    } finally {
      this.#external.delete(run);
    }
  }

  /**
   * Hold the busy flag around one core call.
   *
   * `#busy` is set and PUBLISHED before the first await, so a page disables its
   * buttons for the whole operation rather than from whenever the first state
   * transition happens to arrive. The core is single-flight itself and returns
   * the current state unchanged for a second call; this makes that visible
   * instead of leaving a button live that would silently do nothing.
   */
  async #run(label: string, body: () => Promise<UpdateState>): Promise<void> {
    if (this.#busy || !this.#admitting()) return;
    this.#busy = true;
    // Published BEFORE the call, and re-checked after: `#publish` runs an
    // observer, and an observer may fence, quiesce or dispose this facade
    // re-entrantly. Deciding admissibility only on the way in would then call
    // the core after a teardown the observer itself started.
    this.#publish();
    if (!this.#admitting()) {
      this.#busy = false;
      return;
    }
    try {
      const next = await body();
      if (this.#disposed) return;
      this.#install(next);
    } catch (err) {
      // A rejection is reported as itself. The core's contract is that terminal
      // states are returned rather than thrown, so a throw here is a defect and
      // is surfaced — not folded into a state that would claim something.
      this.deps.reportFailure?.(Object.assign(new Error(`update ${label} threw`), { cause: err }));
    } finally {
      this.#busy = false;
      if (!this.#disposed) this.#publish();
    }
  }

  // -------------------------------------------------------------------------
  // Reduction
  // -------------------------------------------------------------------------

  #onState(state: UpdateState): void {
    if (this.#disposed) return;
    this.#install(state);
  }

  #install(state: UpdateState): void {
    const candidate = "candidate" in state ? state.candidate : null;
    this.#notesUrl = candidate?.notesUrl ?? null;
    this.#view = freeze({
      state: this.#reduce(state),
      actions: this.#actions(state),
      residue: this.#residue,
      currentVersion: this.deps.currentVersion,
    });
    this.#emit();
  }

  #publish(): void {
    // Rebuilt from the core's CURRENT state rather than from the held view: the
    // gates depend on the fence and the busy flag, and both change without a
    // core transition.
    this.#install(this.deps.core.current);
  }

  #emit(): void {
    if (this.#disposed) return;
    try {
      this.deps.onView?.(this.#view);
    } catch (err) {
      this.deps.reportFailure?.(err);
    }
  }

  #candidate(facts: { version: string; build: number; sizeBytes: number; notesUrl: string | null; sha256: string | null }): UpdateCandidateView {
    return {
      version: facts.version,
      build: facts.build,
      sizeBytes: facts.sizeBytes,
      // The BOOLEAN, decided here. The address never crosses.
      hasNotes: releaseNotesUrl(facts.notesUrl, this.deps.feedUrl ?? FEED_URL) !== null,
      sha256: facts.sha256,
    };
  }

  /** The eighteen kinds, one for one, with every reason closed. */
  #reduce(state: UpdateState): UpdateStateView {
    switch (state.kind) {
      case "disabled":
        return { kind: "disabled", reason: state.reason };
      case "idle":
        return { kind: "idle", lastCheckedAt: state.lastCheckedAt };
      case "checking":
        return { kind: "checking" };
      case "up-to-date":
        return { kind: "up-to-date", checkedAt: state.checkedAt };
      case "check-failed":
        return { kind: "check-failed", reason: reasonOf(state.reason), retryable: state.retryable };
      case "feed-untrusted":
        // `detail` is deliberately DROPPED. It is the only field here that can
        // carry an arbitrary string, and the state is terminal: there is nothing
        // a person can do with the detail that the sentence does not already say.
        return { kind: "feed-untrusted" };
      case "update-available":
        return { kind: "update-available", candidate: this.#candidate(state.candidate) };
      case "downloading":
        return {
          kind: "downloading",
          candidate: this.#candidate(state.candidate),
          // The core's own count. Monotonic and bounded by the signed length;
          // nothing here interpolates or rounds it.
          receivedBytes: state.receivedBytes,
        };
      case "verify-failed":
        return {
          kind: "verify-failed",
          candidate: this.#candidate(state.candidate),
          reason: reasonOf(state.reason),
        };
      case "ready":
        return { kind: "ready", candidate: this.#candidate(state.candidate) };
      case "ready-unsigned":
        return { kind: "ready-unsigned", candidate: this.#candidate(state.candidate) };
      case "publisher-mismatch":
        return { kind: "publisher-mismatch", candidate: this.#candidate(state.candidate) };
      case "verifier-unavailable":
        return { kind: "verifier-unavailable", candidate: this.#candidate(state.candidate) };
      case "installing":
        return { kind: "installing", candidate: this.#candidate(state.candidate) };
      case "install-deferred":
        return {
          kind: "install-deferred",
          candidate: this.#candidate(state.candidate),
          reason: reasonOf(state.reason),
        };
      case "revealed":
        return { kind: "revealed", candidate: this.#candidate(state.candidate) };
      case "journal-unavailable":
        return { kind: "journal-unavailable", reason: reasonOf(state.reason) };
      case "blocked":
        // `detail` dropped for the same reason as `feed-untrusted`; the count is
        // the part a person can act on, and there is no action to offer anyway.
        return { kind: "blocked", reason: state.reason, count: state.count };
    }
  }

  #actions(state: UpdateState): UpdateSummaryView["actions"] {
    const open = !this.#disposed && !this.#fenced && !this.#busy;
    const notes = releaseNotesUrl(
      "candidate" in state ? state.candidate.notesUrl : null,
      this.deps.feedUrl ?? FEED_URL,
    );
    return {
      // Terminal states offer no check — not a button that silently does
      // nothing, which is what one over `feed-untrusted` would be.
      canCheck: open && checkAllowed(state),
      canDownload: open && state.kind === "update-available",
      canInstall: open && canInstall(state),
      canReveal: open && canReveal(state),
      canOpenNotes: notes !== null && this.deps.openExternal !== undefined,
      busy: this.#busy,
    };
  }
}
