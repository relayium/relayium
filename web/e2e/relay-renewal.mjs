#!/usr/bin/env node
// Real-browser acceptance for relay renewal: `npm run test:e2e:relay-renewal`.
//
// ## What this proves that no unit test can
//
// The renewal controller's hardest claims are about what a REAL ICE agent does:
// that `createOffer({iceRestart:true})` mints a new ufrag, that the candidates
// gathered afterwards carry it in their own string, that `getStats()` keeps the
// PREVIOUS generation's nominated pair alongside the new one, and that a
// responder's `currentRemoteDescription` is still the old generation while the
// new offer is pending. Every one of those was a defect found only by looking
// at Chrome, and a fake peer connection can be written to agree with whatever
// the implementation already believes.
//
// So this loads the SHIPPED modules — `relay-renew.ts`, `relay-renew-wire.ts`
// and `webrtc-core.ts`, bundled from source, not reimplemented — into a real
// page and drives two real `RTCPeerConnection`s through a complete migration.
//
// ## What it deliberately does NOT prove
//
// **Not a product acceptance.** There is no server here: the `ice-renew` round
// endpoint is implemented in a parallel batch and does not exist yet, so the
// grant is supplied by a local stub. There is no TURN relay either — the two
// peers connect over host candidates on the loopback, which exercises the ICE
// restart and the generation bookkeeping but not an actual relay allocation
// being retired.
//
// The honest claim is therefore: the shipped client state machine performs a
// real ICE migration in a real browser and commits only on real path evidence.
// A relay-backed, server-backed, accelerated-expiry product run is a separate
// gate and is still PENDING. Do not describe a green run here as "renewal
// works end to end".

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import {
  argFlag, argPresent, fail, launchBrowser, newTab, ok, sleep, startPreview, withWatchdog,
} from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");

/**
 * Bundle the production modules into one IIFE the page can run.
 *
 * Bundled rather than served from `dist`, because `dist` exports the app, not
 * these internals — and rather than copied, because a copy is a second
 * implementation that can pass while the shipped one is broken. The entry below
 * is the ONLY thing written for this test; everything it imports is product
 * source.
 */
