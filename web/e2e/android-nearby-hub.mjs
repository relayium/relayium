#!/usr/bin/env node
/**
 * The BROWSER half of the Android ↔ Web **code-less room** acceptance.
 *
 * Driven by `scripts/android-nearby-web-acceptance.sh`, which owns the throwaway
 * Go server, the emulator and every comparison. This half owns one real Chrome
 * on the real built bundle, joined to the room the server keys by the address it
 * OBSERVES — the same room the Android app's "Search through relayium.com" mode
 * joins.
 *
 * ## Why three devices and not one
 *
 * The claim under test is "the user's chosen device, out of several" — and a
 * room with one candidate cannot distinguish that from "the only one", which a
 * first-in-roster fallback would also pass. So this opens THREE independent
 * devices: one target and two decoys. The decoys are not scenery: each is
 * asserted never to have been DIALLED, at the wire and in the DOM, across the
 * whole run.
 *
 * Independence is real rather than nominal. `newTab`'s `lanSeed` option
 * overrides the one storage key (`relayium.lan.seed`) the room uses to group a
 * browser's tabs into a single installation, per page, so three tabs of one
 * profile are three DEVICES to the server. Without it the room would correctly
 * collapse them to one entry and the round would be testing nothing. The device
 * NAME (`relayium_device_name`, read by `App.svelte`'s `deviceName()`) is
 * overridden the same way, because the Android half selects by name and the
 * three must be tellable apart.
 *
 * ## What is stubbed, and what is not
 *
 * Two seams, both of them OS dialogs a headless run cannot answer, both already
 * accepted elsewhere in this directory:
 *
 *   * **Save-as.** `SAVE_STUB` plus the per-save ledger below capture the bytes
 *     the page DECRYPTED. They do not produce those bytes, and nothing here
 *     injects a receipt: every digest is computed over what the page wrote.
 *   * **`webkitRelativePath`.** A folder pick is the only way a browser learns a
 *     file's relative path, and the folder picker is an OS dialog. The path is
 *     therefore defined on the File objects handed to the REAL `.attach-file`
 *     input, which `App.svelte`'s `pickFile` reads through the REAL
 *     `pickedFromInput`. The bytes, the input, the handler and the wire are all
 *     the product's own; only the value the OS would have supplied is supplied
 *     here, and the round fails closed if the property did not take.
 *
 * ## Contract with the shell half
 *
 * Everything OBSERVED is written to `--out` as JSON and the shell's oracle makes
 * the comparisons, so a mistake here surfaces as a failed comparison there
 * rather than as a pass this file granted itself. Hard preconditions — a tab
 * that never joined, a decoy that was dialled — are reported by failing.
 *
 * ## The two barriers
 *
 * The same two-phase shape `android-nearby-acceptance.sh` needed, for the same
 * two reasons, driven here through files the shell owns:
 *
 *   * `transfer` — neither side may end the session while the other is still
 *     reading its message history or its save ledger;
 *   * `room` — this side must stay IN the room while the Android half checks
 *     that its roster survived its own transfer.
 *
 * The decoy sentinels keep sampling inside both waits: a wrong dial that was
 * abandoned before the end leaves nothing for a final check to find.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runInNewContext } from "node:vm";
import {
  argFlag, argPresent, cdp, distinctLanSeed, newTab, ok, requireServer, resolveChrome,
  setWideViewport, sleep, withWatchdog, SAVE_STUB, VERIFY_ON,
} from "./harness.mjs";

const ORIGIN = argFlag("--origin", "");
const TARGET = argFlag("--target-name", "");
const DECOYS = argFlag("--decoy-names", "").split(",").filter(Boolean);
const OUT = argFlag("--out", "");
/** The name the ANDROID half is actually announcing, read from its own early
 *  identity report by the launcher. Required, and compared with `===`:
 *  `"".includes("")` is true, so a defaulted empty value made the presence check
 *  pass for a room the phone had never joined. */
const ANDROID_NAME = argFlag("--android-name", "");
/** Files the shell writes and reads. The browser is a host process, so the
 *  barrier is an ordinary file rendezvous rather than the transfer's own wire —
 *  which is the thing under test and cannot be its own completion oracle. */
const READY_FILE = argFlag("--ready-file", "");
const RELEASE_FILE = argFlag("--release-file", "");
const ROOM_READY_FILE = argFlag("--room-ready-file", "");
const ROOM_RELEASE_FILE = argFlag("--room-release-file", "");
/** The plan is READ in `main`, not at import. `--self-check` runs without one,
 *  and a module that parsed a plan at import could not be checked without
 *  inventing a plan for it. Declared HERE with the other arguments, because the
 *  validation below reads it — a `const` further down the file is in its
 *  temporal dead zone at that point and throws a ReferenceError instead of
 *  printing a usage line. */
const PLAN_PATH = argFlag("--plan", "");
let PLAN = {};
const TIMEOUT_MS = Number(argFlag("--timeout-ms", "420000"));
const BARRIER_MS = Number(argFlag("--barrier-ms", "300000"));

/**
 * `--self-check`: compose and EXERCISE every script this file injects into a
 * page, with no browser, no server and no round.
 *
 * These scripts are built by template composition and run inside a page, which
 * is the one place a mistake in them is silent: a boot script that throws
 * installs no latch, and a latch that never looked reports exactly the zeroes a
 * clean decoy does. So they are syntax-checked here, and the piece the whole
 * decoy claim rests on — the classification of an inbound signal frame as a
 * DIAL or as a benign broadcast — is actually run against both shapes. See
 * `selfCheck` at the foot of this file.
 */
const SELF_CHECK = argPresent("--self-check");

if (!SELF_CHECK) {
  if (!ORIGIN || !TARGET || !OUT || !ANDROID_NAME || !PLAN_PATH || !READY_FILE || !RELEASE_FILE
      || !ROOM_READY_FILE || !ROOM_RELEASE_FILE) {
    console.error("usage: android-nearby-hub.mjs --origin U --target-name N --android-name N "
      + "--decoy-names A,B --plan F --out F --ready-file F --release-file F "
      + "--room-ready-file F --room-release-file F [--self-check]");
    process.exit(2);
  }
  if (DECOYS.length < 2) {
    console.error("this round needs at least two decoys: one candidate cannot show that the "
      + "RIGHT one was chosen");
    process.exit(2);
  }
  if (new Set([TARGET, ...DECOYS]).size !== DECOYS.length + 1) {
    console.error("the target and the decoys must have distinct names, or the Android half "
      + "cannot say which device it selected");
    process.exit(2);
  }
}

