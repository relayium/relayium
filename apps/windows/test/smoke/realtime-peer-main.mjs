// The WINDOWS half of the realtime pairing acceptance: a real Electron, the
// real renderer, the real `RoomController`, driven through the real UI.
//
// Spawned by `realtime-pairing-acceptance.mjs`, which owns the throwaway server,
// the synthetic account, the temporary directories and the browser on the other
// side of the room. This half owns one Electron process and drives the shipped
// pages the way a person would: it clicks `pair-create` or types a code into
// `pair-input`, compares the verification code, writes into the composer, hands
// files to the real `<input type="file">`, accepts the inbound batch, and reads
// back what the page says happened.
//
// ## What is real here, and what is injected
//
// REAL: the signalling socket (`makeSignalingSocket` is omitted, so it is
// Electron's own `WebSocket` against the real hub), the ICE control-plane read,
// the pairing-code mint through the real `PairControl`, the whole renderer, the
// link handshake, the SAS, the file and text lanes, WebRTC itself, and — on
// win32 — the real receive destination, which means the real lease, the real
// `winpath` guards and the real native helper.
//
// INJECTED, and only through `HandlerComposition`, the same reviewed seam the
// other smokes use (`handlers.ts:65-160`):
//
//   * `pickDirectory` — a wrapper-owned folder, because no person can answer a
//     native dialog here. The renderer still cannot name a path.
//   * `makeStore`/`makePreferences` — task-owned files, so a run never touches
//     the developer's keychain or their real preferences.
//   * `makeAuthClient` — the interactive device-code APPROVAL is bypassed; the
//     token it hands back is a REAL bearer the orchestrator minted from the real
//     server for a synthetic account. Nothing about the credential is faked.
//   * `loginItem` — inert, so a run never adds itself to a machine's startup.
//   * `startInbox: false` — no Device Inbox scheduler behind this run.
//   * `makeDestination` — **only on a host that is not win32**, where the real
//     Windows destination cannot exist. Every observation it produces is
//     labelled `hostProvider: true` and the orchestrator refuses to count the
//     Windows-destination assertions on such a host.
//
// The origin is loopback because the ENGINEERING build says so
// (`RELAYIUM_WINDOWS_ENGINEERING=1` + `RELAYIUM_WINDOWS_ORIGIN`, refused unless
// unpackaged AND the hostname is a loopback literal — `build-mode.ts`,
// `origin.ts`). Nothing here reaches production, and no test-only branch exists
// in the product for it.
//
// ## Contract with the orchestrator
//
// One argument: the path of a JSON config. Everything observed is written to
// `config.out` as JSON, and one `RELAYIUM_REALTIME {json}` line is printed. The
// orchestrator makes every comparison, so a mistake in this file surfaces there
// as a failed check rather than as a pass this file granted itself.
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { SecretStore } from "../../dist/main/secrets.js";
import { PreferenceStore } from "../../dist/main/preferences.js";
import { bootstrap } from "../../dist/main/main.js";
// The PRODUCTION win32 destination, imported so it can be OBSERVED — never
// replaced. See `observingWindowsDestination`.
import { NativeHelperDestination } from "../../dist/main/net/native-receive-adapter.js";

const configPath = process.argv[2];

/**
 * This half's own diagnostic log, and its own progress file.
 *
 * ## Why not stdout
 *
 * On win32 this process is started by the Job Object guardian through
 * `CreateProcess`, so the orchestrator holds no pipe to it: the alternative
 * would be inheriting handles across a process this fixture deliberately does
 * not hand arbitrary handles to. Both halves of what stdout was carrying — the
 * running commentary, and the pairing code the browser cannot join without —
 * are files instead, written by this process into its own round directory.
 *
 * stderr is still written, because on a host where the orchestrator does hold
 * the pipe it costs nothing and is the first place a person looks.
 */
let logPath = null;
let statusPath = null;
let logBytes = 0;
/** Bounded: a wedged run must not fill a disk with its own commentary. */
const LOG_BUDGET_BYTES = 4 * 1024 * 1024;

const say = (line) => {
  const text = `peer: ${line}\n`;
  process.stderr.write(text);
  if (logPath && logBytes < LOG_BUDGET_BYTES) {
    try {
      appendFileSync(logPath, text);
      logBytes += Buffer.byteLength(text);
    } catch { /* the log is diagnostics; losing it must not end the round */ }
  }
};

