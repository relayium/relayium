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
 * The LINK role (who offers) follows from the two code-room ids: the smaller
 * id offers. The run's loopback acceptance server assigns ids from a fixed
 * schedule, one per ACCEPTED websocket in order, so the order in which the
 * sockets are accepted decides the roles — and this file makes that order
 * causal. The plan's `identity` lists every socket the round opens, with its
 * sequence and id: a CLI-minted round the CLI's, then the page's; a page-
 * minted round the page's LAN socket on `/`, its LAN socket on
 * `/cross-network`, its code-room socket after "create code" rebinds it, then
 * the CLI's. Each socket is opened only after the previous one passed its
 * barrier (`confirmSocket`):
 *
 *   * a page socket must be welcomed, in the page's own wire record, as its
 *     planned id, with no other socket in that document and — for the code
 *     room the page minted — a roster of the page ALONE;
 *   * the server's own log must show EXACTLY sequences 1..seq accepted with
 *     their scheduled ids (`cli-web-oracle.py accepted-prefix`: 3 = a shorter
 *     prefix, waited on; anything else ends the round at once);
 *   * every actor started so far (the CLI process, the tab) must still be
 *     alive when the prefix is exact — an actor that died is never handed
 *     over.
 *
 * A CLI-minted round's CLI prints its code before it dials, so the minted
 * line alone never starts the page. This file RECORDS both sides' own
 * statement of the role — the CLI's `linked with … (…, initiator|responder)`
 * line and the page's id comparison — and the page's wire record of every
 * document, socket, welcome and roster; `cli-web-oracle.py` judges them all
 * against the plan.
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
import { spawnSync } from "node:child_process";
import { appendFileSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
const SERVER_LOG = argFlag("--server-log", "");
/** Print-only seam: run the real socket sequence and barriers against a
 *  scripted world (see `checkBarrier`); no browser, CLI or server. */
const CHECK_BARRIER = argFlag("--check-barrier", "");
const PLAN = CHECK_BARRIER ? null : JSON.parse(readFileSync(argFlag("--plan", ""), "utf8"));
const KEEP = argPresent("--keep");
const GLOBAL_TIMEOUT_MS = 12 * 60_000;
const ORACLE = fileURLToPath(new URL("../../scripts/interop/cli-web-oracle.py", import.meta.url));
const ID16 = /^[0-9a-f]{16}$/;
const PENDING = 3;
/** The barrier's bound on the server's accept, in polls of ACCEPT_POLL_MS
 *  (60 s), far inside the CLI's own join wait. */
const ACCEPT_POLLS = 240;
const ACCEPT_POLL_MS = 250;
const WELCOME_TIMEOUT_MS = 45_000;

if (!CHECK_BARRIER && (!ORIGIN || !CLI_BIN || !XDG || !OUT || !SERVER_LOG)) {
  console.error("usage: cli-web-pairing.mjs --origin URL --cli BIN --xdg DIR --plan FILE --out FILE --server-log FILE");
  process.exit(2);
}
const CODE_ROLE = PLAN?.codeRole;
if (PLAN) {
  if (!["cli", "web"].includes(CODE_ROLE)) throw new Error(`plan.codeRole must be cli or web, not ${CODE_ROLE}`);
  if (!["quit", "interrupt"].includes(PLAN.ending)) throw new Error(`plan.ending must be quit or interrupt`);
  if (!PLAN.identity || !Array.isArray(PLAN.identity.sockets)) throw new Error("plan.identity must schedule this round's sockets");
}

const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const COMPOSER = ".msgpanel textarea";
const SEND = ".msgpanel button.send";
const ATTACH_FILE = ".msgpanel .attach-file";
const ATTACH_FOLDER = ".msgpanel .attach-folder";
const OPEN_WORKSPACE = ".open-workspace";

/** Everything OBSERVED, for the oracle. Nothing in here is a verdict. */
const observed = {
  round: PLAN?.round,
  codeRole: CODE_ROLE,
  verify: PLAN?.verify,
  ending: PLAN?.ending,
  code: "",
  steps: [],
  // One record per planned socket, in order, once its barrier passed.
  barriers: [],
  // Whether every client this round started was observed to exit.
  cleanup: { cliExited: null, browserExited: null },
  web: {
    role: "", selfId: "", peerId: "", sas: "", peerName: "",
    // The page's own websocket history: every document it loaded, every
    // socket each opened, every welcome and roster each socket received.
    // Read off each document BEFORE the next navigation replaces it. Judged.
    wire: { documents: [] },
    receivedMessages: [], saves: [], sendStatuses: {}, recvStatuses: {},
    endState: "", sdp: null, errors: [],
    // The page's EARLIEST link-establishment signalling, as metadata only (see
    // OBSERVE). Diagnostics: read back on success and on failure, judged by
    // nothing.
    establishment: null,
    establishmentStatus: "",
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

/** The establishment timeline, read best-effort: a diagnostic that cannot be
 *  read is recorded as null with its status, and never turns a round's result
 *  either way. */
async function readEstablishment(tab) {
  try {
    observed.web.establishment = await tab.evaluate("window.__establish ?? null");
    observed.web.establishmentStatus = observed.web.establishment ? "read" : "absent";
  } catch (err) {
    observed.web.establishment = null;
    observed.web.establishmentStatus = `unreadable: ${String(err?.message ?? err).slice(0, 120)}`;
  }
}

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
 *  CLI). Observation only: nothing here changes what the page sends.
 *
 *  `window.__establish` is the link-establishment timeline: the EARLIEST 64
 *  whitelisted entries — later ones only raise `omitted`, because the race this
 *  exists for happens in the first second — each a relative time and inert
 *  metadata: the roster (ids and count), `welcome`/`left`, and the KIND of a
 *  `caps`/`request`/`offer`/`busy` signal with its peer id, plus the page's own
 *  outgoing `busy`. No payload, SDP, ICE, code, key, account or path is copied.
 *  Every hook is best-effort and cannot throw into the page; `send` keeps its
 *  receiver, arguments, return value and exceptions. It is not claimed to cost
 *  zero time. */
const OBSERVE = `
  (() => {
    const wire = window.__wire = { path: location.pathname, sockets: [] };
    window.__sdp = { local: [], remote: [] };
    const EST_MAX = 64;
    const est = window.__establish = { max: EST_MAX, entries: [], omitted: 0 };
    const note = (e) => {
      if (est.entries.length < EST_MAX) est.entries.push(Object.assign({ t: Math.round(performance.now()) }, e));
      else est.omitted += 1;
    };
    window.__establishMark = (label) => {
      if (typeof label === 'string' && /^[a-z0-9:-]{1,40}$/.test(label)) note({ dir: 'mark', type: label });
    };
    const idOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
    const kindOf = (d) => {
      if (!d || typeof d !== 'object') return null;
      if (Array.isArray(d.caps)) return 'caps';
      if (d.busy === true) return 'busy';
      if (d.linkRequest === true && !d.sdp) return 'request';
      if (d.sdp && d.sdp.type === 'offer' && !d.resume) return 'offer';
      return null;
    };
    const capsOf = (d) => d.caps.filter((c) => typeof c === 'string' && /^[a-z0-9-]{1,16}\\/[0-9]{1,3}$/.test(c)).slice(0, 8);
    const inbound = (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'welcome') note({ dir: 'in', type: 'welcome', self: idOf(m.name) });
      else if (m.type === 'peers') {
        const list = Array.isArray(m.peers) ? m.peers : [];
        note({ dir: 'in', type: 'peers', count: list.length, ids: list.slice(0, 16).map((p) => idOf(p && p.id)) });
      } else if (m.type === 'left') note({ dir: 'in', type: 'left', peer: idOf(m.peer) });
      else if (m.type === 'signal') {
        const kind = kindOf(m.data);
        if (!kind) return;
        const e = { dir: 'in', type: 'signal', kind, peer: idOf(m.from), link: m.data.link === true };
        if (kind === 'caps') e.caps = capsOf(m.data);
        note(e);
      }
    };
    const Native = window.WebSocket;
    const seen = new WeakSet();
    const token = (v) => (typeof v === 'string' ? v.slice(0, 64) : null);
    window.WebSocket = function (...args) {
      const ws = new Native(...args);
      if (!seen.has(ws)) {
        seen.add(ws);
        // The judged record: path and room kind only (never the code), each
        // welcome's id and each roster's ids, as the page received them.
        let rec = null;
        try {
          const u = new URL(String(args[0]), location.href);
          rec = { path: u.pathname, room: u.searchParams.has('code') ? 'code' : 'lan', welcomes: [], rosters: [] };
        } catch { rec = { path: null, room: null, welcomes: [], rosters: [] }; }
        wire.sockets.push(rec);
        ws.addEventListener('message', (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m && m.type === 'welcome') rec.welcomes.push(token(m.name));
            if (m && m.type === 'peers') rec.rosters.push(Array.isArray(m.peers) ? m.peers.map((p) => token(p && p.id)) : null);
            try { inbound(m); } catch { /* diagnostics never throw into the page */ }
          } catch { /* not ours */ }
        });
      }
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
    const nativeSend = Native.prototype.send;
    Native.prototype.send = function (...args) {
      try {
        if (seen.has(this) && typeof args[0] === 'string') {
          const m = JSON.parse(args[0]);
          if (m && m.type === 'signal' && m.data && m.data.busy === true) {
            note({ dir: 'out', type: 'signal', kind: 'busy', peer: idOf(m.to), link: m.data.link === true });
          }
        }
      } catch { /* diagnostics never throw into the page */ }
      return nativeSend.apply(this, args);
    };
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

// ── the planned sockets and their barriers ───────────────────────────────────

/** Where each planned page socket lives: the document (its stage name and
 *  path) and its index among that document's sockets. A CLI-minted round's
 *  page loads `/cross-network#c=CODE` once; a page-minted round's loads `/`,
 *  then `/cross-network`, whose LAN socket "create code" rebinds. */
const PAGE_SLOTS = {
  cli: { "code-room": { doc: "code-link", path: "/cross-network", slot: 0 } },
  web: {
    landing: { doc: "landing", path: "/", slot: 0 },
    "cross-network": { doc: "cross-network", path: "/cross-network", slot: 0 },
    "code-room": { doc: "cross-network", path: "/cross-network", slot: 1 },
  },
};

/**
 * The barrier's verdict on one planned page socket, from the page's CURRENT
 * document record (`window.__wire`): `{pending: true}` while it has not been
 * welcomed yet (or the old document still answers), a problem string, or null.
 * `sole`: the page minted this code room, so nobody else may be in it yet.
 */
function welcomeVerdict(doc, codeRole, s) {
  const at = PAGE_SLOTS[codeRole]?.[s.stage];
  if (!at) return `no page socket is planned at stage ${s.stage}`;
  const where = `the page's ${s.stage} socket (seq ${s.seq})`;
  if (!doc || doc.path !== at.path || !Array.isArray(doc.sockets)) return { pending: true };
  const sockets = doc.sockets;
  if (sockets.length <= at.slot || !sockets[at.slot].welcomes?.length) {
    if (sockets.length > at.slot + 1) return `the page's ${at.doc} document opened ${sockets.length} websockets before ${where} was welcomed: an extra or reconnected socket`;
    return { pending: true };
  }
  if (sockets.length !== at.slot + 1) {
    return `the page's ${at.doc} document had opened ${sockets.length} websockets when ${where} was welcomed, not ${at.slot + 1}: an extra or reconnected socket`;
  }
  for (let i = 0; i <= at.slot; i++) {
    const n = sockets[i].welcomes?.length ?? 0;
    if (n !== 1) return `socket ${i + 1} of the page's ${at.doc} document saw ${n} welcomes, not one: a reconnect or a refused join`;
  }
  const sock = sockets[at.slot];
  const room = s.stage === "code-room" ? "code" : "lan";
  if (sock.path !== "/ws" || sock.room !== room) return `${where} is not a ${room}-room /ws socket (${sock.path}, ${sock.room})`;
  const got = sock.welcomes[0];
  if (typeof got !== "string" || !ID16.test(got)) return `${where} was welcomed with a malformed id ${JSON.stringify(got)}`;
  if (got !== s.id) return `${where} was welcomed as ${got}, but the schedule planned ${s.id}`;
  const rosters = Array.isArray(sock.rosters) ? sock.rosters : [];
  if (room === "lan") {
    const strangers = rosters.flatMap((r) => (Array.isArray(r) ? r : [null])).filter((id) => id !== got);
    if (strangers.length) return `${where} listed other clients in the LAN room: ${JSON.stringify(strangers)}`;
    return null;
  }
  if (codeRole === "web") {
    // The page minted this room: before the CLI starts, it is the room's only
    // member, and the page has SEEN that roster.
    if (!rosters.length) return { pending: true };
    const bad = rosters.find((r) => !(Array.isArray(r) && r.length === 1 && r[0] === got));
    if (bad !== undefined) return `${where}'s room was not the page alone before the CLI started: roster ${JSON.stringify(bad)}`;
  }
  return null;
}

/** The server's accepted prefix, judged by the oracle on its own log. */
function acceptedPrefix(log, schedule, n) {
  const r = spawnSync("python3", ["-B", ORACLE, "accepted-prefix", log, schedule.join(","), String(n)],
    { encoding: "utf8", timeout: 20_000 });
  return { code: r.status, err: (r.stderr ?? "").trim() };
}

/**
 * One planned socket's barrier; see the header. `deps` are the world's seams:
 * `welcome(s)` resolves once the page welcomed `s` (throws its problem),
 * `prefix(n)` is the oracle's `{code, err}`, `deadActor()` names an actor that
 * died (or null), `sleep(ms)`. Returns the barrier record; throws otherwise.
 */
async function confirmSocket(s, deps) {
  const who = `${s.actor === "cli" ? "the CLI's" : "the page's"} ${s.stage} socket (seq ${s.seq}, planned ${s.id})`;
  if (s.actor === "web") await deps.welcome(s);
  for (let polls = 0; ; polls++) {
    const r = deps.prefix(s.seq);
    if (r.code !== 0 && r.code !== PENDING) {
      throw new Error(`${who}: the server's accepted sockets cannot become the schedule's first ${s.seq} (oracle exit ${r.code}): ${r.err}`);
    }
    const dead = await deps.deadActor();
    if (dead) {
      throw new Error(`${who}: ${dead} ${r.code === 0 ? "by the time the server had accepted it; it is not handed over" : "before the server accepted it"}`);
    }
    if (r.code === 0) break;
    if (polls >= deps.polls) throw new Error(`${who}: the server did not accept it within ${polls} polls: ${r.err}`);
    await deps.sleep(ACCEPT_POLL_MS);
  }
  return { seq: s.seq, actor: s.actor, stage: s.stage, status: "exact", alive: true };
}

/** Open the round's planned sockets in order, each only after the previous
 *  one passed its barrier. `openers[actor:stage](s)` opens one socket. */
async function openInOrder(identity, openers, deps, barriers) {
  for (const s of identity.sockets) {
    const open = openers[`${s.actor}:${s.stage}`];
    if (!open) throw new Error(`no opener for the planned ${s.actor}:${s.stage} socket`);
    await open(s);
    barriers.push(await confirmSocket(s, deps));
  }
}

/**
 * The print-only seam (`--check-barrier SCENARIO.json`): the REAL
 * `openInOrder`, `confirmSocket`, `welcomeVerdict` and oracle against a
 * scripted world. The scenario names the plan's `identity` and `codeRole`, a
 * server log file the seam owns, and what happens: `onOpen[actor:stage]`
 * appends log text (`append`), sets the page's current document (`doc`)
 * and/or kills an actor (`die`); `appendAt[poll]` appends log text on that
 * barrier poll; `dieAt[poll]` kills an actor there. Prints `{events,
 * barriers, polls, error}`; opens, spawns and connects to nothing.
 */
async function checkBarrier(file) {
  const sc = JSON.parse(readFileSync(file, "utf8"));
  const events = [];
  const barriers = [];
  let doc = null;
  let dead = null;
  let polls = 0;
  const apply = (fx = {}) => {
    if (fx.append) appendFileSync(sc.log, fx.append);
    if (fx.doc !== undefined) doc = fx.doc;
    if (fx.die) dead = fx.die;
  };
  const openers = {};
  for (const s of sc.identity.sockets) {
    const key = `${s.actor}:${s.stage}`;
    openers[key] = async () => { events.push(`open ${key}`); apply(sc.onOpen?.[key]); };
  }
  const deps = {
    welcome: async (s) => {
      const v = welcomeVerdict(doc, sc.codeRole, s);
      if (v && v.pending) throw new Error(`the page's ${s.stage} socket (seq ${s.seq}) was never welcomed`);
      if (v) throw new Error(v);
      events.push(`welcomed ${s.seq}`);
    },
    prefix: (n) => acceptedPrefix(sc.log, sc.identity.schedule, n),
    deadActor: async () => dead,
    sleep: async () => {
      polls += 1;
      if (sc.appendAt?.[polls]) appendFileSync(sc.log, sc.appendAt[polls]);
      if (sc.dieAt?.[polls]) dead = sc.dieAt[polls];
    },
    polls: sc.polls ?? 4,
  };
  let error = null;
  try {
    await openInOrder(sc.identity, openers, deps, barriers);
  } catch (err) {
    error = String(err?.message ?? err);
  }
  process.stdout.write(JSON.stringify({ events, barriers, polls, error }) + "\n");
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
  // The page's documents, archived before each navigation replaces one.
  let currentDoc = "";
  const readWire = async () => tab.evaluate("window.__wire ?? null");
  const archiveDocument = async () => {
    if (!tab || !currentDoc) return;
    const w = await readWire();
    observed.web.wire.documents.push({ stage: currentDoc, sockets: w?.sockets ?? null });
    currentDoc = "";
  };
  try {
    const preference = PLAN.verify === "on" ? VERIFY_ON : VERIFY_DEFAULT;
    const init = preference + OBSERVE + LEDGER;

    const identity = PLAN.identity;
    const schedule = identity.schedule;
    const openers = {
      // A CLI-minted round: the CLI first. Its minted line is printed BEFORE it
      // dials, so the barrier on its accepted socket, not this line, is what
      // lets the page start.
      "cli:code-room": async () => {
        if (CODE_ROLE === "cli") {
          cli = startCli({ bin: CLI_BIN, args: cliArgs, env: cliEnv, label: "cli" });
          const { match } = await cli.waitLine(MINTED_RE, "the CLI to mint a code", { timeoutMs: 30_000 });
          observed.code = match[1];
          step(`the CLI minted ${observed.code}`);
        } else {
          cli = startCli({ bin: CLI_BIN, args: [...cliArgs, observed.code], env: cliEnv, label: "cli" });
          step(`the CLI joins ${observed.code}`);
        }
      },
      // The page joining the code the CLI minted, or the page's own room.
      "web:code-room": async () => {
        if (CODE_ROLE === "cli") {
          tab = await newTab(browser, `${ORIGIN}/cross-network#c=${observed.code}`, init);
          currentDoc = "code-link";
          return;
        }
        await tab.waitFor(`(() => { const b = document.querySelector('.create-code'); return !!b && !b.disabled; })()`,
          "the page's create-code control", 45_000);
        await tab.evaluate("(() => { window.__establishMark?.('create-code:before'); document.querySelector('.create-code').click(); window.__establishMark?.('create-code:after'); return true; })()");
        await tab.waitFor(`/^\\S{4,}$/.test((document.querySelector('.code')?.textContent ?? '').trim())`,
          "the page to show the code it minted", 45_000);
        observed.code = await tab.evaluate("document.querySelector('.code').textContent.trim()");
        step(`the page minted ${observed.code}`);
      },
      // A page-minted round: the landing page's LAN socket first…
      "web:landing": async () => {
        tab = await newTab(browser, `${ORIGIN}/`, init);
        currentDoc = "landing";
      },
      // …then, with that socket accepted and welcomed as planned, the sign-in
      // through the product's own endpoint (the password travels from the
      // environment into the page, never through argv) and `/cross-network`.
      "web:cross-network": async () => {
        const email = process.env.RELAYIUM_ACCEPTANCE_EMAIL ?? "";
        const password = process.env.RELAYIUM_ACCEPTANCE_PASSWORD ?? "";
        if (!email || !password) throw new Error("code-role web needs RELAYIUM_ACCEPTANCE_EMAIL/PASSWORD in the environment");
        await tab.waitFor("document.readyState === 'complete'", "the landing page", 30_000);
        const login = await tab.evaluate(`fetch('/api/auth/password/login', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
        }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) }))`);
        if (login.status !== 200) throw new Error(`the page could not sign in (HTTP ${login.status}: ${login.body})`);
        await archiveDocument();
        await tab.send("Page.navigate", { url: `${ORIGIN}/cross-network` });
        currentDoc = "cross-network";
      },
    };
    const deps = {
      welcome: async (s) => {
        const deadline = Date.now() + WELCOME_TIMEOUT_MS;
        for (;;) {
          let v;
          try { v = welcomeVerdict(await readWire(), CODE_ROLE, s); } catch { v = { pending: true }; }
          if (!v) return;
          if (!v.pending) throw new Error(v);
          if (Date.now() > deadline) throw new Error(`the page's ${s.stage} socket (seq ${s.seq}) was never welcomed within ${WELCOME_TIMEOUT_MS} ms`);
          await sleep(100);
        }
      },
      prefix: (n) => acceptedPrefix(SERVER_LOG, schedule, n),
      deadActor: async () => {
        if (cli?.exit) return `the CLI exited (${JSON.stringify(cli.exit)})`;
        if (tab) {
          try { await tab.evaluate("1"); } catch (err) { return `the page is gone (${String(err?.message ?? err).slice(0, 120)})`; }
        }
        return null;
      },
      sleep: (ms) => sleep(ms),
      polls: ACCEPT_POLLS,
    };
    await openInOrder(identity, openers, deps, observed.barriers);
    step(`every planned socket accepted in order: ${observed.barriers.map((b) => `${b.seq} ${b.actor}:${b.stage}`).join(", ")}`);
    await setWideViewport(tab, 1280, 900);

    // ── 1. link + admission on both ends ────────────────────────────────
    // The page's own view of the code room: its welcome and the CLI in the
    // roster beside it, from the judged wire record.
    const slot = PAGE_SLOTS[CODE_ROLE]["code-room"].slot;
    await tab.waitFor(`(() => { const r = window.__wire?.sockets?.[${slot}]?.rosters ?? []; const last = r[r.length - 1]; return Array.isArray(last) && last.length >= 2; })()`,
      "the CLI to join the code room", 90_000);
    const ids = await tab.evaluate(`(() => {
      const s = window.__wire.sockets[${slot}];
      const self = s.welcomes[0] ?? '';
      const last = s.rosters[s.rosters.length - 1] ?? [];
      return { self, peer: last.find((p) => p !== self) ?? '' };
    })()`);
    Object.assign(observed.web, {
      selfId: ids.self, peerId: ids.peer,
      role: ids.self && ids.peer ? (ids.self < ids.peer ? "initiator" : "responder") : "",
    });
    await tab.evaluate(`(() => { window.__establishMark?.('open-workspace:before'); const b = document.querySelector('${OPEN_WORKSPACE}'); if (b) b.click(); window.__establishMark?.(b ? 'open-workspace:after' : 'open-workspace:absent'); return !!b; })()`)
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
      // pair.go reports the outcome and the cleanup on two lines since
      // b897f15bd: "not saved: the sender cancelled", then the discard line
      // that alone claims "nothing from it was kept". Both are required here
      // and counted exactly by the oracle.
      await cli.waitLine(/^not saved: the sender cancelled$/, "the CLI to report the sender's cancel", { from, timeoutMs: 120_000 });
      await cli.waitLine(/^the partial files of that batch were removed; nothing from it was kept$/, "the CLI to report the discard of the cancelled batch", { from, timeoutMs: 30_000 });
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
    await readEstablishment(tab);
    observed.web.errors = tab.errors.slice(0, 50);
    await archiveDocument();
    observed.complete = true;
  } finally {
    if (tab && !observed.complete) {
      try {
        observed.web.receivedMessages = await tab.evaluate(msgBodies);
        observed.web.saves = await tab.evaluate(SAVE_INDEX);
        observed.web.sdp = await tab.evaluate("window.__sdp");
        observed.web.errors = tab.errors.slice(0, 50);
      } catch { /* best effort on the failure path */ }
      // Separately, so a failed read above cannot cost the timeline the
      // failure path most needs.
      await readEstablishment(tab);
      try { await archiveDocument(); } catch { /* best effort on the failure path */ }
    }
    // Every client this round started, gone before the shell counts the
    // server's accepted sockets: the CLI reaped, Chrome observed to exit.
    if (cli) {
      await cli.kill();
      observed.cli = cli.transcript();
    }
    observed.cleanup.cliExited = cli ? cli.exit !== null : true;
    observed.cleanup.browserExited = KEEP ? false : (await close())?.exited === true;
    writeObservation();
  }
  if (!observed.cleanup.cliExited || !observed.cleanup.browserExited) {
    throw new Error(`the round's clients were not all observed to exit: ${JSON.stringify(observed.cleanup)}`);
  }
}

if (CHECK_BARRIER) {
  checkBarrier(CHECK_BARRIER).then(() => process.exit(0), (err) => { console.error(String(err?.stack ?? err)); process.exit(2); });
} else {
  withWatchdog("cli ↔ web pairing", GLOBAL_TIMEOUT_MS, run).catch((err) => {
    try { writeObservation(); } catch { /* nothing more to do */ }
    console.error(`\n  \x1b[31m✗\x1b[0m ${err?.stack ?? err}`);
    process.exit(1);
  });
}