async function bundleController() {
  const dir = mkdtempSync(join(tmpdir(), "relayium-renew-e2e-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `
import { createRelayRenewal } from ${JSON.stringify(join(WEB, "src/lib/relay-renew.ts"))};
import { establish, LINK_CHANNEL_LABELS, selectedCandidatePair } from ${JSON.stringify(join(WEB, "src/lib/webrtc-core.ts"))};
import * as wire from ${JSON.stringify(join(WEB, "src/lib/relay-renew-wire.ts"))};
globalThis.RELAYIUM_RENEW = { createRelayRenewal, establish, LINK_CHANNEL_LABELS, selectedCandidatePair, wire };
`);
  const build = await rolldown({ input: entry, platform: "browser" });
  const { output } = await build.generate({ format: "iife", inlineDynamicImports: true });
  await build.close();
  rmSync(dir, { recursive: true, force: true });
  return output.map((chunk) => chunk.code ?? "").join("\n");
}

/**
 * The page-side scenario.
 *
 * Two real peer connections in one page, linked by a direct signalling shim.
 * The link is established first — which is what pins the renewal baseline —
 * and then the two REAL controllers drive a migration over it.
 *
 * Written as a string because it runs inside the browser, and kept to
 * orchestration only: every decision is the shipped module's.
 */
const SCENARIO = `globalThis.__renew = { done: false };
globalThis.__renewRun = (async () => {
  const { createRelayRenewal, establish, LINK_CHANNEL_LABELS, wire } = globalThis.RELAYIUM_RENEW;
  const log = [];
  const note = (m, extra) => log.push(extra === undefined ? m : m + " " + JSON.stringify(extra));

  // ── one shared secret, exactly as a link derives ─────────────────────────
  const raw = new Uint8Array(32); crypto.getRandomValues(raw);
  const resumeAuth = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

  // ── a signalling shim: two endpoints, each delivering to the other ───────
  const listeners = { A: [], B: [] };
  const client = (self, peer) => ({
    onSignal(cb) { listeners[self].push(cb); return () => { const i = listeners[self].indexOf(cb); if (i >= 0) listeners[self].splice(i, 1); }; },
    sendSignal(_to, data) {
      // Asynchronous, like a real socket: a synchronous hand-off would hide
      // every ordering hazard this whole design is about.
      setTimeout(() => { for (const cb of [...listeners[peer]]) cb(self === "A" ? "peer-a" : "peer-b", data); }, 0);
    },
  });

  // ── establish the link itself (epoch 0) ──────────────────────────────────
  const config = { iceServers: [] };
  const aConn = establish({
    signaling: client("A", "B"), peerId: "peer-b", role: "initiator",
    generation: "link", channelLabels: LINK_CHANNEL_LABELS, config,
  });
  let bConn = null;
  listeners.B.push(function first(from, data) {
    if (bConn || !data || !data.link || !data.sdp || data.sdp.type !== "offer") return;
    bConn = establish({
      signaling: client("B", "A"), peerId: "peer-a", role: "responder",
      generation: "link", channelLabels: LINK_CHANNEL_LABELS, config,
      initialSignal: data,
    });
  });
  const a = await aConn;
  const b = await bConn;
  note("link established");

  if (!a.renew || !b.renew) throw new Error("no renewal surface on the transport");
  const baselineA = a.renew.baseline();
  const baselineB = b.renew.baseline();
  if (!baselineA || !baselineB) throw new Error("no baseline pinned at epoch 0");
  note("baseline pinned", { a: baselineA.fingerprints.length, b: baselineB.fingerprints.length });

  const ufrag0 = { a: a.renew.localUfrag(), b: b.renew.localUfrag() };
  note("epoch 0 ufrags", ufrag0);

  // ── two real controllers ─────────────────────────────────────────────────
  const now = () => Date.now();
  const GRANT_EXPIRY = Math.floor((Date.now() + 2 * 3600_000) / 1000);
  const make = (self, peer, conn, role) => {
    const state = { commits: [], states: [], requests: 0, renewal: null };
    const link = {
      peerId: peer, role, conn,
      textChannel: conn.getChannel("relayium-text"),
      keys: { resumeAuth },
    };
    // The lane demux, exactly as mixed-session installs it: a control frame is
    // consumed before anything else can see it.
    link.textChannel.binaryType = "arraybuffer";
    link.textChannel.onmessage = (ev) => {
      if (state.renewal.frame(ev.data)) return;
      note("non-control frame reached the lane");
    };
    state.renewal = createRelayRenewal({
      selfId: () => self,
      now,
      sendSignal: (_to, envelope) => client(self === "peer-a" ? "A" : "B", self === "peer-a" ? "B" : "A").sendSignal(peer, envelope),
      requestRound: async (round, rid) => {
        state.requests++;
        // **One side's reply is delayed by a second, deliberately.**
        //
        // The two peers ask the server independently and the replies come back
        // whenever they come back; a harness where both settle in the same turn
        // only ever exercises the ordering where a peer's READY arrives after
        // this side already has its own configuration. The other ordering is
        // ordinary, and it deadlocked: the peer's READY was dropped, no ICE
        // was restarted, and both ends waited out the epoch. Delaying the
        // INITIATOR is the case that does not self-heal.
        if (self === "peer-a") await new Promise((r) => setTimeout(r, 1000));
        // The server stub. Shaped exactly like /api/ice, per §2.2.
        return { status: "granted", round, rid, iceServers: [{ urls: ["turn:stub.invalid:3478"], username: GRANT_EXPIRY + ":token", credential: "x" }] };
      },
      peerSupportsRenew: () => true,
      userActive: () => true,
      deadline: () => state.deadline,
      deadlineAnchor: () => state.anchor,
      renewedConfig: (grant) => ({
        // Deliberately the SAME empty ice config: there is no TURN server here,
        // so the migration must succeed on the restart alone. What is being
        // tested is the generation bookkeeping, not relay allocation.
        rtc: { iceServers: [] },
        deadline: { expiresAt: GRANT_EXPIRY * 1000, deadlineAt: GRANT_EXPIRY * 1000 - 60_000, warnAt: GRANT_EXPIRY * 1000 - 300_000 },
      }),
      commit: (deadline, round) => { state.commits.push({ deadlineAt: deadline.deadlineAt, round }); state.deadline = deadline; state.anchor = now(); },
      onStateChange: (s) => state.states.push(s),
    });
    // A one-minute grant already 50 s old: inside the renewal window.
    state.anchor = now() - 50_000;
    state.deadline = { expiresAt: state.anchor + 120_000, deadlineAt: state.anchor + 60_000, warnAt: state.anchor + 30_000 };
    state.renewal.setLink(link);
    return state;
  };
  const A = make("peer-a", "peer-b", a, "initiator");
  const B = make("peer-b", "peer-a", b, "responder");
  const beforeA = A.deadline.deadlineAt;
  const beforeB = B.deadline.deadlineAt;

  // Route renewal envelopes exactly as peer-link does.
  // Addressed TO B lands in listeners.B, and vice versa. Getting this backwards
  // is silent: every envelope is simply never delivered.
  listeners.B.push((from, data) => { const e = wire.parseRenewEnvelope(data); if (e) B.renewal.signal("peer-a", e); });
  listeners.A.push((from, data) => { const e = wire.parseRenewEnvelope(data); if (e) A.renewal.signal("peer-b", e); });

  // ── the migration ────────────────────────────────────────────────────────
  A.renewal.tick();
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && (A.commits.length === 0 || B.commits.length === 0)) await new Promise((r) => setTimeout(r, 200));

  const ufrag1 = { a: a.renew.localUfrag(), b: b.renew.localUfrag() };
  const selectedA = await a.renew.selectedGeneration();
  const selectedB = await b.renew.selectedGeneration();
  const selected = { a: selectedA.local, b: selectedB.local };
  const selectedRemote = { a: selectedA.remote, b: selectedB.remote };

  return {
    log,
    commitsA: A.commits, commitsB: B.commits,
    statesA: A.states, statesB: B.states,
    requestsA: A.requests, requestsB: B.requests,
    beforeA, beforeB,
    ufrag0, ufrag1, selected, selectedRemote,
    channelA: a.getChannel("relayium-text").readyState,
    channelB: b.getChannel("relayium-text").readyState,
  };
})().then(
  (value) => { globalThis.__renew = { done: true, value }; },
  (err) => { globalThis.__renew = { done: true, error: String(err && err.stack || err) }; },
); "__started__"`;

async function main() {
  const keep = argPresent("--keep");
  const debugPort = Number(argFlag("--port", "9333"));
  const previewPort = Number(argFlag("--preview-port", "4319"));
  let session;
  let preview;
  try {
    const bundle = await bundleController();
    ok("bundled relay-renew.ts + webrtc-core.ts from source");

    // A real origin rather than `about:blank`: `crypto.subtle` and WebRTC both
    // want a secure context, and serving the built app is how every other
    // scenario here gets one. Nothing of the app is used beyond the origin.
    preview = await startPreview({ port: previewPort });
    session = await launchBrowser({ debugPort, keep });
    const tab = await newTab(session.browser, `${preview.base}/`, bundle);
    await sleep(200);

    // Started and polled, never awaited inside one `evaluate`: the harness caps
    // a single evaluate at 30 s on purpose, and a real ICE restart plus a probe
    // round trip can legitimately take longer than that.
    await tab.evaluate(SCENARIO);
    await tab.waitFor("globalThis.__renew.done", "the migration to settle", 100_000);
    const raw = await tab.evaluate("JSON.stringify(globalThis.__renew)");
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`page scenario failed: ${parsed.error}`);
    const result = parsed.value;

    for (const line of result.log) console.log(`    · ${line}`);

    // ── the assertions ─────────────────────────────────────────────────────
    if (result.channelA !== "open" || result.channelB !== "open") {
      throw new Error(`lanes did not stay open: ${result.channelA}/${result.channelB}`);
    }
    ok("both lanes stayed open across the migration");

    if (result.ufrag1.a === result.ufrag0.a || result.ufrag1.b === result.ufrag0.b) {
      throw new Error(`ICE was not actually restarted: ${JSON.stringify({ before: result.ufrag0, after: result.ufrag1 })}`);
    }
    ok(`real ICE restart minted new ufrags (${result.ufrag0.a} → ${result.ufrag1.a})`);

    if (result.selected.a !== result.ufrag1.a || result.selected.b !== result.ufrag1.b) {
      throw new Error(
        "the selected pair does not belong to the new generation: "
        + JSON.stringify({ selected: result.selected, current: result.ufrag1 }),
      );
    }
    ok("getStats reports the NEW generation as selected, not the retained old pair");

    // Where Chrome states the far end's generation too, it must be the new one.
    // Reported rather than asserted when absent: no stack is required to
    // publish it, and inventing agreement from a missing field is exactly what
    // section 6.3 forbids.
    if (result.selectedRemote.a === null && result.selectedRemote.b === null) {
      console.log("    · this Chrome reports no remote ufrag on the selected pair; nothing inferred");
    } else {
      if (result.selectedRemote.a !== null && result.selectedRemote.a !== result.ufrag1.b) {
        throw new Error(`remote generation stale on A: ${JSON.stringify(result.selectedRemote)} vs ${JSON.stringify(result.ufrag1)}`);
      }
      if (result.selectedRemote.b !== null && result.selectedRemote.b !== result.ufrag1.a) {
        throw new Error(`remote generation stale on B: ${JSON.stringify(result.selectedRemote)} vs ${JSON.stringify(result.ufrag1)}`);
      }
      ok("the selected pair's REMOTE end also names the new generation");
    }

    if (result.commitsA.length !== 1 || result.commitsB.length !== 1) {
      throw new Error(`expected exactly one commit per side, got ${result.commitsA.length}/${result.commitsB.length}`);
    }
    ok("both sides committed exactly once");

    if (!(result.commitsA[0].deadlineAt > result.beforeA)
      || !(result.commitsB[0].deadlineAt > result.beforeB)) {
      throw new Error("a deadline did not move forward on commit");
    }
    ok("each deadline moved only at commit, and forward");

    if (result.commitsA[0].round !== 1 || result.commitsB[0].round !== 1) {
      throw new Error("committed the wrong round");
    }
    ok("both sides committed round 1");

    if (!result.statesA.includes("renewed") || !result.statesB.includes("renewed")) {
      throw new Error("state never reached renewed");
    }
    if (result.statesA.indexOf("renewing") >= result.statesA.indexOf("renewed")) {
      throw new Error("reported renewed before renewing");
    }
    ok("state went idle → renewing → renewed, in that order");

    if (result.requestsA < 1 || result.requestsB < 1) {
      throw new Error(`both sides must have asked the server: ${result.requestsA}/${result.requestsB}`);
    }
    ok("converged with the initiator's round reply delayed a second behind the peer's");

    console.log("");
    console.log("  \x1b[33mPENDING\x1b[0m real product acceptance: this run has no server");
    console.log("          (`ice-renew` lands in a parallel batch) and no TURN relay, so it");
    console.log("          does not prove an actual relay allocation is retired and replaced.");
  } catch (err) {
    fail("relay renewal", err);
    process.exitCode = 1;
  } finally {
    if (session && !keep) await session.close();
    if (preview) await preview.stop();
  }
}

// One watchdog, around the whole run. `withWatchdog` calls `process.exit` when
// it resolves — it is the script's exit, not a per-step timer — so wrapping an
// individual step with it ends the run at that step.
await withWatchdog("relay renewal acceptance", 5 * 60_000, main);
