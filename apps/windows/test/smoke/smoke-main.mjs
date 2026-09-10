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

import { app, BrowserWindow, ipcMain } from "electron";
// STATIC, not dynamic. `registerSchemesAsPrivileged` runs at this module's
// top level and Electron only accepts it before the `ready` event; a dynamic
// `import()` inside an async function resolves after ready has already fired.
import { SecretStore } from "../../dist/main/secrets.js";
import {
  bootstrap,
  APP_SCHEME,
  APP_HOST,
  contentSecurityPolicy,
  resolveBundlePath,
} from "../../dist/main/main.js";

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

async function main() {
  await bootstrap({
    showOnLaunch: false,
    composition: {
      makeStore: async () => smokeStore,
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
  // Pinned to the reviewed realtime surface. This tree is at the foundation
  // commit and exposes `appInfo,auth,receive`, so it fails here until the
  // realtime lane is integrated — deliberately, because pinning the assertion to
  // whatever this tree happens to expose would accept a stale bridge silently.
  check(
    "bridge exposed",
    parsed.keys.sort().join(",") === "appInfo,auth,ice,receive,signaling",
    parsed.keys.join(","),
  );
  check("no raw ipcRenderer in the page", parsed.hasIpc === false);

  const info = await win.webContents.executeJavaScript("globalThis.relayium.appInfo()");
  check("appInfo answered over real IPC", typeof info.origin === "string", JSON.stringify(info));
  check("production origin by default", info.origin === "https://relayium.com", info.origin);
  check("not an engineering build by default", info.engineering === false, String(info.engineering));

  // Every declared channel has a handler. A channel the renderer can call and
  // nothing answers is a hang, not an error.
  const declared = [
    "relayium:app-info", "relayium:auth-start", "relayium:auth-poll",
    "relayium:auth-cancel", "relayium:auth-sign-out", "relayium:auth-state",
    "relayium:receive-open", "relayium:receive-begin", "relayium:receive-write",
    "relayium:receive-finish", "relayium:receive-cancel",
  ];
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
async function driveSignInCancellation(win) {
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const text = () => js("document.body.innerText");
  const clickTest = (name) =>
    js(`(() => { const el = document.querySelector('[data-test="${name}"]'); if (!el) return false; el.click(); return true; })()`);
  const present = (name) => js(`document.querySelector('[data-test="${name}"]') !== null`);

  if (!(await waitFor("the signed-out shell", () => present("sign-in")))) return;

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
  if (!(await waitFor("the shell to return to signed out", () => present("sign-in")))) return;

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
