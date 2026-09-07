#!/usr/bin/env node
/**
 * The BROWSER half of the Android ↔ Web interoperability acceptance.
 *
 * Driven by `scripts/android-interop-acceptance.sh`, which owns the throwaway
 * Go server, the disposable account, the pairing code, the emulator and every
 * comparison. This half owns one real Chrome on the real built bundle, joined
 * to the same code over the same real WebSocket and real WebRTC.
 *
 * ## Why it exists next to `native-pairing-browser.mjs`
 *
 * That file's peer is the macOS app. This one's peer is the Android app: a
 * SECOND independent implementation of the same wire, written against the same
 * frozen vectors but in Kotlin, with its own framing, its own nonce
 * accounting and its own flow control. The Kotlin unit suites drive that code
 * against a fake transport and cannot see a DISAGREEMENT between it and the
 * shipped bundle — which is the only class of defect this run is here for.
 *
 * Nothing is stubbed but Save-as (`SAVE_STUB`): a browser download opens an OS
 * dialog no headless run can answer. It captures the bytes the page decrypted;
 * it does not produce them.
 *
 * ## Contract with the shell half
 *
 * Everything OBSERVED is written to `--out` as JSON and the shell makes the
 * comparisons — so a mistake here surfaces as a failed comparison there rather
 * than as a pass this file granted itself. The one exception is a hard
 * precondition (no workspace, no composer): that is reported by failing.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  argFlag, argPresent, cdp, newTab, ok, resolveChrome, sleep,
  SAVE_STUB, VERIFY_DEFAULT, VERIFY_ON, setWideViewport, withWatchdog,
} from "./harness.mjs";

const ORIGIN = argFlag("--origin", "");
const CODE = argFlag("--code", "");
const MESSAGE = argFlag("--message", "");
/**
 * The outgoing BATCH, read from a descriptor FILE rather than from argv.
 *
 * A manifest with one entry never exercises the global file sequence across
 * entries, so a round sends several — including a body that crosses the
 * 192 KiB logical fragment boundary. Passing those bytes as a command-line
 * argument worked on this developer's macOS and would NOT work on the hosted
 * Linux runner: `MAX_ARG_STRLEN` caps a SINGLE argument at 128 KiB there, so a
 * ~400 KB hex string is `E2BIG` — a lane that passed locally and could never
 * pass in CI. The descriptor names each entry by `{name, size, seed}` and the
 * bytes are generated here, from the same deterministic rule the Android half
 * and the shell's comparison use.
 */
const PLAN = JSON.parse(readFileSync(argFlag("--plan", ""), "utf8"));
/** The batches this side sends, in order. The FIRST goes out as soon as the
 *  workspace is open; each later one waits for the Android half to ask for it
 *  in band (see `SEND_AGAIN`), which is what makes "a second batch on the SAME
 *  link, under a later global sequence" an observed sequence rather than a
 *  hopeful sleep. */
const BATCHES = PLAN.batches ?? [];
/** Every message this side must SEE before it finishes — including the
 *  post-cancel one, which is the only proof the conversation survived a
 *  cancelled transfer at the PEER rather than only in Android's own history. */
const EXPECT_MESSAGES = PLAN.expectMessages ?? [];
/** Names this side must NOT end up having saved: a cancelled batch's entries.
 *  Asserted here as well as in the shell, because "the file never completed"
 *  is a statement about this page's own save ledger. */
const FORBID_SAVED = PLAN.forbidSaved ?? [];

/** The same byte rule as `hex_payload` in the shell and `ByteArray(size)` in
 *  the instrumentation. One rule, three implementations that must agree — and
 *  they are compared by digest, so a drift is a failed round, not a silent
 *  pass. */
const bytesFor = ({ size, seed }) =>
  Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) & 0xff);
/** The exact names this side must end up having SAVED, in order. A cancel
 *  round names the RETRY, never the cancelled batch. */
const EXPECT_SAVED = PLAN.expectSaved ?? [];
const OUT = argFlag("--out", "");
const VERIFY = argFlag("--verify", "default");
const KEEP = argPresent("--keep");
const GLOBAL_TIMEOUT_MS = 12 * 60_000;

if (!ORIGIN || !CODE || !OUT) {
  console.error("usage: android-interop.mjs --origin URL --code CODE --out FILE [...]");
  process.exit(2);
}

