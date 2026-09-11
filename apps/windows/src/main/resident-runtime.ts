// The resident behaviour, composed. The decisions live in the pure modules.
//
// This is the file that makes "closing the window does not quit" true rather
// than merely hidden: it owns the first-close notice, the tray, quit consent,
// and the recoverable quiesce that a "Stay" depends on.
//
// ## Hiding is not quiescing
//
// A hidden window keeps its renderer, its rooms and its transfers. Nothing here
// disposes, quiesces, revokes or reloads on hide — those all belong to a quit
// the user has actually agreed to. A hidden page is also still ASKABLE, which is
// why the risk snapshot below does not treat invisibility as absence.

import {
  MAX_RESIDENT_DRAFTS,
  type ResidentCommand,
  type ResidentPage,
  type ResidentSnapshot,
} from "../shared/ipc-contract.js";
import type { AppService, CleanupOutcome } from "./app-service.js";
import type { ResidentBridge } from "./handlers.js";
import { FirstCloseCoordinator, type FirstCloseDialog, type FirstCloseOutcome } from "./first-run.js";
import { translator, type Locale, type Translate } from "./l10n.js";
import { present, type NotificationEvent } from "./notifications.js";
import type { PublishReport, ResidentNotice } from "../shared/ipc-contract.js";
import {
  QuitCoordinator,
  quitRisk,
  type CleanupResidue,
  type QuitDecision,
  type QuitPrompt,
  type ResidueReason,
} from "./quit.js";
import { trayMenuTemplate, trayTooltip, type TrayActions, type TrayMenuEntry } from "./tray.js";

export interface ResidentPlatform {
  /** Bring the window forward. */
  readonly show: () => void;
  /** Hide to the tray. Not a teardown of anything. */
  readonly hide: () => void;
  /** End the process. Called only after a decision of `quit`. */
  readonly exit: () => void;
  /** The first-close notice. Resolves with the button index, or null. */
  readonly askFirstClose: (dialog: FirstCloseDialog) => Promise<number | null>;
  /** A native two-button question. Resolves true only for an explicit yes. */
  readonly confirm: (prompt: QuitPrompt) => Promise<boolean>;
  /** Put a notification on screen. */
  readonly notify: (title: string, body: string) => void;
  /** Whether the window is focused right now. */
  readonly isFocused: () => boolean;
  /** Durable first-close acknowledgement. Both may throw, and a write that
   *  failed must not be reported as an acknowledgement. */
  readonly readAcknowledged: () => boolean | Promise<boolean>;
  readonly writeAcknowledged: () => void | Promise<void>;
  /**
   * Tell the user, visibly, that the app has stopped and needs restarting.
   *
   * Its own method rather than another `reportFailure`, because that one is a
   * log: the promise "the app must be restarted" was being made to stderr,
   * where nobody using the product can read it. Closed, localized copy — no
   * error text, no path — and it never exits or relaunches anything.
   */
  readonly showStopped: (notice: StoppedNotice) => void;
  /** Diagnostics sink. Never a UI. */
  readonly reportFailure: (err: unknown) => void;
}

/** The one exceptional state this app can be left in, as words a person reads. */
export interface StoppedNotice {
  readonly title: string;
  readonly body: string;
  readonly dismiss: string;
}

export interface ResidentRuntimeDeps {
  readonly service: AppService;
  /** Live stored receives, for the risk snapshot. Absent in tests that do not
   *  compose the feature. */
  readonly storedActive?: () => number;
  readonly resident: ResidentBridge;
  readonly platform: ResidentPlatform;
  /** The language to start in, before the page has said which it is showing. */
  readonly locale?: Locale;
  /** Rebuild anything native that is already on screen — the tray menu. */
  /**
   * Stop or resume CLAIMING deliveries. Main's own service, not the page's.
   *
   * Required rather than optional: a tray that offers the item and then does
   * nothing is worse than one that does not offer it, and an optional
   * dependency is how that happens quietly.
   */
  readonly setInboxPaused: (paused: boolean) => void;
  readonly inboxPaused: () => boolean;
  readonly onLocaleChanged?: () => void;
  /**
   * Stop admitting new work in EVERY feature main composes, synchronously and
   * without stopping anything that is running. See `HandlerControl.fence`.
   *
   * Required rather than optional: a runtime built without it would ask the
   * user to decide about a risk that could still grow while they were reading,
   * and the omission would be invisible.
   */
  readonly fence: () => void;
  /**
   * Stop main's own outgoing work, recoverably: sockets, ICE reads, leases,
   * sign-in, queued transitions and secret writes. Never ends the process.
   */
  readonly quiesce: () => Promise<CleanupOutcome>;
  /** The user stayed: undo every fence, in one place. See `HandlerControl`. */
  readonly resume: () => void;
  /** The final, unrecoverable teardown. Only after a decision of `quit`. */
  readonly dispose: () => Promise<void>;
  /** Helper processes abandoned by a cancelled operation. Joined AFTER the
   *  service's own work, never instead of it. */
  readonly drainAbandoned?: () => Promise<number>;
}

