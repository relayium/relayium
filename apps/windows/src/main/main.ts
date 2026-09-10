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

import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, protocol, Tray } from "electron";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINEERING_BANNER, isEngineeringBuild } from "./build-mode.js";
import { apiOrigin } from "./origin.js";
import { registerHandlers } from "./handlers.js";
import { hardenContents, RENDERER_PREFERENCES } from "./window.js";
import type { HandlerComposition, HandlerControl } from "./handlers.js";
import { routeFromArgv } from "./deep-link.js";
import { resolveLocale, translator } from "./l10n.js";
import type { PreferenceStore } from "./preferences.js";
import { drainAbandoned } from "./secret/helper-transport.js";
import { ResidentRuntime, type ResidentPlatform } from "./resident-runtime.js";
import type { FirstCloseDialog } from "./first-run.js";
import type { QuitPrompt } from "./quit.js";

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
/** The resident behaviour. Null before `bootstrap` composes it. */
let resident: ResidentRuntime | null = null;
let handlerControl: HandlerControl | null = null;
/** Set only once a quit has actually been agreed, so a close hides instead. */
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
    if (quitting || resident?.isQuitting) return;
    event.preventDefault();
    // The first time, this explains itself and offers Hide, Quit or Cancel;
    // afterwards it hides silently. Either way it tears nothing down: the
    // renderer, its rooms and its transfers are untouched by hiding.
    void resident?.onWindowClose().catch(() => window.hide());
    if (!resident) window.hide();
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

/**
 * Ask, natively, before adding Relayium to the user's startup programs.
 *
 * In the language the window is showing, like every other native surface here,
 * and it asks BEFORE anything is written: a renderer click is a request, and
 * this is the consent.
 */
async function confirmLoginItem(): Promise<boolean> {
  const t = translator(resident ? resident.currentLocale : "en");
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: t("resident.login.confirmTitle"),
    message: t("resident.login.confirmTitle"),
    detail: t("resident.login.confirmBody"),
    buttons: [t("resident.login.confirm"), t("resident.login.cancel")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

/** Rebuild the menu in place, for a language or a Nearby change. */
function refreshTray(): void {
  if (!tray || !resident) return;
  tray.setToolTip(resident.trayTooltip());
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(resident)));
}

function trayTemplate(runtime: ResidentRuntime): Electron.MenuItemConstructorOptions[] {
  return runtime
    .trayMenu()
    .map((entry) =>
      "type" in entry ? { type: "separator" as const } : { label: entry.label, click: entry.click },
    );
}

function createTray(runtime: ResidentRuntime): void {
  // A resident tray presence is the baseline, not a nicety: receiving while the
  // window is hidden is what "reachable" means, and a tray icon is the only
  // honest way to tell the user the app is still running.
  tray = new Tray(trayIcon());
  tray.setToolTip(runtime.trayTooltip());
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(runtime)));
  // Quit goes through the coordinator, which asks first and cleans up after —
  // never `app.quit()` straight from a menu item, which would discard a running
  // transfer without a word.
  tray.on("click", () => runtime.trayActions().show());
}

/**
 * A pairing link from a second instance, an OS activation, or the web.
 *
 * Both spellings the released Mac accepts: the custom scheme, and the
 * `https://relayium.com/cross-network?mode=text#c=004291` page URL. The code
 * stays a STRING the whole way — parsed as text, validated as six digits,
 * handed on as six digits — because `004291` read as a number is `4291`, which
 * is a different room.
 *
 * The link is OFFERED to the page, never merged into what it is doing: a code
 * arriving mid-transfer does not silently join, and the draft and cancel intent
 * survive it.
 */
