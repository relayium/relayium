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
import { receiveStoredLink } from "../../dist/main/stored/receive.js";
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

/**
 * A stored receive that actually STREAMS, so the page's progress and Cancel are
 * exercised against a running transfer rather than a finished one.
 *
 * It behaves like the real `receiveStoredLink` where it matters: it asks for a
 * folder, opens nothing without one, reports cumulative bytes, and honours the
 * abort signal — including while it is mid-stream, which is what Cancel has to
 * prove.
 */
const stream = { released: null, granted: false, closed: false };

/**
 * Transfers this run holds open on purpose, one per marker link.
 *
 * Separate from `stream` because the scenarios below need a transfer that is
 * still running while something else happens to it — a sign-out, a quit
 * prompt, a reload. `holdAfterAbort` keeps one alive past its own cancellation
 * so its OUTCOME can be delivered at a moment the test chooses, which is the
 * only way to observe which document it is delivered to.
 */
const holds = new Map();
const MARKERS = ["holding", "afterstay", "late"];
function holdFor(marker) {
  let entry = holds.get(marker);
  if (!entry) {
    entry = { granted: false, aborted: false, release: null, holdAfterAbort: false };
    holds.set(marker, entry);
  }
  return entry;
}

async function heldReceive(marker, options) {
  const held = holdFor(marker);
  const facts = { fileCount: 1, totalBytes: 100, burnAfterRead: false, expiresAt: 4_000_000_000 };
  const grant = await options.authority.grant(facts);
  if (grant === null) return { status: "declined" };
  held.granted = true;
  // Reported ONCE, the instant the job starts moving — deliberately the hardest
  // case. That frame races its own acknowledgement across the process boundary:
  // the page learns the job id from the `receive()` reply, and a frame that
  // wins the race has no id to match against yet. It used to be dropped, which
  // left the bar at zero for a transfer that reports once and then stalls. The
  // controller now holds the last unacknowledged frame per job, so this must
  // reach the screen whichever way the race goes.
  options.onProgress?.(30, 100);
  await new Promise((resolve) => {
    held.release = resolve;
    options.signal?.addEventListener(
      "abort",
      () => {
        held.aborted = true;
        if (!held.holdAfterAbort) resolve();
      },
      { once: true },
    );
  });
  if (options.signal?.aborted === true) {
    return { status: "cancelled", residue: false, cleanupTicket: null };
  }
  options.onProgress?.(100, 100);
  return { status: "saved", facts, publishedCount: 1, residue: false, cleanupTicket: null };
}