/** The shipped selectors, the same ones `android-interop.mjs` and
 *  `mixed-link.mjs` drive. Every one of them is a class the product renders on
 *  purpose (`App.svelte`, `MessagePanel.svelte`, `ReceiveActions.svelte`). */
const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const OPEN_WORKSPACE = ".open-workspace";
const COMPOSER = ".msgpanel textarea";
const SEND = ".msgpanel button.send";
const ATTACH_FILE = ".msgpanel .attach-file";
/** The TEXT consent card. With advanced verification ON the incoming lane stops
 *  here and a person answers it — which is the prompt this round answers. */
const TEXT_REQUEST = ".msgpanel .req";
const TEXT_ACCEPT = ".msgpanel .act button.btn-primary";
/** The FILE consent card, and the memory warning that INVERTS its primary
 *  button (`ReceiveActions.svelte`: under `warnsAboutMemory` the primary action
 *  becomes Decline). Clicking a primary button blind would then decline the
 *  batch and the round would fail as a transfer failure. */
const FILE_REQUEST = ".request";
const FILE_MEMWARN = ".request .memwarn";
const FILE_ACCEPT = ".request .actions button.btn-primary";
/** The link's own TERMINAL state, as the product renders it. `WorkspaceHeader`
 *  shows `.wh-restart` exactly when `endReason !== "" || status === "failed"` —
 *  a named ending, not the ordinary `.wh-disconnect` a live session carries.
 *  `.wh-state` is that ending in words, and it is UI copy rather than content,
 *  so it is safe to record and is worth far more than "timed out". */
/**
 * The CHOOSER surface, in whichever mode the page is in.
 *
 * `App.svelte`'s `chooser` is `empty | link | radar` by `visiblePeers.length`
 * (0 / 1 / more): `empty` and `radar` render `<DeviceRadar>` (`.radar`), `link`
 * renders `<PeerLink>` (`.peerlink`). One of the three is always on a page that
 * is in the room and has no workspace, so this is the anti-vacuity signal.
 *
 * It is NOT `.open-workspace`, which is what v3 used and why v3 failed. A peer
 * CARD — and therefore that button — renders only for `selectedPeer`, and
 * `effectiveSelected` is automatic ONLY when there is exactly one visible peer.
 * With three peers in the room a page sits in `radar` mode with nothing
 * selected and renders no card at all, so a device that never passed through a
 * one-peer moment never saw the button. That is ordering-dependent, which is
 * exactly why decoy01 (open while the room held only the phone) passed and
 * decoy02 (open once the room already held two) did not.
 */
const CHOOSER = ".radar, .peerlink";
const LINK_ENDED = ".workspace-head .wh-restart";
const LINK_STATE = ".workspace-head .wh-state";

/** The same byte rule as `digest_of` in the shell and `generatePayload` in the
 *  instrumentation. One rule, three implementations, compared by digest — so a
 *  drift is a failed round rather than a silent pass. */
const bytesFor = ({ size, seed }) =>
  Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);
const hexToBytesJs = (hex) =>
  `Uint8Array.from(${JSON.stringify(hex)}.match(/../g) ?? [], (h) => parseInt(h, 16))`;
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const observed = {
  origin: ORIGIN,
  androidName: ANDROID_NAME,
  targetName: TARGET,
  decoyNames: DECOYS,
  joinOrder: [],
  androidListedBy: {},
  target: {},
  decoys: [],
  sent: { message: null, files: [] },
  barrier: "not reached",
  barrierRoom: "not reached",
  chromePid: 0,
  debugPort: 0,
  pass: false,
};

function writeObservation() {
  writeFileSync(OUT, JSON.stringify(observed, null, 1) + "\n");
}

/**
 * Everything this round installs into a page, before any application code runs.
 *
 * Four separate concerns, deliberately in one script because they must all be
 * present from the FIRST byte the page executes: the identity that decides which
 * device this tab is, the roster observer that answers "who is in this room",
 * the wire latch that answers "was this page ever dialled", and the DOM latch
 * that answers "did this page ever render a session" — including one that
 * appeared and vanished.
 */
const bootScript = (name) => `
  (() => {
    // The device NAME. \`lanSeedScript\` (prepended by newTab) already owns the
    // LAN SEED key; this owns the name key App.svelte's deviceName() reads.
    // Overridden rather than written, because localStorage is shared by every
    // tab of the profile and a tab that WROTE its name would be overwritten by
    // the next one.
    const KEY = "relayium_device_name";
    const NAME = ${JSON.stringify(name)};
    const proto = Storage.prototype;
    const get = proto.getItem, set = proto.setItem, del = proto.removeItem;
    const isName = (store, key) => store === localStorage && key === KEY;
    proto.getItem = function (k) { return isName(this, k) ? NAME : get.call(this, k); };
    proto.setItem = function (k, v) { if (!isName(this, k)) set.call(this, k, v); };
    proto.removeItem = function (k) { if (!isName(this, k)) del.call(this, k); };
  })();

  (() => {
    window.__selfId = "";
    window.__peers = null;
    // Inbound SIGNAL frames, classified. \`from\` is the sending peer's id
    // (protocol.ts's Envelope), so this is the only place a page can answer
    // "did THAT device try to establish something with me".
    //
    // The classification is what makes it usable. A caps hello is broadcast to
    // every peer in the room by design (peer-caps' announcer), and a rename is
    // an ordinary roster update — counting either as a dial would report every
    // decoy as dialled on every run. Everything ELSE counts as a dial, so this
    // fails CLOSED: an unrecognised establishment frame is a dial, not a shrug.
    window.__signals = { dial: {}, benign: {}, dialShapes: {} };
    const shapeOf = (data) => {
      if (!data || typeof data !== "object") return "opaque";
      return Object.keys(data).sort().join("+") || "empty";
    };
    const benign = (data) => {
      if (!data || typeof data !== "object") return false;
      const keys = Object.keys(data);
      if (keys.length !== 1) return false;
      if (keys[0] === "caps" && Array.isArray(data.caps)) return true;
      if (keys[0] === "rename" && typeof data.rename === "string") return true;
      return false;
    };
    const bump = (bag, key) => { bag[key] = (bag[key] ?? 0) + 1; };
    const seen = new WeakSet();
    const hook = (ws) => {
      if (seen.has(ws)) return;
      seen.add(ws);
      ws.addEventListener("message", (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (!m || typeof m !== "object") return;
          if (m.type === "welcome" && typeof m.name === "string") window.__selfId = m.name;
          if (m.type === "peers" && Array.isArray(m.peers)) {
            window.__peers = m.peers.map((p) => ({ id: String(p.id ?? ""), name: String(p.name ?? "") }));
          }
          if (m.type === "signal" && typeof m.from === "string" && m.from) {
            if (benign(m.data)) bump(window.__signals.benign, m.from);
            else {
              bump(window.__signals.dial, m.from);
              // The SHAPE only — the key names of the frame's own object. Never
              // an SDP, a candidate, a key or any payload value.
              const shapes = window.__signals.dialShapes;
              (shapes[m.from] ??= []).indexOf(shapeOf(m.data)) < 0
                && shapes[m.from].push(shapeOf(m.data));
            }
          }
        } catch { /* not a frame this observer reads */ }
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

  (() => {
    // The DOM latch. A card that appeared and then vanished is the same defect
    // as one that stayed — a dial that was abandoned is still a dial — so this
    // is a MutationObserver that COUNTS rather than a final querySelector.
    //
    // \`chooser\` is the anti-vacuity counter and is not optional: every other
    // number here is asserted to be ZERO on a decoy, and zero is also what a
    // latch that never ran, or whose selectors match nothing, reports. A page
    // in this room always has peer cards, so "chooser > 0 and session 0" is the
    // only way to reach a meaningful zero.
    window.__latch = {
      ticks: 0, head: 0, panel: 0, fileReq: 0, textReq: 0, chooser: 0, peerCard: 0,
    };
    const look = () => {
      const l = window.__latch;
      l.ticks++;
      if (document.querySelector(${JSON.stringify(HEAD)})) l.head++;
      if (document.querySelector(".msgpanel")) l.panel++;
      if (document.querySelector(${JSON.stringify(FILE_REQUEST)})) l.fileReq++;
      if (document.querySelector(${JSON.stringify(TEXT_REQUEST)})) l.textReq++;
      // The anti-vacuity counter: a chooser surface is on every page that is in
      // the room and has no workspace.
      if (document.querySelector(${JSON.stringify(CHOOSER)})) l.chooser++;
      // Recorded, never asserted. A decoy showing a peer card only means someone
      // selected a blip on it; it is not a dial and not a failure.
      if (document.querySelector(${JSON.stringify(OPEN_WORKSPACE)})) l.peerCard++;
    };
    window.__latchLook = look;
    const start = () => {
      new MutationObserver(look).observe(document.documentElement, { childList: true, subtree: true });
      // A poller as well as the observer: a subtree that mutates only inside a
      // text node still changes what is on screen, and 200ms is far below the
      // life of any card this round could miss.
      setInterval(look, 200);
      look();
    };
    if (document.documentElement) start();
    else document.addEventListener("readystatechange", start, { once: true });
  })();

${VERIFY_ON}
${SAVE_STUB}
${SAVE_LEDGER()}`;

