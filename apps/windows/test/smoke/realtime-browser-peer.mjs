// The BROWSER half, as a CDP CONNECTION and nothing else.
//
// ## Why this file exists at all
//
// `web/e2e/native-pairing-browser.mjs` is a whole Node process that calls
// `launchBrowser`, and `launchBrowser` owns the Chrome it spawns: its `close()`
// is `chrome.kill(); await sleep(500)` with a swallowed profile removal
// (`web/e2e/harness.mjs:645-655`), and its profile lives in the SHARED
// `tmpdir()/relayium-e2e-` namespace (`:616`). Joining that Node process is not
// joining Chrome — on Windows, killing the Node half would leave the browser
// behind entirely — and a profile prefix shared by every e2e in the workspace
// cannot attribute a process to one run. This fixture is held to an exact
// owned-PID join with retained cleanup, so it cannot delegate process ownership.
//
// So the ORCHESTRATOR spawns Chrome and holds the real `ChildProcess`, records
// its ledger before the first await, and joins it. This module receives a debug
// port that is already up and does one thing: drive the page.
//
// ## Nothing is reimplemented
//
// Every CDP and page primitive is imported from the shared harness, unchanged
// and read-only: `cdp` (`harness.mjs:182`), `newTab` (`:270`),
// `setWideViewport` (`:436`), `SAVE_STUB` (`:447`), `VERIFY_ON` (`:489`). Only
// `launchBrowser` — the process-owning part — is bypassed. The scenario below is
// the shape of `native-pairing-browser.mjs`, which stays untouched and still
// owns the macOS lane.
//
// What driving the tab directly buys, beyond ownership: the file batch is built
// HERE, in the page, so it is no longer limited by a command line. That is what
// makes a `CHUNK_SIZE + 1` file and a multi-file batch expressible in the
// browser -> Windows direction, where they land on the real Windows destination.
import { cdp, newTab, setWideViewport, SAVE_STUB, VERIFY_ON, VERIFY_DEFAULT } from "../../../../web/e2e/harness.mjs";

const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const COMPOSER = ".msgpanel textarea";
const SEND = ".msgpanel button.send";
const ATTACH_FILE = ".msgpanel .attach-file";
const OPEN_WORKSPACE = ".open-workspace";

/** Publish the ids the page already has, without changing any behaviour. The
 *  role is the clients' own `selfId < peerId` rule; this only REPORTS which
 *  assignment a round exercised. Same probe as the macOS lane's. */
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
          if (m && m.type === 'peers' && Array.isArray(m.peers)) window.__relayiumPeers = m.peers.map((p) => p.id);
        } catch { /* not ours */ }
      });
    };
    const Native = window.WebSocket;
    window.WebSocket = function (...args) { const ws = new Native(...args); hook(ws); return ws; };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
  })();
`;

/** The CDP endpoint of a browser SOMEBODY ELSE started and owns. */
export async function connectToOwnedBrowser(debugPort, readyMs, signal) {
  const deadline = Date.now() + readyMs;
  let last = "never answered";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2_000) });
      const { webSocketDebuggerUrl } = await res.json();
      if (webSocketDebuggerUrl) {
        const client = cdp(webSocketDebuggerUrl);
        // `cdp` returns as soon as the socket is CONSTRUCTED; `open` is what
        // says it is usable. Sending before it resolves is "Sent before
        // connected." — a failure that reads like the page, not the transport.
        await client.open;
        return client;
      }
    } catch (err) {
      last = String(err?.message ?? err);
    }
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the owned browser's CDP port ${debugPort} was not usable within ${readyMs}ms: ${last}`);
}

/**
 * Ask the browser to shut ITSELF down, then drop the socket.
 *
 * `cdp(...).close()` is `ws.close()` and nothing more (`harness.mjs:210`): it
 * ends the debugging connection and leaves the browser running. Terminating the
 * parent afterwards is not sufficient either — Chrome is a process TREE, and on
 * Windows `ChildProcess.kill` is `TerminateProcess` on the parent alone, which
 * does not account for its renderer, GPU and utility children.
 *
 * `Browser.close` is the graceful path: Chrome tears its own tree down and the
 * parent then exits normally, which is the only shutdown that accounts for every
 * process without this fixture having to enumerate them. It is bounded, and the
 * caller still JOINS the parent afterwards — a browser that ignored this is
 * reported, not assumed gone.
 */
export async function closeOwnedBrowser(client, budgetMs = 10_000) {
  let graceful = false;
  try {
    await Promise.race([
      client.send("Browser.close").then(() => { graceful = true; }),
      new Promise((r) => setTimeout(r, budgetMs)),
    ]);
  } catch {
    // A browser that is already going away rejects this; the join decides.
  }
  try { client.close(); } catch { /* already closed */ }
  return { graceful };
}

/**
 * One round, from the browser's side.
 *
 * Returns what the PAGE believed. Every comparison is the orchestrator's, so a
 * mistake here surfaces there as a failed check rather than as a pass this file
 * granted itself.
 */