const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const COMPOSER = ".msgpanel textarea";
const SEND = ".msgpanel button.send";
const ATTACH_FILE = ".msgpanel .attach-file";
const OPEN_WORKSPACE = ".open-workspace";

const observed = {
  origin: ORIGIN,
  code: CODE,
  reachedWorkspace: false,
  sas: "",
  role: "",
  selfId: "",
  peerId: "",
  verify: VERIFY,
  receivedMessages: [],
  /** One record per COMPLETED save: `{name, size, sha256}`. The shell compares
   *  every one of them. */
  receivedFiles: [],
  sentMessage: MESSAGE,
  sentBatches: [],
  expectSaved: EXPECT_SAVED,
  debugPort: 0,
  chromePid: 0,
  sentDone: false,
  peerLeft: false,
  /** Only set on a send-cancel round: the gate's observed lifecycle, so the
   *  oracle can reject a round where the hold, the peer's cancel, or the
   *  release never actually happened. */
  forbiddenGate: null,
};

/**
 * An EPHEMERAL debug port, taken from the kernel.
 *
 * A fixed `9470 + round` is wrong twice over: two runs on one machine collide,
 * and `launchBrowser` calls `cleanupStaleBrowsers` for the port it is given —
 * so a developer's own Chrome on that port would be killed by an acceptance
 * that never owned it. Binding to 0 and releasing gives a port nothing else is
 * currently using; the small race between release and Chrome's bind is
 * unavoidable with a subprocess that takes a port number, and is far narrower
 * than a hardcoded one.
 */
async function ephemeralPort() {
  const server = createServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  await new Promise((res) => server.close(res));
  return port;
}

function writeObservation() {
  writeFileSync(OUT, JSON.stringify(observed, null, 2) + "\n");
}

/**
 * A per-SAVE ledger, layered over the harness's `SAVE_STUB`.
 *
 * The stub accumulates every chunk into ONE array and overwrites `name`, so two
 * received batches are indistinguishable from one — and a round that proves "a
 * second batch on the same link arrived" cannot be built on it. This wrapper
 * records each save separately, with its own completion flag, over BOTH save
 * paths the real `filesink.ts` takes:
 *
 *   - a FLAT SINGLE-file batch → `showSaveFilePicker` (a "Save As" per file);
 *   - a MULTI-file batch → `showDirectoryPicker`, then one
 *     `getFileHandle(name).createWritable()` per file inside the chosen folder.
 *
 * Wrapping only `showSaveFilePicker` (as the first version did) made a
 * multi-ENTRY android→web batch invisible — the browser saved it through the
 * directory path this stub had thrown from, so its per-file bytes were never
 * observed and the round could not prove that batch shape. Both paths feed the
 * SAME `__androidSaves`, so the oracle compares real per-file bytes either way.
 *
 * ## The forbidden-file GATE (the deterministic send-cancel)
 *
 * A run7 send-cancel round FAILED because a ~199 KiB payload finished before
 * the Android half's poll-then-cancel reached the controller: the "cancelled"
 * batch had already completed at the browser, and the finite oracle correctly
 * caught the forbidden completion. Bumping a timeout would only paper over the
 * race. The fix is a driver-coordinated gate that makes the cancel genuinely
 * ACTIVE, using only the OS save-dialog seam this file already stubs — no Web
 * runtime change:
 *
 *   1. the payload is larger than one FLOW_WINDOW (8 MiB), so its final frames
 *      cannot be on the wire before the cancel;
 *   2. this side HOLDS the forbidden file's FIRST durable write, so it sends no
 *      ACK and the sender stalls inside the window — the batch cannot reach its
 *      DONE, let alone COMPLETE;
 *   3. this side announces the hold in band (`GATE_OBSERVED`); the Android half
 *      waits for THAT, then cancels and sends `CANCEL_REQUESTED`;
 *   4. this side RELEASES the write on `CANCEL_REQUESTED`. Now the real ordered
 *      `BATCH_ABORT` — which `queueAbort` chained on `recvChain` BEHIND the held
 *      write, so it could not run until the release — processes, retires the
 *      batch and `closeSink`s the sink.
 *
 * `mixed-file-session.svelte.ts` calls `sink.close()` even on the abort path
 * (`closeSink`, line 1387), so a CLOSED ledger record is NOT proof of a
 * successful full save: the real Web genuinely leaves a PARTIAL file on a
 * sender cancel. So this ledger records the ACTUAL partial bytes rather than
 * suppressing the close or discarding them because the plan labels the name
 * forbidden — and the oracle requires that partial to be strictly smaller than
 * the full payload (a full-size or digest match is the run7 failure, still
 * rejected). The gate's own lifecycle (held → cancel-observed → released) is
 * reported so the oracle can reject a round where the abort or the release
 * never actually happened.
 */
