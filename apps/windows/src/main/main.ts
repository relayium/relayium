// Bootstrap.
//
// ## The renderer is served from a registered app scheme, not from `file://`
//
// `file://` gives every page an opaque origin, which makes the same-origin
// checks this app relies on meaningless — `will-navigate` cannot compare an
// origin that does not exist, and neither can the IPC sender check. So the
// bundle is served over `app://relayium/`, registered as standard and secure
// before `ready`, giving the renderer one real, stable origin that is not a
// server anyone else can reach.
//
// ## Single instance, because a second one would be a second identity
//
// Two processes would race for the same installation identity, the same secret
// files and the same tray icon. The second instance hands its arguments to the
// first and exits, which is also how a `relayium://` deep link opened while the
// app is already running reaches the window that exists.

import { app, BrowserWindow, Menu, nativeImage, protocol, Tray } from "electron";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINEERING_BANNER, isEngineeringBuild } from "./build-mode.js";
import { apiOrigin } from "./origin.js";
import { registerHandlers } from "./handlers.js";
import { hardenContents, RENDERER_PREFERENCES } from "./window.js";
import type { HandlerComposition } from "./handlers.js";

export const APP_SCHEME = "app";
export const APP_HOST = "relayium";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const DEEP_LINK_SCHEME = "relayium";

const rendererRoot = resolve(fileURLToPath(new URL("../renderer", import.meta.url)));

// Registered before `ready`, which is the only time Electron accepts it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/**
 * Map a request path to a file inside the bundle, or refuse.
 *
 * Exported and pure so the traversal cases are unit-testable: a scheme handler
 * that resolves `app://relayium/../../secrets` is a file-disclosure bug with a
 * privileged reader attached.
 */
export function resolveBundlePath(root: string, requestPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(requestPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null) return null;
  if (decoded.includes("\0")) return null;
  const relative = decoded.replace(/^\/+/, "");
  const target = normalize(join(root, relative === "" ? "index.html" : relative));
  const rooted = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rooted)) return null;
  return target;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/**
 * The renderer's CSP.
 *
 * `'wasm-unsafe-eval'` is mandatory, not decoration: libsodium is WASM, and
 * without it `crypto.ready()` rejects and no transfer of any kind works. The
 * narrow token is chosen over `'unsafe-eval'` so `eval` and `new Function` stay
 * blocked.
 *
 * `connect-src` is the zero-knowledge control. The web client narrowed its own
 * from a broad `https:` precisely because a script foothold could POST the
 * `#k=` content keys to any host; the same reasoning applies here with more
 * force, so it names this build's API origin and nothing else.
 */
export function contentSecurityPolicy(origin: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src '${"self"}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${origin} ${origin.replace(/^http/, "ws")}`,
    "worker-src 'self'",
  ].join("; ");
}

function registerAppScheme(origin: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response("not found", { status: 404 });
    const target = resolveBundlePath(rendererRoot, url.pathname);
    if (!target) return new Response("forbidden", { status: 403 });
    try {
      const body = await readFile(target);
      const ext = target.slice(target.lastIndexOf("."));
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
          "content-security-policy": contentSecurityPolicy(origin),
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Owned teardown for everything `registerHandlers` started. */
let disposeHandlers: (() => Promise<void>) | null = null;
/** Set only by an explicit Quit, so closing the window hides instead. */
let quitting = false;

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "Relayium",
    icon: fileURLToPath(new URL("../../assets/app-icon.png", import.meta.url)),
    webPreferences: {
      ...RENDERER_PREFERENCES,
      // This app's job is to stay reachable while hidden. Chromium throttles
      // timers in background windows by default, which would stall a transfer
      // the moment the window is minimised to the tray.
      backgroundThrottling: false,
      preload: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)),
    },
  });
  hardenContents(window, APP_SCHEME, APP_HOST, (url, why) => {
    // Recorded, not forwarded. A refused navigation is a signal worth seeing in
    // a log; handing it to the user's browser would be script-triggered
    // browsing with their real session.
    process.stderr.write(`relayium: refused ${why} to ${new URL(url).protocol}\n`);
  });

  // Closing hides. The macOS app makes the same choice
  // (`applicationShouldTerminateAfterLastWindowClosed = false`) for the same
  // reason: this app's job is to stay reachable, and a window is not the app.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  return window;
}