/**
 * Publish progress the orchestrator is WAITING on, atomically.
 *
 * Atomic because the orchestrator polls it: a reader that catches a partial
 * write would either fail to parse or, worse, read a truncated pairing code and
 * join a room that does not exist. Written to a sibling path and renamed, which
 * is atomic within one directory on both platforms this runs on.
 */
function publishStatus(patch) {
  if (!statusPath) return;
  status = { ...status, ...patch };
  try {
    const staging = `${statusPath}.writing`;
    writeFileSync(staging, JSON.stringify(status) + "\n");
    renameSync(staging, statusPath);
  } catch (err) {
    say(`could not publish status: ${String(err)}`);
  }
}

/** What the orchestrator polls for. Deliberately tiny and append-only in
 *  meaning: a phase never goes backwards. */
let status = { phase: "starting", code: "", signedIn: false, linkOpen: false, finished: false };

/** Reported instead of thrown: the orchestrator must always get a result line. */
const observed = {
  platform: process.platform,
  role: "",
  hostProvider: process.platform !== "win32",
  code: "",
  mintRefusal: "",
  signedIn: false,
  linkOpen: false,
  sas: "",
  sasConfirmed: false,
  sentMessage: "",
  sentFileName: "",
  sentFileBytes: 0,
  /** The thread as it stood at the END of the round. Kept because it is the
   *  honest final state, and it is NOT what the message assertion rests on. */
  receivedMessages: [],
  /**
   * The fullest thread this run ever actually saw, read from the REAL history
   * (`[data-test="history"] li`, whose text content is `{entry.body}` and
   * nothing else — never the composer, so never a draft read back).
   *
   * A high-water mark rather than a final snapshot because `LinkPane`'s message
   * Card is gated on `connected`: once the peer leaves, the Card unmounts and
   * the final read is `[]` no matter what was delivered into it. Recording what
   * was on screen WHILE the link was up is the only reading of "the client
   * received the message" that a teardown cannot erase.
   */
  receivedMessagesPeak: [],
  /** Milliseconds from the start of the receive watch to each observation, or
   *  null where it never happened. Reported so an ordering problem is visible
   *  as an ordering problem. */
  receiveTiming: { acceptedAt: null, messageAt: null, outcomeAt: null, stoppedBecause: "" },
  receivedOutcome: "",
  receivedNotice: "",
  /**
   * Every destination this round OPENED, and how each one ended.
   *
   * Present only on win32, where the real `NativeHelperDestination` is what
   * receives. It is the one place the TYPED refusal survives: `LinkPane`'s
   * `failureText` maps every unrecognised reason to the same sentence
   * (`LinkPane.svelte:115-121`), so the panel's text cannot tell a refused
   * manifest apart from a timeout or a permission error.
   */
  destinationOpens: [],
  destinationEntries: [],
  leftRoom: false,
  errors: [],
};

function finish(code) {
  // The LAST thing published, and the flag the orchestrator treats as "this
  // half is done": the observations file is written immediately below, so a
  // reader that sees `finished` will find a complete one.
  try {
    if (config?.out) writeFileSync(config.out, JSON.stringify(observed, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`peer: could not write observations: ${String(err)}\n`);
  }
  process.stdout.write(`RELAYIUM_REALTIME ${JSON.stringify(observed)}\n`);
  publishStatus({ phase: "finished", finished: true, exitCode: code });
  app.exit(code);
}

let config = null;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  observed.errors.push(`unreadable config: ${String(err)}`);
  process.stdout.write(`RELAYIUM_REALTIME ${JSON.stringify(observed)}\n`);
  app.exit(1);
}

observed.role = config.role;
logPath = config.log ?? null;
statusPath = config.status ?? null;
publishStatus({ phase: "config-read" });
say(`config read: role=${config.role} origin=${config.origin}`);
app.setPath("userData", config.userDataDir);
app.disableHardwareAcceleration();

/** A cipher for the run's own store. Never the platform one: this must not
 *  reach a developer's keychain, and on a host that is not Windows there is no
 *  DPAPI to reach anyway. The secret store is not what this run is testing. */