const SAVE_LEDGER = `
  (() => {
    window.__androidSaves = [];
    window.__forbidHold = ${JSON.stringify(FORBID_SAVED)};
    window.__releaseForbidden = false;
    window.__gate = {
      armed: ${JSON.stringify(FORBID_SAVED)}.length > 0,
      writeHeld: false, released: false,
    };
    const held = () => new Promise((resolve) => {
      window.__gate.writeHeld = true;
      const t = setInterval(() => {
        if (window.__releaseForbidden) {
          clearInterval(t);
          window.__gate.released = true;
          resolve();
        }
      }, 50);
    });
    const ledgerWritable = (record, inner) => {
      let firstForbiddenWrite = window.__forbidHold.includes(record.name);
      return {
        write: async (chunk) => {
          if (firstForbiddenWrite) {
            firstForbiddenWrite = false;
            // Hold the FIRST durable write so no ACK goes out and the sender
            // stalls inside its flow window — the batch cannot complete. After
            // the release (driven by the peer's cancel), record the ACTUAL
            // bytes that had arrived: a real partial, never suppressed.
            await held();
          }
          record.chunks.push(chunk.slice());
          return inner.write(chunk);
        },
        // close() is called by the real Web even on the abort path, so a closed
        // record can be a PARTIAL. The oracle, not this flag, decides success.
        close: async () => { record.closed = true; return inner.close(); },
      };
    };
    const newRecord = (name) => {
      const record = { name: name || "", chunks: [], closed: false };
      window.__androidSaves.push(record);
      return record;
    };

    // Flat single-file batches.
    const innerSave = window.showSaveFilePicker;
    window.showSaveFilePicker = async (opts) => {
      const handle = await innerSave(opts);
      const record = newRecord(opts && opts.suggestedName);
      return { createWritable: async () => ledgerWritable(record, await handle.createWritable()) };
    };

    // Multi-file batches: a directory handle whose per-file writables feed the
    // same ledger. Shapes exactly the calls filesink.ts's directoryTarget
    // makes — nested getDirectoryHandle, a create:false existence probe that
    // must report "absent", and getFileHandle(create:true).createWritable().
    const makeDir = () => ({
      getDirectoryHandle: async (_name, _opts) => makeDir(),
      getFileHandle: async (name, opts) => {
        if (!opts || !opts.create) {
          // The dedupe probe asks whether a name is already on disk. Nothing is.
          throw new DOMException("not found", "NotFoundError");
        }
        const record = newRecord(name);
        return { createWritable: async () => ledgerWritable(record, { write: async () => {}, close: async () => {} }) };
      },
    });
    window.showDirectoryPicker = async () => makeDir();
  })();
`;

/** Read the ledger's COMPLETED saves as `{name, size, hex}`. */
const READ_SAVES = `(() => (window.__androidSaves ?? [])
  .filter((r) => r.closed)
  .map((r) => {
    const total = r.chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of r.chunks) { out.set(new Uint8Array(c), o); o += c.byteLength; }
    return { name: r.name, size: total,
             hex: [...out].map((b) => b.toString(16).padStart(2, '0')).join('') };
  }))()`;

/** Publish the page's own peer ids without changing any behaviour, so a round
 *  can REPORT which role assignment it exercised. The clients decide the role
 *  themselves by `selfId < peerId`; nothing here influences it. */
const EXPOSE_IDS = `
  (() => {
    window.__relayiumSelfId = '';
    const seen = new WeakSet();
    const hook = (ws) => {
      if (seen.has(ws)) return;
      seen.add(ws);
      ws.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m && m.type === 'welcome' && typeof m.name === 'string') window.__relayiumSelfId = m.name;
          if (m && m.type === 'peers' && Array.isArray(m.peers)) {
            window.__relayiumPeers = m.peers.map((p) => p.id);
          }
        } catch { /* not ours */ }
      });
    };
    const Native = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new Native(...args);
      hook(ws);
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
  })();
`;

