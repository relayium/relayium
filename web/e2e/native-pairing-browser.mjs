#!/usr/bin/env node
/**
 * The BROWSER half of the macOS-native ↔ Web pairing acceptance.
 *
 * Driven by `scripts/native-web-pairing-acceptance.sh`, which owns the throwaway
 * Go server, the account, and the native peer this talks to. This half owns one
 * real Chrome on the real built bundle, joined to the same pairing code over the
 * same real WebSocket and real WebRTC.
 *
 * ## What makes this evidence rather than another fixture
 *
 * Every existing pairing-room E2E in this repository replaces `window.WebSocket`
 * with a BroadcastChannel fake serving five scripted frames and hands out an
 * empty `iceServers` (`code-room-fixture.mjs`), and every Swift "peer" in the
 * pairing tests is a Swift-authored double. Both are useful and neither can see
 * a disagreement BETWEEN the two clients, which is exactly what the 1.2.5
 * cross-network regression was. So nothing here is stubbed:
 *
 *   * the signalling socket is the product's own, against a real hub;
 *   * the capability hello is whatever the shipped bundle actually sends;
 *   * the transport is real WebRTC on real host candidates;
 *   * the peer on the other side is the macOS app's own `LinkWorkspaceModel`,
 *     assembled by `AppEnvironment` exactly as `RelayiumApp` assembles it.
 *
 * The one stub is Save-as (`SAVE_STUB`), because a browser download opens an OS
 * dialog no headless run can answer. It captures the bytes the page decrypted;
 * it does not produce them.
 *
 * ## Contract with the shell half
 *
 * Arguments: --origin, --code, --message, --file-name, --file-body, --expect-name,
 * --expect-body, --out. Everything it OBSERVED is written to `--out` as JSON, and
 * the shell script makes the comparisons — so a mistake in this file surfaces as
 * a failed comparison there rather than as a pass this file granted itself.
 */
import { writeFileSync } from "node:fs";
import { argFlag, argPresent, launchBrowser, newTab, ok, sleep, SAVE_STUB, VERIFY_DEFAULT, VERIFY_ON, setWideViewport, withWatchdog } from "./harness.mjs";

const ORIGIN = argFlag("--origin", "");
const CODE = argFlag("--code", "");
const MESSAGE = argFlag("--message", "");
const FILE_NAME = argFlag("--file-name", "web-to-mac.txt");
const FILE_BODY = argFlag("--file-body", "from the browser");
const EXPECT_NAME = argFlag("--expect-name", "");
/** What the NATIVE peer will send. The thread renders both directions in the
 *  same `.msg-body` elements, so "at least one message" is satisfied instantly
 *  by this page's own — and reads the thread before the peer's has arrived. */
const EXPECT_MESSAGE = argFlag("--expect-message", "");
const OUT = argFlag("--out", "");
const DEBUG_PORT = Number(argFlag("--debug-port", "9461"));
/**
 * Which verification preference this round runs under, and it must be stated.
 *
 * The shipped default shows no verification code at all, so a round on the
 * default path cannot compare SAS digits with the other endpoint — and a round
 * that turned the preference on to get them would be evidence about the opt-in
 * path only. The caller alternates: the default path is what the owner's users
 * hit and is what the regression lived on; the opt-in path is the only place the
 * two clients' digits can be put side by side at all.
 *
 * Written explicitly in both directions because one browser profile is shared by
 * every tab in a run: a round that injected nothing would inherit whatever the
 * previous one left in localStorage.
 */
const VERIFY = argFlag("--verify", "default");
const KEEP = argPresent("--keep");
const GLOBAL_TIMEOUT_MS = 6 * 60_000;

if (!ORIGIN || !CODE || !OUT) {
  console.error("usage: native-pairing-browser.mjs --origin URL --code CODE --out FILE [...]");
  process.exit(2);
}

const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const COMPOSER = ".msgpanel textarea";
const SEND = ".msgpanel button.send";
const ATTACH_FILE = ".msgpanel .attach-file";
const OPEN_WORKSPACE = ".open-workspace";

/** What the page believed, captured for the shell half to judge. */
const observed = {
  origin: ORIGIN,
  code: CODE,
  reachedWorkspace: false,
  sas: "",
  role: "",
  selfId: "",
  peerId: "",
  verify: "",
  receivedMessages: [],
  receivedFileName: "",
  receivedFileHex: "",
  sentMessage: MESSAGE,
  sentFileName: FILE_NAME,
};

function writeObservation() {
  writeFileSync(OUT, JSON.stringify(observed, null, 2) + "\n");
}

/**
 * The page's own peer ids, read off the module the product uses.
 *
 * Not to DECIDE anything — the role is the clients' own `selfId < peerId` rule —
 * but so a run can REPORT which assignment it exercised. A regression that only
 * appears on one side of that comparison is otherwise an intermittent red whose
 * cause is invisible, which is how "fails about half the time" gets written off
 * as flakiness.
 */
const READ_IDS = `(() => {
  const el = document.querySelector('${HEAD}');
  return {
    self: window.__relayiumSelfId ?? '',
    peer: el?.getAttribute('data-peer') ?? '',
  };
})()`;

/** Publish the ids the page already has, without changing any behaviour. */
const EXPOSE_IDS = `
  (() => {
    const orig = WebSocket.prototype.send;
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
    void orig;
  })();
`;

