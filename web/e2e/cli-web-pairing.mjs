#!/usr/bin/env node
/**
 * **A12: the real `relayium pair` CLI ↔ a real browser, over a real pairing code.**
 *
 * Driven by `scripts/interop/cli-web-acceptance.sh`, which owns the throwaway
 * Go server, the disposable account, the round plan, the CLI's staged source
 * files and every comparison (`scripts/interop/cli-web-oracle.py`). This file
 * owns the two live endpoints of ONE round and nothing else:
 *
 *   * the CLI: the binary built from this tree, `relayium pair [CODE] --dest D`,
 *     stdin a pipe, credentials only in a private XDG_CONFIG_HOME
 *     (`scripts/interop/cli-process.mjs`);
 *   * one headless Chrome on the real built bundle, joined to the same code over
 *     the product's own WebSocket and real WebRTC on loopback host candidates.
 *
 * ## Which code role
 *
 * `--code-role cli`: the CLI mints (`relayium pair` with no code, the logged-in
 * path), the browser joins with `/cross-network#c=CODE`.
 * `--code-role web`: the browser signs in through the product's own password
 * endpoint and mints with the page's own "create code" control; the CLI joins
 * with `relayium pair CODE` (the never-logged-in path).
 *
 * The LINK role (who offers) is not chosen by anyone: the hub assigns ids per
 * socket at random and the smaller id offers. This file RECORDS both sides'
 * own statement of it — the CLI's `linked with … (…, initiator|responder)` line
 * and the page's id comparison — and the shell loops until both assignments
 * have been seen under both code roles.
 *
 * ## One round, sequenced
 *
 * Every step waits on the OTHER endpoint's observable state before the next
 * one starts, so a red step names one direction and one cell:
 *
 *   1. link + admission on both ends; SAS read from both (compared when the
 *      page shows it, i.e. `--verify on`);
 *   2. text web→cli, then cli→web;
 *   3. web→cli: a flat multi-file batch (>192 KiB body, zero-byte, small),
 *      then a FOLDER batch (nested paths, a zero-byte leaf), each accepted with
 *      `/accept` — two consecutive batches on one link;
 *   4. web→cli: a batch the CLI `/decline`s;
 *   5. cli→web: `/send` of flat files, then `/send` of a directory tree, each
 *      accepted on the page — two consecutive batches the other way;
 *   6. cli→web: a batch the page declines;
 *   7. web→cli cancel BY THE SENDER: the page sends a body larger than one flow
 *      window, the CLI accepts, the CLI process is PAUSED (SIGSTOP) so it cannot
 *      acknowledge, the page presses its own Cancel, the CLI is resumed;
 *   8. cli→web cancel BY THE RECEIVER: the page holds its first durable write
 *      of a body larger than one flow window (the save-dialog seam, the same
 *      gate `android-interop.mjs` uses), presses Cancel on the incoming card,
 *      and releases the write;
 *   9. text again both ways (the link survived both cancels);
 *  10. the ending: `quit` — the CLI types `/quit`; or `interrupt` — the CLI
 *      `/send`s a large body the page holds, and receives SIGINT mid-transfer.
 *
 * Nothing about the page is stubbed but the OS save dialogs (the ledger below),
 * which record what the product decrypted and wrote; they never produce bytes.
 */
import { renameSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import process from "node:process";
import {
  argFlag, argPresent, launchBrowser, newTab, ok, sleep,
  VERIFY_DEFAULT, VERIFY_ON, setWideViewport, withWatchdog,
} from "./harness.mjs";
import {
  ADMITTED_RE, LINKED_RE, MINTED_RE, SAS_RE, startCli,
} from "../../scripts/interop/cli-process.mjs";

const ORIGIN = argFlag("--origin", "");
const CLI_BIN = argFlag("--cli", "");
const XDG = argFlag("--xdg", "");
const OUT = argFlag("--out", "");
const PLAN = JSON.parse(readFileSync(argFlag("--plan", ""), "utf8"));
const KEEP = argPresent("--keep");
const GLOBAL_TIMEOUT_MS = 12 * 60_000;

if (!ORIGIN || !CLI_BIN || !XDG || !OUT) {
  console.error("usage: cli-web-pairing.mjs --origin URL --cli BIN --xdg DIR --plan FILE --out FILE");
  process.exit(2);
}
const CODE_ROLE = PLAN.codeRole;
if (!["cli", "web"].includes(CODE_ROLE)) throw new Error(`plan.codeRole must be cli or web, not ${CODE_ROLE}`);
if (!["quit", "interrupt"].includes(PLAN.ending)) throw new Error(`plan.ending must be quit or interrupt`);

const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const COMPOSER = ".msgpanel textarea";
const SEND = ".msgpanel button.send";
const ATTACH_FILE = ".msgpanel .attach-file";
const ATTACH_FOLDER = ".msgpanel .attach-folder";
const OPEN_WORKSPACE = ".open-workspace";

/** Everything OBSERVED, for the oracle. Nothing in here is a verdict. */
const observed = {
  round: PLAN.round,
  codeRole: CODE_ROLE,
  verify: PLAN.verify,
  ending: PLAN.ending,
  code: "",
  steps: [],
  web: {
    role: "", selfId: "", peerId: "", sas: "", peerName: "",
    receivedMessages: [], saves: [], sendStatuses: {}, recvStatuses: {},
    endState: "", sdp: null, errors: [],
  },
  cli: null,
  cancel: { stopped: false, resumed: false, webCancelClicked: false },
  receiverCancel: null,
  interrupt: null,
  complete: false,
};

function writeObservation() {
  const tmp = `${OUT}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(observed, null, 2) + "\n");
  renameSync(tmp, OUT);
}
const step = (name) => { observed.steps.push(name); ok(name); };

async function ephemeralPort() {
  const server = createServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  await new Promise((res) => server.close(res));
  return port;
}

// ── page-side instrumentation ────────────────────────────────────────────────

/** The page's own ids (for the role it took) and the SDP both ends advertised
 *  (for the A10 question: what `a=max-message-size` does a browser offer the
 *  CLI). Observation only: nothing here changes what the page sends. */
const OBSERVE = `
  (() => {
    window.__relayiumSelfId = '';
    window.__sdp = { local: [], remote: [] };
    const Native = window.WebSocket;
    const seen = new WeakSet();
    window.WebSocket = function (...args) {
      const ws = new Native(...args);
      if (!seen.has(ws)) {
        seen.add(ws);
        ws.addEventListener('message', (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m && m.type === 'welcome' && typeof m.name === 'string') window.__relayiumSelfId = m.name;
            if (m && m.type === 'peers' && Array.isArray(m.peers)) window.__relayiumPeers = m.peers.map((p) => p.id);
          } catch { /* not ours */ }
        });
      }
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
    const mms = (sdp) => {
      const m = /a=max-message-size:(\\d+)/i.exec(sdp || '');
      return m ? Number(m[1]) : null;
    };
    const P = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
    if (P) {
      const setLocal = P.setLocalDescription, setRemote = P.setRemoteDescription;
      P.setLocalDescription = function (d, ...rest) {
        const r = setLocal.call(this, d, ...rest);
        Promise.resolve(r).then(() => {
          const s = this.localDescription;
          if (s) window.__sdp.local.push({ type: s.type, maxMessageSize: mms(s.sdp) });
        }).catch(() => {});
        return r;
      };
      P.setRemoteDescription = function (d, ...rest) {
        if (d && d.sdp) window.__sdp.remote.push({ type: d.type, maxMessageSize: mms(d.sdp) });
        return setRemote.call(this, d, ...rest);
      };
    }
  })();
`;

/**
 * The save ledger: one record per file the page opened for writing, over BOTH
 * save paths `filesink.ts` takes (Save-As for a flat single file; a directory
 * handle for anything else, whose nested `getDirectoryHandle` calls give each
 * record its PATH). It records bytes the product wrote; it never makes any.
 *
 * `window.__holdNames` arms the receive-cancel gate per file name: the first
 * durable write of such a file is held until `window.__release[name]`, so no
 * acknowledgement leaves the page and the CLI sender stalls inside its flow
 * window — the batch cannot complete before the page's Cancel is pressed.
 */
const LEDGER = `
  (() => {
    window.__saves = [];
    window.__holdNames = [];
    window.__held = {};
    window.__release = {};
    const hold = (name) => new Promise((resolve) => {
      window.__held[name] = true;
      const t = setInterval(() => {
        if (window.__release[name]) { clearInterval(t); resolve(); }
      }, 50);
    });
    const writable = (record, inner) => {
      let first = true;
      return {
        write: async (chunk) => {
          if (first) {
            first = false;
            if (window.__holdNames.includes(record.name)) await hold(record.name);
          }
          const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk.slice(0))
            : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength))
            : new Uint8Array(await new Blob([chunk]).arrayBuffer());
          record.chunks.push(bytes);
          return inner.write(chunk);
        },
        close: async () => { record.closed = true; return inner.close(); },
        abort: async () => { record.aborted = true; },
      };
    };
    const record = (name, path) => {
      const r = { name: name || '', path: path || name || '', chunks: [], closed: false, aborted: false, removed: false };
      window.__saves.push(r);
      return r;
    };
    window.showSaveFilePicker = async (opts) => {
      const r = record(opts && opts.suggestedName, opts && opts.suggestedName);
      return { createWritable: async () => writable(r, { write: async () => {}, close: async () => {} }) };
    };
    const dir = (prefix) => ({
      name: prefix,
      getDirectoryHandle: async (name) => dir(prefix + name + '/'),
      getFileHandle: async (name, opts) => {
        if (!opts || !opts.create) throw new DOMException('not found', 'NotFoundError');
        const r = record(name, prefix + name);
        return { createWritable: async () => writable(r, { write: async () => {}, close: async () => {} }) };
      },
      removeEntry: async (name) => {
        for (const r of window.__saves) if (r.path === prefix + name) r.removed = true;
      },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    });
    window.showDirectoryPicker = async () => dir('');
  })();