/** The in-band request for this side's next batch. The Android half sends it
 *  as an ordinary text message once it is ready for one — after a cancelled
 *  receive has been observed to leave nothing behind, for instance. Using the
 *  text lane as the barrier means the second batch is ordered AFTER a state
 *  the other endpoint actually reached. */
const SEND_AGAIN = "relayium-e2e:send-again";

/** The send-cancel gate's two in-band signals. The browser announces it is
 *  HOLDING the forbidden file's first write (so the sender's batch is stalled
 *  mid-flight and cannot complete); the Android half waits for that, cancels,
 *  and sends the release. Ordinary text messages, so they ride the same lane
 *  the round already proves works. */
const GATE_OBSERVED = "relayium-e2e:gate-held";
const CANCEL_REQUESTED = "relayium-e2e:cancel-now";

/** The TERMINAL handshake, this side's last message. Sent only once every
 *  expectation of the round — every message, every completed save, every batch
 *  of our own dispatched — has been OBSERVED on this page. The Android half
 *  keeps its Activity (and so the WebRTC session) alive until this arrives:
 *  its own "everything I meant to send entered the channel" is a local claim,
 *  and acting on it once tore the session down while this page was still
 *  receiving the second batch. After sending it, this side waits to see the
 *  peer LEAVE, so the teardown is itself sequenced rather than raced. */
const DONE = "relayium-e2e:done";

const hexToBytesJs = (hex) => `Uint8Array.from(${JSON.stringify(hex)}.match(/../g) ?? [], (h) => parseInt(h, 16))`;

/**
 * OWNED Chrome: spawned by THIS file, PID in hand from the same tick.
 *
 * The shared `launchBrowser` was measured leaking twice, in two different
 * ways, and both leaks come from ownership arriving too late:
 *
 *   * the shell used to register a SUBSHELL as the browser half, so its
 *     SIGTERM never reached this process — Node and its Chrome outlived the
 *     run with PPID 1 (the shell now `exec`s node, so the registered PID IS
 *     this process);
 *   * this file's own handlers were registered only AFTER `await
 *     launchBrowser(...)` resolved, so a termination arriving while CDP was
 *     still coming up hit Node's default action — die without unwinding —
 *     and the Chrome that had already been spawned survived it (observed
 *     once at 54 seconds).
 *
 * `launchBrowser` cannot close that second gap from outside: it exposes no
 * process until it resolves. Spawning here means the child exists the moment
 * the signal handler — registered before ANY spawn — can be asked about it,
 * so termination is handled identically before and after CDP readiness.
 * Everything killed here is `chrome.pid` and nothing else: no pkill, no
 * killing by port, no pattern.
 *
 * What is deliberately NOT reproduced from `launchBrowser`: its
 * `cleanupStaleBrowsers` sweep (this run's port is kernel-assigned and
 * carries no leftovers of a previous fixed-port run — and the sweep could
 * kill a browser this run never owned) and its rich launch diagnostics (a
 * bounded stderr tail is kept and quoted on failure).
 */
