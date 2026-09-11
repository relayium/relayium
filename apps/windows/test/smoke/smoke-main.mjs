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

import { app, BrowserWindow, clipboard, ipcMain } from "electron";
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
import path from "node:path";

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
};

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

async function main() {
  await bootstrap({
    showOnLaunch: false,
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
  check(
    "bridge exposed",
    parsed.keys.sort().join(",") ===
      "accountSummary,appInfo,auth,ice,inbox,inboxSend,loginItem,osEntry,pair,pairHandoff,prefs,receive,receivedDrag,resident,send,signaling,stored,update",
    parsed.keys.join(","),
  );
  check("no raw ipcRenderer in the page", parsed.hasIpc === false);

  const info = await win.webContents.executeJavaScript("globalThis.relayium.appInfo()");
  check("appInfo answered over real IPC", typeof info.origin === "string", JSON.stringify(info));
  check("production origin by default", info.origin === PRODUCTION_ORIGIN, info.origin);
  check("not an engineering build by default", info.engineering === false, String(info.engineering));

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
    // Updates. None of these carries an address, a key or a version the page
    // chose: `update-act` takes one of four closed actions and is always a
    // MANUAL trigger, and `update-notes` names a destination with a token that
    // main resolves from the SIGNED manifest.
    "relayium:update-state", "relayium:update-act",
    "relayium:update-residue", "relayium:update-notes",
    "relayium:inbox-delete-message", "relayium:inbox-rename", "relayium:inbox-wake",
    "relayium:inbox-release-retained",
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
  await driveSignInCancellation(win);

  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures })}\n`);
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
        ` target.click(); return true; })()`,
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