/**
 * Everything the quiesce could not finish OR could not confirm.
 *
 * All three sources, not just main's leases. A page that never acknowledged may
 * still be sending, and a helper that could not be drained may still be
 * running; reporting either only to a log makes the dialog say "nothing to
 * worry about" over exactly what the user should be deciding.
 */
function residueOf(
  outcome: CleanupOutcome,
  uncertainty: { rendererConfirmed: boolean; helpers: number; helperFailed: boolean },
): CleanupResidue {
  const reasons: ResidueReason[] = [];
  if (outcome.unresolved > 0) reasons.push("staged-files");
  if (outcome.openLeases > 0 || outcome.opening > 0) reasons.push("open-lease");
  // Asked to stop and not seen to stop. Not a file fact, so it takes the
  // unknown sentence rather than "some files could not be cleaned up".
  if (outcome.networkUnsettled > 0) reasons.push("network-unsettled");
  if (!uncertainty.rendererConfirmed) reasons.push("renderer-unconfirmed");
  if (uncertainty.helpers > 0 || uncertainty.helperFailed) reasons.push("helper-processes");
  if (reasons.length === 0 && outcome.firstReason !== null) reasons.push("unknown");
  return {
    reasons,
    count:
      outcome.unresolved +
      outcome.openLeases +
      outcome.opening +
      outcome.networkUnsettled +
      Math.max(0, uncertainty.helpers) +
      (uncertainty.rendererConfirmed ? 0 : 1),
  };
}

export class ResidentRuntime {
  private readonly firstClose: FirstCloseCoordinator;
  private readonly quit: QuitCoordinator;
  /** Set once a quit has been agreed to, so `close` stops hiding. */
  private quitting = false;
  /**
   * The WHOLE quit, not merely the question.
   *
   * `QuitCoordinator` coalesces the prompt and the cleanup, but three callers
   * sharing one decision each went on to run the teardown and the exit for
   * themselves — three disposes and three exits, or on a Stay three resume
   * cycles. Cleared only while the app is still alive, so a later, genuine quit
   * can still happen.
   */
  private quitRun: Promise<QuitDecision> | null = null;
  /** Whether the page agreed to start nothing while a quit is deciding. */
  private rendererFenced = false;
  /** Whether the user was actually shown residue and chose to quit anyway. */
  private residueAccepted = false;
  /**
   * The app is on screen and cannot work: a teardown failed partway and the
   * user chose to stay. Read by anything that would otherwise describe this as
   * a working app.
   */
  private stopped = false;

  /** The page's language, followed rather than read from the OS twice. */
  private locale: Locale;
  private translate: Translate;
  /** Whether Nearby is running, as last reported by the page. */
  private nearby = false;

  constructor(private readonly deps: ResidentRuntimeDeps) {
    this.locale = deps.locale ?? "en";
    this.translate = translator(this.locale);
    // A STABLE wrapper, so the coordinators built once below keep asking the
    // current catalogue rather than capturing the one at construction.
    const t: Translate = (key) => this.translate(key);
    this.firstClose = new FirstCloseCoordinator({
      store: {
        read: deps.platform.readAcknowledged,
        write: deps.platform.writeAcknowledged,
      },
      ask: deps.platform.askFirstClose,
      reportFailure: deps.platform.reportFailure,
      t,
    });

    this.quit = new QuitCoordinator({
      risk: () => this.snapshotRisk(),
      confirm: (prompt) => deps.platform.confirm(prompt),
      cleanup: () => this.quiesce(),
      onResidue: async (_residue, prompt) => {
        const accepted = await deps.platform.confirm(prompt);
        this.residueAccepted = accepted === true;
        return accepted;
      },
      reportFailure: deps.platform.reportFailure,
      t,
    });
  }