function spawnOwnedChrome(debugPort) {
  const chromeBin = resolveChrome();
  const profile = mkdtempSync(join(tmpdir(), "relayium-android-e2e-"));
  const chrome = spawn(chromeBin, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Headless has no mDNS resolver, so Chrome's default of hiding local IPs
    // behind .local candidates would leave ICE permanently failed on loopback.
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderrTail = "";
  chrome.stderr.on("data", (d) => { stderrTail = (stderrTail + String(d)).slice(-4000); });
  let exit = null;
  const died = new Promise((resolve) => {
    chrome.once("exit", (code, signal) => { exit = { code, signal }; resolve(); });
    chrome.once("error", (err) => { exit = { spawnError: String(err) }; resolve(); });
  });
  let ws = null;
  const close = async () => {
    try { ws?.close(); } catch { /* already gone */ }
    if (exit === null) {
      try { chrome.kill("SIGTERM"); } catch { /* already gone */ }
      await Promise.race([died, sleep(2_000)]);
    }
    if (exit === null) {
      try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
      await Promise.race([died, sleep(1_000)]);
    }
    await sleep(300); // let Chrome release its profile file handles
    if (!KEEP) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* a leftover temp dir is harmless */ }
    }
  };
  /** Bounded CDP readiness: poll the version endpoint, connect the browser
   *  websocket, and fail — quoting Chrome's own stderr — the moment the child
   *  is observed dead rather than waiting out the deadline against it. */
  const ready = async (deadlineMs = 45_000) => {
    const startedAt = Date.now();
    for (;;) {
      if (exit) {
        throw new Error(`Chrome exited before CDP was ready (${JSON.stringify(exit)}); `
          + `stderr tail:\n${stderrTail}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`,
                                { signal: AbortSignal.timeout(2_000) });
        const { webSocketDebuggerUrl } = await res.json();
        if (webSocketDebuggerUrl) {
          const browser = cdp(webSocketDebuggerUrl);
          await browser.open;
          ws = browser;
          console.log(`  chrome CDP ready in ${Date.now() - startedAt}ms (owned pid ${chrome.pid})`);
          return browser;
        }
      } catch { /* not listening yet; the deadline below bounds this */ }
      if (Date.now() - startedAt > deadlineMs) {
        throw new Error(`Chrome's CDP port never became ready within ${deadlineMs}ms; `
          + `stderr tail:\n${stderrTail}`);
      }
      await sleep(250);
    }
  };
  return { chrome, close, ready };
}

// **Registered before anything is spawned.** The shell's cleanup sends
// SIGTERM, and Node's default action for it is to die without unwinding — a
// `finally` cannot run then. These handlers close THIS run's browser and
// nothing else, whether the signal lands before or after CDP came up.
let owned = null;
let closing = null;
const closeOwned = () => (closing ??= (owned ? owned.close() : Promise.resolve()).catch(() => {}));
const onSignal = (signal) => {
  console.error(`  received ${signal}: closing this run's browser`);
  // Persist whatever was observed before the run was torn down — a terminated
  // run's observation is exactly what a stuck-round diagnosis needs, and the
  // finally that normally writes it does not run on a signal.
  try { writeObservation(); } catch { /* nothing more to save */ }
  closeOwned().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
};
process.once("SIGTERM", () => onSignal("SIGTERM"));
process.once("SIGINT", () => onSignal("SIGINT"));

