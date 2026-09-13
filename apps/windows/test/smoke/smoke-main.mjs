// The smoke build's main process: start the real app, then interrogate the real
// window.
//
// This is not a mock. It imports the shipping `bootstrap()`, so what it asserts
// is what a user's build does — the window's actual `webPreferences`, the actual
// registered scheme, the actual tray, the actual IPC handler set. A test that
// re-created a window with the right flags would prove only that the test can
// set flags.
//
// ## What it is allowed to touch
//
// Nothing belonging to the person running it. Three separate measures, because
// "it probably won't" is not a property:
//
//   * **No keychain.** The secret store is INJECTED — a task-owned temporary
//     directory and a test cipher — and the wrapper clears the engineering
//     environment variables before spawning.
//
//     To be precise about the risk rather than overstate it: on an ordinary Mac
//     with no overrides set, `currentDataRoot()` already refuses with
//     `unsupported-platform` BEFORE `electronCipher()` is reached, so the
//     default path does not touch the keychain and none was observed doing so.
//     The exposure is an INHERITED override — `RELAYIUM_WINDOWS_DATA_ROOT` plus
//     the engineering flag would make the data root resolve and the real
//     `safeStorage` be constructed. Isolation therefore rests on the explicit
//     injection and the cleared environment, not on that refusal happening to
//     come first.
//   * **No protocol association.** `bootstrap()` gates
//     `setAsDefaultProtocolClient` on a packaged Windows build, so this run
//     cannot seize `relayium://` from whatever already owns it — on a Mac that
//     is the real, shipped Relayium app.
//   * **No production auth and no browser.** The device-auth client and the
//     approval-page opener are INJECTED too, so the sign-in exercised below
//     never reaches `relayium.com` and never hands a URL to the system browser.
//     The URL is still built and validated by the shipping code; it simply goes
//     to an assertion instead of a window.
//   * **No visible window and no leftover files.** The window is created and
//     driven through `webContents` but never shown, and the two temporary
//     directories belong to the WRAPPER, which removes them after this process
//     has exited and its Chromium handles are certainly closed. This process
//     deliberately deletes nothing.
//
// ## Why it drives the real DOM
//
// The controller unit tests cover the lifecycle. They cannot see wiring drift:
// a channel added to the contract but not the preload, a button wired to a
// method that no longer exists, a payload shape the handler rejects. So this
// clicks the actual Sign in and Cancel buttons in the actual `App.svelte`, holds
// the device poll inside the main process, releases a late success, and requires
// the page AND the authoritative auth state to still say signed out.

import { app, BrowserWindow, clipboard, ipcMain, Menu, screen } from "electron";
// STATIC, not dynamic. `registerSchemesAsPrivileged` runs at this module's
// top level and Electron only accepts it before the `ready` event; a dynamic
// `import()` inside an async function resolves after ready has already fired.
import { SecretStore } from "../../dist/main/secrets.js";
// The REAL control-plane readers and the real preference store, constructed
// here with a synthetic transport and a task-owned file. Substituting the
// classes wholesale would stop exercising the shipping request building,
// redirect refusal and body narrowing; substituting only what leaves the
// machine keeps all of that and still guarantees the run reaches no network.
import { IceControl } from "../../dist/main/net/ice-control.js";
import { PairControl } from "../../dist/main/net/pair-control.js";
import { PreferenceStore } from "../../dist/main/preferences.js";
import { IPC_CHANNELS } from "../../dist/shared/ipc-contract.js";
import {
  bootstrap,
  APP_SCHEME,
  APP_HOST,
  contentSecurityPolicy,
  resolveBundlePath,
} from "../../dist/main/main.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
  // RETURNED, so `if (!check(...)) return;` means what it reads as.
  //
  // It used to return undefined while `installed-acceptance.mjs`'s returned the
  // boolean, and the two files are read the same way by anyone writing a new
  // scenario. That difference cost a whole assertion in this file: a guard
  // written in the other file's idiom made its function return on its first
  // line, and the run stayed green because a scenario that never executes
  // reports nothing. No existing caller here reads the result, so making the
  // two agree changes only what a future one can rely on.
  return ok;
};

/**
 * A scenario that could not run HERE, reported rather than passed over.
 *
 * A platform-specific scenario that vanishes on the platforms it does not apply
 * to reads exactly like one that ran and was satisfied. The run's own output has
 * to be able to say "this was not covered", or the suite quietly overstates
 * itself every time it is run somewhere else.
 */
const skipped = [];
const skip = (name, why) => skipped.push(`${name}: ${why}`);