/**
 * A per-SAVE ledger over the harness's `SAVE_STUB`, in the shape
 * `android-interop.mjs` proved.
 *
 * The bare stub accumulates every chunk into ONE `window.__e2e` array and
 * overwrites its `name`, so two received batches are indistinguishable from one
 * and a per-file assertion cannot be built on it — and its `showDirectoryPicker`
 * THROWS, which would make any multi-file batch fail as a save error. This
 * records each save separately over BOTH paths `filesink.ts` takes:
 *
 *   - a FLAT SINGLE-file batch → `showSaveFilePicker`;
 *   - a MULTI-file batch → `showDirectoryPicker`, then one
 *     `getFileHandle(name).createWritable()` per file inside the chosen folder,
 *     with `getDirectoryHandle` for each nested segment.
 *
 * The directory path records the nested SEGMENTS as well as the leaf, because a
 * round that asserts a nested path has to know where the file was written, not
 * only what it was called.
 */
function SAVE_LEDGER() {
  return `
  (() => {
    window.__saves = [];
    const record = (name, dirs) => {
      const r = { name: name || "", dirs: dirs.slice(), chunks: [], closed: false };
      window.__saves.push(r);
      return r;
    };
    const writable = (r, inner) => ({
      write: async (chunk) => { r.chunks.push(chunk.slice()); return inner.write(chunk); },
      close: async () => { r.closed = true; return inner.close(); },
    });

    const innerSave = window.showSaveFilePicker;
    window.showSaveFilePicker = async (opts) => {
      const handle = await innerSave(opts);
      const r = record(opts && opts.suggestedName, []);
      return { createWritable: async () => writable(r, await handle.createWritable()) };
    };

    const makeDir = (dirs) => ({
      getDirectoryHandle: async (name, _opts) => makeDir([...dirs, String(name)]),
      getFileHandle: async (name, opts) => {
        // filesink.ts probes with create:false to ask whether the name is
        // already on disk. Nothing is, and answering anything but NotFound
        // would send it down its dedupe branch.
        if (!opts || !opts.create) throw new DOMException("not found", "NotFoundError");
        const r = record(String(name), dirs);
        return {
          createWritable: async () =>
            writable(r, { write: async () => {}, close: async () => {} }),
        };
      },
    });
    window.showDirectoryPicker = async () => makeDir([]);
  })();
`;
}

/**
 * What a page's DOM actually holds right now, as COUNTS.
 *
 * For failure evidence only, and deliberately nothing but numbers: no text, no
 * names, no message bodies. "The latch saw nothing" and "the page is in a state
 * this round did not anticipate" are different diagnoses, and without this they
 * look identical.
 */
const DOM_CENSUS = `(() => Object.fromEntries([
  ['radar', '.radar'], ['peerlink', '.peerlink'], ['peer', '.peer'],
  ['openWorkspace', '${OPEN_WORKSPACE}'], ['workspaceHead', '${HEAD}'],
  ['msgpanel', '.msgpanel'], ['fileRequest', '${FILE_REQUEST}'],
  ['textRequest', '${TEXT_REQUEST}'], ['unsupported', '.pa-unsupported'],
].map(([name, sel]) => [name, document.querySelectorAll(sel).length])))()`;

/** Every COMPLETED save, with its bytes digested IN the page. */
const READ_SAVES = `(async () => {
  const out = [];
  for (const r of (window.__saves ?? [])) {
    if (!r.closed) continue;
    const blob = new Blob(r.chunks);
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    out.push({
      name: r.name,
      dirs: r.dirs,
      size: buf.byteLength,
      sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    });
  }
  return out;
})()`;

/**
 * The messages this page RECEIVED, never the ones it sent.
 *
 * `MessagePanel.svelte` renders both directions as `.msg-body` and distinguishes
 * them with `class:out` on the `<li>`. Reading every `.msg-body` — which the
 * older interop round does, because everything it waits for happens to be
 * inbound — would let this side's own echo satisfy an assertion about what
 * arrived, which is the one thing a text lane must not be able to fake.
 *
 * ACCUMULATED, never snapshotted: `.msg-body` nodes are UNMOUNTED when the
 * workspace switches views (a file transfer taking the panel is enough), so a
 * single read can legitimately see an empty thread moments after rendering.
 */
