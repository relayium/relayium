// The one window, the rules it is created under, and the only way out to a
// browser.
//
// Every flag below is load-bearing. They are set here rather than at the call
// site so `window.test.ts` can assert the exact set, and so a future window
// cannot be created with a quietly weaker one.

import { shell, type BrowserWindow, type WebPreferences } from "electron";

/**
 * The renderer's privileges, stated once.
 *
 *   * `sandbox` — the renderer runs in an OS sandbox, so a scripting bug in the
 *     UI is not code execution on the user's machine.
 *   * `contextIsolation` — the preload's world is separate from the page's, so
 *     page script cannot reach `ipcRenderer` by walking prototypes.
 *   * `nodeIntegration: false` — no `require` in the page.
 *   * `webviewTag: false` — a `<webview>` would be a second, unaudited renderer.
 *   * `webSecurity` — same-origin policy stays on.
 */
export const RENDERER_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
} as const satisfies WebPreferences;

/**
 * Is this URL the app's own bundle?
 *
 * ## Why this does not compare `URL.origin`
 *
 * `app:` is not a "special" scheme, so WHATWG `URL` gives it the **opaque**
 * origin — the string `"null"`. So do `file:`, `data:`, `blob:` of an opaque
 * origin, and every other custom scheme. Comparing `url.origin === "app://…"`
 * therefore fails open in the worst way: `file:///C:/Users/…` and
 * `data:text/html,…` both produce `"null"`, and any check written that way
 * treats them as the app's own page.
 *
 * So the parts are compared directly: scheme, host, and the absence of
 * credentials or a port. Nothing here can be satisfied by an opaque origin.
 */
export function isAppBundleURL(raw: string, scheme: string, host: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== `${scheme}:`) return false;
  // `hostname`, not `host`: `host` carries a port, and `app://relayium:1234/`
  // must not pass a check written against `app://relayium`.
  if (url.hostname !== host) return false;
  if (url.port !== "") return false;
  if (url.username !== "" || url.password !== "") return false;
  return true;
}

/**
 * Refuse everything the app does not explicitly need.
 *
 * ## Navigation and `window.open` DENY. They do not forward.
 *
 * An earlier shape handed any `http(s)` URL to `shell.openExternal` from these
 * handlers. That is script-triggered browser navigation: a foothold in the
 * renderer could open any page it liked, with the user's real browser session,
 * without a user action. Both handlers now simply refuse.
 *
 * The one legitimate journey out — the device-approval page — is opened by an
 * explicit main-process handler that validated the URL against this build's own
 * origin and approval path first. That route is a declared capability, not a
 * side effect of navigation.
 */
export function hardenContents(
  window: BrowserWindow,
  scheme: string,
  host: string,
  onRefused?: (url: string, why: "window-open" | "navigate") => void,
): void {
  const contents = window.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    onRefused?.(url, "window-open");
    return { action: "deny" };
  });

  // Without this, one `location.href` in the renderer turns the privileged
  // window into a browser for remote content that keeps the preload bridge.
  contents.on("will-navigate", (event, url) => {
    if (isAppBundleURL(url, scheme, host)) return;
    event.preventDefault();
    onRefused?.(url, "navigate");
  });

  // A renderer that never asks for these must not be granted them by a
  // default-allow policy.
  contents.session.setPermissionRequestHandler((_c, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);

  // `<webview>` is disabled in the preferences above; refusing the attach as
  // well means the two halves cannot drift apart.
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * Hand ONE approved URL to the user's browser.
 *
 * Callers must have validated the destination already; this re-checks scheme,
 * credentials and origin because `shell.openExternal` launches whatever the OS
 * associates with a scheme, and an unchecked value is program launch on the
 * user's behalf.
 *
 * Returns whether it opened, so a caller can report a refusal rather than
 * silently appearing to succeed.
 */
export async function openApprovedExternal(url: string, allowedOrigin: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  // `https:` IS a special scheme, so `origin` is meaningful here — unlike the
  // app-bundle check above, which is why the two are written differently.
  if (parsed.origin !== allowedOrigin) return false;
  await shell.openExternal(parsed.toString());
  return true;
}