function handleDeepLink(argv: readonly string[]): void {
  const link = argv.find(
    (arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`) || arg.startsWith("https://"),
  );
  if (!link) return;
  showWindow();
  const parsed = routeFromArgv([link]);
  if (!parsed.ok) return;
  const route = parsed.route;
  if (route.kind === "download") {
    // Handed to the page as a LINK, which it offers back on the stored channel.
    // Opening a link does not start a download: the page shows it, the user
    // asks, and the folder picker is what authorises writing anything.
    void resident?.offerStoredLink(route.url);
    return;
  }
  if (route.kind === "realtime-with-mode") {
    void resident?.offerPairCode(route.code, route.mode === "text" ? "text" : "files");
    return;
  }
  // A pairing route with no code opens the page; there is nothing to join yet.
  if (route.kind === "realtime" && route.code !== null) void resident?.offerPairCode(route.code);
}

/**
 * The real Electron surfaces the resident behaviour drives.
 *
 * No translator here on purpose: every string is already localized by the pure
 * module that composed it, so this file cannot accidentally introduce an
 * English literal onto a Chinese screen.
 */
function residentPlatform(preferences: () => PreferenceStore): ResidentPlatform {
  const window = (): BrowserWindow | null =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

  const ask = async (options: Electron.MessageBoxOptions): Promise<number | null> => {
    const win = window();
    // Window-modal where there is a window, so the question cannot be lost
    // behind it; a hidden window is shown first, because a modal nobody can see
    // is a hang.
    if (win) {
      if (!win.isVisible()) showWindow();
      const { response } = await dialog.showMessageBox(win, options);
      return response;
    }
    const { response } = await dialog.showMessageBox(options);
    return response;
  };

  return {
    show: showWindow,
    hide: () => window()?.hide(),
    exit: () => {
      quitting = true;
      app.quit();
    },
    askFirstClose: (d: FirstCloseDialog) =>
      ask({
        type: "info",
        title: d.title,
        message: d.title,
        detail: d.body,
        buttons: [...d.buttons],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }),
    confirm: async (prompt: QuitPrompt) => {
      const response = await ask({
        type: "warning",
        title: prompt.title,
        message: prompt.title,
        detail: prompt.body,
        buttons: [prompt.quitAction, prompt.stayAction],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      // Exactly the quit button. A dismissed dialog is not consent, and neither
      // is a window closed by the compositor.
      return response === 0;
    },
    notify: (title, body) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      notification.on("click", showWindow);
      notification.show();
    },
    showStopped: (notice) => {
      // A native dialog, not a log line and not a notification: this is the one
      // state where the app is visible and cannot work, so it must be in front
      // of the user rather than behind a toast they may have muted. The window
      // is brought forward first for the same reason.
      //
      // Nothing here quits or relaunches: they chose to stay, and the message
      // says what to do rather than doing it for them. The text is entirely
      // from the closed catalogue — no error, no path.
      showWindow();
      const win = window();
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        title: notice.title,
        message: notice.title,
        detail: notice.body,
        buttons: [notice.dismiss],
        defaultId: 0,
        noLink: true,
      };
      // Fire and forget: the acknowledgement is the user's, and nothing here
      // waits on it or acts differently for it.
      void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).catch(
        () => undefined,
      );
    },
    isFocused: () => window()?.isFocused() === true,
    // The acknowledgement lives in the settings file, written through the SAME
    // store the rest of the app uses — two stores over one path would each
    // serialise only their own writes. A read that throws is treated as "not
    // acknowledged", which shows the notice again; a write that throws is
    // reported as not persisted rather than silently acked, which would make
    // the notice never appear again.
    readAcknowledged: async () => (await preferences().read()).firstCloseAcknowledged,
    writeAcknowledged: async () => {
      await preferences().write("firstCloseAcknowledged", true);
    },
    reportFailure: (err) => {
      // A log line, not a dialog: this is where a path or a raw errno is allowed
      // to go, and the user-facing surfaces carry closed codes instead.
      process.stderr.write(`relayium: ${err instanceof Error ? err.message : String(err)}\n`);
    },
  };
}

export interface BootstrapOptions {
  /** Substituted composition. See `HandlerComposition` — injection only, never
   *  an ambient override, and never supplied by the shipped entry point. */
  readonly composition?: HandlerComposition;
  /**
   * Wrap the real resident surfaces.
   *
   * Injection only, like `composition`, and for the same reason: the resident
   * behaviour is native dialogs, a tray and notifications, and an automated run
   * has to be able to answer a dialog without a person. The wrapper receives the
   * REAL platform, so anything it does not replace still runs the shipped path.
   */
  readonly residentPlatform?: (real: ResidentPlatform) => ResidentPlatform;
  /** Leave the window hidden. A test drives the renderer through `webContents`
   *  and has no reason to put a window on a developer's screen. */
  readonly showOnLaunch?: boolean;
}

/** Test/diagnostic only: the composed resident behaviour, once bootstrapped. */
export function residentRuntime(): ResidentRuntime | null {
  return resident;
}

/** Test/diagnostic only: what main still holds. */
export function ownedReceives(): number | null {
  return handlerControl?.service.openLeaseCount ?? null;
}

/**
 * Test/diagnostic only: end the Device Inbox's current backoff.
 *
 * The same thing the page's "Try again now" reaches, exposed so a driven run
 * can step the scheduler deliberately rather than sleeping through a real
 * interval. It STARTS nothing and enables nothing — a fenced or disabled
 * scheduler wakes into the same guard it was parked at.
 */
export function wakeInbox(): boolean {
  if (!handlerControl) return false;
  handlerControl.inbox.wake();
  return true;
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

  // ## Notifications need an identity, and it has to be the INSTALLER's
  //
  // On Windows a toast is attributed to an AppUserModelID, and the one that
  // exists on the machine is the shortcut's — `electron-builder.yml` sets
  // `appId: com.relayium.windows`. Without this, Electron uses a per-process
  // default that matches no installed shortcut, and the notification either
  // shows unattributed or does not appear at all. Spelled as the literal it
  // must equal rather than derived, so a mismatch is a visible edit.
  //
  // Windows-only, because it is a Windows concept; and untestable from macOS,
  // so nothing here claims it works — the claim is that the identity is set and
  // matches the installer.
  if (process.platform === "win32") app.setAppUserModelId("com.relayium.windows");

  await app.whenReady();
  const origin = apiOrigin();
  registerAppScheme(origin);

  mainWindow = await createWindow();
  // Handlers are registered BEFORE the renderer is loaded. The page's first
  // `appInfo()` runs as soon as the bundle executes, and a handler registered
  // after `loadURL` races it — intermittently, which is the worst kind.
  const control = registerHandlers(
    mainWindow,
    origin,
    APP_SCHEME,
    APP_HOST,
    {
      ...(options.composition ?? {}),
      // The folder pickers this registration opens are native dialogs, so they
      // need the same language the tray and the quit prompt use. Read per
      // dialog through the resident runtime, which is created just below and
      // follows what the PAGE reports; `app.getLocale()` is only the answer
      // until the window has said otherwise.
      locale:
        options.composition?.locale ??
        (() => resident?.currentLocale ?? resolveLocale(app.getLocale())),
    },
    {
      // Real transitions, not a method waiting for a caller: a publication that
      // actually completed, a message the page actually received, a failure
      // that actually happened.
      onPublished: (report) => resident?.onPublished(report),
      onNotice: (notice) => resident?.onNotice(notice),
      onLocale: (locale) => resident?.setLocale(locale),
      onNearby: (active) => resident?.setNearbyActive(active),
      confirmLoginItem: async () => confirmLoginItem(),
      reportFailure: (err) =>
        process.stderr.write(`relayium: ${err instanceof Error ? err.message : String(err)}\n`),
    },
  );
  handlerControl = control;

  // The main process shows native dialogs, a tray menu and notifications, and
  // they must be in the language the WINDOW is showing. `app.getLocale()` is
  // only the starting point — the page reports its own catalogue and this
  // follows it, because the two APIs can disagree.
  resident = new ResidentRuntime({
    service: control.service,
    // ## Everything main holds, INCLUDING what it is sending
    //
    // This is the pre-quit question — "is anything happening?" — and it is asked
    // BEFORE any fence or abort. It counted only the two RECEIVING features, so
    // an upload or a device delivery in flight made the app look idle at exactly
    // the moment the user was deciding whether to end it. The counts that
    // `quiesce` reports come after work has been aborted and are far too late to
    // inform a consent.
    //
    // `inventory().active` on each sender includes an admission that has not
    // registered a job yet: a send one await from opening an upload is work a
    // person would be surprised to lose, and reporting zero for it would be the
    // same omission one step earlier.
    storedActive: () =>
      control.storedReceive.active +
      control.inbox.active +
      control.storedSend.inventory().active +
      control.inboxSend.inventory().active,
    resident: control.resident,
    fence: control.fence,
    quiesce: control.quiesce,
    resume: control.resume,
    dispose: control.dispose,
    drainAbandoned: () => drainAbandoned(),
    locale: resolveLocale(app.getLocale()),
    onLocaleChanged: () => refreshTray(),
    platform: options.residentPlatform
      ? options.residentPlatform(residentPlatform(control.preferences))
      : residentPlatform(control.preferences),
  });
  createTray(resident);
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
    // Already agreed, already cleaned up — this is the coordinator's own exit
    // coming back around, and it must be allowed through.
    if (quitting || resident?.isQuitting) return;
    event.preventDefault();
    // Ask, join, and quit only if the user said so. The foundation's
    // `dispose().finally(app.quit)` quit whether cleanup worked or not, and
    // turned a rejection into an unhandled one; a person who could have said
    // "stay and try again" never got to.
    void resident?.requestQuit();
  });
  app.on("window-all-closed", () => {
    // Deliberately empty: the tray keeps the app alive. Quit is explicit.
  });
}