`;

/** Metadata only: never touches bytes on a poll (see android-interop.mjs on
 *  why hex-encoding megabytes per poll blocks the page under test). */
const SAVE_INDEX = `(() => (window.__saves ?? []).map((r, i) => ({
  i, name: r.name, path: r.path, closed: !!r.closed, aborted: !!r.aborted, removed: !!r.removed,
  size: r.chunks.reduce((n, c) => n + c.byteLength, 0) })))()`;

/** SHA-256 of a CLOSED save, computed in the page with WebCrypto — only the
 *  digest crosses CDP. The oracle compares it with a digest it derives itself
 *  from the plan's seed, so the page cannot vouch for bytes it did not write. */
const saveDigestJs = (i) => `(async () => {
  const r = (window.__saves ?? [])[${Number(i)}];
  if (!r) return null;
  const n = r.chunks.reduce((a, c) => a + c.byteLength, 0);
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of r.chunks) { all.set(c, o); o += c.byteLength; }
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
})()`;

async function readSaves(tab) {
  const index = await tab.evaluate(SAVE_INDEX);
  const out = [];
  for (const r of index) {
    out.push({ ...r, sha256: await tab.evaluate(saveDigestJs(r.i)) });
  }
  return out;
}

/** In-page bytes, by the same rule the shell's stager and the oracle use. */
const BYTES_FN = `(size, seed) => { const u = new Uint8Array(size); for (let i = 0; i < size; i++) u[i] = (i * 31 + seed) & 0xff; return u; }`;

/** Attach `entries` through the page's own file (or folder) control. */
async function attach(tab, entries, { folder = false } = {}) {
  const sel = folder ? ATTACH_FOLDER : ATTACH_FILE;
  await tab.waitFor(`(() => { const i = document.querySelector('${sel}'); return !!i && !i.disabled; })()`,
    `the ${folder ? "folder" : "file"} attachment control`, 30_000);
  const result = await tab.evaluate(`(() => {
    const bytes = ${BYTES_FN};
    const input = document.querySelector('${sel}');
    const dt = new DataTransfer();
    for (const e of ${JSON.stringify(entries)}) {
      const f = new File([bytes(e.size, e.seed)], e.name, { type: 'application/octet-stream' });
      if (e.path) Object.defineProperty(f, 'webkitRelativePath', { value: e.path });
      dt.items.add(f);
    }
    input.files = dt.files;
    const paths = [...input.files].map((f) => f.webkitRelativePath || '');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return paths;
  })()`);
  if (folder) {
    const want = entries.map((e) => e.path);
    if (JSON.stringify(result) !== JSON.stringify(want)) {
      throw new Error(`the folder control did not keep the relative paths: ${JSON.stringify(result)}`);
    }
  }
}

async function sendText(tab, body) {
  await tab.waitFor(`(() => {
    const ta = document.querySelector('${COMPOSER}');
    const send = document.querySelector('${SEND}');
    if (!ta || !send) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    if (ta.value !== ${JSON.stringify(body)} || send.disabled) {
      setter.call(ta, ${JSON.stringify(body)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return !send.disabled;
  })()`, "the composer to hold the draft and enable Send", 30_000);
  await tab.evaluate(`(() => { document.querySelector('${SEND}').click(); return true; })()`);
}

const msgBodies = `[...document.querySelectorAll('.msg-body')].map((el) => el.textContent)`;

/** The consent card for an inbound batch: returns the names it lists. */
async function awaitConsent(tab, what) {
  await tab.waitFor("!!document.querySelector('.request')", `the consent card for ${what}`, 120_000);
  return tab.evaluate(`[...document.querySelectorAll('.request .fname')].map((el) => el.textContent)`);
}

/** Answer the card, reading the memory warning FIRST: under `.memwarn` the two
 *  buttons swap meaning (dom-contracts.mjs `RECEIVE`). */
async function answerConsent(tab, accept) {
  return tab.evaluate(`(() => {
    const card = document.querySelector('.request');
    if (!card) throw new Error('no consent card to answer');
    const warned = !!card.querySelector('.memwarn');
    const button = ${accept} ? (warned ? '.btn-ghost' : '.btn-primary') : (warned ? '.btn-primary' : '.btn-ghost');
    card.querySelector(button).click();
    return warned;
  })()`);
}

/** The transfer card of one direction ('send' | 'recv'): state and status. */
const cardJs = (dir) => `(() => {
  const label = document.getElementById('xfer-label-${dir}');
  const card = label && label.closest('.xfer');
  if (!card) return null;
  return {
    done: card.classList.contains('ok') || card.classList.contains('bad'),
    ok: card.classList.contains('ok'),
    status: (card.querySelector('.status')?.textContent ?? '').trim(),
    moving: !!card.querySelector('.progress-bar'),
    meta: (card.querySelector('.meta')?.textContent ?? '').trim(),
  };
})()`;

/** Press Cancel on one direction's in-flight card. */
const cancelCardJs = (dir) => `(() => {
  const label = document.getElementById('xfer-label-${dir}');
  const card = label && label.closest('.xfer');
  const b = card && card.querySelector('.cancel');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** Dismiss a finished card so the next batch's card is unambiguous. */
const dismissCardJs = (dir) => `(() => {
  const label = document.getElementById('xfer-label-${dir}');
  const card = label && label.closest('.xfer');
  const b = card && card.querySelector('.xfer-head .x:not(.cancel)');
  if (b) b.click();
  return !!b;
})()`;

/** Wait for one direction's card to reach a terminal state, record it, and
 *  dismiss it. `orGone`: a card the product retires outright on a cancel
 *  (instead of leaving it in a finished state) also counts, and is recorded as
 *  `{gone: true}` so the oracle can tell the two apart. */
async function awaitCardDone(tab, dir, what, timeoutMs = 120_000, { orGone = false } = {}) {
  await tab.waitFor(`(() => { const c = ${cardJs(dir)}; return ${orGone ? "!c ||" : "!!c &&"} c.done; })()`, what, timeoutMs);
  const c = await tab.evaluate(cardJs(dir));
  if (!c) return { gone: true };
  await tab.evaluate(dismissCardJs(dir));
  await tab.waitFor(`!document.getElementById('xfer-label-${dir}')`, `the finished ${dir} card to be dismissed`, 15_000);
  return c;
}

// ── the round ────────────────────────────────────────────────────────────────

let cli = null;
let closeBrowser = null;
for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  process.once(sig, () => {
    const done = () => process.exit(code);
    Promise.resolve(cli?.kill()).finally(() => {
      if (KEEP || !closeBrowser) done();
      else closeBrowser().then(done, done);
    });
  });
}

async function run() {
  const cliEnv = { XDG_CONFIG_HOME: XDG };
  const cliArgs = ["pair", "--server", ORIGIN, "--dest", PLAN.dest];

  const { browser, close } = await launchBrowser({ debugPort: await ephemeralPort(), keep: KEEP });
  closeBrowser = close;
  let tab;
  try {
    const preference = PLAN.verify === "on" ? VERIFY_ON : VERIFY_DEFAULT;
    const init = preference + OBSERVE + LEDGER;

    if (CODE_ROLE === "cli") {
      cli = startCli({ bin: CLI_BIN, args: cliArgs, env: cliEnv, label: "cli" });
      const { match } = await cli.waitLine(MINTED_RE, "the CLI to mint a code", { timeoutMs: 30_000 });
      observed.code = match[1];
      step(`the CLI minted ${observed.code}`);
      tab = await newTab(browser, `${ORIGIN}/cross-network#c=${observed.code}`, init);
    } else {
      // The page signs in through the product's own endpoint (the password
      // travels from the environment into the page, never through argv), then
      // mints with its own control.
      const email = process.env.RELAYIUM_ACCEPTANCE_EMAIL ?? "";
      const password = process.env.RELAYIUM_ACCEPTANCE_PASSWORD ?? "";
      if (!email || !password) throw new Error("code-role web needs RELAYIUM_ACCEPTANCE_EMAIL/PASSWORD in the environment");
      tab = await newTab(browser, `${ORIGIN}/`, init);
      await tab.waitFor("document.readyState === 'complete'", "the landing page", 30_000);
      const login = await tab.evaluate(`fetch('/api/auth/password/login', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
      }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) }))`);
      if (login.status !== 200) throw new Error(`the page could not sign in (HTTP ${login.status}: ${login.body})`);
      await tab.send("Page.navigate", { url: `${ORIGIN}/cross-network` });
      await tab.waitFor(`(() => { const b = document.querySelector('.create-code'); return !!b && !b.disabled; })()`,
        "the page's create-code control", 45_000);
      await tab.evaluate("(() => { document.querySelector('.create-code').click(); return true; })()");
      await tab.waitFor(`/^\\S{4,}$/.test((document.querySelector('.code')?.textContent ?? '').trim())`,
        "the page to show the code it minted", 45_000);
      observed.code = await tab.evaluate("document.querySelector('.code').textContent.trim()");
      step(`the page minted ${observed.code}`);
      cli = startCli({ bin: CLI_BIN, args: [...cliArgs, observed.code], env: cliEnv, label: "cli" });
    }
    await setWideViewport(tab, 1280, 900);

    // ── 1. link + admission on both ends ────────────────────────────────
    await tab.waitFor("(window.__relayiumPeers ?? []).length >= 2", "the CLI to join the code room", 90_000);
    const ids = await tab.evaluate(`(() => {
      const peers = window.__relayiumPeers ?? [];
      const self = window.__relayiumSelfId ?? '';
      return { self, peer: peers.find((p) => p !== self) ?? '' };
    })()`);
    Object.assign(observed.web, {
      selfId: ids.self, peerId: ids.peer,
      role: ids.self && ids.peer ? (ids.self < ids.peer ? "initiator" : "responder") : "",
    });
    await tab.evaluate(`(() => { const b = document.querySelector('${OPEN_WORKSPACE}'); if (b) b.click(); return !!b; })()`)
      .catch(() => false);
    const linked = await cli.waitLine(LINKED_RE, "the CLI's linked line", { timeoutMs: 90_000 });
    const sasLine = await cli.waitLine(SAS_RE, "the CLI's SAS line", { timeoutMs: 30_000 });
    await cli.waitLine(ADMITTED_RE, "the CLI to admit the link", { timeoutMs: 60_000 });
    await tab.waitFor(`!!document.querySelector('${HEAD}')`, "the unified workspace header", 90_000);
    if (PLAN.verify === "on") {
      await tab.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "the page's verification code", 30_000);
      observed.web.sas = await tab.evaluate(`document.querySelector('${HEAD_SAS}').textContent.trim()`);
    }
    observed.web.peerName = await tab.evaluate("(document.querySelector('.wh-peer')?.textContent ?? '').trim()");
    step(`linked: CLI says "${linked.line.text}", page is ${observed.web.role}, CLI SAS ${sasLine.match[1]}${observed.web.sas ? `, page SAS ${observed.web.sas}` : ""}`);

    // ── 2. text, both directions ─────────────────────────────────────────
    const [w1, w2] = PLAN.webMessages;
    const [c1, c2] = PLAN.cliMessages;
    await sendText(tab, w1);
    await cli.waitStdout((s) => s.includes(w1 + "\n"), "the page's first message on the CLI's stdout");
    step("text web → cli");
    cli.write(c1);
    await tab.waitFor(`${msgBodies}.includes(${JSON.stringify(c1)})`, "the CLI's first message on the page", 60_000);
    step("text cli → web");

    // ── 3. web → cli: flat batch, then folder batch; each /accept ────────
    const acceptInbound = async (label, entries, folder) => {
      const from = cli.mark();
      await attach(tab, entries, { folder });
      await cli.waitLine(/^type \/accept to save them, or \/decline$/, `the CLI's prompt for ${label}`, { from, timeoutMs: 60_000 });
      cli.write("/accept");
      await cli.waitLine(/^saved: every file verified and written to disk in /, `the CLI to save ${label}`, { from, timeoutMs: 120_000 });
      observed.web.sendStatuses[label] = await awaitCardDone(tab, "send", `the page's send card for ${label} to finish`);
      step(`web → cli ${label} saved`);
    };
    await acceptInbound("flat", PLAN.webBatches.flat, false);
    await acceptInbound("folder", PLAN.webBatches.folder, true);

    // ── 4. web → cli: declined by the CLI ────────────────────────────────
    {
      const from = cli.mark();
      await attach(tab, PLAN.webBatches.declined, { folder: false });
      await cli.waitLine(/^type \/accept to save them, or \/decline$/, "the CLI's prompt for the batch it declines", { from });
      cli.write("/decline");
      await cli.waitLine(/^declined$/, "the CLI's decline", { from });
      observed.web.sendStatuses.declined = await awaitCardDone(tab, "send", "the page's send card for the declined batch to finish");
      step("web → cli batch declined by the CLI");
    }

    // ── 5. cli → web: flat files, then a directory tree; page accepts ────
    const sendToWeb = async (label, srcs, expectNames) => {
      const from = cli.mark();
      cli.write(`/send ${srcs.map((p) => JSON.stringify(p)).join(" ")}`);
      const listed = await awaitConsent(tab, label);
      observed.web.recvStatuses[`${label}:offered`] = listed;
      await answerConsent(tab, true);
      await cli.waitLine(/^delivered: the other side verified and saved the files$/, `the CLI's delivery of ${label}`, { from, timeoutMs: 120_000 });
      observed.web.recvStatuses[label] = await awaitCardDone(tab, "recv", `the page's receive card for ${label} to finish`);
      step(`cli → web ${label} delivered (${expectNames} file(s) offered)`);
    };
    await sendToWeb("flat", PLAN.cliBatches.flat.map((e) => e.src), PLAN.cliBatches.flat.length);
    await sendToWeb("dir", [PLAN.cliBatches.dir.src], PLAN.cliBatches.dir.entries.length);

    // ── 6. cli → web: declined by the page ───────────────────────────────
    {
      const from = cli.mark();
      cli.write(`/send ${JSON.stringify(PLAN.cliBatches.declined.src)}`);
      observed.web.recvStatuses["declined:offered"] = await awaitConsent(tab, "the batch the page declines");
      await answerConsent(tab, false);
      await cli.waitLine(/^not sent: the other side declined the files$/, "the CLI to report the page's decline", { from });
      await tab.waitFor("!document.querySelector('.request')", "the consent card to go away after declining", 30_000);
      step("cli → web batch declined by the page");
    }

    // ── 7. web → cli, cancelled by the SENDER (the page) ─────────────────
    {
      const from = cli.mark();
      await attach(tab, [PLAN.webBatches.cancel], { folder: false });
      await cli.waitLine(/^type \/accept to save them, or \/decline$/, "the CLI's prompt for the batch the page will cancel", { from });
      cli.write("/accept");
      await cli.waitLine(/^receiving 1 file\(s\) into /, "the CLI to start receiving", { from });
      // Hold the receiver: a paused process acknowledges nothing, so the page
      // cannot run past its flow window, and the body is larger than one.
      cli.signal("SIGSTOP");
      observed.cancel.stopped = true;
      await tab.waitFor(`(() => { const c = ${cardJs("send")}; return !!c && c.moving; })()`,
        "the page's send to be in flight", 30_000);
      observed.cancel.inFlight = await tab.evaluate(cardJs("send"));
      observed.cancel.webCancelClicked = await tab.evaluate(cancelCardJs("send"));
      if (!observed.cancel.webCancelClicked) throw new Error("the page offered no Cancel on its in-flight send");
      // The cancel is now queued BEHIND data the paused CLI has not read. The
      // page's card cannot settle before the CLI answers the abort, so the CLI
      // is resumed first and both ends are then awaited.
      await sleep(500);
      cli.signal("SIGCONT");
      observed.cancel.resumed = true;
      observed.web.sendStatuses.cancelled = await awaitCardDone(tab, "send", "the page's cancelled send to finish", 60_000, { orGone: true });
      await cli.waitLine(/^not saved: the sender cancelled; nothing from it was kept$/, "the CLI to report the sender's cancel", { from, timeoutMs: 120_000 });
      step("web → cli cancelled by the sending page; the CLI kept nothing");
    }

    // ── 8. cli → web, cancelled by the RECEIVER (the page) ───────────────
    {
      const name = PLAN.cliBatches.cancel.name;
      await tab.evaluate(`(() => { window.__holdNames.push(${JSON.stringify(name)}); return true; })()`);
      const from = cli.mark();
      cli.write(`/send ${JSON.stringify(PLAN.cliBatches.cancel.src)}`);
      await awaitConsent(tab, "the batch the page will stop");
      await answerConsent(tab, true);
      await tab.waitFor(`!!window.__held[${JSON.stringify(name)}]`, "the page to hold the first write", 60_000);
      const clicked = await tab.evaluate(cancelCardJs("recv"));
      if (!clicked) throw new Error("the page offered no Cancel on its in-flight receive");
      await sleep(300);
      await tab.evaluate(`(() => { window.__release[${JSON.stringify(name)}] = true; return true; })()`);
      await cli.waitLine(/^not delivered: the other side stopped the transfer$/, "the CLI to report the receiver's stop", { from, timeoutMs: 120_000 });
      observed.receiverCancel = { name, clicked, card: await awaitCardDone(tab, "recv", "the page's stopped receive to finish", 60_000, { orGone: true }) };
      step("cli → web stopped by the receiving page");
    }

    // ── 9. text still works both ways ────────────────────────────────────
    await sendText(tab, w2);
    await cli.waitStdout((s) => s.includes(w2 + "\n"), "the page's post-cancel message on the CLI's stdout");
    cli.write(c2);
    await tab.waitFor(`${msgBodies}.includes(${JSON.stringify(c2)})`, "the CLI's post-cancel message on the page", 60_000);
    step("text both ways after the cancels");
    // Read the thread NOW: once the CLI leaves, the page retires the workspace
    // and its thread with it, so a read after the ending sees nothing.
    observed.web.receivedMessages = await tab.evaluate(msgBodies);

    // ── 10. the ending ───────────────────────────────────────────────────
    if (PLAN.ending === "quit") {
      cli.write("/quit");
      observed.cliExit = await cli.waitExit("/quit", 60_000);
      step(`the CLI quit (exit ${observed.cliExit.code})`);
    } else {
      const name = PLAN.cliBatches.final.name;
      await tab.evaluate(`(() => { window.__holdNames.push(${JSON.stringify(name)}); return true; })()`);
      const from = cli.mark();
      cli.write(`/send ${JSON.stringify(PLAN.cliBatches.final.src)}`);
      await awaitConsent(tab, "the batch the CLI will abandon");
      await answerConsent(tab, true);
      await tab.waitFor(`!!window.__held[${JSON.stringify(name)}]`, "the page to hold the final batch's first write", 60_000);
      cli.signal("SIGINT");
      observed.cliExit = await cli.waitExit("SIGINT mid-transfer", 60_000);
      await tab.evaluate(`(() => { window.__release[${JSON.stringify(name)}] = true; return true; })()`);
      observed.interrupt = { name, from };
      step(`the CLI was interrupted mid-transfer (exit ${observed.cliExit.code})`);
    }
    // The page must SEE the CLI go: its header leaves the live state.
    await tab.waitFor(`(() => {
      const s = (document.querySelector('.wh-state')?.textContent ?? '').trim();
      return !!document.querySelector('.wh-restart') || /ended|left|disconnect|closed|结束|离开|断开/i.test(s);
    })()`, "the page to see the CLI leave", 60_000).catch(() => {});
    observed.web.endState = await tab.evaluate("(document.querySelector('.wh-state')?.textContent ?? '').trim()");
    await sleep(1_000);
    observed.web.messagesAfterEnd = await tab.evaluate(msgBodies);
    observed.web.saves = await readSaves(tab);
    observed.web.sdp = await tab.evaluate("window.__sdp");
    observed.web.errors = tab.errors.slice(0, 50);
    observed.complete = true;
  } finally {
    if (tab && !observed.complete) {
      try {
        observed.web.receivedMessages = await tab.evaluate(msgBodies);
        observed.web.saves = await tab.evaluate(SAVE_INDEX);
        observed.web.sdp = await tab.evaluate("window.__sdp");
        observed.web.errors = tab.errors.slice(0, 50);
      } catch { /* best effort on the failure path */ }
    }
    if (cli) {
      await cli.kill();
      observed.cli = cli.transcript();
    }
    writeObservation();
    if (!KEEP) await close();
  }
}

withWatchdog("cli ↔ web pairing", GLOBAL_TIMEOUT_MS, run).catch((err) => {
  try { writeObservation(); } catch { /* nothing more to do */ }
  console.error(`\n  \x1b[31m✗\x1b[0m ${err?.stack ?? err}`);
  process.exit(1);
});
