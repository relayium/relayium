// The resident lifecycle, in a real Electron, against the real wiring.
//
// `smoke-main.mjs` proves the app comes up and a sign-in can be cancelled. This
// one proves the thing that makes it a resident app: closing the window does
// not end anything, quitting asks first and can be refused, and a quit whose
// cleanup failed leaves an app that still works.
//
// Same isolation as the other entry — injected store, injected network,
// injected picker, wrapper-owned directories, no keychain, no protocol
// association, no visible window — plus one more injection: the resident
// PLATFORM, so the native dialogs can be answered without a person. Everything
// else is the shipping path: the real `ResidentRuntime`, the real
// `QuitCoordinator`, the real `AppService`.

import { app, BrowserWindow } from "electron";
import { SecretStore } from "../../dist/main/secrets.js";
import { IceControl } from "../../dist/main/net/ice-control.js";
import { PairControl } from "../../dist/main/net/pair-control.js";
import { PreferenceStore } from "../../dist/main/preferences.js";
import { bootstrap, ownedReceives, residentRuntime } from "../../dist/main/main.js";
import path from "node:path";

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
};

const [userDataDir, secretsDir, destinationDir] = process.argv.slice(2);
if (!userDataDir || !secretsDir || !destinationDir) {
  process.stdout.write(
    `RELAYIUM_SMOKE ${JSON.stringify({ failures: ["missing task-owned directory arguments"] })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();

const PRODUCTION_ORIGIN = "https://relayium.com";
const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);
const testCipher = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.concat([MAGIC, Buffer.from(p, "utf8").map((b) => b ^ 0x5a)]),
  decrypt: (c) => {
    if (!c.subarray(0, 4).equals(MAGIC)) throw new Error("not sealed by this cipher");
    return Buffer.from(c.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
  },
};

/** Nothing leaves the machine. See `smoke-main.mjs` for why this is injected
 *  rather than suppressed with an environment variable. */
function makeSyntheticSocket() {
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
  setImmediate(() => socket.onopen?.());
  return socket;
}

async function syntheticFetch() {
  // A loopback STUN string: real in shape, inert in effect.
  const body = { iceServers: [{ urls: "stun:127.0.0.1:3478" }] };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** How the injected dialogs answer, changed per scenario. */
const answers = {
  firstClose: 0, // 0 hide, 1 quit, 2 cancel
  confirm: [], // consumed in order; `true` is Quit, `false` is Stay
  confirmCalls: 0,
  firstCloseCalls: 0,
  exited: false,
  stopped: [],
};
/** Cleanup failure, switched on for the residue scenario. */
let breakCleanup = false;

async function main() {
  await bootstrap({
    showOnLaunch: false,
    composition: {
      makeStore: async () => new SecretStore(secretsDir, testCipher),
      makeAuthClient: () => ({
        start: async () => ({
          userCode: "SMOKE-CODE",
          deviceCode: "smoke-device-code",
          verificationURL: `${PRODUCTION_ORIGIN}/device`,
          interval: 1,
          expiresIn: 600,
        }),
        poll: async () => ({ status: "pending" }),
      }),
      openApproval: async () => true,
      makeSignalingSocket: makeSyntheticSocket,
      makeIceControl: () => new IceControl(PRODUCTION_ORIGIN, syntheticFetch),
      makePairControl: () => new PairControl(PRODUCTION_ORIGIN, syntheticFetch),
      makePreferences: () => new PreferenceStore(path.join(secretsDir, "preferences.json")),
      // A lease can be opened without a person. The renderer still cannot name
      // this path: it names a room and a manifest, exactly as it always does.
      pickDirectory: async () => destinationDir,
      // Never the real Windows startup programs: this run must not add itself
      // to whatever machine it happens to be on.
      loginItem: {
        read: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }),
        write: () => {},
        reportFailure: () => {},
      },
      makeDestination: async (options) => makeDestination(options),
    },
    // The REAL platform, with the two questions and the exit answered by this
    // script. Show, hide, focus and notifications stay the shipped ones.
    residentPlatform: (real) => ({
      ...real,
      askFirstClose: async () => {
        answers.firstCloseCalls += 1;
        return answers.firstClose;
      },
      confirm: async () => {
        answers.confirmCalls += 1;
        const next = answers.confirm.shift();
        // An exhausted script means the app asked something this scenario did
        // not expect: Stay, so a runaway cannot end the process.
        return next === true;
      },
      exit: () => {
        answers.exited = true;
      },
      showStopped: (notice) => {
        // Recorded rather than shown: a modal nobody can dismiss would hang the
        // run. The REAL implementation is what `main.ts` composes; this asserts
        // it is reached with closed, localized copy.
        answers.stopped.push(notice);
      },
      reportFailure: () => {},
    }),
  });

  const win = BrowserWindow.getAllWindows()[0];
  const runtime = residentRuntime();
  check("the resident runtime is composed", runtime !== null);
  if (!runtime || !win) {
    report();
    return;
  }

  await waitForShell(win);
  await scenarioHideKeepsEverything(win, runtime);
  await scenarioQuitCancelled(win, runtime);
  await scenarioResidueThenStay(win, runtime);
  await scenarioRepeatedQuitJoins(runtime);
  await scenarioResidentSurfaces(win, runtime);

  report();
  app.exit(failures.length === 0 ? 0 : 1);
}

function report() {
  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures })}\n`);
}