const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);
const runCipher = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.concat([MAGIC, Buffer.from(p, "utf8").map((b) => b ^ 0x5a)]),
  decrypt: (c) => {
    if (!c.subarray(0, 4).equals(MAGIC)) throw new Error("not sealed by this cipher");
    return Buffer.from(c.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
  },
};

/** The verification preference is written BEFORE boot, because the page reads it
 *  at startup; a later write would not reach the component's own state. */
const prefsPath = path.join(config.secretsDir, "preferences.json");
writeFileSync(prefsPath, JSON.stringify({ verifyPeers: Boolean(config.verify) }), "utf8");

/** What the injected poll answers. Flipped once, to a REAL bearer. */
let pollAnswer = { status: "pending" };

// ---------------------------------------------------------------------------
// Driving the real page
// ---------------------------------------------------------------------------

const js = (win, expr) => win.webContents.executeJavaScript(expr);

/** Poll an expression until it is true. A deadline, never a sleep: a fixed wait
 *  is either a slow run or a flaky one, and usually both. */
async function until(win, what, expr, budgetMs) {
  say(`waiting for ${what} (<=${budgetMs}ms)`);
  const started = Date.now();
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      if (await js(win, `(() => { try { return !!(${expr}); } catch { return false; } })()`)) {
        say(`got ${what} after ${Date.now() - started}ms`);
        return true;
      }
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  observed.errors.push(`timed out after ${budgetMs}ms waiting for ${what}${last ? `: ${String(last)}` : ""}`);
  return false;
}

const clickTest = (win, name) =>
  js(win, `(() => { const el = document.querySelector('[data-test="${name}"]');
    if (!el) return false; (el.tagName === 'BUTTON' ? el : el.querySelector('button') ?? el).click(); return true; })()`);

const textOf = (win, name) =>
  js(win, `document.querySelector('[data-test="${name}"]')?.textContent?.trim() ?? ""`);

const hasTest = (win, name) => `document.querySelector('[data-test="${name}"]') !== null`;