export async function driveBrowserPeer(browser, options) {
  const {
    origin, code, message, files, expectMessage, verify = true,
    joinBudgetMs = 90_000, transferBudgetMs = 120_000,
  } = options;

  const observed = {
    reachedWorkspace: false, sas: "", role: "", selfId: "", peerId: "",
    verify: verify ? "on" : "default",
    receivedMessages: [], receivedFileName: "", receivedFileHex: "", receivedBytes: 0,
    sentMessage: message, sentFiles: files.map((f) => f.name), notes: [],
  };

  observed.failure = null;
  try {
  const tab = await newTab(browser, `${origin}/cross-network#c=${code}`,
    (verify ? VERIFY_ON : VERIFY_DEFAULT) + EXPOSE_IDS + SAVE_STUB);
  await setWideViewport(tab, 1280, 900);

  await tab.waitFor("(window.__relayiumPeers ?? []).length >= 2", "the Windows peer to join the code room", joinBudgetMs);
  const ids = await tab.evaluate(`(() => {
    const peers = window.__relayiumPeers ?? [];
    const self = window.__relayiumSelfId ?? '';
    return { self, peer: peers.find((p) => p !== self) ?? '' };
  })()`);
  observed.selfId = ids.self;
  observed.peerId = ids.peer;
  observed.role = ids.self && ids.peer ? (ids.self < ids.peer ? "initiator" : "responder") : "";

  // Whichever side the ids made the asker, the workspace has to arrive.
  //
  // ## Why this polls instead of clicking once
  //
  // It used to click exactly once, best-effort, with the failure swallowed —
  // and then wait ninety seconds for a header that nothing would ever produce
  // if that click had found no button. The two peers being visible to each
  // other does not mean the control is rendered yet; it is the next paint.
  //
  // Run 34655707714 is what that looks like from outside: round 1 reported
  // `browserRole=initiator`, which can only be set AFTER both peers were seen,
  // and then timed out on the header with no notes at all. Round 2 drew
  // responder — where the other side asks, so a missed click costs nothing —
  // and round 3 drew initiator with the button already there. Only the round
  // that had to click, and clicked too early, hung.
  //
  // So the ask is retried until the workspace arrives, and what happened is
  // RECORDED either way: a control that never appears within the budget is a
  // different fact from one that appeared and did not open anything, and a
  // ninety-second silence cannot tell them apart.
  let clicks = 0;
  let sawControl = false;
  let opened = false;
  const openDeadline = Date.now() + joinBudgetMs;
  for (;;) {
    opened = await tab.evaluate(`!!document.querySelector('${HEAD}')`).catch(() => false);
    if (opened) break;
    const clicked = await tab
      .evaluate(`(() => { const b = document.querySelector('${OPEN_WORKSPACE}'); if (!b) return false; b.click(); return true; })()`)
      .catch(() => false);
    if (clicked) {
      sawControl = true;
      clicks += 1;
    }
    if (Date.now() >= openDeadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (opened) {
    // Worth seeing in a GREEN run: more than one ask means the first was early,
    // which is the condition that used to be fatal rather than merely noted.
    if (clicks > 1) observed.notes.push(`the workspace was asked for ${clicks} times before it opened`);
  } else {
    // Only here. On a responder round the other side opens the workspace and
    // this control is never meant to exist, so its absence is unremarkable
    // until the header has also failed to arrive.
    observed.notes.push(
      sawControl
        ? `the workspace was asked for ${clicks} times and never opened`
        : `no open-workspace control appeared, and neither did the workspace :: ${await tab
            .evaluate("document.body.innerText.slice(0, 300)")
            .catch(() => "(the page could not be read)")}`,
    );
  }
  await tab.waitFor(`!!document.querySelector('${HEAD}')`, "the unified workspace header", joinBudgetMs);
  observed.reachedWorkspace = true;

  if (verify) {
    await tab.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "the verification code", 30_000);
    observed.sas = await tab.evaluate(`document.querySelector('${HEAD_SAS}').textContent.trim()`);
    const surfaces = await tab.evaluate("document.querySelectorAll('.sas').length");
    if (surfaces !== 1) observed.notes.push(`the page showed ${surfaces} verification surfaces, not one`);
  }

  // ---- the browser sends a message ---------------------------------------
  //
  // ## The composer is GATED, and the gate is a real decision
  //
  // `MessagePanel` renders no textarea while `status === "incomingRequest"`: it
  // renders Accept and Reject instead, and delivers no body until `accept()`
  // (`web/src/lib/MessagePanel.svelte:100-101,193-201`). `canSend` additionally
  // requires `status === "open"` (`:95`). So a peer that is offered a session
  // must ACCEPT IT — the way a person does, by pressing the button — before it
  // has anything to type into. Waiting on the textarea alone deadlocks whenever
  // the other side spoke first, which is exactly what this fixture saw.
  //
  // Nothing is forced: no state is written, no protocol step is skipped, and if
  // no offer is pending the loop simply waits for the composer to arrive.
  const ACCEPT = ".msgpanel .act .btn-primary, .request .btn-primary";
  const settled = await tab.waitFor(`(() => {
    const accept = document.querySelector('${ACCEPT}');
    if (accept) { accept.click(); return false; }
    return !!document.querySelector('${COMPOSER}');
  })()`, "the composer, accepting any offered session on the way", joinBudgetMs)
    .then(() => true).catch(() => false);
  if (!settled) {
    observed.notes.push(`no composer :: ${await tab.evaluate(
      `(() => { const p = document.querySelector('.msgpanel');
        return JSON.stringify({ present: !!p, text: (p?.textContent ?? '').slice(0, 200),
          controls: [...document.querySelectorAll('.msgpanel button, .msgpanel textarea')].map((e) => e.tagName + '.' + e.className) }); })()`
    ).catch((e) => String(e))}`);
    throw new Error("the composer never arrived");
  }

  // Send only becomes available at `status === "open"`, which is the far side
  // having accepted. Re-asserting the draft while waiting is deliberate: a
  // Svelte re-render at the connecting -> open boundary would otherwise discard
  // the one synthetic input event and leave Send disabled forever.
  const enabled = await tab.waitFor(`(() => {
    const ta = document.querySelector('${COMPOSER}');
    const send = document.querySelector('${SEND}');
    if (!ta || !send) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    if (ta.value !== ${JSON.stringify(message)}) {
      setter.call(ta, ${JSON.stringify(message)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return !send.disabled;
  })()`, "Send to become available", transferBudgetMs).then(() => true).catch(() => false);
  if (!enabled) {
    observed.notes.push(`Send never enabled :: ${await tab.evaluate(
      `(() => { const p = document.querySelector('.msgpanel');
        return JSON.stringify({ text: (p?.textContent ?? '').slice(0, 200),
          draft: document.querySelector('${COMPOSER}')?.value ?? null }); })()`
    ).catch((e) => String(e))}`);
    throw new Error("Send never became available");
  }
  await tab.evaluate(`(() => { document.querySelector('${SEND}').click(); return true; })()`);

  // ---- and a REAL batch: nested, empty, and across the chunk boundary -----
  const handed = await tab.evaluate(`(() => {
    const input = document.querySelector('${ATTACH_FILE}');
    if (!input) return { ok: false, why: 'no attachment control in the unified workspace' };
    if (input.disabled) return { ok: false, why: 'the attachment control was disabled' };
    const filled = (n, seed) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
      return out;
    };
    const dt = new DataTransfer();
    let total = 0;
    for (const spec of ${JSON.stringify(files)}) {
      const bytes = spec.text !== undefined ? new TextEncoder().encode(spec.text) : filled(spec.size, spec.seed);
      total += bytes.byteLength;
      dt.items.add(new File([bytes], spec.name));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, total, names: [...dt.files].map((f) => f.name) };
  })()`);
  if (!handed.ok) observed.notes.push(`the browser could not hand over its batch: ${handed.why}`);

  // ---- and receives the Windows side's message and file ------------------
  await tab.waitFor(
    expectMessage
      ? `[...document.querySelectorAll('.msg-body')].some((el) => el.textContent === ${JSON.stringify(expectMessage)})`
      : "document.querySelectorAll('.msg-body').length >= 1",
    "the Windows peer's message to render", transferBudgetMs);
  observed.receivedMessages = await tab.evaluate(
    `[...document.querySelectorAll('.msg-body')].map((el) => el.textContent)`);

  // An inbound batch needs consent; accepting it is the person on screen.
  const written = await tab.waitFor(`(() => {
    const req = document.querySelector('.request .btn-primary');
    if (req) { req.click(); return false; }
    return !!(window.__e2e && window.__e2e.closed);
  })()`, "the Windows peer's file, accepting its consent card on the way", transferBudgetMs)
    .then(() => true).catch(() => false);
  if (!written) {
    observed.notes.push(`no inbound file :: ${await tab.evaluate(
      `JSON.stringify({ opens: window.__e2e?.opens ?? 0, bytes: window.__e2e?.bytes ?? 0,
        closed: window.__e2e?.closed ?? false, request: !!document.querySelector('.request') })`
    ).catch((e) => String(e))}`);
    throw new Error("the inbound file never completed");
  }
  const saved = await tab.evaluate(`(() => {
    const bytes = window.__e2e.chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(bytes);
    let o = 0;
    for (const c of window.__e2e.chunks) { out.set(new Uint8Array(c), o); o += c.byteLength; }
    return {
      name: window.__e2e.name,
      bytes,
      hex: [...out].map((b) => b.toString(16).padStart(2, '0')).join(''),
    };
  })()`);
  observed.receivedFileName = saved.name;
  observed.receivedBytes = saved.bytes;
  observed.receivedFileHex = saved.hex;
  } catch (err) {
    // A partial round still knows things — which role it drew, whether the
    // workspace opened, what SAS it saw. Throwing would discard exactly the
    // evidence a failure needs, so the failure travels IN the observations.
    observed.failure = String(err?.message ?? err);
  }
  return observed;
}
