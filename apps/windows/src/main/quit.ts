// Ending the process without losing what was in flight.
//
// Two independent costs, mirroring `QuitPresentation.swift` on macOS: a transfer
// that will not finish, and text the user has not sent. Four states, because
// they are independent and the copy differs.
//
// ## Cleanup is joined, and its failure is a decision the user makes
//
// The foundation's `before-quit` did `void dispose().finally(() => app.quit())`.
// That quits whether or not cleanup worked, and a rejection there is an
// unhandled promise rejection rather than a report. Staged partial files left on
// a user's disk are exactly the thing they would want to know about, and the
// only moment they can act on it is before the process goes away.
//
// So a failed cleanup produces an actionable choice — quit anyway, or stay open
// so it can be retried — never a silent success and never a swallowed error.
//
// ## A contract the eventual main wiring must honour
//
// "Stay" after a failed cleanup is only meaningful if the app is still usable.
// `cleanup` here must therefore be a QUIESCE — cancel in-flight work, release
// what it can, and remain able to run again — not a final `dispose()` that
// leaves the composed `AppService` permanently torn down. A coordinator that
// returned "stay" over an unusable app would be offering a choice it cannot
// deliver. This module cannot enforce that from here; the wiring must pass the
// recoverable operation, and that is why this note is in the source.

import type { Translate } from "./l10n.js";

export type QuitRisk =
  | "none"
  | "transfer"
  | "local-text"
  | "transfer-and-local-text"
  /**
   * What is at stake could not be established.
   *
   * Its own state rather than a pessimistic spelling of the others, because it
   * is a different sentence: "this will discard your unsent text" asserts there
   * is unsent text, and saying so when the page could not be asked is a claim
   * the app has no basis for. Main cannot fill the gap either — an OUTGOING
   * WebRTC transfer lives in the renderer, so a destroyed or unresponsive page
   * takes the truth about BOTH costs with it.
   *
   * It never means "probably nothing". A prompt is shown and an actual human
   * answer is required, exactly as for a known risk.
   */
  | "unknown";

export function quitRisk(transferRunning: boolean, hasLocalText: boolean): QuitRisk {
  if (transferRunning && hasLocalText) return "transfer-and-local-text";
  if (transferRunning) return "transfer";
  if (hasLocalText) return "local-text";
  return "none";
}

export interface QuitPrompt {
  readonly title: string;
  readonly body: string;
  readonly quitAction: string;
  readonly stayAction: string;
}

/** `null` when there is nothing at stake — no dialog for a quit that costs nothing. */
export function quitPrompt(risk: QuitRisk, t: Translate): QuitPrompt | null {
  if (risk === "none") return null;
  const title =
    risk === "unknown"
      ? "resident.quit.unknownTitle"
      : risk === "local-text"
        ? "resident.quit.localTextTitle"
        : "resident.quit.transferTitle";
  const body =
    risk === "unknown"
      ? "resident.quit.unknownBody"
      : risk === "transfer"
        ? "resident.quit.transferBody"
        : risk === "local-text"
          ? "resident.quit.localTextBody"
          : "resident.quit.bothBody";
  return {
    title: t(title),
    body: t(body),
    quitAction: t("resident.quit.now"),
    stayAction: t("resident.quit.stay"),
  };
}

/**
 * What cleanup could not finish.
 *
 * Closed reasons and a count. **Never a message.** An earlier revision put
 * `err.message` in here, which is an arbitrary filesystem error string — it
 * routinely contains the full path of the file that failed, and this value is
 * handed to `onResidue`, i.e. to a dialog. That contradicts the same invariant
 * `notifications.ts` holds: a user-facing surface renders closed codes and
 * counts, and carries no place for a path to arrive through.
 *
 * The underlying error is not lost — it goes to `reportFailure`, which is a
 * diagnostics sink, not a UI.
 */
export type ResidueReason =
  /** Partly-written files in the staging area could not be removed. */
  | "staged-files"
  /** A receive lease did not release. */
  | "open-lease"
  /**
   * The page could not confirm it stopped.
   *
   * Distinct from the file reasons because it is a different fact and needs a
   * different sentence: nothing is known to be left on disk, and something may
   * still be SENDING. Reporting it as leftover files would be a guess in the
   * reassuring direction.
   */
  | "renderer-unconfirmed"
  /** Helper processes that could not be confirmed gone. */
  | "helper-processes"
  /** Sockets or control-plane reads that were asked to stop and were not seen
   *  to. Not a file fact, so it takes the unknown sentence. */
  | "network-unsettled"
  /** Cleanup failed in a way this module cannot classify. */
  | "unknown";

/** Whether this residue is about files on disk, or about not knowing. */
function isFileResidue(reasons: readonly ResidueReason[]): boolean {
  return reasons.every((reason) => reason === "staged-files" || reason === "open-lease");
}