/** Set a controlled input the way Svelte will notice. */
const typeInto = (win, name, value) =>
  js(win, `(() => {
    const el = document.querySelector('[data-test="${name}"]');
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

/**
 * Hand a batch to the real file control.
 *
 * The `click` is DISPATCHED rather than invoked: an untrusted event runs the
 * component's `beginPick` (which captures the send intent) and runs no default
 * action, so no native dialog opens. `input.click()` would open one and hang the
 * run behind a dialog nobody can answer.
 *
 * The bytes are built HERE, in the page, from a deterministic spec — the
 * orchestrator rebuilds the same bytes to compare digests. That is what makes a
 * `CHUNK_SIZE + 1` file possible at all: it never crosses a command line.
 */
const sendFiles = (win, files) =>
  js(win, `(() => {
    const inputs = [...document.querySelectorAll('.drop input[type=file]')];
    const input = inputs[0];
    if (!input) return { ok: false, why: 'no file control in the link pane' };
    if (input.disabled) return { ok: false, why: 'the file control was disabled' };
    const filled = (n, seed) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
      return out;
    };
    const specs = ${JSON.stringify(files)};
    const dt = new DataTransfer();
    let total = 0;
    for (const spec of specs) {
      const bytes = spec.text !== undefined
        ? new TextEncoder().encode(spec.text)
        : filled(spec.size, spec.seed);
      total += bytes.byteLength;
      dt.items.add(new File([bytes], spec.name));
    }
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, total, names: [...dt.files].map((f) => f.name) };
  })()`);

/** Everything the thread is showing, for the orchestrator to compare. */
const readMessages = (win) =>
  js(win, `[...document.querySelectorAll('[data-test="history"] li')].map((el) => el.textContent)`);

/** The terminal receipts `LinkPane` can render, in the order it tests them. */
const RECEIPT_MARKERS = ["recv-saved", "recv-failed", "recv-partial", "recv-cancelled", "recv-failed-saved"];

/**
 * Watch ONE receive, recording each thing as it actually happens.
 *
 * ## Why this is one loop and not three waits
 *
 * The previous shape was strictly ordered: wait up to the whole transfer budget
 * for the consent card, then for the peer's message, then for a terminal
 * receipt. Nothing on the wire is ordered that way. Both peers hand over a batch
 * at once, and `mixed-file-session.svelte.ts:1183-1198` resolves that glare by
 * having the RESPONDER park its batch and replay it after the keeper's has
 * finished — so on the rounds where this client is the initiator the inbound
 * manifest legitimately arrives LAST, long after the peer's message did. A
 * serial wait spends its entire budget on whichever step the arbitration
 * happened to defer, and never looks at the ones that already completed.
 *
 * So all three are watched together, on one budget, and each is recorded with
 * the moment it was observed. Anything that did not happen is still an error
 * naming exactly what did not happen — nothing here is permitted to pass by
 * being skipped.
 *
 * The thread is read from `[data-test="history"] li` on every pass and kept as a
 * HIGH-WATER MARK. That is not a convenience: `LinkPane`'s message Card is
 * `{#if connected}`, so the moment the peer leaves the room the Card unmounts
 * and a final read returns `[]` however much was delivered into it. The peak is
 * what was genuinely on screen while the link was up; the final read is
 * reported separately and is not what the assertion rests on.
 */
async function watchReceive(win) {
  const budgetMs = config.transferBudgetMs;
  const started = Date.now();
  const deadline = started + budgetMs;
  const since = () => Date.now() - started;
  const timing = observed.receiveTiming;
  const expectMessage = config.expectMessage ?? "";
  /** After a destination has REFUSED, the receive is provably over. A short
   *  grace lets any receipt render, and then there is nothing left to wait for:
   *  sitting out the rest of the budget would only delay the report. */
  const REFUSAL_GRACE_MS = 5_000;
  let refusedAt = null;

  say(`watching the receive (<=${budgetMs}ms)`);
  while (Date.now() < deadline) {
    // Consent, once: an inbound batch is a decision and the shipped page asks.
    if (timing.acceptedAt === null && await js(win, hasTest(win, "recv-accept"))) {
      await clickTest(win, "recv-accept");
      timing.acceptedAt = since();
      say(`accepted the inbound consent card after ${timing.acceptedAt}ms`);
    }

    // The REAL thread, never the composer.
    const history = await readMessages(win).catch(() => null);
    if (Array.isArray(history)) {
      if (history.length > observed.receivedMessagesPeak.length) observed.receivedMessagesPeak = history;
      if (timing.messageAt === null && expectMessage && history.some((entry) => entry === expectMessage)) {
        timing.messageAt = since();
        say(`the peer's message reached the thread after ${timing.messageAt}ms`);
      }
    }

    if (timing.outcomeAt === null) {
      for (const marker of RECEIPT_MARKERS) {
        if (await js(win, hasTest(win, marker))) {
          observed.receivedOutcome = marker;
          observed.receivedNotice = await textOf(win, marker);
          timing.outcomeAt = since();
          say(`the receive settled as ${marker} after ${timing.outcomeAt}ms`);
          break;
        }
      }
    }

    const done = timing.acceptedAt !== null && timing.outcomeAt !== null
      && (!expectMessage || timing.messageAt !== null);
    if (done) {
      timing.stoppedBecause = "every watched observation happened";
      break;
    }
    // A destination that REFUSED the manifest has already decided this receive;
    // see `destinationOpens`. Nothing further can arrive for it.
    if (refusedAt === null && observed.destinationOpens.some((entry) => entry.outcome === "refused")) {
      refusedAt = Date.now();
      say("a destination refused the manifest; holding briefly for its receipt");
    }
    if (refusedAt !== null && Date.now() - refusedAt >= REFUSAL_GRACE_MS
        && (!expectMessage || timing.messageAt !== null)) {
      timing.stoppedBecause = "the destination refused the manifest and the grace elapsed";
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!timing.stoppedBecause) timing.stoppedBecause = `the ${budgetMs}ms watch budget elapsed`;

  // Each missing observation is named as itself. "The receive did not finish"
  // and "the message never arrived" are different failures and a single timeout
  // line cannot tell an orchestrator which one happened.
  if (timing.acceptedAt === null) {
    observed.errors.push(`no inbound consent card within ${budgetMs}ms (${timing.stoppedBecause})`);
  }
  if (expectMessage && timing.messageAt === null) {
    observed.errors.push(`the peer's message never reached the thread within ${budgetMs}ms; `
      + `the fullest thread seen was ${JSON.stringify(observed.receivedMessagesPeak)}`);
  }
  if (timing.outcomeAt === null) {
    observed.errors.push(`the receive never reached a terminal receipt within ${budgetMs}ms `
      + `(${timing.stoppedBecause}); destinationOpens=${JSON.stringify(observed.destinationOpens)}`);
  }
}

async function drive(win) {
  say(`driving ${win.webContents.getURL() || "(no url yet)"}`);
  // ---- 1. the page is up ------------------------------------------------
  if (!await until(win, "the app shell", `document.querySelector('[data-test="nav-pair"]') !== null`, 60_000)) return;

  // ---- 2. sign in, only when this round needs a minted code -------------
  if (config.role === "create") {
    pollAnswer = { status: "ok", accessToken: config.token, accountEmail: config.accountEmail };
    // The REAL button, not the IPC behind it.
    //
    // `relayium.auth.start` only mints the device code; `relayium.auth.poll` is a
    // separate channel and the RENDERER's own controller is what drives it
    // (`preload.cts:51-56`). Calling `start` directly therefore begins a flow
    // nothing is polling, which is a sign-in that never lands. Clicking is also
    // the point: this run is meant to exercise the shipped path.
    await clickTest(win, "nav-account");
    if (!await until(win, "the signed-out account page", hasTest(win, "sign-in"), 30_000)) return;
    await clickTest(win, "sign-in");
    observed.signedIn = await until(win, "the signed-in account", hasTest(win, "sign-out"), 60_000);
    publishStatus({ phase: "signed-in", signedIn: observed.signedIn });
    if (!observed.signedIn) {
      observed.errors.push(`sign-in never landed: ${JSON.stringify(
        await js(win, `globalThis.relayium.auth.state()`).catch((e) => String(e)))}`);
      return;
    }
  }

  // ---- 3. the pairing room ----------------------------------------------
  await clickTest(win, "nav-pair");
  if (!await until(win, "the pairing page", hasTest(win, "pair-input"), 30_000)) return;

  if (config.role === "create") {
    await clickTest(win, "pair-create");
    const minted = await until(win, "a minted pairing code", hasTest(win, "pair-code"), 60_000);
    if (!minted) {
      observed.mintRefusal = await textOf(win, "pair-mint-error");
      return;
    }
    observed.code = (await textOf(win, "pair-code")).replace(/\s+/g, "");
    // Published as it happens: the browser half cannot join a code that only
    // appears in the observations this process writes when it is finished.
    publishStatus({ phase: "code-minted", code: observed.code });
    say(`pair-code=${observed.code}`);
  } else {
    await typeInto(win, "pair-input", config.code);
    await clickTest(win, "pair-join");
    observed.code = config.code;
  }

  // ---- 4. the link, and the verification code ---------------------------
  observed.linkOpen = await until(win, "the link pane",
    `${hasTest(win, "sas")} || ${hasTest(win, "message")} || ${hasTest(win, "link-status")}`, config.joinBudgetMs);
  publishStatus({ phase: "link", linkOpen: observed.linkOpen });
  if (!observed.linkOpen) return;

  if (config.verify) {
    if (await until(win, "the verification code", hasTest(win, "sas"), 60_000)) {
      observed.sas = await textOf(win, "sas");
      observed.sasConfirmed = await clickTest(win, "sas-confirm");
    }
  }

  // ---- 5. this side sends -----------------------------------------------
  //
  // The composer is gated the same way the web panel's is: a session that has
  // been OFFERED shows Accept, not a text box. So any pending offer is accepted
  // first — by clicking the real control, not by writing state — and only then
  // is the composer waited on. Waiting on the box alone deadlocks whenever the
  // other side spoke first.
  const composerReady = await until(win, "the composer, accepting any offered session on the way",
    `(() => {
       const accept = document.querySelector('[data-test="text-accept"]')
         ?? document.querySelector('[data-test="recv-accept"]');
       if (accept) { accept.click(); return false; }
       return document.querySelector('[data-test="message"]') !== null
         && document.querySelector('[data-test="send"]') !== null;
     })()`, config.transferBudgetMs);
  if (!composerReady) return;
  await typeInto(win, "message", config.sendMessage);
  await until(win, "Send to become available",
    `!document.querySelector('[data-test="send"]').disabled`, 30_000);
  await clickTest(win, "send");
  observed.sentMessage = config.sendMessage;

  if (config.sendFiles?.length) {
    const handed = await sendFiles(win, config.sendFiles);
    if (!handed.ok) observed.errors.push(`send refused: ${handed.why}`);
    else {
      observed.sentFileName = handed.names.join("|");
      observed.sentFileBytes = handed.total;
    }
  }

  // ---- 6. and receives ---------------------------------------------------
  await watchReceive(win);
  observed.receivedMessages = await readMessages(win);

  // ---- 7. the lifecycle case --------------------------------------------
  if (config.lifecycle === "leave") {
    // The room's own leave, which records the intent — not a bare disconnect.
    observed.leftRoom = (await clickTest(win, "disconnect")) || (await clickTest(win, "pair-leave"));
    await until(win, "the link to be gone", `${hasTest(win, "pair-input")} || ${hasTest(win, "pair-disconnected")}`, 30_000);
  }
}

async function main() {
  say("main entered");
  mkdirSync(config.destinationDir, { recursive: true });
  const store = new SecretStore(config.secretsDir, runCipher);
  await bootstrap({
    showOnLaunch: false,
    composition: {
      makeStore: async () => store,
      makeAuthClient: () => ({
        start: async () => ({
          userCode: "REALTIME",
          deviceCode: "realtime-device-code",
          verificationURL: `${config.origin}/device`,
          interval: 1,
          expiresIn: 600,
        }),
        poll: async () => pollAnswer,
      }),
      openApproval: async () => true,
      makePreferences: () => new PreferenceStore(prefsPath),
      pickDirectory: async () => config.destinationDir,
      loginItem: {
        read: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }),
        write: () => {},
        reportFailure: () => {},
      },
      startInbox: false,
      // On win32 this is the REAL destination — the real lease, the real
      // `winpath` refusals and the real native helper — reached through a
      // factory that only WRITES DOWN how each open ended (see
      // `observingWindowsDestination`); the class, its arguments and its
      // results are the production ones. Anywhere else the product cannot
      // answer at all, so a portable provider stands in and every observation
      // is labelled `hostProvider`.
      ...(process.platform === "win32"
        ? (assertDelegationShape() ? { makeDestination: observingWindowsDestination } : {})
        : { makeDestination: hostDestination }),
    },
  });

  say("bootstrap returned");
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    observed.errors.push("bootstrap produced no window");
    finish(1);
    return;
  }
  await drive(win);
  observed.destinationEntries = listDestination(config.destinationDir);
  finish(observed.errors.length === 0 ? 0 : 1);
}