/**
 * The tray artwork — the real brand mark, not an empty image.
 *
 * This is load-bearing rather than cosmetic. Closing the window hides the app,
 * and the tray icon is then the ONLY way back to it. An empty image gives a
 * zero-size, effectively invisible tray entry, which turns "hide to tray" into
 * "the app vanished and cannot be recovered".
 *
 * Sourced from the same `AppIcon` artwork the macOS app ships, so the two
 * platforms present one brand.
 */
function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(
    fileURLToPath(new URL("../../assets/tray.png", import.meta.url)),
  );
  if (image.isEmpty()) {
    // Loud rather than silent: an unreadable icon means the packaged build is
    // missing an asset, and the symptom would otherwise be an unrecoverable
    // hidden window.
    throw new Error("tray icon asset missing or unreadable");
  }
  return image;
}

function createTray(): void {
  // A resident tray presence is the baseline, not a nicety: receiving while the
  // window is hidden is what "reachable" means, and a tray icon is the only
  // honest way to tell the user the app is still running.
  tray = new Tray(trayIcon());
  tray.setToolTip("Relayium");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Relayium", click: showWindow },
      { type: "separator" },
      {
        label: "Quit Relayium",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

/** A `relayium://` URL from a second instance or an OS activation. */
function handleDeepLink(argv: readonly string[]): void {
  const link = argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`));
  if (!link) return;
  showWindow();
  // Routing the link to a destination is a later slice; what is delivered here
  // is that a second instance forwards it and the existing window comes forward
  // rather than a second app starting.
}

export interface BootstrapOptions {
  /** Substituted composition. See `HandlerComposition` — injection only, never
   *  an ambient override, and never supplied by the shipped entry point. */
  readonly composition?: HandlerComposition;
  /** Leave the window hidden. A test drives the renderer through `webContents`
   *  and has no reason to put a window on a developer's screen. */
  readonly showOnLaunch?: boolean;
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", (_event, argv) => {
    showWindow();
    handleDeepLink(argv);
  });

  // ## This app never registers `relayium://`. The installer owns it.
  //
  // `assets/installer.nsh` writes the association at install time and removes it
  // at uninstall, only when it still names that installation. Registering here
  // too would put a second writer on a shared, single-valued resource and would
  // leave a key the uninstaller could not recognise as its own.
  //
  // Nothing in this process mutates a host association, packaged or not: a
  // development run or a smoke test must never seize the scheme from whatever
  // already owns it. The app only *handles* what it is given — see
  // `handleDeepLink`.

  await app.whenReady();
  const origin = apiOrigin();
  registerAppScheme(origin);

  mainWindow = await createWindow();
  // Handlers are registered BEFORE the renderer is loaded. The page's first
  // `appInfo()` runs as soon as the bundle executes, and a handler registered
  // after `loadURL` races it — intermittently, which is the worst kind.
  disposeHandlers = registerHandlers(mainWindow, origin, APP_SCHEME, APP_HOST, options.composition ?? {});
  createTray();
  await mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  if (isEngineeringBuild()) {
    // The macOS Engineering candidate carries a permanent banner for exactly
    // this reason: a build talking to a non-production origin must never be
    // mistakable for the real one.
    mainWindow.setTitle(`Relayium — ${ENGINEERING_BANNER}`);
  }

  if (options.showOnLaunch !== false) showWindow();
  handleDeepLink(process.argv);

  app.on("before-quit", (event) => {
    quitting = true;
    if (!disposeHandlers) return;
    // Cancel in-flight sign-ins and receive leases before the process goes
    // away, so a quit does not leave staged bytes on the user's disk.
    const dispose = disposeHandlers;
    disposeHandlers = null;
    event.preventDefault();
    void dispose().finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    // Deliberately empty: the tray keeps the app alive. Quit is explicit.
  });
}
