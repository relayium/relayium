// The update pane's state, owned by the shell rather than by the page.
//
// Main is authoritative: this holds no derived update state, computes no
// affordance from a state name, and never advances progress itself. It renders
// what main pushes and forwards four closed tokens back.

import {
  UPDATE_SUMMARY_LOADING,
  type UpdateAction,
  type UpdateSummaryView,
} from "../../shared/update-summary.js";
import type { UpdateSummaryBridge } from "./bridge.js";

/**
 * A REQUEST that failed, which is not an update state.
 *
 * The channel broke; main said nothing. Kept separate from `view` on purpose:
 * inventing an `UpdateState` for it would put a claim on screen that no process
 * made, and every state in that union is a claim about signing, staging or
 * installation.
 */
export type UpdateRequestFailure =
  /** `state()` or `residue()` did not answer. */
  | { readonly kind: "read" }
  /** An action never reached main. */
  | { readonly kind: "action"; readonly action: UpdateAction }
  /** The browser open could not be asked for. */
  | { readonly kind: "notes" };

export class UpdateSummaryController {
  view = $state<UpdateSummaryView>(UPDATE_SUMMARY_LOADING);
  /** The action in flight, so one button shows progress and all are disabled. */
  pending = $state<UpdateAction | null>(null);
  /** Main answered, and refused to open the browser. Not a channel failure. */
  notesFailed = $state(false);
  /**
   * A request this app could not complete. Rendered, never swallowed.
   *
   * The previous shape caught every rejection into `null` and installed nothing,
   * so a broken channel looked exactly like a quiet app.
   */
  failure = $state<UpdateRequestFailure | null>(null);
  /**
   * An actual view has been observed — pushed by main, or read successfully.
   *
   * Until then the pane must NOT render its starting value as fact. That value
   * is `disabled/no-pin`, which is today's shipped truth but is still a claim
   * about this build's signing configuration, and a failed first read has
   * confirmed nothing at all.
   */
  confirmed = $state(false);

  readonly #stop: Array<() => void> = [];
  /**
   * Which answer may still be installed.
   *
   * A push is the newest word. The initial `state()` read is issued at startup
   * and can answer AFTER a transition main has already pushed — installing it
   * then would roll the pane back to `idle` over a `downloading` the user can
   * see. Every assignment from a response goes through this.
   */
  #seq = 0;
  #destroyed = false;

  constructor(private readonly bridge: UpdateSummaryBridge) {
    this.#stop.push(
      bridge.onState((payload) => {
        const shaped = payload as UpdateSummaryView | null;
        // Shaped, not trusted: this crosses a process boundary and a malformed
        // push must not blank a pane that was known to be true.
        if (shaped === null || typeof shaped !== "object") return;
        if (typeof (shaped as { state?: unknown }).state !== "object") return;
        if (typeof (shaped as { actions?: unknown }).actions !== "object") return;
        if (typeof (shaped as { residue?: unknown }).residue !== "object") return;
        if (this.#destroyed) return;
        this.#seq += 1;
        // A push supersedes a stale failure: main is speaking again.
        this.failure = null;
        this.confirmed = true;
        this.view = shaped;
      }),
    );
  }

  /** Read what main already holds. Called once by the shell at startup. */
  async load(): Promise<void> {
    await this.#install(() => this.bridge.state(), { kind: "read" });
  }

  /** Re-read the residue counts, for the `blocked` explanation. */
  async refreshResidue(): Promise<void> {
    await this.#install(() => this.bridge.residue(), { kind: "read" });
  }

  /**
   * Perform one action.
   *
   * Single-flight across ALL actions, not per action: main holds one slot, so a
   * second click while any is running would be refused there and look like a
   * button that does nothing.
   */
  async act(action: UpdateAction): Promise<void> {
    if (this.#destroyed || this.pending !== null) return;
    this.pending = action;
    try {
      await this.#install(() => this.bridge.act({ action }), { kind: "action", action });
    } finally {
      if (!this.#destroyed) this.pending = null;
    }
  }

  /**
   * Open the release notes.
   *
   * A closed token crosses; main holds the address, taken from the signed
   * manifest. A refusal is shown rather than a link that appears to do nothing.
   */
  async openNotes(): Promise<void> {
    if (this.#destroyed) return;
    this.notesFailed = false;
    const seq = ++this.#seq;
    let result: { ok: boolean } | null = null;
    try {
      result = await this.bridge.openExternal({ target: "release-notes" });
    } catch {
      result = null;
    }
    // Stale answers write nothing — a newer push or a teardown has spoken.
    if (this.#destroyed || this.#seq !== seq) return;
    if (result === null) {
      // The channel failed. Distinct from main refusing to open: one is "we
      // could not ask", the other is "we asked and it did not open".
      this.failure = { kind: "notes" };
      return;
    }
    this.failure = null;
    this.notesFailed = !result.ok;
  }

  /**
   * Whether the failed request can be offered again.
   *
   * A read may always be retried — that is an IPC call, not an update
   * operation. An ACTION may only be re-offered while its gate still allows it,
   * so a retry can never become a route to a check the facade forbids on a
   * terminal state.
   */
  get retryable(): boolean {
    const failure = this.failure;
    if (failure === null) return false;
    if (failure.kind !== "action") return true;
    const gates = this.view.actions;
    switch (failure.action) {
      case "check":
        return gates.canCheck;
      case "download":
        return gates.canDownload;
      case "install":
        return gates.canInstall;
      case "reveal":
        return gates.canReveal;
    }
  }

  /** Re-issue exactly the request that failed. Never a different one. */
  async retry(): Promise<void> {
    const failure = this.failure;
    if (failure === null || this.#destroyed || !this.retryable) return;
    if (failure.kind === "read") return this.load();
    if (failure.kind === "notes") return this.openNotes();
    return this.act(failure.action);
  }

  /** Dismiss the notice without retrying. */
  dismissFailure(): void {
    this.failure = null;
  }

  /**
   * Install an answer, or record that the request failed.
   *
   * Main returns the current view for every refusal, so a rejection here means
   * the CHANNEL failed. That is reported as a request failure — actually
   * rendered — rather than swallowed, and no `UpdateState` is invented for it.
   *
   * A known view is PRESERVED across a later failure: the last thing main said
   * is still the last thing main said, and blanking it would lose true
   * information to describe a broken call.
   */
  async #install(
    read: () => Promise<UpdateSummaryView>,
    onFailure: UpdateRequestFailure,
  ): Promise<void> {
    if (this.#destroyed) return;
    const seq = ++this.#seq;
    let view: UpdateSummaryView | null = null;
    let failed = false;
    try {
      view = await read();
    } catch {
      failed = true;
    }
    // Stale results — a newer push, a newer request, or a teardown — write
    // nothing at all, including the failure.
    if (this.#destroyed || this.#seq !== seq) return;
    if (failed || view === null) {
      this.failure = onFailure;
      return;
    }
    this.failure = null;
    this.confirmed = true;
    this.view = view;
  }

  /** Only the app's own teardown calls this. */
  destroy(): void {
    this.#destroyed = true;
    this.failure = null;
    // Invalidated first: a read or an open answering after this must write
    // nothing.
    this.#seq += 1;
    for (const stop of this.#stop.splice(0)) stop();
  }
}