const READ_INBOUND = `[...document.querySelectorAll('.msg:not(.out) .msg-body')]
  .map((el) => el.textContent)`;

/**
 * OWNED Chrome: spawned here, PID in hand from the same tick.
 *
 * Not `launchBrowser`: it runs `cleanupStaleBrowsers` for the port it is given,
 * which can kill a browser this run never owned, and it exposes no process until
 * it resolves — so a SIGTERM arriving while CDP is still coming up would hit
 * Node's default action and orphan the Chrome it had already spawned. Same
 * reasoning, and the same shape, as `android-interop.mjs`.
 */
function spawnOwnedChrome(debugPort) {
  const chromeBin = resolveChrome();
  const profile = mkdtempSync(join(tmpdir(), "relayium-nearby-web-"));
  const chrome = spawn(chromeBin, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Headless has no mDNS resolver, so Chrome's default of hiding local IPs
    // behind .local candidates would leave ICE permanently failed on loopback.
    "--disable-features=WebRtcHideLocalIpsWithMdns",
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
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* a leftover temp dir is harmless */ }
  };
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

/** A port the kernel is not currently using. A fixed one collides between two
 *  runs on one machine and invites a cleanup that kills a stranger's browser. */
async function ephemeralPort() {
  const server = createServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  await new Promise((res) => server.close(res));
  return port;
}

// **Registered before anything is spawned.** The shell's cleanup sends SIGTERM,
// and Node's default action for it is to die without unwinding — a `finally`
// cannot run then. These handlers close THIS run's browser and nothing else,
// whether the signal lands before or after CDP came up.
let owned = null;
let closing = null;
const closeOwned = () => (closing ??= (owned ? owned.close() : Promise.resolve()).catch(() => {}));
const onSignal = (signal) => {
  console.error(`  received ${signal}: closing this run's browser`);
  try { writeObservation(); } catch { /* nothing more to save */ }
  closeOwned().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
};
process.once("SIGTERM", () => onSignal("SIGTERM"));
process.once("SIGINT", () => onSignal("SIGINT"));

/**
 * A decoy's observation, LATCHED for the whole run rather than sampled at the
 * end.
 *
 * Two independent sources, because either alone has a hole. The WIRE says
 * whether the Android half ever sent this page an establishment frame — the
 * thing a wrong selection actually does — and it survives a session that was
 * abandoned before anything rendered. The DOM says whether a person at this
 * device would have SEEN a session, which is the user-visible half of the same
 * claim and is what catches a product that renders a consent card for a peer it
 * never negotiated with.
 */
class DecoySentinel {
  constructor(device) {
    this.device = device;
    this.dialFrames = 0;
    this.dialShapes = [];
    this.latch = null;
  }

  async poll() {
    const state = await this.device.tab.evaluate(`(() => {
      window.__latchLook?.();
      const androidId = (window.__peers ?? []).find(
        (p) => p.name === ${JSON.stringify(ANDROID_NAME)})?.id ?? "";
      const s = window.__signals ?? { dial: {}, dialShapes: {} };
      return {
        latch: window.__latch,
        census: ${DOM_CENSUS},
        androidId,
        dial: androidId ? (s.dial[androidId] ?? 0) : 0,
        shapes: androidId ? (s.dialShapes[androidId] ?? []) : [],
      };
    })()`);
    this.latch = state.latch;
    this.census = state.census;
    this.androidId = state.androidId;
    this.dialFrames = Math.max(this.dialFrames, state.dial);
    for (const shape of state.shapes ?? []) {
      if (!this.dialShapes.includes(shape)) this.dialShapes.push(shape);
    }
  }

  /** What the launcher's oracle judges. `latch.ticks`/`latch.chooser` travel
   *  with it so a zero can be told apart from a latch that never looked. */
  snapshot() {
    return {
      name: this.device.name,
      dialFrames: this.dialFrames,
      dialShapes: this.dialShapes,
      everHead: (this.latch?.head ?? 0) > 0,
      everPanel: (this.latch?.panel ?? 0) > 0,
      everFileRequest: (this.latch?.fileReq ?? 0) > 0,
      everTextRequest: (this.latch?.textReq ?? 0) > 0,
      latchTicks: this.latch?.ticks ?? 0,
      latchChooser: this.latch?.chooser ?? 0,
      // Recorded, never asserted: a peer card on a decoy only means a blip was
      // selected there. It is not a dial.
      latchPeerCard: this.latch?.peerCard ?? 0,
      census: this.census ?? null,
    };
  }
}

async function openDevice(browser, name) {
  const tab = await newTab(browser, `${ORIGIN}/`, bootScript(name), { lanSeed: distinctLanSeed() });
  await setWideViewport(tab);
  // `welcome` has landed AND a roster has been broadcast. Until then the page
  // cannot exclude itself and lists nobody, which is correct and is not a state
  // this round can act on.
  await tab.waitFor("!!window.__selfId && Array.isArray(window.__peers)",
                    `${name} to join the code-less room`, 90_000);
  const selfId = await tab.evaluate("window.__selfId");
  ok(`${name} joined the code-less room as ${selfId.slice(0, 6)}…`);
  return { name, tab, selfId };
}

/** Sample every decoy once and publish the result, so the observation on disk is
 *  current even for a round that never reaches its end. */
async function sampleDecoys(sentinels) {
  for (const sentinel of sentinels) await sentinel.poll();
  observed.decoys = sentinels.map((sentinel) => sentinel.snapshot());
}

/**
 * Wait for a page condition while sampling the decoys.
 *
 * `tab.waitFor` is the ordinary tool and it is the WRONG one for the long waits
 * here. In the case this round exists to detect — the phone dialling a decoy —
 * the target never gets a workspace, so a plain `waitFor` blocks for the whole
 * timeout and the observation written afterwards reports `decoys: []`: the very
 * evidence of the wrong dial, missing from the run that produced it. Sequential
 * on purpose (one CDP conversation at a time), and every exit is a condition.
 */
async function awaitWithSentinels(tab, expression, what, timeoutMs, sentinels) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tab.evaluate(expression)) return;
    await sampleDecoys(sentinels);
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(500);
  }
}

/** Wait for a file the shell writes, sampling the decoys while waiting: a wrong
 *  dial during a barrier is still a wrong dial. */