  /** True once quit is agreed and the window may actually close. */
  get isQuitting(): boolean {
    return this.quitting;
  }

  /**
   * True once a failed teardown has left this process unable to work.
   *
   * Not a synonym for "quitting": the user stayed, the window is theirs, and
   * nothing here closes it. It exists so no surface reports a healthy app.
   */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * A window close. Hide, quit or nothing — and never a teardown by itself.
   *
   * The notice is shown once. Afterwards a close hides silently, which is what
   * every resident Windows app does and what the acknowledgement records.
   */
  async onWindowClose(): Promise<FirstCloseOutcome> {
    const outcome = await this.firstClose.onClose();
    if (outcome.action === "hide") this.deps.platform.hide();
    if (outcome.action === "quit") void this.requestQuit();
    // `cancel` does nothing on purpose: the window stays exactly as it was,
    // including its rooms and transfers.
    return outcome;
  }

  /**
   * Quit, if the user says so.
   *
   * Repeated requests — the tray, the window, a second `before-quit` — join the
   * first decision rather than opening a second dialog over the same choice.
   */
  requestQuit(): Promise<QuitDecision> {
    if (this.quitRun) return this.quitRun;
    const run = this.runQuit().finally(() => {
      // A quit that succeeded ends the process, so this is unobservable there;
      // a Stay must be followed by the ability to quit for real later.
      if (!this.quitting) this.quitRun = null;
    });
    this.quitRun = run;
    return run;
  }

  private async runQuit(): Promise<QuitDecision> {
    // BOTH halves fenced before the question is asked, and left fenced through
    // the answer. Main can refuse new work by itself; an outgoing send, a new
    // room and a pairing join all START in the page, so without its agreement
    // a "nothing at stake" answer is only true for one side.
    //
    // Main's half is fenced FIRST and synchronously, before the await below.
    // It was `service.fenceReceives()` — one feature of several — so a stored
    // receive could still be admitted while the page was being asked and while
    // a human read the dialog. The page's acknowledgement is not main's
    // admission authority: it can be slow, stale or never arrive, and main
    // must already be refusing by then.
    //
    // A fence is not a quiesce: nothing running stops, and Stay clears it.
    this.deps.fence();
    const fenced = await this.deps.resident.send({ kind: "admission", action: "fence" });
    this.rendererFenced = fenced !== "unavailable" && fenced.ok;

    let decision: QuitDecision;
    try {
      decision = await this.quit.request();
    } catch (err) {
      this.deps.platform.reportFailure(err);
      decision = "stay";
    }
    if (decision === "stay") {
      await this.stay();
      return decision;
    }
    this.quitting = true;
    // The terminal teardown, and only now: everything before this point was
    // recoverable because the user could still choose Stay.
    try {
      await this.deps.dispose();
    } catch (err) {
      this.deps.platform.reportFailure(err);
      // "They already agreed to leave residue behind" is only true if they were
      // ASKED. On a clean or no-risk path nobody was, so a failure discovered
      // here is a NEW fact and gets its own question rather than being waved
      // through on a consent that was never given.
      if (!this.residueAccepted) {
        const asked = await this.deps.platform
          .confirm({
            title: this.translate("resident.quit.residueUnknownTitle"),
            body: this.translate("resident.quit.residueUnknownBody"),
            quitAction: this.translate("resident.quit.residueQuitAnyway"),
            stayAction: this.translate("resident.quit.residueStay"),
          })
          .catch((askErr: unknown) => {
            this.deps.platform.reportFailure(askErr);
            return false;
          });
        if (asked !== true) {
          // Not exiting, and not relaunching: they said stay, and neither of
          // those is something to do on their behalf.
          //
          // But "stay" cannot mean what it usually means here. The teardown ran
          // and failed partway, so what is left is a window in front of a
          // service that will refuse everything. Saying that only to the
          // diagnostics sink left the user with an app that looks fine and does
          // nothing, so it is said on screen, in their language, with the one
          // action that fixes it.
          this.quitting = false;
          this.stopped = true;
          this.deps.platform.reportFailure(
            new Error("shutdown failed and the user chose to stay; the app must be restarted"),
          );
          this.deps.platform.showStopped({
            title: this.translate("resident.stopped.title"),
            body: this.translate("resident.stopped.body"),
            dismiss: this.translate("resident.stopped.dismiss"),
          });
          return "stay";
        }
      }
    }
    this.deps.platform.exit();
    return decision;
  }