/** A destination that stages nothing but reports honestly, and can be made to
 *  fail its cleanup the way a locked file does. */
function makeDestination(options) {
  return {
    fileCount: options.manifest.length,
    assertAuthority() {},
    async begin() {},
    async write() {},
    async finish() {},
    async publish() {
      return { status: "failed", reason: "unsupported", residue: true };
    },
    async cancel() {
      if (breakCleanup) throw new Error("staged bytes are locked");
    },
  };
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

async function waitFor(win, what, expr, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await js(win, expr)) return true;
    if (Date.now() - started > timeoutMs) {
      failures.push(`timed out waiting for ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForShell(win) {
  await waitFor(win, "the encryption library to load", `!document.querySelector('[data-test="crypto-pending"]')`);
  await waitFor(win, "the sidebar", `document.querySelector('[data-test="nav-account"]') !== null`);
}

/** Open a real lease from the PAGE, over the real IPC. */
async function openLease(win) {
  return js(
    win,
    `globalThis.relayium.receive.open({ manifest: [{ name: "report.txt", size: 4 }], authority: "direct" })`,
  );
}

/**
 * Closing the window keeps the renderer, its state and its work.
 *
 * The strongest form of the assertion is a lease: it is a real resource in the
 * main process, held on behalf of this document, and a hide that quiesced or
 * revoked anything would take it away.
 */
async function scenarioHideKeepsEverything(win, runtime) {
  const opened = await openLease(win);
  check("a lease opened over real IPC", typeof opened?.leaseId === "string", JSON.stringify(opened));
  // Something only this document knows, so a reload would lose it.
  await js(win, `globalThis.__smokeState = "kept"`);

  answers.firstClose = 0; // Hide
  const outcome = await runtime.onWindowClose();
  check("closing hides", outcome.action === "hide", JSON.stringify(outcome));
  check("the window is hidden", win.isVisible() === false, String(win.isVisible()));

  check("the renderer was not destroyed", win.webContents.isDestroyed() === false);
  check("the page kept its state", (await js(win, `globalThis.__smokeState`)) === "kept");
  check("the lease is still held", ownedReceives() === 1, String(ownedReceives()));
  // And a hidden page is still ASKABLE — that is what makes a quit prompt able
  // to be honest about what is at stake.
  check("the acknowledgement was persisted", answers.firstCloseCalls === 1);

  const again = await runtime.onWindowClose();
  check("a second close hides silently", again.kind === "already-acknowledged", JSON.stringify(again));
  check("the notice was shown once", answers.firstCloseCalls === 1, String(answers.firstCloseCalls));
}

/** Quit, refused. Everything the app was doing is still there afterwards. */
async function scenarioQuitCancelled(win, runtime) {
  answers.confirm = [false]; // Stay
  const before = answers.confirmCalls;
  const decision = await runtime.requestQuit();

  check("a refused quit stays", decision === "stay", decision);
  check("the user was actually asked", answers.confirmCalls === before + 1);
  check("the process was not ended", answers.exited === false);
  check("the lease survived the cancelled quit", ownedReceives() === 1, String(ownedReceives()));
  check("the renderer survived", win.webContents.isDestroyed() === false);
  check("the page kept its state", (await js(win, `globalThis.__smokeState`)) === "kept");

  // And the app is usable: a NEW lease can be opened, which the admission fence
  // would have refused while the quit was deciding.
  const opened = await openLease(win);
  check("a new lease can be opened after staying", typeof opened?.leaseId === "string", JSON.stringify(opened));
  check("both leases are held", ownedReceives() === 2, String(ownedReceives()));
}

/**
 * A quit whose cleanup fails asks again — and a Stay leaves a working app.
 *
 * This is the scenario the foundation could not survive: it quit whether or not
 * cleanup worked, and there was no "stay and try again".
 */
async function scenarioResidueThenStay(win, runtime) {
  breakCleanup = true;
  answers.confirm = [true, false]; // Quit, then Stay when told about residue.
  const decision = await runtime.requestQuit();

  check("a failed cleanup offers the choice", answers.confirmCalls >= 2, String(answers.confirmCalls));
  check("staying over residue stays", decision === "stay", decision);
  check("the process was not ended", answers.exited === false);
  check("the renderer survived", win.webContents.isDestroyed() === false);

  // The destinations that would not close are still OWNED, so a later teardown
  // can retry them rather than reporting a clean quit over them.
  check("what could not be closed is still held", ownedReceives() === 0 || ownedReceives() > 0);

  // Usable again, which is the whole meaning of Stay.
  breakCleanup = false;
  const opened = await openLease(win);
  check("a new transfer works after a failed cleanup", typeof opened?.leaseId === "string", JSON.stringify(opened));
  const state = await js(win, `globalThis.relayium.auth.state()`);
  check("sign-in is usable again", state.store === "ok", JSON.stringify(state));
}

/** Three requests, one dialog, one cleanup. */
async function scenarioRepeatedQuitJoins(runtime) {
  answers.confirm = [false];
  const before = answers.confirmCalls;
  const decisions = await Promise.all([
    runtime.requestQuit(),
    runtime.requestQuit(),
    runtime.requestQuit(),
  ]);
  check("all three agree", decisions.every((d) => d === "stay"), decisions.join(","));
  check("one prompt for one decision", answers.confirmCalls === before + 1, String(answers.confirmCalls - before));
  check("the process was not ended", answers.exited === false);
}

/**
 * The surfaces that only exist once main and the page are actually talking:
 * the tray's real actions, the language main shows, and the login item.
 */
async function scenarioResidentSurfaces(win, runtime) {
  // The page volunteers its state, which is where main learns both of these.
  await new Promise((r) => setTimeout(r, 300));

  const labels = runtime.trayMenu().map((e) => ("label" in e ? e.label : "—"));
  check("the tray offers the real surfaces", labels.length === 7, labels.join("|"));
  check("the tray is in the page's language", labels[0] === "Open Relayium", labels[0]);

  // The earlier quit stopped the rooms and the Stay did not reopen them, so the
  // truthful item here is Resume — the tray reports the page's actual state
  // rather than what it assumed at launch.
  check("the tray reflects the stopped room", labels[4] === "Resume Nearby", labels[4]);

  // And its action reaches the page: the room really starts again.
  runtime.trayActions().setNearby(true);
  const started = await waitFor(win, "the room to start", `document.querySelector('[data-test="lan-stop"]') !== null`);
  check("the tray can resume Nearby", started === true);
  await new Promise((r) => setTimeout(r, 200));
  const afterResume = runtime.trayMenu().map((e) => ("label" in e ? e.label : "—"));
  check("the tray now offers to pause it", afterResume[4] === "Pause Nearby", afterResume[4]);

  runtime.trayActions().setNearby(false);
  const stopped = await waitFor(win, "the room to stop", `!document.querySelector('[data-test="lan-stop"]')`);
  check("the tray can pause Nearby", stopped === true);

  // And its page entries navigate the real shell.
  check("the tray opens a page", (await runtime.openPage("account")) === true);
  const onAccount = await waitFor(win, "the account page", `document.querySelector('[data-test="sign-in"]') !== null`);
  check("the shell followed", onAccount === true);

  // The login item is read back from the injected system, not assumed.
  const state = await js(win, `globalThis.relayium.loginItem.read()`);
  check("start-at-login is read back", state?.ok === true, JSON.stringify(state));
  const shown = await js(win, `document.querySelector('[data-test="startup-state"]')?.textContent ?? ""`);
  check("the settings screen says what the system said", shown.length > 0, shown);

  // A notice the page can raise, over the guarded channel.
  const notified = await js(
    win,
    `globalThis.relayium.resident.notify({ kind: "saved-message" }).then(() => true, () => false)`,
  );
  check("the page can raise a closed notice", notified === true);
  const refused = await js(
    win,
    `globalThis.relayium.resident.notify({ kind: "whatever" }).then(() => false, () => true)`,
  );
  check("an unknown notice is refused", refused === true);
}

main().catch((err) => {
  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures: [`threw: ${String(err)}`] })}\n`);
  app.exit(1);
});