async function waitForFile(path, what, sentinels) {
  const deadline = Date.now() + BARRIER_MS;
  for (;;) {
    if (existsSync(path)) return;
    await sampleDecoys(sentinels);
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${BARRIER_MS}ms waiting for ${what} (${path})`);
    }
    await sleep(500);
  }
}

async function main() {
  PLAN = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  await requireServer(ORIGIN, "this run's throwaway server serving the built bundle");
  const debugPort = await ephemeralPort();
  observed.debugPort = debugPort;
  owned = spawnOwnedChrome(debugPort);
  observed.chromePid = owned.chrome.pid;
  console.error(`  owned chrome pid ${owned.chrome.pid} on debug port ${debugPort}`);
  const browser = await owned.ready();

  try {
    // DECOYS FIRST, target LAST, and the ordering is load-bearing.
    //
    // The Android list is SORTED by name (`nearbyDevices` in
    // `NearbyDevices.kt`), so the launcher's names already put the target last
    // in the order the phone DISPLAYS. Joining it last makes it last in ARRIVAL
    // order too, so neither a first-in-roster fallback nor a first-rendered one
    // can reach the target by accident. Both orders are reported and the oracle
    // checks them; this comment is not the evidence.
    const devices = [];
    for (const name of [...DECOYS, TARGET]) devices.push(await openDevice(browser, name));
    const target = devices[devices.length - 1];
    const decoys = devices.slice(0, -1);
    const sentinels = decoys.map((d) => new DecoySentinel(d));
    observed.joinOrder = devices.map((d) => d.name);
    observed.target.name = TARGET;
    observed.target.selfId = target.selfId;
    observed.decoyIds = Object.fromEntries(decoys.map((d) => [d.name, d.selfId]));
    if (new Set(devices.map((d) => d.selfId)).size !== devices.length) {
      throw new Error("the server gave two of these tabs the same peer id; they were not three "
        + "independent devices and no roster claim below would mean anything");
    }

    // Every device must SEE the Android phone by its EXACT announced name, or
    // "it chose the right one out of several" is a claim about a room the
    // candidates were not all in.
    for (const device of devices) {
      await awaitWithSentinels(
        device.tab,
        `(window.__peers ?? []).some(p => p.name === ${JSON.stringify(ANDROID_NAME)})`,
        `${device.name} to list the Android device by its exact name`, 180_000, sentinels);
      observed.androidListedBy[device.name] = await device.tab.evaluate(
        `(window.__peers ?? []).find(p => p.name === ${JSON.stringify(ANDROID_NAME)}).id`);
    }
    const androidIds = new Set(Object.values(observed.androidListedBy));
    if (androidIds.size !== 1) {
      throw new Error("the three browser devices listed DIFFERENT ids for the Android name "
        + `${JSON.stringify([...androidIds])}; more than one device is answering to it and this `
        + "round cannot say which one was chosen");
    }
    observed.androidId = [...androidIds][0];
    ok(`all ${devices.length} browser devices list the Android phone as ${observed.androidId.slice(0, 6)}…`);

    // ── every observer proved LIVE, before the transfer begins ──────────
    //
    // The anti-vacuity check used to happen at the END, and v3 showed why that
    // is the wrong place: a page can go the whole run without ever rendering the
    // control the check looks for, and the round then fails at the finish line
    // having proved everything else. Worse, it fails ORDER-DEPENDENTLY.
    //
    // Asserted here instead, as a PRECONDITION, and it must be here rather than
    // later for a product reason: the roster section is `{#if !mixed && …}`, so
    // the chooser is gone once a workspace exists. This is the last moment at
    // which every page in this round still has one.
    for (const device of devices) {
      const deadline = Date.now() + 60_000;
      let ready;
      for (;;) {
        const seen = await device.tab.evaluate(`(() => {
          window.__latchLook?.();
          return { latch: window.__latch, census: ${DOM_CENSUS} };
        })()`);
        if ((seen.latch?.ticks ?? 0) > 0 && (seen.latch?.chooser ?? 0) > 0) { ready = seen; break; }
        if (Date.now() > deadline) { ready = { failed: true, ...seen }; break; }
        await sleep(250);
      }
      if (ready.failed) {
        throw new Error(`${device.name}'s observer is not live: its latch has run `
          + `${ready.latch?.ticks ?? 0} time(s) and has never seen a chooser surface. `
          + "Every zero it reports would be meaningless. DOM census: "
          + `${JSON.stringify(ready.census)}`);
      }
      observed.readiness ??= {};
      observed.readiness[device.name] = { ticks: ready.latch.ticks, chooser: ready.latch.chooser };
    }
    ok("all three observers are live: each has rendered a chooser surface");

    // Nothing here dials. The whole point is that the ANDROID side selects and
    // this side only answers, so `.open-workspace` — the OUTBOUND action on a
    // peer card — is never clicked by any of these three pages.
    await awaitWithSentinels(
      target.tab, `!!document.querySelector('${HEAD}')`,
      "the target to be given a workspace by the phone", TIMEOUT_MS, sentinels);
    ok("the target has a live link, opened by the phone");

    // The SAS, from the ONE surface the product renders it on. Verification is
    // ON for every tab in this run (VERIFY_ON), so a session that reached the
    // workspace without a code is a handshake that did not complete.
    await awaitWithSentinels(
      target.tab, `!!document.querySelector('${HEAD_SAS}')`,
      "the verification code on the target", 60_000, sentinels);
    observed.target.sas = await target.tab.evaluate(
      `document.querySelector('${HEAD_SAS}').textContent.trim()`);
    const surfaces = await target.tab.evaluate("document.querySelectorAll('.sas').length");
    if (surfaces !== 1) {
      throw new Error(`the target showed ${surfaces} verification surfaces, not one`);
    }
    ok(`target SAS ${observed.target.sas}`);

    /**
     * ONE attempt to put this side's message into the channel. Never a wait.
     *
     * The v1 owning run failed here, and the reason is a fact about the product
     * this harness had wrong. `MessagePanel.svelte` renders the composer when
     * `composing` is true, and in the unified workspace that is
     * `open || connecting || waitingAccept` — deliberately, so a draft does not
     * vanish while the session is still coming up. Sending is governed by
     * something stricter: `canSend` is `status === "open" && !overLimit &&
     * draft !== ""`.
     *
     * So "the textarea exists" is NOT "the conversation is open", and the
     * previous version treated it as the trigger for a 60-SECOND BLOCKING WAIT
     * on Send becoming enabled. For those 60 seconds this half answered no
     * consent card, accepted no batch and polled no decoy — then gave up, closed
     * Chrome, and the phone reported `error_connection_lost`. Whatever the lane
     * was waiting for, a harness that stops observing cannot say.
     *
     * Hence: one `evaluate`, one answer, and the outer loop decides what to do
     * next. Every state the composer can be in is a RETURN VALUE, so a round
     * that never sends names the state it was stuck in.
     */
    const trySendMessage = async (text) => target.tab.evaluate(`(() => {
      const ta = document.querySelector('${COMPOSER}');
      const send = document.querySelector('${SEND}');
      if (!ta || !send) return 'no-composer';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      if (ta.value !== ${JSON.stringify(text)}) {
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // The draft is set above, so a disabled Send here means the LANE is not
      // open yet — not that the text was rejected.
      if (send.disabled) return 'send-disabled';
      send.click();
      return 'sent';
    })()`);

    const sendBatch = async (batch, index) => {
      const entries = batch.map((f) =>
        `{ name: ${JSON.stringify(f.name)}, path: ${JSON.stringify(f.path ?? "")},`
        + ` bytes: ${hexToBytesJs(toHex(bytesFor(f)))} }`).join(",\n          ");
      // RETRYABLE, not fatal. The attachment control is unmounted while the
      // panel is showing a consent card and disabled until the link can carry a
      // batch; both are ordinary transient states, and throwing on either would
      // end a round for a condition that resolves on the next tick. The outer
      // deadline fails a round that never becomes ready, and it names the last
      // state seen.
      const paths = await target.tab.evaluate(`(() => {
        const input = document.querySelector('${ATTACH_FILE}');
        if (!input) return 'no-attach-control';
        if (input.disabled) return 'attach-disabled';
        const spec = [
          ${entries}
        ];
        const dt = new DataTransfer();
        for (const s of spec) {
          dt.items.add(new File([s.bytes], s.name, { type: 'application/octet-stream' }));
        }
        input.files = dt.files;
        for (let i = 0; i < spec.length; i++) {
          if (!spec[i].path) continue;
          Object.defineProperty(input.files[i], 'webkitRelativePath',
            { value: spec[i].path, configurable: true });
        }
        const got = [...input.files].map((f) => f.webkitRelativePath ?? '');
        for (let i = 0; i < spec.length; i++) {
          if (got[i] !== spec[i].path) {
            throw new Error('the relative path did not take on ' + spec[i].name
              + ' (got ' + JSON.stringify(got[i]) + '); this batch would have been sent flat');
          }
        }
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return got;
      })()`);
      if (typeof paths === "string") return paths;
      observed.sent.files.push(...batch.map((f, i) => ({
        name: f.name, path: paths[i], size: f.size, seed: f.seed,
      })));
      ok(`browser attached batch ${index}: `
         + batch.map((f) => `${f.path || f.name} (${f.size}B)`).join(", "));
      return "sent";
    };

    // ── the round's own loop ─────────────────────────────────────────────
    //
    // Every exit is a CONDITION. Consent, sending and receiving are polled
    // together rather than ordered, because the phone's batch can legitimately
    // arrive before or after this side's own message is answered, and forcing an
    // order here would deadlock on an interleaving that is perfectly legal.
    const expectMessage = PLAN.expectMessage ?? "";
    const expectSaved = PLAN.expectSaved ?? [];
    const inbound = new Set();
    const deadline = Date.now() + TIMEOUT_MS;
    let textAccepted = false;
    let textConsentClicks = 0;
    /** The last answer each non-blocking attempt gave, so a timeout names the
     *  state this half was actually stuck in rather than only what was missing. */
    let composerState = "not attempted";
    let attachState = "not attempted";
    /** Consecutive ticks on which the link looked terminal. Sticky, because a
     *  single sample can catch the workspace mid-remount. */
    let terminalTicks = 0;
    let messageSent = false;
    let batchesSent = 0;
    let acceptedFileRequests = 0;
    let saves = [];

    for (;;) {
      for (const body of await target.tab.evaluate(READ_INBOUND)) inbound.add(body);
      observed.target.receivedMessages = [...inbound];
      await sampleDecoys(sentinels);

      // ── the TEXT consent, answered through the product's own control ───
      // With verification ON the incoming conversation stops here and a person
      // answers it. `.act button.btn-primary` is Accept and `.act .btn-ghost` is
      // Reject (MessagePanel.svelte), so this is the affirmative answer and not
      // "whichever button came first".
      //
      // Attempted EVERY tick while the card is on screen, not latched after one
      // click. A latch assumes the first click landed on a card that was fully
      // mounted, and the state that matters is not "we clicked once" but "the
      // lane is open" — which the composer's own enabled Send is the proof of.
      // Bounded so a card that never goes away cannot become an infinite click.
      if (textConsentClicks < 20) {
        const clicked = await target.tab.evaluate(`(() => {
          if (!document.querySelector('${TEXT_REQUEST}')) return false;
          const accept = document.querySelector('${TEXT_ACCEPT}');
          if (!accept) return false;
          accept.click();
          return true;
        })()`);
        if (clicked) {
          textConsentClicks++;
          textAccepted = true;
          ok(`target accepted the conversation through its consent card (${textConsentClicks})`);
        }
      }

      // ── the FILE consent, with the memory-warning branch refused ────────
      // Under `warnsAboutMemory` the card's PRIMARY button is Decline, so a
      // blind primary click would decline the batch and the round would fail as
      // a transfer failure with no sign of why. This round's payloads are far
      // below that threshold, so the warning appearing at all is a state this
      // round cannot interpret — it fails closed rather than guessing.
      const consent = await target.tab.evaluate(`(() => {
        if (!document.querySelector('${FILE_REQUEST}')) return 'none';
        if (document.querySelector('${FILE_MEMWARN}')) return 'memwarn';
        const accept = document.querySelector('${FILE_ACCEPT}');
        if (!accept) return 'none';
        accept.click();
        return 'accepted';
      })()`);
      if (consent === "memwarn") {
        throw new Error("the incoming batch raised the large-batch memory warning, which "
          + "INVERTS the card's primary button; this round's payloads are far below that "
          + "threshold, so the round cannot interpret the state it is in");
      }
      if (consent === "accepted") {
        acceptedFileRequests++;
        ok(`target accepted an incoming batch through its consent card (${acceptedFileRequests})`);
      }

      // This side's own message: ONE non-blocking attempt per tick.
      //
      // The gate is the attempt's own answer, not a precondition read
      // separately. `send-disabled` means the lane is not open yet, and the next
      // tick — which will also answer any consent card that appeared meanwhile —
      // simply tries again. Nothing here waits.
      if (!messageSent && PLAN.message) {
        composerState = await trySendMessage(PLAN.message);
        if (composerState === "sent") {
          observed.sent.message = PLAN.message;
          messageSent = true;
          ok("browser sent its message");
        }
      }

      // This side's own batch, once the phone has confirmed it is ready for one
      // IN BAND. Sequenced rather than sampled: an unsequenced pair picks one
      // arbitrary interleaving and reports it as though both directions had been
      // covered, and with a real DocumentsUI on the other end it is also the
      // difference between a deterministic run and one where a consent card
      // repaints the screen while the picker is being driven.
      if (batchesSent < (PLAN.batches ?? []).length && messageSent
          && (!PLAN.readyMessage || inbound.has(PLAN.readyMessage))) {
        attachState = await sendBatch(PLAN.batches[batchesSent], batchesSent);
        if (attachState === "sent") {
          batchesSent++;
          continue;
        }
        // Not ready yet — fall through and try again on the next tick rather
        // than spinning here with everything else unobserved.
      }

      // ── an authentic terminal link, reported as itself ─────────────────
      //
      // Waiting out the full timeout for a link the product has already declared
      // over reports "the phone never sent it" for a session that ended minutes
      // earlier. This adds a FAILURE path and touches no success condition: the
      // round still breaks only on the same complete set of observations.
      //
      // Sticky across ticks rather than acted on the first sight of it. The
      // workspace head unmounts and remounts as the panel switches views, and a
      // single sample that caught it mid-swap would end a healthy round.
      const linkState = await target.tab.evaluate(`(() => {
        if (document.querySelector('${LINK_ENDED}')) {
          return { over: true, why: 'the product declared this link ended',
                   state: (document.querySelector('${LINK_STATE}')?.textContent ?? '').trim() };
        }
        if (!document.querySelector('${HEAD}')) {
          return { over: true, why: 'the workspace is gone', state: '' };
        }
        return { over: false, why: '', state: '' };
      })()`);
      terminalTicks = linkState.over ? terminalTicks + 1 : 0;
      if (terminalTicks === 1 && linkState.over) observed.target.terminal = linkState;
      if (terminalTicks >= 6) {
        throw new Error(`the link is over and this round cannot finish: ${linkState.why}`
          + `${linkState.state ? ` (${linkState.state})` : ""}. Observed for ${terminalTicks} `
          + `consecutive ticks. text=${inbound.has(expectMessage)} `
          + `composer=${composerState} attach=${attachState} `
          + `textConsentClicks=${textConsentClicks} fileConsents=${acceptedFileRequests}`);
      }

      saves = await target.tab.evaluate(READ_SAVES);
      observed.target.receivedFiles = saves;

      const savedNames = saves.map((r) => r.name);
      const missingSaves = expectSaved.filter((f) => !savedNames.includes(f.name));
      const haveText = !expectMessage || inbound.has(expectMessage);
      if (haveText && !missingSaves.length && batchesSent >= (PLAN.batches ?? []).length
          && (!PLAN.message || messageSent)) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("the browser half never observed everything this round expects: "
          + `text=${haveText} missingSaves=${JSON.stringify(missingSaves.map((f) => f.name))} `
          + `saved=${JSON.stringify(savedNames)} batchesSent=${batchesSent}/`
          + `${(PLAN.batches ?? []).length} textConsentClicks=${textConsentClicks} `
          + `composer=${composerState} attach=${attachState} `
          + `fileConsents=${acceptedFileRequests} inbound=${inbound.size}`);
      }
      await sleep(500);
    }
    observed.target.acceptedTextRequest = textAccepted;
    observed.target.textConsentClicks = textConsentClicks;
    observed.target.acceptedFileRequests = acceptedFileRequests;
    ok(`browser observed ${inbound.size} inbound message(s) and ${saves.length} completed save(s)`);

    // ── barrier 1: neither side ends the session the other is reading ────
    await sampleDecoys(sentinels);
    observed.barrier = "waiting";
    writeObservation();
    writeFileSync(READY_FILE, "ready\n");
    await waitForFile(RELEASE_FILE, "the launcher to release the transfer barrier", sentinels);
    observed.barrier = "released";
    ok("transfer barrier released: both halves had finished asserting");

    // ── barrier 2: this side stays IN the room ───────────────────────────
    //
    // The Android half now disconnects and checks that its roster survived its
    // own transfer. Closing these tabs — or even letting the run end — would
    // withdraw three devices from the room while it looks, and its list would
    // correctly be empty. Nothing is asserted here; STAYING is the contribution.
    observed.barrierRoom = "waiting";
    writeObservation();
    writeFileSync(ROOM_READY_FILE, "ready\n");
    await waitForFile(ROOM_RELEASE_FILE, "the launcher to release the room barrier", sentinels);
    observed.barrierRoom = "released";
    ok("room barrier released: the phone checked its roster while these devices were still in it");

    // ── the assertion the decoys exist for ───────────────────────────────
    await sampleDecoys(sentinels);
    for (const decoy of observed.decoys) {
      // Anti-vacuity first: a latch that never looked, or one whose selectors
      // match nothing, reports the same zeroes a clean decoy does.
      // The SAME positive requirement as the precondition, re-checked over the
      // whole interval. No waiver: a decoy that stopped observing part-way
      // through is a decoy whose zeroes stop meaning anything from that point.
      if (decoy.latchTicks < 1 || decoy.latchChooser < 1) {
        throw new Error(`the decoy ${decoy.name} never observed a live DOM with working `
          + `selectors (ticks=${decoy.latchTicks} chooser=${decoy.latchChooser}), so its `
          + `zeroes mean nothing. DOM census: ${JSON.stringify(decoy.census)}`);
      }
      if (decoy.dialFrames > 0 || decoy.everHead || decoy.everPanel
          || decoy.everFileRequest || decoy.everTextRequest) {
        throw new Error(`the decoy ${decoy.name} was dialled or rendered a session at some `
          + `point (${JSON.stringify(decoy)}); the Android half did not choose only the device `
          + "it was told to");
      }
    }
    ok("neither decoy was ever dialled, on the wire or on screen");

    observed.pass = true;
    return 0;
  } finally {
    writeObservation();
    await closeOwned();
  }
}