/**
 * The REAL Windows destination, with its outcome written down.
 *
 * ## Why an observer exists at all
 *
 * The check this fixture owes on win32 is that a Windows-illegal name is
 * refused FOR THAT REASON. The rendered panel cannot support that claim:
 * `LinkPane.svelte:115-121` maps `unsupported`, `permission`, `conflict`,
 * `timeout`, `internal` and `helper-unavailable` to their own sentences and
 * EVERYTHING ELSE — including a refused manifest — to the one generic
 * `recvFailedPrefix` string. So "a terminal `recv-failed` with some non-empty
 * text" is equally satisfied by a helper that timed out, a folder that denied
 * permission, or a lease that failed for a reason nobody has named. It is not
 * evidence of a path refusal and this fixture will not present it as such.
 *
 * The typed cause is real, and it exists exactly one layer down. `NUL.txt` is
 * the NUL device, the helper refuses the manifest with its own stable
 * `E_MANIFEST` (`native/internal/wire/code.go:22`), and
 * `NativeHelperClient.request` turns that into a `NativeHelperError` carrying
 * `helperCode: "E_MANIFEST"` (`native-helper-client.ts:1562-1570`). That error
 * is what `openDestination` raises, and it is thrown straight through
 * `ReceiveCoordinator.open` — where `RoomController.#pickSaveTarget` rethrows
 * anything that is not a `ReceiveCancelledError` WITHOUT recording a receipt
 * (`room-controller.svelte.ts:648-660`). The typed cause is therefore destroyed
 * before it can reach any surface the page could be asked about.
 *
 * ## What this does and does not change
 *
 * `makeDestination` is the existing, reviewed `HandlerComposition` seam
 * (`handlers.ts:65-160`) that this file already uses off win32. Here it is
 * given a factory that calls `NativeHelperDestination.open` with EXACTLY the
 * arguments `AppService.openDestination` passes on win32
 * (`app-service.ts:1499-1510`) — the same class, the same mapping, the same
 * order — records what happened, and returns or rethrows the original value
 * unchanged. No behaviour is substituted, nothing is caught that would
 * otherwise propagate, and no product file is touched.
 *
 * The duplication of that one call shape is the cost of observing it from
 * outside. `assertDelegationShape` below fails loudly rather than silently
 * drifting if the production call ever stops matching.
 */