async function run() {
  const debugPort = await ephemeralPort();
  observed.debugPort = debugPort;
  owned = spawnOwnedChrome(debugPort);
  observed.chromePid = owned.chrome.pid;
  console.error(`  owned chrome pid ${owned.chrome.pid} on debug port ${debugPort}`);
  const browser = await owned.ready();
  let tab;
  try {
    const preference = VERIFY === "on" ? VERIFY_ON : VERIFY_DEFAULT;
    tab = await newTab(browser, `${ORIGIN}/cross-network#c=${CODE}`,
                       preference + EXPOSE_IDS + SAVE_STUB + SAVE_LEDGER);
    await setWideViewport(tab, 1280, 900);

    await tab.waitFor("(window.__relayiumPeers ?? []).length >= 2",
                      "the Android peer to join the code room", 90_000);
    const ids = await tab.evaluate(`(() => {
      const peers = window.__relayiumPeers ?? [];
      const self = window.__relayiumSelfId ?? '';
      return { self, peer: peers.find((p) => p !== self) ?? '' };
    })()`);
    observed.selfId = ids.self;
    observed.peerId = ids.peer;
    observed.role = ids.self && ids.peer ? (ids.self < ids.peer ? "initiator" : "responder") : "";
    ok(`browser is ${observed.role} (self ${ids.self}, peer ${ids.peer})`);

    const opened = await tab.evaluate(`(() => {
      const b = document.querySelector('${OPEN_WORKSPACE}');
      if (!b) return false;
      b.click();
      return true;
    })()`).catch(() => false);
    if (opened) ok("browser asked to open the unified workspace");

    await tab.waitFor(`!!document.querySelector('${HEAD}')`, "the unified workspace header", 120_000);
    observed.reachedWorkspace = true;
    if (VERIFY === "on") {
      await tab.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "the verification code", 30_000);
      observed.sas = await tab.evaluate(`document.querySelector('${HEAD_SAS}').textContent.trim()`);
      const surfaces = await tab.evaluate("document.querySelectorAll('.sas').length");
      if (surfaces !== 1) throw new Error(`the page showed ${surfaces} verification surfaces, not one`);
    }
    ok(`unified workspace open${observed.sas ? `, SAS ${observed.sas}` : " (verification at its shipped default)"}`);

    // ── the browser sends its message ────────────────────────────────────
    await tab.waitFor(`!!document.querySelector('${COMPOSER}')`, "the composer", 30_000);
    const sendMessage = async (text, what) => {
      await tab.waitFor(`(() => {
        const ta = document.querySelector('${COMPOSER}');
        const send = document.querySelector('${SEND}');
        if (!ta || !send) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        if (ta.value !== ${JSON.stringify(text)} || send.disabled) {
          setter.call(ta, ${JSON.stringify(text)});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return !send.disabled;
      })()`, `the composer to retain ${what} and enable Send`, 20_000);
      await tab.evaluate(`(() => { document.querySelector('${SEND}').click(); return true; })()`);
    };
    await sendMessage(MESSAGE, "its draft");
    ok("browser sent a message");

    // ── and its batches, byte-exact ──────────────────────────────────────
    //
    // `sendBatch` is one attach; the round's plan decides how many there are.
    // Batch 0 goes now; every later one waits for the Android half to ask in
    // band, so "another batch on the SAME link" is ordered after a state the
    // other endpoint really reached rather than after a sleep.
    const sendBatch = async (batch, index) => {
      const batchJs = batch.map((f) =>
        `dt.items.add(new File([${hexToBytesJs(Buffer.from(bytesFor(f)).toString("hex"))}], `
        + `${JSON.stringify(f.name)}, { type: 'application/octet-stream' }));`).join("\n      ");
      await tab.evaluate(`(() => {
        const input = document.querySelector('${ATTACH_FILE}');
        if (!input) throw new Error('no attachment control in the unified workspace');
        if (input.disabled) throw new Error('the attachment control was disabled');
        const dt = new DataTransfer();
        ${batchJs}
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      observed.sentBatches.push(batch.map((f) => f.name));
      ok(`browser attached batch ${index}: `
         + batch.map((f) => `${f.name} (${f.size}B)`).join(", "));
    };

    if (BATCHES.length) await sendBatch(BATCHES[0], 0);

    // ── everything the far side must be seen to say and send ─────────────
    //
    // Interleaved on purpose: a later batch is gated on the in-band request,
    // and that request can arrive before or after the messages this round
    // expects. Polling both together avoids ordering either one into a
    // deadlock, and every exit from this loop is a CONDITION rather than a
    // sleep that hoped.
    let nextBatch = 1;
    // Generous, and still bounded. One round moves a >192KiB payload in each
    // direction plus two more batches, and the Android half's own waits are
    // 180s each — a browser deadline shorter than the round it is watching
    // reports "the peer never sent it" for a peer that was still sending.
    const deadline = Date.now() + 8 * 60_000;

    // **Accumulated, never snapshotted.**
    //
    // `.msg-body` elements are UNMOUNTED when the workspace switches views —
    // a file transfer taking the panel is enough — so a poll can legitimately
    // observe an empty thread moments after rendering four messages. Reading
    // the live list into `observed` each time reported `receivedMessages: []`
    // for a round in which every message had demonstrably arrived (the
    // in-band `send-again` had already released the second batch). What the
    // acceptance means by "the peer received it" is that the page rendered it
    // at some point, so that is what is recorded.
    const seen = new Set();
    let gateAnnounced = false;
    let released = false;
    for (;;) {
      for (const body of await tab.evaluate(
        `[...document.querySelectorAll('.msg-body')].map((el) => el.textContent)`)) {
        seen.add(body);
      }
      observed.receivedMessages = [...seen];

      if (nextBatch < BATCHES.length && seen.has(SEND_AGAIN)) {
        await sendBatch(BATCHES[nextBatch], nextBatch);
        nextBatch++;
        continue;
      }

      // ── the send-cancel gate ─────────────────────────────────────────────
      // Once this side is HOLDING the forbidden file's first write, announce it
      // so the Android half can cancel a batch that is genuinely stalled; and
      // when the Android half asks (CANCEL_REQUESTED), release the hold so the
      // real ordered BATCH_ABORT — queued behind that very write — can run.
      const gate = await tab.evaluate("window.__gate ?? null");
      if (gate) {
        observed.forbiddenGate = gate;
        if (gate.writeHeld && !gateAnnounced) {
          await sendMessage(GATE_OBSERVED, "the gate-held signal");
          gateAnnounced = true;
        }
        if (seen.has(CANCEL_REQUESTED) && !released) {
          await tab.evaluate("window.__gate.cancelObserved = true; window.__releaseForbidden = true");
          released = true;
        }
      }

      // Accept an inbound offer whenever one is on screen. Consent is the
      // person on screen; this round is about the bytes, not that decision.
      await tab.evaluate(`(() => {
        const card = document.querySelector('.request .btn-primary');
        if (card) { card.click(); return true; }
        return false;
      })()`).catch(() => false);

      const saves = await tab.evaluate(READ_SAVES);
      observed.receivedFiles = saves.map(({ name, size, hex }) => ({ name, size, hex }));
      // A forbidden name is EXPECTED to appear as a PARTIAL after a real
      // cancel (mixed-file-session closes the sink on abort, committing what
      // arrived), so its presence is not itself the failure — the oracle
      // requires it to be strictly smaller than the full payload and rejects a
      // full-size or digest match. It is excluded here only from the set the
      // loop waits to COMPLETE, so a partial never satisfies an expected save.
      const savedNames = saves.map((r) => r.name).filter((n) => !FORBID_SAVED.includes(n));

      const missingMessages = EXPECT_MESSAGES.filter((m) => !seen.has(m));
      const missingSaves = EXPECT_SAVED.filter((n) => !savedNames.includes(n));
      if (!missingMessages.length && !missingSaves.length && nextBatch >= BATCHES.length) break;

      if (Date.now() > deadline) {
        throw new Error(
          "timed out waiting for the Android half. "
          + `missing messages: ${JSON.stringify(missingMessages)}; `
          + `missing saves: ${JSON.stringify(missingSaves)}; `
          + `saved: ${JSON.stringify(savedNames)}; `
          + `messages seen: ${JSON.stringify([...seen])}; `
          + `batches sent: ${nextBatch}/${BATCHES.length}`);
      }
      await sleep(500);
    }
    ok(`browser saw ${observed.receivedMessages.length} message(s) and completed `
       + `${observed.receivedFiles.length} save(s)`);

    // ── the terminal handshake ───────────────────────────────────────────
    //
    // Only THIS side knows when this side has everything, so only this side
    // may release the peer. The Android half holds its Activity — and the
    // session — open until this exact message arrives; closing on its own
    // local completion once cut off the second batch mid-receive. Then the
    // roles invert for the teardown itself: this side waits to SEE the peer
    // leave (the hub's peers list shrinking, or the workspace resetting to
    // its waiting state), so "the peer got the release and acted on it" is
    // an observation, not an assumption. No sleep stands in for either edge.
    await sendMessage(DONE, "the done handshake");
    observed.sentDone = true;
    ok("browser confirmed in band that it observed everything");
    await tab.waitFor(
      `((window.__relayiumPeers ?? []).length < 2) || !document.querySelector('${HEAD}')`,
      "the Android peer to leave after the done handshake", 120_000);
    observed.peerLeft = true;
    ok("browser observed the peer leave; the teardown was sequenced, not raced");
  } finally {
    // Safety net only: the hold is normally released in-loop on the peer's
    // CANCEL_REQUESTED. If the round ended before that (an early failure), this
    // settles any still-pending forbidden write so no promise leaks; by now the
    // batch is long aborted, so it closes nothing.
    await tab?.evaluate?.("window.__releaseForbidden = true").catch(() => {});
    writeObservation();
    if (!KEEP) await closeOwned();
  }
}

withWatchdog("android ↔ web interop (browser half)", GLOBAL_TIMEOUT_MS, run).catch(async (err) => {
  writeObservation();
  console.error(`\n  \x1b[31m✗\x1b[0m ${err?.stack ?? err}`);
  // The watchdog's whole point is that `run()` may be HUNG — in which case its
  // `finally` never runs and the exit below would orphan the browser. Closing
  // here covers that path too; `closeOwned` is idempotent.
  await closeOwned();
  process.exit(1);
});
