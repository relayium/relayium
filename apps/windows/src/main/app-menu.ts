// The application menu, which this app was shipping without having written.
//
// ## What was on screen before this file existed
//
// Nothing called `Menu.setApplicationMenu`, so Electron installed its own
// default — and that default is a developer's menu. A shipped Relayium showed a
// menu bar whose View submenu offered **Reload**, **Force Reload** and **Toggle
// Developer Tools**: three ways to interrupt or inspect a privileged window,
// presented to every user, in a product whose whole claim is that it cannot
// read their files. macOS ships a curated menu — the standard app menu plus
// Check for Updates, and a Settings scene — with none of that.
//
// ## Why the menu is replaced rather than removed
//
// Deleting it would have been one line and a regression. On Windows the Edit
// roles are what bind Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A and Ctrl+Z: with no menu,
// those accelerators do not exist, and the stored-link field and the message
// composer become fields a person cannot paste into. The menu is not decoration
// on this platform — it is where text editing comes from.
//
// So every role that carries an accelerator stays, and the ones that only offer
// a developer a way in are gone from a shipped build. An engineering build keeps
// them, under their own submenu, because that is what an engineering build is
// for and hiding them there is not a security boundary — `isEngineeringBuild()`
// is already the gate for every other developer affordance in this app.
//
// ## Labels
//
// Supplied rather than inherited. A role's built-in label is Chromium's, in
// Chromium's idea of the locale; this app knows which language it is rendering
// and says so, in both maintained languages, from the same catalog the tray
// uses. `&` marks the Windows access key — Alt+F, Alt+E — which is how a menu
// bar is reached without a mouse here.

import type { Translate } from "./l10n.js";

/** Only what this module needs from Electron, so the template stays testable. */
export interface MenuItemTemplate {
  readonly label?: string;
  readonly role?: string;
  readonly type?: "separator";
  readonly submenu?: readonly MenuItemTemplate[];
}

/**
 * The menu a build of this app should have.
 *
 * `engineering` adds the developer submenu and nothing else: the shipped items
 * are identical in both, so what a developer tests is what a user gets.
 */
export function applicationMenuTemplate(t: Translate, engineering: boolean): MenuItemTemplate[] {
  const menu: MenuItemTemplate[] = [
    {
      label: t("menu.file"),
      submenu: [{ role: "quit", label: t("menu.quit") }],
    },
    {
      label: t("menu.edit"),
      // Every one of these is an accelerator before it is a menu item. A person
      // pasting a link into this app is using this submenu without opening it.
      submenu: [
        { role: "undo", label: t("menu.undo") },
        { role: "redo", label: t("menu.redo") },
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { role: "selectAll", label: t("menu.selectAll") },
      ],
    },
    {
      label: t("menu.view"),
      // Zoom and full screen only. These change how the app is displayed; they
      // do not reload it or open a window onto its internals.
      submenu: [
        { role: "resetZoom", label: t("menu.actualSize") },
        { role: "zoomIn", label: t("menu.zoomIn") },
        { role: "zoomOut", label: t("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("menu.fullScreen") },
      ],
    },
    {
      label: t("menu.window"),
      // `close` hides to the tray rather than quitting — the window's own
      // handler decides that, and this item goes through it like the button.
      submenu: [
        { role: "minimize", label: t("menu.minimize") },
        { role: "close", label: t("menu.close") },
      ],
    },
  ];

  if (engineering) {
    menu.push({
      label: t("menu.developer"),
      submenu: [
        { role: "reload", label: t("menu.reload") },
        { role: "forceReload", label: t("menu.forceReload") },
        { type: "separator" },
        { role: "toggleDevTools", label: t("menu.devTools") },
      ],
    });
  }
  return menu;
}

/** The roles a shipped build must not offer. Named once, asserted from here. */
export const DEVELOPER_ROLES: readonly string[] = ["reload", "forceReload", "toggleDevTools"];
