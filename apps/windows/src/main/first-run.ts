// The first time closing the window does not quit.
//
// ## Why this exists on Windows and not on macOS
//
// The released Mac app has no equivalent, deliberately: on macOS a closed window
// is understood not to be a closed app, and the menu bar item is always visible.
// On Windows the same behaviour is genuinely surprising — the user closes the
// window and reasonably believes the program exited. Shown once, then never
// again.
//
// ## A dialog, not a balloon
//
// `tray.displayBalloon` is silently dropped when notifications are off or Focus
// Assist is on. A notice that may never appear cannot be recorded as shown, so
// "shown once" would become a claim the code cannot back. A modal dialog is
// either answered or it is not.
//
// ## The flag is written only on an explicit answer
//
// Cancel, a dismissed dialog, or a failed write all leave it unset, so the
// notice returns. Erring towards showing it twice is a small annoyance; erring
// the other way means the one explanation the user gets is one they never saw.

import type { Translate } from "./l10n.js";

export type FirstCloseChoice = "hide" | "quit" | "cancel";

export interface FirstCloseDialog {
  readonly title: string;
  readonly body: string;
  /** Index-aligned with the choices below. */
  readonly buttons: readonly string[];
  readonly choices: readonly FirstCloseChoice[];
}

export function firstCloseDialog(t: Translate): FirstCloseDialog {
  return {
    title: t("resident.firstClose.title"),
    body: t("resident.firstClose.body"),
    buttons: [
      t("resident.firstClose.hide"),
      t("resident.firstClose.quit"),
      t("resident.firstClose.cancel"),
    ],
    choices: ["hide", "quit", "cancel"],
  };
}

/**
 * Durable acknowledgement.
 *
 * `read` reports whether the notice has been acknowledged; `write` records that
 * it has. Both may fail, and neither failure may be swallowed.
 */
export interface AcknowledgementStore {
  readonly read: () => boolean | Promise<boolean>;
  readonly write: () => void | Promise<void>;
}

export interface FirstCloseDeps {
  readonly store: AcknowledgementStore;
  /** Resolves with the button index chosen, or null if dismissed. */
  readonly ask: (dialog: FirstCloseDialog) => Promise<number | null>;
  /**
   * Where the actual error goes. Required, so it cannot be forgotten — the
   * outcomes below are CLOSED codes with no message, because they cross into
   * IPC and onto a screen, and a raw filesystem error routinely names the path
   * it failed on.
   */
  readonly reportFailure: (err: unknown) => void;
  readonly t: Translate;
}

export type FirstCloseFailure =
  | "flag-unreadable"
  | "flag-write-failed"
  | "dialog-failed"
  | "dialog-out-of-range";

export type FirstCloseOutcome =
  /** Nothing was shown; the notice had already been acknowledged. */
  | { readonly kind: "already-acknowledged"; readonly action: "hide" }
  | {
      readonly kind: "answered";
      readonly action: FirstCloseChoice;
      readonly persisted: boolean;
      readonly failure?: FirstCloseFailure;
    }
  /**
   * The notice could not be put in front of the user.
   *
   * The action is **cancel**, not hide. This dialog exists so that a user who
   * closes the window understands the app is still running; hiding it when the
   * explanation failed to appear delivers exactly the confusion the feature was
   * added to prevent. The window stays, they can close it again, and the
   * failure is reported.
   */
  | { readonly kind: "dialog-failed"; readonly action: "cancel"; readonly failure: FirstCloseFailure };

/**
 * Decides what a window close should do. Performs nothing itself.
 *
 * ## Serialized
 *
 * A user hammering the X, or a close arriving while the dialog is already up,
 * must not open a second dialog or write the acknowledgement twice. Concurrent
 * calls join the first decision, exactly as `QuitCoordinator` does — a modal
 * that appears twice is a bug the user sees, and a double `write()` is a bug
 * they do not.
 */
export class FirstCloseCoordinator {
  private inFlight: Promise<FirstCloseOutcome> | null = null;

  constructor(private readonly deps: FirstCloseDeps) {}

  onClose(): Promise<FirstCloseOutcome> {
    if (this.inFlight) return this.inFlight;
    const run = this.decide().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async decide(): Promise<FirstCloseOutcome> {
    let acknowledged = false;
    let readFailure: FirstCloseFailure | undefined;
    try {
      acknowledged = await this.deps.store.read();
    } catch (err) {
      // Treated as "not yet acknowledged" — the safe direction, because it
      // shows the notice again rather than suppressing the only explanation.
      this.deps.reportFailure(err);
      readFailure = "flag-unreadable";
    }
    if (acknowledged) return { kind: "already-acknowledged", action: "hide" };

    const dialog = firstCloseDialog(this.deps.t);
    let index: number | null;
    try {
      index = await this.deps.ask(dialog);
    } catch (err) {
      this.deps.reportFailure(err);
      return { kind: "dialog-failed", action: "cancel", failure: "dialog-failed" };
    }

    const choice = index === null ? "cancel" : dialog.choices[index];
    if (choice === undefined) {
      this.deps.reportFailure(new Error(`dialog returned out-of-range index ${index}`));
      return { kind: "dialog-failed", action: "cancel", failure: "dialog-out-of-range" };
    }

    // Only an explicit Hide or Quit acknowledges. A dismissed dialog is not an
    // answer, and Cancel is a refusal to answer.
    if (choice === "cancel") {
      return { kind: "answered", action: "cancel", persisted: false, ...(readFailure ? { failure: readFailure } : {}) };
    }

    try {
      // Awaited, so a settings file that could not be written reports
      // `persisted: false` rather than claiming an acknowledgement that is not
      // on disk — the user would then never see the notice again.
      await this.deps.store.write();
    } catch (err) {
      this.deps.reportFailure(err);
      return { kind: "answered", action: choice, persisted: false, failure: "flag-write-failed" };
    }
    return { kind: "answered", action: choice, persisted: true, ...(readFailure ? { failure: readFailure } : {}) };
  }
}