function observingWindowsDestination(options) {
  const entry = {
    manifest: options.manifest.map((file) => file.name),
    outcome: "opening",
    errorName: "",
    /** The client's coarse bucket, e.g. `io-failed`. */
    code: "",
    /** The helper's own stable code. THIS is the typed refusal cause. */
    helperCode: "",
    residue: null,
    message: "",
  };
  observed.destinationOpens.push(entry);
  // Exactly `app-service.ts:1504-1508`: no `id`, and the manifest reduced to
  // `{ name, size }`. Kept identical on purpose.
  return NativeHelperDestination.open({
    authorityId: options.authorityId,
    rootPath: options.rootPath,
    manifest: options.manifest.map((file) => ({ name: file.name, size: file.size })),
  }).then((destination) => {
    entry.outcome = "opened";
    return destination;
  }, (err) => {
    // "refused" only when the destination itself declined the manifest. A
    // helper that was never available, timed out, or died is a DIFFERENT
    // outcome and must not be able to satisfy a refusal assertion.
    entry.errorName = String(err?.name ?? "");
    entry.code = String(err?.code ?? "");
    entry.helperCode = String(err?.helperCode ?? "");
    entry.residue = typeof err?.residue === "boolean" ? err.residue : null;
    entry.message = String(err?.message ?? err).slice(0, 300);
    entry.outcome = entry.helperCode === "E_MANIFEST" ? "refused" : "failed";
    throw err;
  });
}