async function run() {
  const { browser, close } = await launchBrowser({ debugPort: DEBUG_PORT, keep: KEEP });
  try {
    const preference = VERIFY === "on" ? VERIFY_ON : VERIFY_DEFAULT;
    const tab = await newTab(browser, `${ORIGIN}/cross-network#c=${CODE}`,
                             preference + EXPOSE_IDS + SAVE_STUB);
    await setWideViewport(tab, 1280, 900);

    // The peer appears, and the page decides for itself whether it is a link
    // peer. Nothing here tells it.
    await tab.waitFor("(window.__relayiumPeers ?? []).length >= 2", "the native peer to join the code room", 60_000);
    const ids = await tab.evaluate(`(() => {
      const peers = window.__relayiumPeers ?? [];
      const self = window.__relayiumSelfId ?? '';
      return { self, peer: peers.find((p) => p !== self) ?? '' };
    })()`);
    observed.selfId = ids.self;
    observed.peerId = ids.peer;
    observed.role = ids.self && ids.peer ? (ids.self < ids.peer ? "initiator" : "responder") : "";
    ok(`browser is ${observed.role} (self ${ids.self}, peer ${ids.peer})`);

    // Whichever side the ids made the asker, the workspace has to arrive. The
    // page offers an explicit control when it is the one to open it; when the
    // native side opens it first, the header simply appears.
    const opened = await tab.evaluate(`(() => {
      const b = document.querySelector('${OPEN_WORKSPACE}');
      if (!b) return false;
      b.click();
      return true;
    })()`).catch(() => false);
    if (opened) ok("browser asked to open the unified workspace");

    // The HEADER is the assertion; the SAS inside it exists only on the opt-in
    // path. Waiting on the code under the default preference would hang forever
    // against a workspace that had opened perfectly.
    await tab.waitFor(`!!document.querySelector('${HEAD}')`, "the unified workspace header", 90_000);
    observed.reachedWorkspace = true;
    observed.verify = VERIFY;
    if (VERIFY === "on") {
      await tab.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "the verification code", 30_000);
      observed.sas = await tab.evaluate(`document.querySelector('${HEAD_SAS}').textContent.trim()`);
      // One link, one SAS: what would actually go wrong is a second verification
      // surface elsewhere on the page, which is the shape the pairing room used
      // to have when every session carried its own code.
      const surfaces = await tab.evaluate("document.querySelectorAll('.sas').length");
      if (surfaces !== 1) throw new Error(`the page showed ${surfaces} verification surfaces, not one`);
    }
    ok(`unified workspace open${observed.sas ? `, SAS ${observed.sas}` : " (verification at its shipped default)"}`);

    // ── the browser sends a message ──────────────────────────────────────
    await tab.waitFor(`!!document.querySelector('${COMPOSER}')`, "the composer", 30_000);
    await tab.evaluate(`(() => {
      const ta = document.querySelector('${COMPOSER}');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(MESSAGE)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await tab.waitFor(`!document.querySelector('${SEND}').disabled`, "the send button to enable", 20_000);
    await tab.evaluate(`(() => { document.querySelector('${SEND}').click(); return true; })()`);
    ok("browser sent a message");

    // ── the browser sends a file ─────────────────────────────────────────
    await tab.evaluate(`(() => {
      const input = document.querySelector('${ATTACH_FILE}');
      if (!input) throw new Error('no attachment control in the unified workspace');
      if (input.disabled) throw new Error('the attachment control was disabled');
      const dt = new DataTransfer();
      dt.items.add(new File([new TextEncoder().encode(${JSON.stringify(FILE_BODY)})],
                            ${JSON.stringify(FILE_NAME)}, { type: 'text/plain' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    ok("browser attached a file");

    // ── and receives the native side's message and file ──────────────────
    await tab.waitFor(
      EXPECT_MESSAGE
        ? `[...document.querySelectorAll('.msg-body')].some((el) => el.textContent === ${JSON.stringify(EXPECT_MESSAGE)})`
        : "document.querySelectorAll('.msg-body').length >= 1",
      "the native peer's message to render", 120_000);
    observed.receivedMessages = await tab.evaluate(
      `[...document.querySelectorAll('.msg-body')].map((el) => el.textContent)`);

    // An inbound batch needs consent; accepting it is the person on screen, and
    // the acceptance is about the bytes rather than about that decision.
    await tab.waitFor("!!document.querySelector('.request')", "the inbound file consent card", 120_000)
      .then(() => tab.evaluate("(() => { document.querySelector('.request .btn-primary').click(); return true; })()"))
      .catch(() => { /* already accepted, or the card auto-resolved */ });

    await tab.waitFor("!!window.__e2e && window.__e2e.closed", "the native peer's file to be written", 180_000);
    const saved = await tab.evaluate(`(() => {
      const bytes = window.__e2e.chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(bytes);
      let o = 0;
      for (const c of window.__e2e.chunks) { out.set(new Uint8Array(c), o); o += c.byteLength; }
      return {
        name: window.__e2e.name,
        hex: [...out].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    })()`);
    observed.receivedFileName = saved.name;
    observed.receivedFileHex = saved.hex;
    ok(`browser received ${saved.name} (${saved.hex.length / 2} bytes)`);

    if (EXPECT_NAME && saved.name !== EXPECT_NAME) {
      throw new Error(`expected ${EXPECT_NAME}, received ${saved.name}`);
    }

    // Give the outbound batch a moment to be accepted and drained on the far
    // side; the shell half asserts what the NATIVE peer actually wrote.
    await sleep(2_000);
  } finally {
    writeObservation();
    if (!KEEP) await close();
  }
}

withWatchdog("native ↔ web pairing (browser half)", GLOBAL_TIMEOUT_MS, run).catch((err) => {
  writeObservation();
  console.error(`\n  \x1b[31m✗\x1b[0m ${err?.stack ?? err}`);
  process.exit(1);
});