// Isolated directories, created and removed by the WRAPPER and passed in here.
// Without the first, the run would write into the developer's real Electron
// profile. Nothing in this file deletes them: see the wrapper's header for why
// deleting a profile this process still has open cannot be done correctly.
const [userDataDir, secretsDir] = process.argv.slice(2);
if (!userDataDir || !secretsDir) {
  process.stdout.write(
    `RELAYIUM_SMOKE ${JSON.stringify({ failures: ["missing task-owned directory arguments"] })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();

/** A promise a test can hold open across another operation. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Poll a condition rather than sleeping a guessed interval. */
async function waitFor(what, predicate, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) {
      failures.push(`timed out waiting for ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Obviously not a real cipher, and never the platform one. */
const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);
const testCipher = {
  isAvailable: () => true,
  encrypt: (plaintext) =>
    Buffer.concat([MAGIC, Buffer.from(plaintext, "utf8").map((b) => b ^ 0x5a)]),
  decrypt: (ciphertext) => {
    if (!ciphertext.subarray(0, 4).equals(MAGIC)) throw new Error("not sealed by this cipher");
    return Buffer.from(ciphertext.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
  },
};

// The device-auth composition. `poll` blocks until this smoke releases it, which
// is what makes the cancellation race deterministic instead of hopeful.
const pollEntered = deferred();
const pollRelease = deferred();
let pollCalls = 0;
let approvalURLSeen = null;
const smokeStore = new SecretStore(secretsDir, testCipher);

/**
 * The answer to the native startup consent, chosen per scenario below.
 *
 * Only the ANSWER is injected: a run with nobody in front of it cannot press a
 * button in a modal dialog. The registry write, the deliberate re-read after it
 * and the classification of what Windows reports back are the shipped path.
 */
let loginItemConsent = false;

// ## Nothing in this run reaches the network, and nothing overrides ambiently
//
// The shell opens a LAN room by itself on a fresh process — that is the product
// behaviour, and suppressing it with `RELAYIUM_WINDOWS_NO_LAN_AUTOSTART` would
// be an ambient override that also stops the wiring being exercised at all. So
// the three things that would leave the machine are INJECTED through the same
// reviewed composition the auth client already uses: the signalling socket, and
// the `fetch` inside the real ICE and pairing readers.
/** The origin this build compiles in, restated so the readers above are built
 *  against the same address the app uses — and asserted below, not assumed. */
const PRODUCTION_ORIGIN = "https://relayium.com";

const socketURLs = [];
/** A `SignalingSocketLike` that connects to nothing. */
function makeSyntheticSocket(url) {
  socketURLs.push(url);
  const socket = {
    send() {},
    close() {
      socket.onclose?.();
    },
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  // The open is delivered asynchronously, like a real socket's, so the room
  // sees the same ordering it would in production.
  setImmediate(() => socket.onopen?.());
  return socket;
}

const fetchedURLs = [];
/** A transport that answers from memory. It never opens a connection. */
async function syntheticFetch(url, init) {
  fetchedURLs.push(String(url));
  if (init?.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
  // A loopback STUN string, so the shape is real while the address is inert:
  // this run creates no peer connection, and nothing dials it.
  return new Response(JSON.stringify({ iceServers: [{ urls: "stun:127.0.0.1:3478" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * **The OS startup toggle, against Windows itself rather than a stand-in.**
 *
 * This was the last purely-injected desktop capability. Every assertion about
 * it ran through a substituted `LoginItemSystem`, which proves the module's
 * decisions and says nothing about whether Windows does what the module asks.
 * The thing a user would report — "I turned it on and it did not start" — lives
 * entirely in the part that was never executed.
 *
 * So this drives the real IPC, with the real adapter, and then asks WINDOWS.
 *
 * ## Why the registry and not `getLoginItemSettings`
 *
 * Reading the state back through Electron would be the same library answering a
 * question about its own write. The Run key is where Windows actually looks at
 * sign-in, and it is the only place that can contradict the app. An entry is
 * matched by its DATA rather than by a value NAME: the name Electron chooses
 * varies between a packaged app and this unpackaged run, and pinning it here
 * would assert a detail of the harness instead of the behaviour.
 *
 * ## Why consent is answered but nothing else is
 *
 * Enabling opens a modal dialog, and a run with nobody in front of it cannot
 * answer one. The DECLINED case is asserted first and is the one that matters
 * most: a decline must write nothing at all, rather than write and undo — a
 * process that died between those two would leave a startup entry behind that
 * the user never agreed to.
 */
async function assertStartupTogglesAgainstWindowsItself(win) {
  // Strictly Windows. On any other machine this would register a login item
  // belonging to whoever is running the suite, which no test may do to the
  // person running it.
  if (process.platform !== "win32") {
    skip("the OS startup toggle", `not Windows (${process.platform})`);
    return;
  }

  const js = (expr) => win.webContents.executeJavaScript(expr);
  const read = () => js("globalThis.relayium.loginItem.read()");
  const write = (enabled) => js(`globalThis.relayium.loginItem.write({ enabled: ${enabled} })`);

  /** Every Run-key entry whose command names THIS executable. */
  const runKeyEntries = async () => {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"],
      { windowsHide: true },
    ).catch((err) => ({ stdout: String(err?.stdout ?? "") }));
    const exe = process.execPath.toLowerCase();
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(exe))
      .map((line) => line.trim());
  };

  const before = await runKeyEntries();
  check("no startup entry before this run", before.length === 0, before.join(" | "));

  const initial = await read();
  check("the startup state reads", initial.ok === true, JSON.stringify(initial));
  check("nothing starts Relayium yet", initial.state === "off", JSON.stringify(initial));

  // Declined FIRST, while there is still nothing to undo: if a decline wrote
  // and then reverted, this is the only point at which the difference is
  // visible in the registry rather than in the answer.
  loginItemConsent = false;
  const declined = await write(true);
  check("a declined consent still answers", declined.ok === true, JSON.stringify(declined));
  check("a declined consent leaves it off", declined.state === "off", JSON.stringify(declined));
  const afterDecline = await runKeyEntries();
  check("a declined consent wrote NOTHING to the registry", afterDecline.length === 0, afterDecline.join(" | "));

  loginItemConsent = true;
  const enabled = await write(true);
  check("consent enables startup", enabled.ok === true && enabled.state === "on", JSON.stringify(enabled));

  // Windows' own answer, not Electron's.
  const afterEnable = await runKeyEntries();
  check("Windows now launches THIS executable at sign-in", afterEnable.length === 1, afterEnable.join(" | "));

  const reread = await read();
  check("and the app reports what the registry says", reread.ok === true && reread.state === "on", JSON.stringify(reread));

  // Off again, and the entry is GONE rather than emptied. A run that left the
  // runner registered would also be a run that lied about cleaning up.
  const disabled = await write(false);
  check("it turns off", disabled.ok === true && disabled.state === "off", JSON.stringify(disabled));
  const afterDisable = await runKeyEntries();
  check("and the registry entry is removed", afterDisable.length === 0, afterDisable.join(" | "));
}

/**
 * **The window fits the screen it opened on, and the floor is real.**
 *
 * Windows display scaling shrinks the logical work area rather than enlarging
 * the window: a 1366x768 laptop at 150% has 910x512 to give. The app used to
 * ask for a fixed 1040x700 with a fixed 880x560 floor, which on that machine is
 * a window whose bottom edge — and whatever control is on it — sits below the
 * desktop with no way to bring it up.
 *
 * The arithmetic is covered by `window-sizing.test.ts` across the screens
 * people actually have. What THIS adds is the half arithmetic cannot reach: the
 * numbers were handed to a real window manager, and it honours them. A minimum
 * the app computes but the platform ignores would pass every unit test.
 */

/**
 * A build the product has withdrawn support for, in the real app.
 *
 * Everything else about the version gate is proved by unit cases and by a
 * source check over `App.svelte`'s branches. Neither can answer the question
 * that matters: with a real main process, a real preload and a real renderer,
 * does a blocked build actually stop being a product?
 *
 * It is driven through the SHIPPED path — `PolicyGate`'s own push, the real IPC
 * event, the real subscription — rather than by launching with a special flag.
 * That is a stronger test and it costs nothing: the live refresh exists, so the
 * state can be reached in a running app, which is exactly how it will be
 * reached in the field.
 *
 * Runs last. It empties the shell on purpose.
 */
async function assertABlockedBuildRendersNothingElse(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const before = await js(`document.querySelector('[data-test="nav-lan"]') !== null`);
  if (!check("the product is on screen before the block", before === true)) return;

  // The real channel, with the payload main would send. Not a page-local fake:
  // this goes through `contextBridge`, the preload subscription and the shaping
  // the page does on arrival.
  win.webContents.send("relayium:client-support-changed", {
    state: "blocked",
    current: "0.0.1",
    minimum: "9.9.9",
    latest: "9.9.9",
  });
  await new Promise((r) => setTimeout(r, 120));

  check(
    "the unsupported card is shown",
    (await js(`document.querySelector('[data-test="unsupported-title"]') !== null`)) === true,
  );
  // NOT BUILT, not hidden. Every one of these is a surface that starts work in
  // its own effects — a room socket, a staged selection, a notification
  // registration — and the whole rule is that a build which may not run does
  // not start any of it.
  //
  // The NAVIGATION is deliberately not in this list, and finding that out is
  // what this scenario was for: the first version asserted the nav rows were
  // gone, and they are not. macOS does the same thing on purpose —
  // `AppVersionGate` wraps the window's CONTENT and says why it is not inside
  // `AppShellView`: "the shell's whole contract is that its split view renders
  // unconditionally, and `MacSurfaceGuardTests` holds it to that." Windows
  // matches. Asserting otherwise would have had me change the app to differ
  // from the client it is supposed to match.
  for (const gone of ["lan-start", "inbox-enable", "inbox-sign-in", "pair-create", "help-toggle"]) {
    check(
      `${gone} is not rendered at all`,
      (await js(`document.querySelector('[data-test="${gone}"]') !== null`)) === false,
    );
  }
  // The staged-selection pane too: it sits above the page chain and would
  // otherwise let a build that may not run take files from Explorer.
  check(
    "no staged selection is taken",
    (await js(`document.querySelector('[data-test="pending-selection"]') !== null`)) === false,
  );
  check(
    "and it offers no way out that a policy document could aim",
    (await js(`document.querySelectorAll('[data-test="unsupported-title"] ~ a').length`)) === 0,
  );
}

async function assertTheWindowFitsTheScreen(win) {
  const work = screen.getPrimaryDisplay().workAreaSize;
  const bounds = win.getBounds();
  check(
    "the window opened inside the usable screen",
    bounds.width <= work.width && bounds.height <= work.height,
    `window ${bounds.width}x${bounds.height} work ${work.width}x${work.height}`,
  );

  const [minWidth, minHeight] = win.getMinimumSize();
  check(
    "and cannot be asked to be larger than the screen before it is resized",
    minWidth <= work.width && minHeight <= work.height,
    `min ${minWidth}x${minHeight} work ${work.width}x${work.height}`,
  );

  // The floor, enforced by the platform rather than by the value we passed it.
  // Nothing in the app can observe a minimum that the window manager quietly
  // dropped, so this asks for something far below it and reads back what
  // actually happened.
  const before = win.getBounds();
  win.setSize(200, 200);
  const clamped = win.getBounds();
  check(
    "the window manager enforces the floor it was given",
    clamped.width === minWidth && clamped.height === minHeight,
    `asked 200x200 got ${clamped.width}x${clamped.height} floor ${minWidth}x${minHeight}`,
  );
  win.setSize(before.width, before.height);
}

/**
 * **The menu bar this build actually installed.**
 *
 * The template is covered by unit tests. This is the other half: that it was
 * INSTALLED, and that Electron's default — which offers Reload, Force Reload
 * and Toggle Developer Tools to every user — was replaced rather than left in
 * place. A template that is never set is a menu that is perfect in a test and
 * absent on screen, and the default it leaves behind looks deliberate.
 */
function assertTheMenuIsThisAppsAndNotElectrons(win) {
  const menu = Menu.getApplicationMenu();
  if (!check("an application menu is installed", menu !== null)) return;

  const roles = [];
  const walk = (items) => {
    for (const item of items) {
      if (item.role) roles.push(String(item.role).toLowerCase());
      if (item.submenu) walk(item.submenu.items);
    }
  };
  walk(menu.items);

  // The three the default menu offers and this one must not.
  for (const role of ["reload", "forcereload", "toggledevtools"]) {
    check(`the menu offers no ${role}`, !roles.includes(role), roles.join(","));
  }
  // And the ones that are accelerators before they are menu items: without
  // these, Ctrl+C and Ctrl+V do not exist in this app's text fields.
  for (const role of ["copy", "paste", "cut", "selectall", "undo", "redo"]) {
    check(`the menu binds ${role}`, roles.includes(role), roles.join(","));
  }

  // A real window is open; the menu belongs to the application, so this is the
  // menu that window is showing.
  check("the window this menu belongs to is real", win.isDestroyed() === false);
}

async function main() {
  await bootstrap({
    showOnLaunch: false,
    confirmLoginItem: async () => loginItemConsent,
    composition: {
      makeStore: async () => smokeStore,
      // ## The account reads are injected even though this run never signs in
      //
      // `AccountSummaryService.refresh()` runs at startup regardless, and the
      // origin here is the PRODUCTION one. A signed-out profile makes no
      // request today — but that is a property of another module's control
      // flow, and relying on it would mean this smoke reaches the real
      // relayium.com the day that changes. The seam costs one line and removes
      // the possibility entirely.
      accountSummary: {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "no account in this run" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      },
      makeAuthClient: () => ({
        start: async () => ({
          userCode: "SMOKE-CODE",
          deviceCode: "smoke-device-code",
          // A string this run never fetches. The shipping `approvalURL` still
          // validates it against the build's origin before it is handed on.
          verificationURL: "https://relayium.com/device",
          interval: 1,
          expiresIn: 600,
        }),
        poll: async () => {
          pollCalls += 1;
          pollEntered.resolve();
          return pollRelease.promise;
        },
      }),
      openApproval: async (url) => {
        approvalURLSeen = url;
        return true;
      },
      makeSignalingSocket: makeSyntheticSocket,
      makeIceControl: () => new IceControl(PRODUCTION_ORIGIN, syntheticFetch),
      makePairControl: () => new PairControl(PRODUCTION_ORIGIN, syntheticFetch),
      // A task-owned file, so the run cannot read or rewrite the preferences of
      // whoever is running it.
      makePreferences: () => new PreferenceStore(path.join(secretsDir, "preferences.json")),
    },
  });

  const windows = BrowserWindow.getAllWindows();
  check("exactly one window", windows.length === 1, `saw ${windows.length}`);
  const win = windows[0];

  const prefs = win.webContents.getLastWebPreferences() ?? {};
  check("sandboxed", prefs.sandbox === true, String(prefs.sandbox));
  check("context isolated", prefs.contextIsolation === true, String(prefs.contextIsolation));
  check("no node integration", prefs.nodeIntegration !== true, String(prefs.nodeIntegration));
  check("no webview tag", prefs.webviewTag !== true, String(prefs.webviewTag));
  check("web security on", prefs.webSecurity !== false, String(prefs.webSecurity));
  // Read back from the REAL window, not from the constant a unit test can see.
  // Electron defaults this to true and downloads hunspell dictionaries from the
  // Chromium CDN to satisfy it, so a window that lost the flag would reach a
  // Google-operated server the first time somebody typed — with no page request
  // to observe, because that fetch belongs to the browser process.
  // Read from the SESSION, which is the switch that can be observed:
  // `getLastWebPreferences()` does not report `spellcheck` at all, so asserting
  // it there passes on `undefined` whatever the window was built with — a check
  // that cannot fail is worse than no check.
  // The window's own surface, read from the real window. Electron's default is
  // white, so in dark mode this is the difference between a window that is the
  // right colour before the page paints and one that flashes.
  {
    const { nativeTheme } = await import("electron");
    const expected = nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff";
    check(
      "the window is the same colour as the page it will show",
      win.getBackgroundColor().toLowerCase() === expected,
      `${win.getBackgroundColor()} expected ${expected} (dark=${nativeTheme.shouldUseDarkColors})`,
    );
  }

  check(
    "no spellchecker, so typing fetches nothing",
    win.webContents.session.isSpellCheckerEnabled() === false,
    String(win.webContents.session.isSpellCheckerEnabled()),
  );
  // Read from the live WebContents rather than the recorded preferences:
  // `getLastWebPreferences()` does not report this one, so asserting it there
  // would be asserting `undefined === false` and passing for the wrong reason.
  check(
    "background throttling off for a resident receiver",
    win.webContents.backgroundThrottling === false,
    String(win.webContents.backgroundThrottling),
  );

  // The renderer really loaded, from the app scheme rather than file://.
  const url = win.webContents.getURL();
  check("served from the app scheme", url.startsWith(`${APP_SCHEME}://${APP_HOST}/`), url);

  // And the bundle really executed: the preload bridge is present and the page
  // reached the main process for its own state.
  const bridge = await win.webContents.executeJavaScript(
    "JSON.stringify({ keys: Object.keys(globalThis.relayium ?? {}), hasIpc: 'ipcRenderer' in globalThis })",
  );
  const parsed = JSON.parse(bridge);
  // EXACT set, not a superset: a `contains` check would pass while the preload
  // quietly grew a surface nobody reviewed.
  //
  // Pinned to the reviewed surface as it stands — `inboxSend` joined `send`,
  // `inbox`, `stored`, `resident` and `loginItem` — rather than to whatever this
  // tree happens to expose, which would accept a stale or an unreviewed bridge
  // silently. `inboxSend` is its own namespace rather than a member of `inbox`
  // because it is the only Inbox surface that returns a KEY, and a reader
  // auditing this line should see that without opening another file.
  //
  // `help` is one method and it carries no address: the page names a SCREEN and
  // a language, and main composes the URL from its own table.
  check(
    "bridge exposed",
    parsed.keys.sort().join(",") ===
      "account,accountSummary,appInfo,auth,help,ice,inbox,inboxSend,loginItem,onClientSupport,osEntry,pair,pairHandoff,prefs,receive,receivedDrag,resident,send,signaling,stored,update",
    parsed.keys.join(","),
  );
  check("no raw ipcRenderer in the page", parsed.hasIpc === false);

  const info = await win.webContents.executeJavaScript("globalThis.relayium.appInfo()");
  check("appInfo answered over real IPC", typeof info.origin === "string", JSON.stringify(info));
  check("production origin by default", info.origin === PRODUCTION_ORIGIN, info.origin);
  check("not an engineering build by default", info.engineering === false, String(info.engineering));
  // The wrapper started this process with `npm_package_version=9.9.9-poison`.
  // A build that reads its identity from the environment reports it; one that
  // reads compiled metadata does not. The same value reaches central during
  // Device Inbox enrolment, where it is validated, so this is not a diagnostic
  // string.
  check("the version is not taken from the environment", info.version !== "9.9.9-poison", String(info.version));
  check(
    "the version is the one compiled into this build",
    info.version === app.getVersion(),
    `${info.version} vs ${app.getVersion()}`,
  );

  // Every declared channel has a handler. A channel the renderer can call and
  // nothing answers is a hang, not an error.
  const declared = [
    "relayium:app-info", "relayium:auth-start", "relayium:auth-poll",
    "relayium:auth-cancel", "relayium:auth-sign-out", "relayium:auth-state",
    "relayium:receive-open", "relayium:receive-begin", "relayium:receive-write",
    "relayium:receive-finish", "relayium:receive-cancel", "relayium:receive-publish",
    // "Open the folder", for a receive that has already SAVED. It names the
    // opaque token main minted and pushed, never a path: the page was not given
    // the directory, so it cannot ask for a different one, and main resolves
    // the token against what it kept. Every refusal is a closed reason and
    // carries none of the operating system's own text.
    "relayium:receive-reveal",
    "relayium:signaling-open", "relayium:signaling-send", "relayium:signaling-close",
    "relayium:ice-config", "relayium:pair-create",
    "relayium:prefs-read", "relayium:prefs-write",
    "relayium:resident-ack", "relayium:resident-snapshot", "relayium:resident-notify",
    "relayium:login-item-read", "relayium:login-item-write",
    // What the OS handed Relayium. `state` and `clear` take nothing; `read`
    // takes a capability token and a bounded range. None of the three accepts a
    // path, which is what keeps staging main's decision rather than the page's.
    "relayium:os-entry-state", "relayium:os-entry-read", "relayium:os-entry-clear",
    // The pairing handoff. `copy` NAMES an action and carries no text, so this
    // channel cannot be used to put a URL of the page's choosing on the
    // clipboard.
    "relayium:pair-handoff-state", "relayium:pair-handoff-copy",
    // Dragging or revealing ONE received file, named by its capability token.
    // No path crosses in either direction.
    "relayium:received-act",
    "relayium:stored-receive-start", "relayium:stored-receive-cancel",
    "relayium:stored-receive-result", "relayium:stored-inventory",
    "relayium:stored-cleanup-retry",
    // Device Inbox receive. Every one of these takes an id or
    // nothing: none of them can carry a path, a claim token or a key, and
    // enabling opens a native dialog in main rather than accepting a
    // destination from the page.
    "relayium:inbox-state", "relayium:inbox-enable", "relayium:inbox-disable",
    "relayium:inbox-choose-folder", "relayium:inbox-pending", "relayium:inbox-accept",
    "relayium:inbox-reject", "relayium:inbox-messages", "relayium:inbox-open-message",
    // Copying happens in MAIN, because `window.ts` denies every renderer
    // permission including the browser clipboard. It names a message this
    // account has received; there is no channel that takes a string.
    "relayium:inbox-copy-message",
    // Off / ask / auto, the main-owned folder reveal, and the receipt listing.
    "relayium:inbox-set-policy", "relayium:inbox-reveal-folder", "relayium:inbox-receipts",
    // What arrived, BY NAME, and the one act that forgets it.
    //
    // `inbox-history` is the only Inbox channel that carries the user's own
    // file names, and it carries them for the reason they were received: so a
    // person can see what arrived. They are relative names — the receiving
    // directory is not among them, and `inbox-reveal-folder` is what opens it
    // from a path only main holds. `inbox-forget-delivery` is the ONLY thing
    // that deletes that record: turning receiving off and signing out leave it
    // alone, exactly as they leave the message vault alone.
    "relayium:inbox-history", "relayium:inbox-forget-delivery",
    // Device Inbox SEND. A target is named by central's DEVICE ID and nothing
    // else: the device's public key, its key id and its algorithm all stay in
    // main, because a renderer holding a target's key could seal to it. The
    // ciphertext flows renderer→main, and the one secret flowing the other way
    // is the content key for the delivery that document owns.
    "relayium:inbox-send-targets", "relayium:inbox-send-start", "relayium:inbox-send-feed",
    "relayium:inbox-send-end", "relayium:inbox-send-cancel",
    // Convergence, never a fresh send: an unknown outcome retains its plan and
    // its idempotency key so the SAME attempt can be replayed.
    "relayium:inbox-send-converge",
    // Stored send and history. The renderer produces the ciphertext, so frames
    // flow renderer→main here; the one secret flowing the other way is the
    // content key `start` answers with, for the job that document owns.
    "relayium:stored-send-start", "relayium:stored-send-feed", "relayium:stored-send-end",
    "relayium:stored-send-cancel", "relayium:stored-send-history", "relayium:stored-send-link",
    "relayium:stored-send-delete", "relayium:stored-send-reconcile",
    // Copying a link happens in MAIN, for the same reason the Inbox message
    // copy does: `window.ts` denies the renderer clipboard permission.
    "relayium:stored-send-copy-link",
    // The account screen. Reads and the two device mutations that already
    // existed; the only journey out of the app is `account-manage`, which names
    // a destination with a closed token and lets MAIN compose the address.
    "relayium:account-summary-state", "relayium:account-summary-refresh",
    "relayium:account-device-rename", "relayium:account-device-revoke",
    "relayium:account-manage",
    // Reviewed: carries NOTHING. Main reads the address from the profile the
    // server returns for the credential main holds, so this channel cannot be
    // used to make the app email an address a page chose.
    "relayium:account-resend-verification",
    // Updates. None of these carries an address, a key or a version the page
    // chose: `update-act` takes one of four closed actions and is always a
    // MANUAL trigger, and `update-notes` names a destination with a token that
    // main resolves from the SIGNED manifest.
    "relayium:update-state", "relayium:update-act",
    "relayium:update-residue", "relayium:update-notes",
    "relayium:inbox-delete-message", "relayium:inbox-rename", "relayium:inbox-wake",
    "relayium:inbox-release-retained",
    // The help's one journey out. A SCREEN and a language, never an address:
    // main owns the slug table and composes the URL on the product SITE's
    // origin, which is not this build's API origin — an engineering build
    // dials loopback and no documentation was ever published there.
    "relayium:help-open-guide",
  ];
  // Restated above rather than derived, so a channel cannot be added to the
  // contract and reach a handler without appearing in a reviewed list — and
  // then compared BOTH ways against the contract, so the restatement cannot go
  // stale in either direction the way the bridge allowlist just had.
  check(
    "the reviewed channel list is the contract",
    [...declared].sort().join(",") === [...IPC_CHANNELS].sort().join(","),
    `declared=${[...declared].sort().join(",")} contract=${[...IPC_CHANNELS].sort().join(",")}`,
  );
  for (const channel of declared) {
    // `handle` throws if one is already registered — which is the assertion.
    let already = false;
    try {
      ipcMain.handle(channel, () => undefined);
      ipcMain.removeHandler(channel);
    } catch {
      already = true;
    }
    check(`handler registered for ${channel}`, already);
  }

  // The scheme handler refuses to walk out of the bundle.
  check(
    "bundle path traversal refused",
    resolveBundlePath("/app/renderer", "/../../etc/passwd") === null,
  );
  const csp = contentSecurityPolicy("https://relayium.com");
  check("CSP allows wasm for libsodium", csp.includes("'wasm-unsafe-eval'"), csp);
  check("CSP blocks inline script", !/script-src[^;]*unsafe-inline/.test(csp), csp);
  check("CSP pins connect-src to this origin", csp.includes("connect-src 'self' https://relayium.com"), csp);

  // The injected store really is the one in use: signed out, with a HEALTHY
  // store rather than the "unreadable" a failed real-cipher path would report.
  const authState = await win.webContents.executeJavaScript("globalThis.relayium.auth.state()");
  check("injected secret store is in use", authState.store === "ok", JSON.stringify(authState));
  check("not signed in", authState.signedIn === false, JSON.stringify(authState));

  // And the window was never put on screen.
  check("window stayed hidden", win.isVisible() === false, String(win.isVisible()));

  // ## The LAN room the shell opened by itself went to the injected socket
  //
  // Evidence rather than assumption: if the composition were not reaching the
  // signalling layer, this run would be opening a real WebSocket to the
  // production hub. The address is also the one MAIN built from the compiled
  // origin — the renderer names a room kind and never a URL — so asserting its
  // shape here is asserting that rule held.
  if (!(await waitFor("the automatic LAN room to open its socket", async () => socketURLs.length > 0))) {
    return;
  }
  check(
    "signalling went to the injected socket, at main's own address",
    socketURLs.every((u) => u === "wss://relayium.com/ws"),
    socketURLs.join(","),
  );
  // Whatever the ICE and pairing readers fetched, they fetched from memory, and
  // only from this build's own origin.
  check(
    "no request left this build's origin",
    fetchedURLs.every((u) => u.startsWith(`${PRODUCTION_ORIGIN}/`)),
    fetchedURLs.join(","),
  );

  await assertSendFilesReachedThePane(win);
  await assertPairHandoffRefusesWithoutACode(win);
  await assertSignedOutGatesRatherThanGreys(win);
  await assertKeyboardAndMotion(win);
  await assertEveryScreenExplainsItself(win);
  await driveSignInCancellation(win);
  await assertStartupTogglesAgainstWindowsItself(win);
  await assertTheWindowFitsTheScreen(win);
  assertTheMenuIsThisAppsAndNotElectrons(win);
  // LAST, because it empties the shell and nothing else can run afterwards.
  await assertABlockedBuildRendersNothingElse(win);

  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures, skipped })}\n`);
  // `quit`, not `exit`: it runs the app's real `before-quit` teardown, which
  // cancels in-flight sign-ins and leases. `exit` would skip it, and a smoke
  // that never exercises the shutdown path cannot claim it works.
  app.quit();
}

/**
 * Click Sign in, hold the poll, click Cancel, then release a late success.
 *
 * The assertion is the one that was false before this revision: after Cancel,
 * neither the page nor the authoritative auth state may say signed in, and no
 * bearer may exist in the injected store.
 */
/**
 * The right-click path, end to end, through the shipping argv handler.
 *
 * The installer registers `Relayium.exe --send-files "%1"` on files and
 * directories and a SendTo shortcut carrying the same flag. Every one of those
 * entries existed while `main.ts` parsed no such flag and `OsEntryService` had
 * no caller, so they launched the app and dropped the selection in silence.
 * Nothing caught it: the unit cases prove the staging rules, and the os-entry
 * smoke drives a SYNTHETIC in-page bridge with no main process at all.
 *
 * This asserts the seam those two leave open — real argv, real bootstrap, real
 * IPC, real pane — and then asserts the property the whole contract exists for:
 * the directory the file came from must not reach the screen.
 */
/**
 * The pairing handoff refuses cleanly, and never writes the clipboard.
 *
 * This run is signed out, so no code can be minted and the interesting half is
 * the refusal path — which is also the half with a security property worth
 * pinning. `copy` NAMES an action and carries no text: main writes what main
 * retained. If that ever became "main writes what the page sent", this channel
 * would be a way to put arbitrary content on someone's clipboard, and the bug
 * would look exactly like a working feature.
 *
 * The clipboard is read, never written. A smoke that stamped a sentinel over
 * whatever the developer had copied would be a rude test.
 */
/**
 * Every screen ends with help, and it is a real control rather than a triangle.
 *
 * A screen says what it is and hands over its controls; somebody who does not
 * already know what a pairing code is, or where a received file goes, otherwise
 * has to leave the app to find out. Driven on every screen rather than one,
 * because the failure this guards against is a screen that was added without
 * its answers.
 */
async function assertEveryScreenExplainsItself(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const clickTest = (name) =>
    js(
      `(() => { const el = document.querySelector('[data-test="${name}"]'); if (!el) return false;` +
        ` const target = el.tagName === "BUTTON" ? el : el.querySelector("button") ?? el;` +
        ` if (target.disabled === true) return false; target.click(); return true; })()`,
    );

  for (const page of ["lan", "pair", "stored", "inbox", "account"]) {
    check(`the ${page} row clicked`, await clickTest(`nav-${page}`));
    const state = await js(
      `(() => { const section = document.querySelector('[data-test="help"]'); if (!section) return null;` +
        ` const toggle = section.querySelector('[data-test="help-toggle"]');` +
        ` const body = section.querySelector('[data-test="help-body"]');` +
        ` const box = toggle.getBoundingClientRect();` +
        ` return { page: section.dataset.page, expanded: toggle.getAttribute("aria-expanded"),` +
        ` hidden: body.hidden, height: Math.round(box.height), width: Math.round(box.width),` +
        ` controls: toggle.getAttribute("aria-controls") === body.id }; })()`,
    );
    check(`${page} ends with help`, state !== null, String(state));
    if (state === null) continue;
    check(`the help is this screen's`, state.page === page, JSON.stringify(state));
    // Closed first: a reader who knows the screen should not scroll past an
    // essay to reach its controls.
    check(`${page} help starts closed`, state.expanded === "false" && state.hidden === true, JSON.stringify(state));
    // A real control, not a triangle in a column of grey text. The whole row is
    // the target and it is the height every other control here is.
    check(`${page} help is a real control`, state.height >= 32 && state.width > 200, JSON.stringify(state));
    check(`${page} help names what it opens`, state.controls === true, JSON.stringify(state));

    // The row carries the one sentence that is always on screen. A row saying
    // only "Help" tells a reader nothing about whether opening it will answer
    // their question — which is why the Mac puts the purpose here, and why it
    // is asserted CLOSED rather than after expanding.
    const row = await js(
      `(() => { const s = document.querySelector('[data-test="help"]');` +
        ` const toggle = s.querySelector('[data-test="help-toggle"]');` +
        ` const purpose = s.querySelector('[data-test="help-purpose"]');` +
        ` const hintId = toggle.getAttribute("aria-describedby");` +
        ` const hint = hintId ? document.getElementById(hintId) : null;` +
        ` return { visible: purpose !== null && toggle.contains(purpose),` +
        ` text: (purpose?.textContent ?? "").trim().length,` +
        ` hint: (hint?.textContent ?? "").trim().length }; })()`,
    );
    check(`${page} says what it is for while still closed`, row.visible === true && row.text > 0, JSON.stringify(row));
    // The hint is what a screen reader gets in place of seeing that preview.
    check(`${page} help describes what opening it gives`, row.hint > 0, JSON.stringify(row));

    check(`${page} help opens`, await clickTest("help-toggle"));
    const opened = await js(
      `(() => { const s = document.querySelector('[data-test="help"]');` +
        ` const body = s.querySelector('[data-test="help-body"]');` +
        ` const text = (n) => s.querySelector('[data-test="' + n + '"]')?.textContent?.trim() ?? "";` +
        ` return { expanded: s.querySelector('[data-test="help-toggle"]').getAttribute("aria-expanded"),` +
        ` hidden: body.hidden, steps: s.querySelectorAll('[data-test="help-steps"] li').length,` +
        ` purpose: text("help-purpose").length, boundary: text("help-boundary").length,` +
        ` where: text("help-where").length, failure: text("help-failure").length,` +
        ` recovery: text("help-recovery").length }; })()`,
    );
    check(`${page} help expands`, opened.expanded === "true" && opened.hidden === false, JSON.stringify(opened));
    check(`${page} help gives three steps`, opened.steps === 3, JSON.stringify(opened));
    // All six answered. A screen answering five is the state the table exists
    // to prevent, and it would look fine until somebody needed the sixth.
    for (const answer of ["purpose", "boundary", "where", "failure", "recovery"]) {
      check(`${page} help answers ${answer}`, opened[answer] > 0, JSON.stringify(opened));
    }

    // The link to a maintained document, where one exists — and NOTHING on the
    // screen that has none. The absence is the half worth executing: an
    // invented "learn more" pointing at a page that does not answer the
    // question is worse than no link, and it is exactly the kind of thing a
    // table edit adds without anyone noticing on screen.
    const guide = await js(
      `(() => { const s = document.querySelector('[data-test="help"]');` +
        ` const link = s.querySelector('[data-test="help-guide"]');` +
        ` return link === null ? null : { label: link.textContent.trim(),` +
        ` tag: link.tagName, href: link.getAttribute("href") }; })()`,
    );
    if (page === "account") {
      check("the account screen promises no document", guide === null, JSON.stringify(guide));
    } else {
      check(`${page} offers its guide`, guide !== null, String(guide));
      if (guide !== null) {
        check(`${page} guide link is labelled`, guide.label.length > 0, JSON.stringify(guide));
        // A button, not an anchor. There is no address in this document to put
        // in an href: the page names a SCREEN and main composes the URL, so a
        // foothold here has nothing to read and nothing to navigate.
        check(`${page} guide link carries no address`, guide.tag === "BUTTON" && guide.href === null, JSON.stringify(guide));
      }
    }

    check(`${page} help closes again`, await clickTest("help-toggle"));
  }
}

/**
 * The app can be driven without a mouse, and honours a request for less motion.
 *
 * The capability was already there and reasoned — the sidebar is a real ARIA
 * listbox and the shell moves focus to the content region on every navigation —
 * but nothing executed any of it, so a regression would have been invisible
 * until somebody noticed with a keyboard. These are the assertions that were
 * missing, not the behaviour.
 *
 * Keys go through `sendInputEvent`, which is the OS path into the window. A
 * synthesized DOM event would prove the handler and not the route to it.
 */
async function assertKeyboardAndMotion(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const press = async (keyCode) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await new Promise((r) => setTimeout(r, 80));
  };

  // ## Reachable at all
  //
  // Every row's button is `tabindex="-1"` on purpose: the listbox holds focus
  // and the arrows move within it. That is the correct pattern AND the one that
  // strands a keyboard user completely if the container ever loses its own
  // tabindex, because then nothing in the sidebar is reachable.
  const listbox = await js(
    `(() => { const el = document.querySelector('[role="listbox"]'); if (!el) return null;` +
      ` el.focus(); return { focused: document.activeElement === el, tabindex: el.tabIndex,` +
      ` active: el.getAttribute("aria-activedescendant") }; })()`,
  );
  check("the sidebar can be focused from the keyboard", listbox?.focused === true, JSON.stringify(listbox));
  check("and is in the tab order", listbox?.tabindex === 0, JSON.stringify(listbox));
  // Without this a screen reader announces the list once and then nothing as
  // the selection moves.
  check("and says which option focus is on", typeof listbox?.active === "string" && listbox.active !== "", JSON.stringify(listbox));

  await press("Down");
  const moved = await js(`document.querySelector('[role="listbox"]').getAttribute("aria-activedescendant")`);
  check("an arrow key moves the selection", moved !== listbox?.active, `${listbox?.active} -> ${moved}`);

  // ## And the keyboard goes with the eyes
  //
  // Focus must land in the new page. Left where it was, it sits on a control
  // that is no longer rendered, which drops it to the document — and the next
  // Tab starts from the top of the window again.
  const focusedRegion = await js(
    `document.activeElement?.getAttribute?.("data-test") ?? document.activeElement?.tagName ?? "none"`,
  );
  check("navigating moves focus into the page", focusedRegion === "page-scroller", String(focusedRegion));

  // ## Less motion means less MOTION, not faster motion
  //
  // The usual `0.01ms` trick still animates, and for a vestibular trigger a
  // jump done quickly is worse than a slow one. Emulated rather than assumed:
  // the stylesheet declaring the rule is not evidence that it applies.
  // `attach` is synchronous and THROWS when something is already attached, so
  // it is guarded rather than awaited.
  try {
    win.webContents.debugger.attach("1.3");
  } catch {
    // Already attached by something else in this run; the commands below still
    // work through that session.
  }
  try {
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const reduced = await js(
      `(() => { const el = document.querySelector('[data-test="page-scroller"]');` +
        ` const s = getComputedStyle(el);` +
        ` return { rise: getComputedStyle(document.documentElement).getPropertyValue("--enter-rise").trim(),` +
        ` props: s.transitionProperty, animation: s.animationName }; })()`,
    );
    check("reduced motion removes the rise", reduced?.rise === "0px", JSON.stringify(reduced));
    check(
      "and animates nothing that moves",
      !/transform|all/.test(reduced?.props ?? "") && (reduced?.animation ?? "none") === "none",
      JSON.stringify(reduced),
    );
  } finally {
    await win.webContents.debugger
      .sendCommand("Emulation.setEmulatedMedia", { features: [] })
      .catch(() => undefined);
    win.webContents.debugger.detach();
  }
}

/**
 * A feature that needs an account NAMES that, and offers the way in.
 *
 * The rule macOS states in `CapabilityGateView`: no dead controls. The Device
 * Inbox is gated entire when signed out, and this run is signed out, so the
 * gate is what the page should be.
 *
 * Pinned here because it is easy to regress into a greyed screen that states
 * no reason, and because the only surface that can assert it is a real one.
 */
async function assertSignedOutGatesRatherThanGreys(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const present = (name) => js(`document.querySelector('[data-test="${name}"]') !== null`);
  const clickTest = (name) =>
    js(
      `(() => { const el = document.querySelector('[data-test="${name}"]'); if (!el) return false;` +
        ` const target = el.tagName === "BUTTON" ? el : el.querySelector("button") ?? el;` +
        ` if (target.disabled === true) return false; target.click(); return true; })()`,
    );

  if (!(await waitFor("the sidebar", () => present("nav-inbox")))) return;
  check("the inbox row clicked", await clickTest("nav-inbox"));
  if (!(await waitFor("the account gate", () => present("inbox-sign-in")))) return;
  // The gate REPLACES the surface rather than disabling it: a greyed Enable
  // states no reason and leaves the reader guessing whether it is broken.
  check("the gated surface is not also offered", (await present("inbox-enable")) === false);

  // ---- the pairing screen gates only the half that spends an account -------
  //
  // Found by comparing macOS's view files against this app's rather than by
  // reading the parity ledger, which did not mention it.
  // `CapabilityGateView.swift` says the Cross-network screen gates "only the
  // half that spends an account — joining a code is right beside it and needs
  // nothing", and Windows did not gate it at all: pressing Create signed out
  // spent a round trip and came back with the same sentence as a refusal.
  //
  // The copy already existed and already said the right thing. What is asserted
  // here is that it is said BEFORE the attempt, and that the half needing no
  // account is untouched.
  check("the pair row clicked", await clickTest("nav-pair"));
  if (!(await waitFor("the pairing screen", () => present("pair-join")))) return;
  check("creating a code says up front that it needs an account",
    (await present("pair-signed-out")) === true);
  // Absent, not greyed. A disabled Create states no reason.
  check("and the Create button is not also offered",
    (await present("pair-create")) === false);
  // The half that needs nothing is still there, and still the obvious action.
  check("joining a code is untouched", (await present("pair-join")) === true);
  // The way out is offered, and deliberately not as the prominent control —
  // a primary Sign in here would outrank the Join beside it. macOS gives the
  // same reason for the same screen.
  check("a sign-in is offered", (await present("pair-sign-in")) === true);
  check("and it does not outrank Join",
    (await js(`document.querySelector('[data-test="pair-sign-in"]').className`))
      .includes("primary") === false);
}

async function assertPairHandoffRefusesWithoutACode(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const call = async (expr) => JSON.parse(await js(`${expr}.then((v) => JSON.stringify(v))`));
  // Awaited: `clipboard.readText()` resolves to the text here rather than
  // returning it, and comparing two unawaited promises would compare two
  // distinct objects and fail for a reason that has nothing to do with the
  // clipboard.
  const before = await clipboard.readText();

  const idle = await call("globalThis.relayium.pairHandoff.state()");
  check("the handoff starts with no code", idle.kind === "idle", JSON.stringify(idle));

  const none = await call(`globalThis.relayium.pairHandoff.copy({ action: "copy-join-link" })`);
  check("copying with no code is refused", none.kind === "no-code", JSON.stringify(none));

  // An action this protocol does not define is refused rather than guessed at.
  const bogus = await call(`globalThis.relayium.pairHandoff.copy({ action: "copy-anything" })`);
  check("an undefined action is refused", bogus.kind === "unavailable", JSON.stringify(bogus));

  // The property the whole shape exists for.
  const after = await clipboard.readText();
  check("the clipboard was never written", after === before, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}

async function assertSendFilesReachedThePane(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const present = (name) => js(`document.querySelector('[data-test="${name}"]') !== null`);

  const picked = process.argv[4] ?? null;
  check("the launcher handed over a real file", picked !== null, process.argv.join(" "));
  if (picked === null) return;

  // The argv an actual right-click produces, delivered the way Explorer
  // delivers it to an app that is already running. `bootstrap` registered this
  // listener; emitting here drives THAT handler, not a copy of it.
  check("the window was hidden before the selection arrived", win.isVisible() === false);
  app.emit("second-instance", {}, ["C:\\ignored\\Relayium.exe", "--send-files", picked]);

  // The crypto gate first: until libsodium loads the shell shows its starting
  // card, so failing here would report the gate rather than the pane.
  if (!(await waitFor("the encryption library to load", async () => !(await present("crypto-pending"))))) return;
  if (!(await waitFor("the staged selection to reach the pane", () => present("pending-selection")))) return;
  check("and the window was put on screen for it", win.isVisible() === true);

  const name = picked.split(/[\\/]/).pop();
  const count = await js(`document.querySelector('[data-test="pending-count"]')?.innerText ?? ""`);
  check("the pane names what was picked", count.includes(name), count);

  // The property the token contract exists for. The pane is given names and
  // relative paths; the DIRECTORY is main's and must never be rendered.
  const directory = picked.slice(0, picked.length - name.length - 1);
  const body = await js("document.body.innerText");
  check("no absolute path reached the screen", !body.includes(directory), directory);
  const html = await js("document.body.innerHTML");
  check("and none is hidden in an attribute either", !html.includes(directory));
}

async function driveSignInCancellation(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const text = () => js("document.body.innerText");
  // Clicks what a user clicks. A sidebar row carries its `data-test` on the
  // `li` and its handler on the `button` inside, so clicking the marked element
  // itself would dispatch an event nothing listens to and then report success.
  const clickTest = (name) =>
    js(
      `(() => { const el = document.querySelector('[data-test="${name}"]'); if (!el) return false;` +
        ` const target = el.tagName === "BUTTON" ? el : el.querySelector("button") ?? el;` +
        ` if (target.disabled === true) return false; target.click(); return true; })()`,
    );
  const present = (name) => js(`document.querySelector('[data-test="${name}"]') !== null`);

  // ## The shell no longer opens on the sign-in screen
  //
  // A fresh process lands on LAN and starts a room by itself — the product
  // behaviour — so the account screen is reached the way a user reaches it:
  // through the sidebar. Waiting for `sign-in` on whatever page happens to be
  // showing would be waiting for something that is never going to appear.
  //
  // The crypto gate comes first. Until libsodium has loaded the main pane shows
  // the starting card and every page's controls are absent, so failing here
  // reports the gate rather than a missing button.
  if (!(await waitFor("the encryption library to load", async () => !(await present("crypto-pending"))))) {
    return;
  }
  if (!(await waitFor("the sidebar", () => present("nav-account")))) return;
  check("account row clicked", await clickTest("nav-account"));

  if (!(await waitFor("the signed-out account page", () => present("sign-in")))) return;

  check("sign in clicked", await clickTest("sign-in"));
  // The main process really received the start and really built an approval URL.
  if (!(await waitFor("the waiting screen", async () => (await text()).includes("SMOKE-CODE")))) return;
  check(
    "approval URL built and validated by the shipping path",
    approvalURLSeen === "https://relayium.com/device?code=SMOKE-CODE",
    String(approvalURLSeen),
  );

  // Wait for the renderer to actually issue its first poll, so Cancel lands
  // while a real request is outstanding. Anything else tests nothing.
  const polled = await Promise.race([
    pollEntered.promise.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 20_000)),
  ]);
  check("renderer issued a poll", polled === true && pollCalls === 1, `pollCalls=${pollCalls}`);
  if (!polled) return;

  check("cancel clicked", await clickTest("cancel"));
  if (!(await waitFor("the account page to return to signed out", () => present("sign-in")))) return;

  // The late success: the response the user's cancel was racing.
  pollRelease.resolve({
    status: "ok",
    accessToken: "smoke-late-token",
    accountEmail: "smoke@example.invalid",
  });
  // Give the late outcome every chance to be adopted. A pass here has to mean
  // it was refused, not that the assertion ran before it arrived.
  await new Promise((r) => setTimeout(r, 750));

  const after = await text();
  check("page does not claim a signed-in account", !after.includes("Signed in as"), after);
  check("page offers sign in again", await present("sign-in"));

  const state = await js("globalThis.relayium.auth.state()");
  check("authoritative state is signed out", state.signedIn === false, JSON.stringify(state));
  check("store still healthy", state.store === "ok", JSON.stringify(state));

  // And nothing reached the disk: the strongest form of the assertion.
  let bearer = "absent";
  try {
    await smokeStore.get("account-bearer");
    bearer = "present";
  } catch (err) {
    bearer = err?.code ?? String(err);
  }
  check("no bearer was written by the cancelled sign-in", bearer === "not-found", String(bearer));
}

main().catch((err) => {
  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures: [`threw: ${String(err)}`] })}\n`);
  app.exit(1);
});