/** A guard, not a formality: this fixture reimplements one production call
 *  shape and must not keep claiming to when the class behind it has changed. */
function assertDelegationShape() {
  if (typeof NativeHelperDestination?.open !== "function") {
    observed.errors.push("the production win32 destination no longer exposes open(); "
      + "the refusal observation cannot claim to be delegating to it");
    return false;
  }
  return true;
}

/**
 * A destination for a host that is not Windows.
 *
 * Deliberately minimal and deliberately labelled: it writes the bytes under the
 * wrapper-owned folder so the transfer can complete and the lifecycle can be
 * observed on a developer's machine. It is NOT the product's destination, it
 * enforces none of `winpath`'s rules, and the orchestrator refuses to count any
 * Windows-destination assertion when `hostProvider` is true.
 */
async function hostDestination(options) {
  const root = options.rootPath;
  const names = options.manifest.map((entry) => entry.name ?? entry.path ?? "");
  const handles = new Map();
  const safe = (name) =>
    path.join(root, ...String(name).split("/").filter((part) => part && part !== ".." && part !== "."));
  return {
    fileCount: names.length,
    assertAuthority(authorityId) {
      if (authorityId !== options.authorityId) throw new Error("authority mismatch");
    },
    async begin(index) {
      const target = safe(names[index] ?? `file-${index}`);
      await mkdir(path.dirname(target), { recursive: true });
      handles.set(index, await open(target, "w"));
    },
    async write(index, chunk) {
      await handles.get(index)?.write(Buffer.from(chunk));
    },
    async finish(index) {
      await handles.get(index)?.close();
      handles.delete(index);
    },
    async publish() {
      for (const handle of handles.values()) await handle.close().catch(() => undefined);
      handles.clear();
      return { status: "complete", publishedCount: names.length, total: names.length };
    },
    async cancel() {
      for (const handle of handles.values()) await handle.close().catch(() => undefined);
      handles.clear();
    },
  };
}

const digestOf = (file) => {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
  catch (err) { return `unreadable: ${String(err)}`; }
};

/** What is actually on disk, relative to the destination root. */
function listDestination(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let info;
      try { info = statSync(full); } catch { continue; }
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (info.isDirectory()) walk(full, rel);
      // The DIGEST, not just the size: "a file of the right length" is not the
      // assertion this run owes, and the orchestrator compares bytes.
      else out.push({ path: rel, size: info.size, sha256: digestOf(full) });
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

main().catch((err) => {
  observed.errors.push(String(err?.stack ?? err));
  finish(1);
});