/**
 * Every injected script, composed exactly as a round composes it, then run.
 *
 * The sandbox is deliberately thin — enough `window`, `document`, `Storage` and
 * `WebSocket` for the boot script to install itself, and nothing that would
 * answer an assertion on its behalf. What it proves is narrow, and it is the
 * narrow thing that fails SILENTLY in a page: that these strings parse, that the
 * device-name override takes, that the roster observer reads a `welcome` and a
 * `peers` frame, that the DOM latch counts, and — the assertion the whole decoy
 * claim rests on — that a caps or rename broadcast is NOT counted as a dial
 * while an offer, and anything unrecognised, IS.
 */
function selfCheck() {
  const problems = [];
  const parses = (label, source) => {
    try {
      new Function(source);
    } catch (error) {
      problems.push(`${label} is not valid JavaScript: ${error?.message ?? error}`);
    }
  };

  const boot = bootScript("relayium-web-target-zz");
  parses("the boot script", boot);
  parses("the save ledger", SAVE_LEDGER());
  parses("the completed-saves reader", `return ${READ_SAVES}`);
  parses("the inbound-message reader", `return ${READ_INBOUND}`);
  // The ledger must be layered OVER the harness's stub, never instead of it: it
  // wraps `window.showSaveFilePicker`, so a boot order that installed it first
  // would wrap nothing and the flat-file save path would go unobserved.
  if (boot.indexOf(SAVE_STUB) < 0 || boot.indexOf(SAVE_STUB) > boot.indexOf("window.__saves")) {
    problems.push("the save ledger is not layered over the harness's SAVE_STUB");
  }
  if (!boot.includes(VERIFY_ON)) {
    problems.push("the boot script does not turn advanced verification on, so the round would "
      + "assert a SAS the shipped default never shows");
  }

  if (!problems.length) {
    const listeners = [];
    class FakeStorage {
      constructor() { this.map = new Map(); }
      getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
      setItem(k, v) { this.map.set(k, String(v)); }
      removeItem(k) { this.map.delete(k); }
    }
    const storage = new FakeStorage();
    let nodes = [];
    const sandbox = {
      Storage: FakeStorage,
      localStorage: storage,
      DOMException: class extends Error {},
      Blob: class {},
      crypto: { subtle: {} },
      setInterval: () => 0,
      MutationObserver: class { observe() {} },
      document: {
        documentElement: {},
        addEventListener: () => {},
        querySelector: (sel) => (nodes.includes(sel) ? {} : null),
        querySelectorAll: () => [],
      },
      WebSocket: class {
        constructor() { this.handlers = []; }
        addEventListener(_type, fn) { this.handlers.push(fn); listeners.push(fn); }
      },
    };
    sandbox.window = sandbox;
    try {
      runInNewContext(boot, sandbox);
      // The name override: the page must report the name this round gave it, and
      // the application must not be able to overwrite it — three tabs share one
      // profile, so a tab that WROTE its name would be overwritten by the next.
      new sandbox.WebSocket();
      storage.setItem("relayium_device_name", "something-else");
      if (storage.getItem("relayium_device_name") !== "relayium-web-target-zz") {
        problems.push("the device-name override did not take");
      }
      // And the write must be SWALLOWED, not merely shadowed. localStorage is
      // shared by every tab of one profile, so a page that let the application
      // write this key would leave the other two devices' names in the store —
      // which is the state the override exists to prevent.
      if (storage.map.get("relayium_device_name") !== undefined) {
        problems.push("the device-name override let the application write the shared key");
      }
      const deliver = (frame) => {
        for (const fn of listeners) fn({ data: JSON.stringify(frame) });
      };
      deliver({ type: "welcome", name: "SELF" });
      deliver({ type: "peers", peers: [{ id: "P1", name: "phone" }] });
      if (sandbox.window.__selfId !== "SELF") problems.push("the welcome frame was not read");
      if (JSON.stringify(sandbox.window.__peers) !== JSON.stringify([{ id: "P1", name: "phone" }])) {
        problems.push("the roster frame was not read");
      }
      // BENIGN: a caps hello is broadcast to every peer in the room by design and
      // a rename is an ordinary roster update. Counting either as a dial would
      // report every decoy as dialled on every run.
      deliver({ type: "signal", from: "P1", data: { caps: ["link/1"] } });
      deliver({ type: "signal", from: "P1", data: { rename: "phone 2" } });
      if ((sandbox.window.__signals.dial.P1 ?? 0) !== 0) {
        problems.push("a caps or rename broadcast was counted as a dial; every decoy would "
          + "fail on every run");
      }
      // A DIAL: an offer, and anything unrecognised. It fails CLOSED — a frame
      // shape nobody anticipated is a dial, not a shrug.
      deliver({ type: "signal", from: "P1", data: { sdp: "..." } });
      deliver({ type: "signal", from: "P1", data: { somethingNew: 1 } });
      if ((sandbox.window.__signals.dial.P1 ?? 0) !== 2) {
        problems.push("an offer or an unrecognised frame was not counted as a dial; a wrong "
          + "selection would leave no trace");
      }
      // The DOM latch, including the anti-vacuity counter a clean decoy needs.
      // The anti-vacuity counter must answer to the CHOOSER surface, in
      // whichever of its three modes — not to `.open-workspace`, which a page
      // in radar mode with nothing selected does not render at all. That was
      // v3's failure, and it was ordering-dependent, so only an explicit check
      // catches a regression to it.
      nodes = [".workspace-head", ".radar, .peerlink"];
      sandbox.window.__latchLook();
      let latch = sandbox.window.__latch;
      if (!(latch.ticks > 0) || !(latch.head > 0) || !(latch.chooser > 0)
          || latch.fileReq !== 0 || latch.textReq !== 0) {
        problems.push(`the DOM latch does not count what it claims to: ${JSON.stringify(latch)}`);
      }
      // A page in the room but with NO peer card selected — v3's decoy02 — must
      // still satisfy anti-vacuity.
      nodes = [".radar, .peerlink"];
      sandbox.window.__latch = {
        ticks: 0, head: 0, panel: 0, fileReq: 0, textReq: 0, chooser: 0, peerCard: 0,
      };
      sandbox.window.__latchLook();
      latch = sandbox.window.__latch;
      if (!(latch.chooser > 0) || latch.peerCard !== 0 || latch.head !== 0) {
        problems.push("a page in radar mode with no peer card selected does not satisfy "
          + `anti-vacuity: ${JSON.stringify(latch)}`);
      }
    } catch (error) {
      problems.push(`the boot script threw when run: ${error?.stack ?? error}`);
    }
  }

  if (problems.length) {
    console.error("SELF-CHECK FAIL:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log("SELF-CHECK PASS: every injected page script parses; the name override, the "
    + "roster observer, the dial classifier (benign vs offer vs unknown) and the DOM latch "
    + "all behave as this round's assertions assume");
  return 0;
}

if (SELF_CHECK) process.exit(selfCheck());

withWatchdog("android ↔ web code-less room (browser half)", TIMEOUT_MS + BARRIER_MS + 120_000, main)
  .then((code) => process.exit(code ?? 0))
  .catch(async (error) => {
    writeObservation();
    console.error(`\n  \x1b[31m✗\x1b[0m ${error?.stack ?? error}`);
    // The watchdog's whole point is that `main()` may be HUNG, in which case its
    // `finally` never runs and the exit below would orphan the browser.
    await closeOwned();
    process.exit(1);
  });