export interface CleanupResidue {
  readonly reasons: readonly ResidueReason[];
  /** How many items were left behind; 0 when that is not knowable. */
  readonly count: number;
}

export interface QuitDeps {
  /**
   * What is at stake, read FRESH at the moment quit is requested.
   *
   * Async because the honest answer needs the renderer, and because the wiring
   * fences new receives before it asks — so a "none" answer cannot be overtaken
   * by a transfer that started while the question was in flight.
   */
  readonly risk: () => QuitRisk | Promise<QuitRisk>;
  /** Resolves true to proceed with quitting. */
  readonly confirm: (prompt: QuitPrompt) => Promise<boolean>;
  /**
   * Join every outstanding lease and pending operation. Resolves with what could
   * not be cleaned up; rejects only on an unexpected failure, which is treated
   * as residue rather than allowed to escape.
   */
  readonly cleanup: () => Promise<CleanupResidue>;
  /** Resolves true to quit despite residue, false to stay open. */
  readonly onResidue: (residue: CleanupResidue, prompt: QuitPrompt) => Promise<boolean>;
  /**
   * Where the actual error goes.
   *
   * Required, not optional: an unclassified cleanup failure must reach a log,
   * and making this omissible is how it would end up reaching nothing. It is
   * deliberately NOT the same channel as `onResidue` — one is for the operator,
   * one is for the user, and they are allowed to say different things.
   */
  readonly reportFailure: (err: unknown) => void;
  readonly t: Translate;
}

export type QuitDecision = "quit" | "stay";

/**
 * One quit at a time.
 *
 * Repeated requests — the tray item, the window, `before-quit` firing again —
 * join the FIRST cleanup rather than starting a second. Two concurrent cleanups
 * over the same leases is how a cancel races a publish, and the second caller
 * getting a different answer from the first is how a user sees a dialog for a
 * decision that was already made.
 */
export class QuitCoordinator {
  private inFlight: Promise<QuitDecision> | null = null;

  constructor(private readonly deps: QuitDeps) {}

  request(): Promise<QuitDecision> {
    if (this.inFlight) return this.inFlight;
    const run = this.run().finally(() => {
      // Cleared so a "stay" can be followed by a later, genuine quit. A quit
      // that succeeded ends the process, so the cleared state is unobservable.
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async run(): Promise<QuitDecision> {
    let risk: QuitRisk;
    try {
      risk = await this.deps.risk();
    } catch (err) {
      // A snapshot that failed is not "nothing at stake". It is the same
      // position as an unreachable page, and it asks.
      this.deps.reportFailure(err);
      risk = "unknown";
    }
    const prompt = quitPrompt(risk, this.deps.t);
    if (prompt !== null) {
      let proceed: boolean;
      try {
        proceed = await this.deps.confirm(prompt);
      } catch (err) {
        // A prompt that failed is not consent. Letting this reject would escape
        // `request()` into `before-quit`, where it becomes an unhandled
        // rejection AND the quit proceeds anyway — losing the transfer the
        // dialog existed to protect.
        this.deps.reportFailure(err);
        return "stay";
      }
      // Exactly `true`. A malformed or undefined answer from a dialog behind
      // IPC is not consent, and here the cost of treating it as consent is a
      // running transfer killed on the strength of a value nobody sent.
      if (proceed !== true) return "stay";
    }

    let residue: CleanupResidue;
    try {
      residue = await this.deps.cleanup();
    } catch (err) {
      // Not swallowed — it goes to the diagnostics sink — and not quietly
      // quitting either: a cleanup that threw has left an unknown amount
      // behind, which is the strongest reason to ask, not the weakest. The
      // error text stays out of the residue that reaches the dialog.
      this.deps.reportFailure(err);
      residue = { reasons: ["unknown"], count: 0 };
    }

    if (residue.reasons.length === 0) return "quit";

    // Two sentences, because they describe two different situations. "Some
    // files could not be cleaned up" is false when what actually happened is
    // that the page never confirmed it stopped.
    const fileResidue = isFileResidue(residue.reasons);
    const residuePrompt: QuitPrompt = {
      title: this.deps.t(fileResidue ? "resident.quit.residueTitle" : "resident.quit.residueUnknownTitle"),
      body: this.deps.t(fileResidue ? "resident.quit.residueBody" : "resident.quit.residueUnknownBody"),
      quitAction: this.deps.t("resident.quit.residueQuitAnyway"),
      stayAction: this.deps.t("resident.quit.residueStay"),
    };
    try {
      return (await this.deps.onResidue(residue, residuePrompt)) === true ? "quit" : "stay";
    } catch (err) {
      // If we cannot even ask, stay. Quitting on an unasked question would
      // discard the user's data on their behalf.
      this.deps.reportFailure(err);
      return "stay";
    }
  }
}