  /**
   * Follow the page's language.
   *
   * Called whenever the page says which catalogue it is showing, so a Chinese
   * window never gets an English quit dialog. Rebuilding the tray is the
   * caller's job because the menu is already on screen.
   */
  setLocale(locale: Locale): void {
    if (locale === this.locale) return;
    this.locale = locale;
    this.translate = translator(locale);
    this.deps.onLocaleChanged?.();
  }

  /** The language every native surface should be using right now. */
  get currentLocale(): Locale {
    return this.locale;
  }

  /** Whether Nearby is running, as the page last reported. */
  setNearbyActive(active: boolean): void {
    if (active === this.nearby) return;
    this.nearby = active;
    this.deps.onLocaleChanged?.();
  }

  /** Tray menu, wired to the real actions. */
  trayMenu(): readonly TrayMenuEntry[] {
    return trayMenuTemplate(this.translate, this.trayActions());
  }

  trayTooltip(): string {
    return trayTooltip(this.translate);
  }

  trayActions(): TrayActions {
    return {
      show: () => this.deps.platform.show(),
      openNearby: () => void this.openPage("lan"),
      openInbox: () => void this.openPage("inbox"),
      // The settings page, where the update pane is. The menu opens it and
      // acts on nothing: a menu item cannot show what it would do.
      openUpdates: () => void this.openPage("account"),
      setNearby: (active) => void this.setLan(active ? "resume" : "pause"),
      nearbyActive: () => this.nearby,
      // Straight to main's own service: unlike Nearby, whose room the PAGE
      // owns, the Device Inbox runs here. It therefore works with the window
      // hidden or closed, which is the state a tray item exists for.
      setInboxPaused: (paused) => {
        this.deps.setInboxPaused(paused);
        // The label says what it will DO, so it has to be rebuilt once the
        // state has moved. The same refresh a locale change uses.
        this.deps.onLocaleChanged?.();
      },
      inboxPaused: () => this.deps.inboxPaused(),
      quit: () => void this.requestQuit(),
    };
  }

  /**
   * A publication finished. Announce what actually happened.
   *
   * Main's own observation, not the page's claim: `complete` means this process
   * wrote those files under their final names. A received TEXT is never this —
   * it saves no files, and announcing "files saved" for one would be a lie the
   * user acts on.
   */
  onPublished(report: PublishReport): void {
    if (report.status === "complete") {
      this.notify({ kind: "saved", files: report.publishedCount });
      return;
    }
    // `partial` and `failed` are both "it did not finish", which is the fact
    // the notification carries; the detail belongs on screen, not on a toast.
    this.notify({ kind: "failed" });
  }

  /** Something only the page can see. A closed kind; main writes the words. */
  onNotice(notice: ResidentNotice): void {
    this.notify(notice === "attention" ? { kind: "attention" } : { kind: "saved-message" });
  }

  /** Open a page, bringing the window forward first — the tray's other job. */
  async openPage(page: ResidentPage): Promise<boolean> {
    this.deps.platform.show();
    const ack = await this.deps.resident.send({ kind: "navigate", page });
    return ack !== "unavailable" && ack.ok;
  }

  /** Pause or resume same-network discovery from outside the page. */
  async setLan(action: "pause" | "resume"): Promise<boolean> {
    const ack = await this.deps.resident.send({ kind: "lan", action });
    return ack !== "unavailable" && ack.ok;
  }

  /**
   * A pairing code that arrived from outside the app.
   *
   * Handed to the page as a code, never merged into whatever it is doing: the
   * page decides, keeps its draft and its cancel intent, and asks if it must.
   */
  async offerPairCode(code: string, mode?: "text" | "files"): Promise<boolean> {
    this.deps.platform.show();
    const command: ResidentCommand = mode
      ? { kind: "pair-code", code, mode }
      : { kind: "pair-code", code };
    const ack = await this.deps.resident.send(command);
    return ack !== "unavailable" && ack.ok;
  }

  /**
   * A stored link from the OS. Offered to the page, never acted on here.
   *
   * The window comes forward because the user just asked for this app; the page
   * shows the link on its Stored route and waits for them.
   */
  async offerStoredLink(link: string): Promise<boolean> {
    this.deps.platform.show();
    const ack = await this.deps.resident.send({ kind: "stored-link", link });
    return ack !== "unavailable" && ack.ok;
  }

