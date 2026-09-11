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

export interface TrayMenuItem {
  readonly label: string;
  readonly click: () => void;
}

export type TrayMenuEntry = TrayMenuItem | { readonly type: "separator" };

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
  readonly quit: () => void;
}

/**
 * The context menu, in order.
 *
 * Quit is separated from Show deliberately: they are the only two items, one is
 * harmless and one ends the process, and a mis-click between adjacent items
 * should not be able to quit an app the user meant to open.
 */
export function trayMenuTemplate(t: Translate, actions: TrayActions): readonly TrayMenuEntry[] {
  const active = actions.nearbyActive();
  const paused = actions.inboxPaused();
  return [
    { label: t("resident.tray.show"), click: actions.show },
    { type: "separator" },
    { label: t("resident.tray.nearby"), click: actions.openNearby },
    { label: t("resident.tray.inbox"), click: actions.openInbox },
    { label: t("resident.tray.updates"), click: actions.openUpdates },
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