async function streamingReceive(options) {
  const marker = MARKERS.find((name) => options.link.includes(`/d/${name}`));
  if (marker) return heldReceive(marker, options);
  // Only the marker link is simulated. Everything else goes to the REAL
  // receive, so the refusal path below is the shipping parser refusing an
  // untrusted host rather than this stand-in agreeing to.
  if (!options.link.includes("/d/streaming")) return receiveStoredLink(options);
  const facts = { fileCount: 1, totalBytes: 100, burnAfterRead: false, expiresAt: 4_000_000_000 };
  const grant = await options.authority.grant(facts);
  if (grant === null) return { status: "declined" };
  stream.granted = true;
  options.onProgress?.(25, 100);
  await new Promise((resolve) => {
    stream.released = resolve;
    options.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  // The body is closed on the way out either way — that is what releases the
  // connection, and it is a side effect the test can observe.
  stream.closed = true;
  if (options.signal?.aborted === true) {
    return { status: "cancelled", residue: false, cleanupTicket: null };
  }
  options.onProgress?.(100, 100);
  return { status: "saved", facts, publishedCount: 1, residue: false, cleanupTicket: null };
}

/** How the injected dialogs answer, changed per scenario. */
const answers = {
  firstClose: 0, // 0 hide, 1 quit, 2 cancel
  confirm: [], // consumed in order; `true` is Quit, `false` is Stay
  confirmCalls: 0,
  firstCloseCalls: 0,
  exited: false,
  stopped: [],
  /** Run once, WHILE the confirmation is on screen. A person reading a dialog
   *  takes time, and that window is exactly where a late start has to be
   *  refused; nothing else in this file can observe it. */
  onConfirm: null,
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
      storedReceive: { receive: streamingReceive },
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
        const hook = answers.onConfirm;
        if (hook) {
          answers.onConfirm = null;
          await hook();
        }
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
  await scenarioStoredReceive(win, runtime);
  await scenarioAnonymousAcrossSignOut(win);
  await scenarioNoLateStartWhileQuitting(win, runtime);
  // Last: it replaces the document every earlier scenario was driving.
  await scenarioOutcomeDoesNotCrossDocuments(win);

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

const js = (win, expr) =>
  win.webContents.executeJavaScript(expr).catch((err) => {
    process.stderr.write(`resident-smoke: script failed: ${String(err)}\n  expr: ${expr.slice(0, 160)}\n`);
    throw err;
  });

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

/**
 * Type a link into the REAL input and press the REAL button.
 *
 * Typing and submitting are two steps, deliberately. The submit button is
 * disabled while the box is empty, and Svelte flushes that attribute after the
 * input event — clicking in the same tick clicks a disabled button and nothing
 * happens, which is a test that proves nothing rather than a failure.
 */
async function startFromPage(win, value) {
  await js(
    win,
    `(() => {
      const input = document.querySelector('[data-test="stored-link"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  await waitFor(
    win,
    "the open button to become usable",
    `!document.querySelector('[data-test="stored-open"]').disabled`,
  );
  return js(
    win,
    `(() => {
      const button = document.querySelector('[data-test="stored-open"]');
      if (button.disabled) return "disabled";
      button.click();
      return "clicked";
    })()`,
  );
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

/**
 * The Stored page, driven as a user drives it, in the real DOM.
 *
 * Actual compiled handlers: typing into the real input, submitting the real
 * form, and reading what the page says back. The transport is injected, so
 * nothing leaves the machine and the refusal path is exercised end to end
 * without a server.
 */
async function scenarioStoredReceive(win, runtime) {
  await js(win, `(() => { document.querySelector('[data-test="nav-stored"] button')?.click(); return true; })()`);
  const onPage = await waitFor(win, "the stored page", `document.querySelector('[data-test="stored-link"]') !== null`);
  if (!onPage) return;

  // The page offers no working control for what this build cannot do, and says
  // so in words.
  check(
    "the unbuilt modes are named, not mocked up",
    (await js(win, `document.querySelector('[data-test="stored-send-soon"]') !== null`)) === true,
  );

  // A link this build will not act on. The page must show a CODE's sentence,
  // never the input, and must not have downloaded anything.
  const type = (value) => startFromPage(win, value);

  check("the link was typed and submitted", (await type("https://example.invalid/d/abc#k=x")) === "clicked");
  const answered = await waitFor(
    win,
    "the refusal",
    `document.querySelector('[data-test="stored-outcome"]') !== null`,
  );
  check("an untrusted link is refused", answered === true);
  const shown = await js(win, `document.querySelector('[data-test="stored-outcome"]')?.textContent ?? ""`);
  check("the refusal is a sentence, not the link", !shown.includes("example.invalid"), shown);
  check("the key never appears on screen", !(await js(win, `document.body.innerText`)).includes("#k="), "fragment on screen");

  // ## A real transfer, held mid-stream
  //
  // The page must show progress for a job it can name, and Cancel must reach it
  // BEFORE the final receipt. Both are asserted as side effects: the bar moves,
  // and the injected stream observes the abort and closes its body.
  check("the stream starts idle", stream.granted === false && stream.closed === false);
  check("the streaming link was submitted", (await type("https://relayium.com/d/streaming#k=Zm9vYmFy")) === "clicked");

  const moving = await waitFor(
    win,
    "progress to appear mid-transfer",
    `document.querySelector('[data-test="stored-progress"]')?.textContent?.includes("25") === true`,
  );
  check("progress reaches the page during the transfer", moving === true);
  check("the folder was granted before anything streamed", stream.granted === true);
  check("the transfer has NOT finished", stream.closed === false);

  // Cancel, while it is still running.
  check(
    "cancel is offered during the transfer",
    (await js(win, `document.querySelector('[data-test="stored-cancel"]') !== null`)) === true,
  );
  const clicked = await js(
    win,
    `(() => {
      const button = document.querySelector('[data-test="stored-cancel"]');
      if (!button) {
        return JSON.stringify({
          clicked: false,
          progress: document.querySelector('[data-test="stored-progress"]')?.textContent ?? null,
          outcome: document.querySelector('[data-test="stored-outcome"]')?.textContent ?? null,
          refusal: document.querySelector('[data-test="stored-refusal"]')?.textContent ?? null,
        });
      }
      button.click();
      return JSON.stringify({ clicked: true });
    })()`,
  );
  check("cancel was pressed while the transfer was running", JSON.parse(clicked).clicked === true, clicked);

  const ended = await waitFor(
    win,
    "the cancelled outcome",
    `document.querySelector('[data-test="stored-outcome"]') !== null`,
  );
  check("cancelling ends the transfer", ended === true);
  // The side effects, not the acknowledgement: the stream saw the abort and
  // closed, and the page says nothing was saved.
  check("the stream observed the abort and closed", stream.closed === true);
  const cancelled = await js(
    win,
    `document.querySelector('[data-test="stored-outcome"]')?.textContent ?? JSON.stringify({
      missing: true,
      body: document.body.innerText.slice(0, 200),
    })`,
  );
  check("the page reports a cancellation", cancelled.toLowerCase().includes("cancel"), cancelled);
  check(
    "progress is gone once it ended",
    (await js(win, `document.querySelector('[data-test="stored-progress"]') === null`)) === true,
  );

  // A deep link reaches the page and lands in the box — and downloads nothing
  // by arriving.
  check(
    "an OS link is offered to the page",
    (await runtime.offerStoredLink("https://relayium.com/d/abc#k=Zm9vYmFy")) === true,
  );
  const offered = await waitFor(
    win,
    "the offered link",
    `document.querySelector('[data-test="stored-from-link"]') !== null`,
  );
  check("the page says where it came from", offered === true);
  check(
    "the link is in the box, waiting for the user",
    (await js(win, `document.querySelector('[data-test="stored-link"]').value`)).endsWith("#k=Zm9vYmFy"),
  );
  check(
    "nothing was downloaded by opening it",
    (await js(win, `document.querySelector('[data-test="stored-progress"]') === null`)) === true,
  );
  void runtime;
}

/**
 * A stored link is anonymous, so signing out is not an authority change over it.
 *
 * The shipped Mac composes it the same way: `CloudDownloadModel` holds no
 * account and no sign-out path cancels it. The assertion is the SIDE EFFECT —
 * the transfer never saw an abort and went on to save — not that main returned
 * something reassuring.
 */
async function scenarioAnonymousAcrossSignOut(win) {
  const started = await startFromPage(win, "https://relayium.com/d/holding#k=Zm9vYmFy");
  check("the held transfer was submitted", started === "clicked", started);
  const moving = await waitFor(
    win,
    "the held transfer to report progress",
    `document.querySelector('[data-test="stored-progress"]')?.textContent?.includes("30") === true`,
  );
  check("the held transfer is running", moving === true);

  // The real account transition, over the real IPC: the epoch moves, the
  // in-flight sign-in is retired and account leases are cancelled.
  const out = await js(win, `globalThis.relayium.auth.signOut().then((r) => JSON.stringify(r), () => "threw")`);
  check("the account transition actually ran", out === JSON.stringify({ signedIn: false }), String(out));

  await new Promise((r) => setTimeout(r, 200));
  const held = holdFor("holding");
  check("signing out did not abort an anonymous download", held.aborted === false);
  check(
    "the page still shows it running",
    (await js(win, `document.querySelector('[data-test="stored-progress"]') !== null`)) === true,
  );

  held.release?.();
  const saved = await waitFor(
    win,
    "the download to finish after the sign-out",
    `document.querySelector('[data-test="stored-outcome"]') !== null`,
  );
  check("the download finished across the account change", saved === true);
}

/**
 * A quit that is being DECIDED admits nothing new — and stops nothing either.
 *
 * Main fences its own admission before it asks anybody anything, so the risk
 * the prompt describes is still the risk when the person answers. The page's
 * acknowledgement is not what makes that true: this asserts it against the
 * real IPC channel while the dialog is up.
 */
async function scenarioNoLateStartWhileQuitting(win, runtime) {
  const started = await startFromPage(win, "https://relayium.com/d/afterstay#k=Zm9vYmFy");
  check("a transfer is running when the quit is requested", started === "clicked", started);
  const moving = await waitFor(
    win,
    "the transfer to report progress",
    `document.querySelector('[data-test="stored-progress"]')?.textContent?.includes("30") === true`,
  );
  check("the transfer is running", moving === true);

  let duringConsent = null;
  const held = holdFor("afterstay");
  answers.confirm = [false]; // Stay
  answers.onConfirm = async () => {
    duringConsent = await js(
      win,
      `globalThis.relayium.stored.receive({ link: "https://relayium.com/d/holding#k=Zm9vYmFy" }).then((r) => JSON.stringify(r), () => "threw")`,
    );
    // A fence is not a cancel: what was already running is untouched while the
    // user decides, because they may still say Stay.
    check("the running transfer was not aborted by the fence", held.aborted === false);
  };

  const decision = await runtime.requestQuit();
  check("the quit was refused", decision === "stay", decision);
  check("the user was actually asked", duringConsent !== null);
  check(
    "a receive started while the user was deciding is refused",
    JSON.parse(duringConsent ?? "{}").refusal === "unavailable",
    String(duringConsent),
  );
  check("the process was not ended", answers.exited === false);

  // Stay re-admits: the SAME call now succeeds, and reaches the stand-in.
  const readmitted = await js(
    win,
    `globalThis.relayium.stored.receive({ link: "https://relayium.com/d/late#k=Zm9vYmFy" }).then((r) => JSON.stringify(r), () => "threw")`,
  );
  check("Stay makes stored receive usable again", JSON.parse(readmitted ?? "{}").ok === true, String(readmitted));

  // And the transfer that was running through the whole quit still finishes.
  held.release?.();
  await new Promise((r) => setTimeout(r, 200));
  check("the fenced transfer was never aborted", held.aborted === false);
}

/**
 * An outcome belongs to the document that ASKED for it.
 *
 * The `late` transfer is started above, aborted by the reload, and then held
 * past its own cancellation so its outcome is delivered only once the
 * REPLACEMENT document exists and is listening on the real event channel.
 * Nothing about the job id closes this: a freshly mounted controller has no id
 * to mismatch against.
 */
async function scenarioOutcomeDoesNotCrossDocuments(win) {
  const late = holdFor("late");
  // Kept alive past the abort, so the delivery moment is this test's to choose.
  late.holdAfterAbort = true;
  await new Promise((r) => setTimeout(r, 200));
  check("the late transfer is running before the reload", late.granted === true);

  // The document goes away. Main revokes it, which aborts the transfer — but
  // the stand-in does not RETURN yet, so nothing has been delivered.
  win.webContents.reload();
  await waitForShell(win);
  await new Promise((r) => setTimeout(r, 200));
  check("the reload aborted the retired document's transfer", late.aborted === true);

  // The replacement document, listening on the real channel rather than on
  // whatever the controller chose to render.
  await js(
    win,
    `(() => {
      globalThis.__leakedOutcomes = [];
      globalThis.__leakedProgress = [];
      globalThis.relayium.stored.onOutcome((p) => globalThis.__leakedOutcomes.push(p));
      globalThis.relayium.stored.onProgress((p) => globalThis.__leakedProgress.push(p));
      return true;
    })()`,
  );

  late.release?.();
  await new Promise((r) => setTimeout(r, 400));
  const leaked = await js(win, `JSON.stringify(globalThis.__leakedOutcomes)`);
  check("the retired document's outcome never reaches its replacement", leaked === "[]", String(leaked));
  check(
    "and neither does its progress",
    (await js(win, `JSON.stringify(globalThis.__leakedProgress)`)) === "[]",
  );
  check(
    "the new document shows no receipt for a transfer it never started",
    (await js(win, `document.querySelector('[data-test="stored-outcome"]') === null`)) === true,
  );

  // The control. Without it, an absence proves only that the channel is dead:
  // this document's OWN outcome must arrive on the same listener.
  await js(win, `(() => { document.querySelector('[data-test="nav-stored"] button')?.click(); return true; })()`);
  await waitFor(win, "the stored page in the new document", `document.querySelector('[data-test="stored-link"]') !== null`);
  const submitted = await startFromPage(win, "https://example.invalid/d/abc#k=x");
  check("the new document can start a transfer", submitted === "clicked", submitted);
  const arrived = await waitFor(
    win,
    "the new document's own outcome",
    `globalThis.__leakedOutcomes.length === 1`,
  );
  check("the live channel delivers THIS document's outcome", arrived === true);
}

main().catch((err) => {
  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures: [`threw: ${String(err)}`] })}\n`);
  app.exit(1);
});