  /**
   * Emit a notification for something that actually happened.
   *
   * Suppressed while the window is focused: the user is looking at the thing
   * being announced. `attention` is not suppressed — it exists because
   * something is waiting for them.
   */
  notify(event: NotificationEvent): boolean {
    if (event.kind !== "attention" && this.deps.platform.isFocused()) return false;
    const content = present(event, this.translate);
    this.deps.platform.notify(content.title, content.body);
    return true;
  }

  /**
   * What quitting would cost, read fresh.
   *
   * Main knows what IT holds. It does not know about an outgoing WebRTC send or
   * an unsent draft — both live in the page — so the page is asked, and an
   * answer that does not arrive makes the whole thing UNKNOWN rather than
   * quietly nothing. A hidden window is asked like any other; hidden is not
   * unavailable.
   */
  private async snapshotRisk() {
    // Everything main holds or might: a registered lease, an open still inside
    // the picker, and a destination whose cleanup has not succeeded. Counting
    // only registered leases would call an unfinished open "nothing".
    const mainTransfer =
      this.deps.service.heldReceiveCount > 0 || (this.deps.storedActive?.() ?? 0) > 0;

    // A page that could not be fenced can start work between this answer and
    // the quit it authorises, so nothing it says can settle the question.
    if (!this.rendererFenced) return "unknown" as const;

    const snapshot = await this.deps.resident.freshSnapshot();
    if (snapshot === "unknown") return "unknown" as const;

    const page: ResidentSnapshot = snapshot;
    const transfer = mainTransfer || page.sending || page.receiving;
    const drafts = page.drafts > 0 && page.drafts <= MAX_RESIDENT_DRAFTS;
    return quitRisk(transfer, drafts);
  }

  /**
   * Stop, recoverably, in the order that makes the answer true.
   *
   * The page's rooms first — an outgoing transfer is its to stop — then main's
   * own leases, sign-in and secret work, and only then the helper's abandoned
   * processes. Draining the abandoned work first would return while an active
   * secret write was still running, because that drain tracks the abandoned and
   * not the active.
   */
  private async quiesce(): Promise<CleanupResidue> {
    const stopped = await this.deps.resident.send({ kind: "quiesce" });
    const rendererConfirmed = stopped !== "unavailable" && stopped.ok;
    if (!rendererConfirmed) {
      // Reported AND carried into the residue below. A page that never said it
      // stopped may still be sending, and only the user can decide whether to
      // end that; a log line decides it for them.
      this.deps.platform.reportFailure(new Error("renderer did not acknowledge quiesce"));
    }

    // Main's own sockets, ICE reads, leases, sign-in, queued transitions and
    // secret work. The page's acknowledgement is about the UI; this is where
    // main's outgoing work actually lives.
    const outcome = await this.deps.quiesce();

    let helpers = 0;
    let helperFailed = false;
    if (this.deps.drainAbandoned) {
      try {
        // The COUNT matters: helpers that could not be drained are processes
        // still running, which is a fact for the dialog, not for a log.
        helpers = await this.deps.drainAbandoned();
      } catch (err) {
        helperFailed = true;
        this.deps.platform.reportFailure(err);
      }
    }
    return residueOf(outcome, { rendererConfirmed, helpers, helperFailed });
  }

  /**
   * The user stayed. Be an app again.
   *
   * Admission is restored and the service is usable, so the next transfer and
   * the next sign-in work. Nothing that was stopped comes back: the rooms were
   * told to stop and the page is told it may operate, not told to reopen them.
   */
  private async stay(): Promise<void> {
    // Everything, not just the lease service: stored receive is fenced by the
    // same quiesce and has to be un-fenced by the same Stay.
    this.deps.resume();
    this.rendererFenced = false;
    // Admission first, then the resume. Neither reopens what was stopped: the
    // page becomes able to start things again, and is told the quit is off.
    const admitted = await this.deps.resident.send({ kind: "admission", action: "admit" });
    const ack = await this.deps.resident.send({ kind: "resume" });
    if (admitted === "unavailable" || !admitted.ok || ack === "unavailable" || !ack.ok) {
      this.deps.platform.reportFailure(new Error("renderer did not acknowledge resume"));
    }
  }
}
