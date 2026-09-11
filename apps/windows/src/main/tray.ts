// The tray menu.
//
// ## Scope, and what is owed
//
// Show and Quit. That is not the finished design: the macOS `MenuBarExtra` is a
// live control surface — it can resume nearby receiving and reach the Device
// Inbox, which is what makes a hidden Mac reachable rather than merely running.
// Those actions are OWED on Windows as soon as those features exist here. They
// are absent now because the destinations do not exist, and a menu offering
// controls over nothing would be a fake functional surface.
//
// The menu template is built as data so it can be asserted without an Electron
// tray. Nothing in this module imports Electron.

import type { Translate } from "./l10n.js";
import type { InboxStatus } from "../shared/ipc-contract.js";

export interface TrayMenuItem {
  readonly label: string;
  readonly click: () => void;
}

/**
 * A line that reports rather than acts.
 *
 * Not a disabled control: there is nothing here to press and no action being
 * withheld. It is the answer to the question a person opens a tray menu to ask
 * — is this thing still doing anything — which on a resident app is the one
 * question the window cannot answer, because the window is shut.
 */
export interface TrayStatusLine {
  readonly label: string;
  readonly enabled: false;
}

export type TrayMenuEntry = TrayMenuItem | TrayStatusLine | { readonly type: "separator" };

export interface TrayActions {
  readonly show: () => void;
  /** Open a page directly. The tray is the only way back to a hidden window,
   *  so it is also the fastest way to the thing the user came back FOR. */
  readonly openNearby: () => void;
  readonly openInbox: () => void;
  /**
   * Open the page the update lives on.
   *
   * The tray is the only way back to a hidden window, and "is there an update?"
   * is a question people ask of a tray icon. It opens the SETTINGS page rather
   * than acting: nothing about an update should happen from a menu, because a
   * menu cannot show what it is about to do.
   */
  readonly openUpdates: () => void;
  /** Pause or resume same-network discovery without opening the window. */
  readonly setNearby: (active: boolean) => void;
  /** Whether Nearby is currently on, so the item can say which it does. */
  readonly nearbyActive: () => boolean;
  /**
   * Stop or resume CLAIMING deliveries, without changing the stored answer.
   *
   * Deliberately not the enable/disable the page offers. That writes the user's
   * policy and tells central; this stops taking new deliveries and touches
   * neither, so pausing from a menu cannot un-enrol a device by accident. A
   * delivery already running is unaffected.
   */
  readonly setInboxPaused: (paused: boolean) => void;
  /** Whether claiming is currently paused, so the item can say which it does. */
  readonly inboxPaused: () => boolean;
  /** What the Device Inbox is doing, for the line that reports it. */
  readonly inboxStatus: () => InboxStatus;
  /**
   * Show the folder deliveries land in, and whether there is one to show.
   *
   * The pair is deliberate. A menu has nowhere to put a refusal — no room for a
   * sentence and nothing that stays on screen long enough to read one — so the
   * item is ABSENT when there is no folder rather than present and refusing.
   * That is the rule the rest of this app follows for any control whose reason
   * cannot be shown beside it.
   */
  readonly revealInbox: () => void;
  readonly hasInboxFolder: () => boolean;
  /**
   * The signed-in account, or "" when there is none.
   *
   * The address itself, because a tray that said only "signed in" would not
   * answer the question people actually open it for on a machine with more
   * than one account. Nothing else about the account crosses.
   */
  readonly accountIdentity: () => string;
  readonly quit: () => void;
}

/**
 * The context menu, in order.
 *
 * Quit is separated from Show deliberately: they are the only two items, one is
 * harmless and one ends the process, and a mis-click between adjacent items
 * should not be able to quit an app the user meant to open.
 */
/**
 * What the Device Inbox is doing, in one sentence.
 *
 * ## One opinion, in one place
 *
 * The page has its own vocabulary for these states and its own catalogue, which
 * is deliberate — `l10n.ts` exists because a tray is not a page. What must NOT
 * exist twice is the JUDGEMENT: which state means "it is working" and which
 * means "it stopped and needs you". So the mapping is here, once, and tested
 * here rather than inferred from a label somewhere else.
 *
 * Paused comes first because it outranks everything the status can say: the
 * status is deliberately unchanged by a pause — nothing was written and central
 * was not told — so reporting `idle` while claiming is stopped would be true
 * about the enrolment and wrong about the machine.
 */
export function inboxStatusLabel(t: Translate, status: InboxStatus, paused: boolean): string {
  if (paused) return t("resident.tray.statusInboxPaused");
  switch (status.kind) {
    case "unavailable":
      return t("resident.tray.statusInboxUnavailable");
    case "needs-account":
      return t("resident.tray.statusInboxNeedsAccount");
    case "account-unreadable":
      return t("resident.tray.statusInboxUnreadable");
    case "disabled":
      return t("resident.tray.statusInboxOff");
    case "folder-missing":
      return t("resident.tray.statusInboxFolderMissing");
    case "starting":
      return t("resident.tray.statusInboxStarting");
    case "receiving":
      return t("resident.tray.statusInboxReceiving");
    case "blocked":
      return t("resident.tray.statusInboxBlocked");
    case "offline":
      return t("resident.tray.statusInboxOffline");
    // `idle` is the ordinary on state. Anything unrecognised is reported as ON
    // rather than as a fault: a state this build does not know about is not
    // evidence that receiving stopped, and claiming it stopped would be the
    // more harmful of the two guesses.
    default:
      return t("resident.tray.statusInboxOn");
  }
}

export function trayMenuTemplate(t: Translate, actions: TrayActions): readonly TrayMenuEntry[] {
  const active = actions.nearbyActive();
  const paused = actions.inboxPaused();
  const account = actions.accountIdentity();
  return [
    // ## The status comes FIRST, above everything that acts
    //
    // A resident app receives with its window shut, so "is it still doing
    // anything" is the question the tray is opened to answer and the window
    // cannot. Reporting it under the actions would put the answer below the
    // things a person might press by accident on the way to it.
    {
      label: account === "" ? t("resident.tray.statusSignedOut") : account,
      enabled: false,
    },
    { label: inboxStatusLabel(t, actions.inboxStatus(), paused), enabled: false },
    {
      label: active ? t("resident.tray.statusNearbyOn") : t("resident.tray.statusNearbyOff"),
      enabled: false,
    },
    { type: "separator" },
    { label: t("resident.tray.show"), click: actions.show },
    { type: "separator" },
    { label: t("resident.tray.nearby"), click: actions.openNearby },
    { label: t("resident.tray.inbox"), click: actions.openInbox },
    { label: t("resident.tray.updates"), click: actions.openUpdates },
    // "Where did my files go" is a question asked of a tray icon, and answering
    // it should not require opening the window the files arrived without.
    //
    // Spread rather than rendered-and-disabled: a menu has nowhere to put a
    // refusal, so when there is no folder the item is ABSENT instead of present
    // and failing.
    ...(actions.hasInboxFolder()
      ? [{ label: t("resident.tray.revealInbox"), click: actions.revealInbox }]
      : []),
    {
      // Says what it will DO, not what is true now: a menu item labelled with a
      // state is read as a toggle by half of everyone and as a status by the
      // other half.
      label: t(active ? "resident.tray.pauseNearby" : "resident.tray.resumeNearby"),
      click: () => actions.setNearby(!active),
    },
    {
      // The Device Inbox has the same pair, for the same reason: this app
      // receives while its window is hidden, so the tray has to be able to stop
      // it. Pausing here does NOT write the policy or tell central — a menu is
      // the wrong place to un-enrol a device from.
      label: t(paused ? "resident.tray.resumeInbox" : "resident.tray.pauseInbox"),
      click: () => actions.setInboxPaused(!paused),
    },
    { type: "separator" },
    { label: t("resident.tray.quit"), click: actions.quit },
  ];
}

export function trayTooltip(t: Translate): string {
  return t("resident.tray.tooltip");
}
