import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { connect, connectLink, connectResume, connectResumeLink, connectText, classifyPath, summarizeStats, PeerBusyError, localCaps, LINK_CAPTURE_MAX_BYTES, LINK_CHANNEL_LABELS, TEXT_CAPTURE_MAX_BYTES, authPayload as reExportedAuthPayload, type InboundSignal } from "./webrtc";
import { TEXT_MAX_BYTES, TEXT_FRAME_OVERHEAD } from "./text-wire";
import { clearRoom, enterRoom } from "./room.svelte";
import { advertisedCaps } from "./peer-caps.svelte";
import type { SignalingClient } from "./signaling";
import { ready, generateKeyPair, deriveSession, signResume, verifyResume, type SessionKeys } from "./crypto";
import { sas } from "./crypto";
import { authPayload, linkLeavePayload, signalGeneration, type RtcConfig, type SignalAuth } from "./webrtc-core";

// ── Minimal RTCPeerConnection / RTCDataChannel doubles ───────────────────────
// Enough surface for connect()'s offer/answer + commit-then-reveal state machine.
// The data channel opens only when a test calls _open(), so we can inspect the
// handshake before (and independently of) transport establishment.
class FakeDataChannel {
  binaryType = "";
  bufferedAmountLowThreshold = 0;
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly label = "relayium") {}
  send() {}
  close() { this.readyState = "closed"; }
  _open() { this.readyState = "open"; this.onopen?.(); }
  _message(data: ArrayBuffer) { this.onmessage?.({ data }); }
}

// A lane that models the Chrome race the hosted code room hit: the transition to
// "open" and its one open dispatch happen *inside* the collecting read of
// readyState. The read still reports the pre-transition value it observed, so a
// collector that decides whether to install a handler based on that value and
// only then installs it has already missed the lane's only open event.
class RacingDataChannel {
  binaryType = "";
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  #state = "connecting";
  #racePending = true;
  constructor(readonly label = "relayium") {}
  get readyState() {
    const observed = this.#state;
    if (this.#racePending) {
      this.#racePending = false; // disarm before dispatching: the race happens once
      this.#state = "open";
      this.onopen?.(); // whoever is installed *now* is the only one who hears it
    }
    return observed;
  }
  set readyState(v: string) { this.#racePending = false; this.#state = v; }
  send() {}
  close() { this.readyState = "closed"; }
  _open() { this.readyState = "open"; this.onopen?.(); }
  _message(data: ArrayBuffer) { this.onmessage?.({ data }); }
}

const instances: FakePC[] = [];

class FakePC {
  static inboundLabels: string[] = ["relayium"];
  /** How a remotely-created (responder-side) lane is built. Swappable so a test
   *  can hand the collector a lane with real-browser open-dispatch timing. */
  static inboundChannel: (label: string) => FakeDataChannel = (label) => new FakeDataChannel(label);
  onicecandidate: ((e: unknown) => void) | null = null;
  ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  channel: FakeDataChannel | null = null;
  channels: FakeDataChannel[] = [];
  /** The RTCConfiguration this peer connection was constructed with, so a test
   *  can prove which ICE path it is actually exercising (relay-only vs. LAN). */
  constructor(readonly config?: RtcConfig) { instances.push(this); }
  createDataChannel(label: string) {
    const ch = new FakeDataChannel(label);
    this.channels.push(ch);
    this.channel ??= ch;
    return ch;
  }
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async createAnswer() { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription() {}
  async setRemoteDescription(desc: { type: string }) {
    if (desc.type === "offer" && this.ondatachannel) {
      for (const label of FakePC.inboundLabels) {
        const ch = FakePC.inboundChannel(label);
        this.channels.push(ch);
        this.channel ??= ch;
        this.ondatachannel({ channel: ch });
      }
    }
  }
  async addIceCandidate() {}
  close() { this.connectionState = "closed"; }
}

// A two-party signaling hub. Each side's sendSignal is delivered to the peer's
// listeners on a later tick; an optional interceptor can tamper in flight.
function makeHub() {
  const listeners: Record<"I" | "R", ((from: string, data: unknown) => void)[]> = { I: [], R: [] };
  const sent: Record<"I" | "R", InboundSignal[]> = { I: [], R: [] };
  let intercept: ((data: InboundSignal) => InboundSignal) | null = null;
  const clone = (d: unknown) => JSON.parse(JSON.stringify(d)) as InboundSignal;
  function side(self: "I" | "R", peer: "I" | "R"): SignalingClient {
    return {
      onSignal(cb: (from: string, data: unknown) => void) {
        listeners[self].push(cb);
        return () => {
          const i = listeners[self].indexOf(cb);
          if (i >= 0) listeners[self].splice(i, 1);
        };
      },
      sendSignal(_to: string, data: unknown) {
        let d = clone(data);
        sent[self].push(d);
        if (intercept) d = intercept(d);
        setTimeout(() => listeners[peer].forEach((cb) => cb(self, clone(d))), 0);
      },
    } as unknown as SignalingClient;
  }
  return {
    I: side("I", "R"),
    R: side("R", "I"),
    sent,
    /** Deliver a raw signal to one side as if it came from the peer. */
    inject: (to: "I" | "R", from: "I" | "R", data: InboundSignal) =>
      listeners[to].forEach((cb) => cb(from, clone(data))),
    setIntercept: (fn: typeof intercept) => (intercept = fn),
  };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const openAll = () => instances.forEach((pc) => {
  for (const ch of pc.channels) if (ch.readyState !== "open") ch._open();
});

// A real pair of SignalAuths: two ephemeral keypairs run through the same
// crypto_kx exchange the first (SAS-verified) connection would have done. Using
// the real derivation — rather than a stub that always says yes — is what makes
// the resume tests below also prove the two sides derive the SAME key.
function authOf(k: SessionKeys): SignalAuth {
  return {
    sign: (payload) => signResume(k.resumeAuth, payload),
    verify: (payload, mac) => verifyResume(k.resumeAuth, payload, mac),
  };
}
async function pairAuth(): Promise<{ I: SignalAuth; R: SignalAuth; iKeys: SessionKeys }> {
  const i = generateKeyPair();
  const r = generateKeyPair();
  const iKeys = await deriveSession("initiator", i, r.publicKey);
  const rKeys = await deriveSession("responder", r, i.publicKey);
  return { I: authOf(iKeys), R: authOf(rKeys), iKeys };
}

beforeAll(async () => { await ready(); });
afterEach(() => {
  instances.length = 0;
  FakePC.inboundLabels = ["relayium"];
  FakePC.inboundChannel = (label) => new FakeDataChannel(label);
  vi.useRealTimers(); // a test that installed the jumpable clock must not leak it
  vi.unstubAllGlobals();
});

describe("webrtc commit-then-reveal handshake", () => {
  it("cancels an in-progress connection and closes its peer connection", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const controller = new AbortController();
    const p = connect({
      signaling: hub.I, peerId: "R", selfKey: generateKeyPair().publicKey,
      role: "initiator", onPeerKey: () => {}, signal: controller.signal,
    });
    const rejected = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    controller.abort();
    await rejected;
    expect(instances[0].connectionState).toBe("closed");
  });

  // The handshake gate adds a window that establish() no longer guards: the
  // channel is open (so establish has dropped its abort listener) but the peer
  // key has not arrived. Cancel has to keep working there, or a user pressing it
  // during "正在建立加密连接" would get nothing for the next 30 seconds while the
  // peer connection stayed alive behind a UI that already looked idle.
  it("still cancels after the channel opens but before the key is verified", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const controller = new AbortController();

    // Answers the offer (transport comes up) but never reveals.
    hub.R.onSignal((from, data) => {
      const msg = data as InboundSignal;
      if (msg.sdp?.type === "offer") hub.R.sendSignal(from, { sdp: { type: "answer", sdp: "answer" }, commit: "AAAA" });
    });

    const p = connect({
      signaling: hub.I, peerId: "R", selfKey: generateKeyPair().publicKey,
      role: "initiator", onPeerKey: () => {}, signal: controller.signal,
    });
    const rejected = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    openAll();
    await flush();
    controller.abort();
    await rejected;
    expect(instances[0].connectionState).toBe("closed");
  });

  it("does not send an offer when already cancelled", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const controller = new AbortController();
    controller.abort();
    const p = connect({
      signaling: hub.I, peerId: "R", selfKey: generateKeyPair().publicKey,
      role: "initiator", onPeerKey: () => {}, signal: controller.signal,
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(hub.sent.I).toEqual([]);
    expect(instances[0].connectionState).toBe("closed");
  });

  it("delivers each peer's real key and yields a matching SAS", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    let iPeer: Uint8Array | undefined;
    let rPeer: Uint8Array | undefined;

    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: (k) => (rPeer = k) });
    const iP = connect({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: (k) => (iPeer = k) });

    await flush();
    // Both sides learned the peer's *real* public key via a verified reveal.
    expect(iPeer && Array.from(iPeer)).toEqual(Array.from(rKey.publicKey));
    expect(rPeer && Array.from(rPeer)).toEqual(Array.from(iKey.publicKey));
    // Which means both compute the same short authentication string.
    expect(sas(iKey.publicKey, iPeer!)).toBe(sas(rKey.publicKey, rPeer!));

    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    ic.close();
    rc.close();
  });

  it("removes its abort listener once establishment succeeds", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const rKey = generateKeyPair();
    const iKey = generateKeyPair();
    const rP = connect({
      signaling: hub.R, peerId: "I", selfKey: rKey.publicKey,
      role: "responder", onPeerKey: () => {},
    });
    const iP = connect({
      signaling: hub.I, peerId: "R", selfKey: iKey.publicKey,
      role: "initiator", onPeerKey: () => {}, signal: controller.signal,
    });
    await flush();
    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    expect(remove.mock.calls.some(([type]) => type === "abort")).toBe(true);
    controller.abort();
    expect(instances[1].connectionState).not.toBe("closed");
    ic.close();
    rc.close();
  });

  it("rejects with PeerBusyError when the peer replies busy", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    // Stand-in for a mid-transfer responder: on the initiator's offer, refuse
    // with { busy: true } instead of answering.
    hub.R.onSignal((from, data) => {
      if ((data as InboundSignal).sdp?.type === "offer") hub.R.sendSignal(from, { busy: true });
    });

    const iP = connect({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {} });
    const rejected = expect(iP).rejects.toBeInstanceOf(PeerBusyError);
    await flush();
    await rejected;
  });

  it("aborts when a reveal does not open its commitment (MITM)", async () => {
    useJumpableClock();
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    const attacker = generateKeyPair();
    const attackerB64 = btoa(String.fromCharCode(...attacker.publicKey));

    // Relay swaps any revealed public key for its own; the nonce/commit are
    // untouched, so verifyCommit must fail and the receiver must refuse.
    hub.setIntercept((d) => (d.reveal ? { ...d, reveal: { ...d.reveal, key: attackerB64 } } : d));

    let rPeer: Uint8Array | undefined;
    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: (k) => (rPeer = k) });
    const iP = connect({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {} });
    // Attach the rejection expectation up front: the responder rejects mid-flush,
    // so waiting until afterwards would leave the rejection momentarily unhandled.
    const rejected = expect(rP).rejects.toThrow(/commitment|MITM/);

    await flush();
    // The responder saw the tampered initiator reveal first and must reject.
    await rejected;
    expect(rPeer).toBeUndefined();

    // The initiator must NOT be left holding a resolved connection. Its channel
    // can open perfectly well — the transport is fine, it is the handshake that
    // is dead — and before the handshake gate existed connect() resolved right
    // there, handing the caller a connection whose keys never arrive. The caller
    // then spun on `while (!keys)` with no deadline: the transfer sat at 0% for
    // as long as the tab stayed open. Now the handshake deadline ends it.
    openAll();
    await expectHandshakeTimeout(iP);
  });
});

/** Install a clock that still advances on its own (so the hub's setTimeout
 *  delivery and flush() keep working) but can also be jumped forward past the
 *  30s commit-reveal deadline. Must be called BEFORE connect(), or the deadline
 *  is armed on the real clock and no amount of advancing will fire it.
 *  afterEach restores real timers. */
const useJumpableClock = () => vi.useFakeTimers({ shouldAdvanceTime: true });

/** Track whether a promise has settled, without consuming its rejection. */
function watch(p: Promise<unknown>): () => boolean {
  let settled = false;
  void p.then(() => (settled = true), () => (settled = true));
  return () => settled;
}

/** Assert that a connect() promise whose channel is already open is still
 *  unresolved, and then fails once the key-reveal window — 30 s from the moment
 *  the channel opened, NOT the rest of the overall setup deadline — elapses.
 *  Requires useJumpableClock(). */
async function expectHandshakeTimeout(p: Promise<unknown>): Promise<void> {
  const settled = watch(p);
  const rejects = expect(p).rejects.toThrow(/handshake timed out/);
  await flush();
  expect(settled(), "connect() must not resolve before the peer key is verified").toBe(false);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(settled(), "the key window must be a window, not an instant").toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  await rejects;
}

// ── how long a setup is allowed to take ─────────────────────────────────────
//
// A flat 30-second cut-off was rejected: it kills exactly the connections that
// are working, just slowly (a phone waking its radio, then two TURN Allocate
// round trips because long-term credentials always draw a 401 challenge first,
// then hole punching). The policy is two deadlines instead — 30 s with no
// progress, and a 90 s ceiling nothing can push back.
describe("the setup deadline", () => {
  /** A syntactically plausible remote candidate. Distinct per index, because the
   *  progress ledger counts each piece of evidence exactly once. */
  const candidate = (i: number): InboundSignal =>
    ({ ice: { candidate: `candidate:${i} 1 udp 2122260223 10.0.0.${i} 5000 typ host`, sdpMid: "0", sdpMLineIndex: 0 } });

  function startInitiator(hub: ReturnType<typeof makeHub>) {
    return connect({
      signaling: hub.I, peerId: "R", selfKey: generateKeyPair().publicKey,
      role: "initiator", onPeerKey: () => {},
    });
  }

  it("fails at ~30 s when the far side never responds at all", async () => {
    useJumpableClock();
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const p = startInitiator(makeHub()); // nobody is listening on the other side
    const settled = watch(p);
    const rejects = expect(p).rejects.toThrow(/connection timed out/);
    await flush();

    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled(), "must not give up before the no-progress window is spent").toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejects;
    expect(instances[0].connectionState).toBe("closed");
  });

  it("keeps going past 30 s for a late answer, then times out from there", async () => {
    useJumpableClock();
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const p = startInitiator(hub);
    const settled = watch(p);
    const rejects = expect(p).rejects.toThrow(/connection timed out/);
    await flush();

    // A phone that took 25 s to wake up and answer. The old flat cut-off had
    // five seconds left for the whole of ICE; this restarts the window.
    await vi.advanceTimersByTimeAsync(25_000);
    hub.inject("I", "R", { sdp: { type: "answer", sdp: "answer" }, commit: "AAAA" });
    await flush();

    await vi.advanceTimersByTimeAsync(20_000); // t≈45s — past the old deadline
    expect(settled(), "a peer that really answered must buy more time").toBe(false);
    await vi.advanceTimersByTimeAsync(11_000); // t≈56s — 30s after the answer
    await rejects;
  });

  it("counts a remote candidate as progress, but not without limit", async () => {
    useJumpableClock();
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const p = startInitiator(hub);
    const settled = watch(p);
    const rejects = expect(p).rejects.toThrow(/connection timed out/);
    await flush();

    // Candidates every 20 s. Each one would push the no-progress window to +30 s,
    // so on that timer alone this would still be alive at 110 s.
    for (let i = 0; i < 5; i++) {
      hub.inject("I", "R", candidate(i));
      await flush();
      if (i < 4) await vi.advanceTimersByTimeAsync(20_000);
    }
    await vi.advanceTimersByTimeAsync(5_000); // t≈85s
    expect(settled(), "real ICE traffic must extend the window").toBe(false);

    // The ceiling is not extendable, so 90 s is 90 s however the peer paces it.
    await vi.advanceTimersByTimeAsync(6_000); // t≈91s
    await rejects;
    expect(instances[0].connectionState).toBe("closed");
  });

  it("does not hand a late-opening channel a fresh key window past the ceiling", async () => {
    useJumpableClock();
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const p = startInitiator(hub);
    const settled = watch(p);
    const rejects = expect(p).rejects.toThrow(/handshake timed out/);
    await flush();

    // Genuine progress for 60 s, then the channel finally opens at ~80 s.
    for (let i = 0; i < 4; i++) {
      hub.inject("I", "R", candidate(i));
      await flush();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    openAll();
    await flush();
    expect(settled(), "the transport is up; only the key is missing").toBe(false);

    // A full 30 s key window from here would run to 110 s. The overall ceiling
    // wins instead — the whole setup still ends at 90 s.
    await vi.advanceTimersByTimeAsync(5_000); // t≈85s
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000); // t≈91s
    await rejects;
  });
});

// A getStats() report is a Map keyed by stat id; each candidate-pair references
// its two endpoint candidates by id. Build the minimal shape classifyPath reads.
function statsReport(pair: Record<string, unknown>, cands: Record<string, string>) {
  const m = new Map<string, unknown>();
  m.set("cp", { type: "candidate-pair", ...pair });
  for (const [id, candidateType] of Object.entries(cands)) m.set(id, { type: "local-candidate", candidateType });
  return m as unknown as RTCStatsReport;
}

describe("classifyPath", () => {
  it("reports lan for a nominated host↔host pair (Chromium shape)", () => {
    const s = statsReport(
      { nominated: true, state: "succeeded", localCandidateId: "l", remoteCandidateId: "r" },
      { l: "host", r: "host" },
    );
    expect(classifyPath(s)).toBe("lan");
  });

  it("reports p2p when a srflx candidate is involved", () => {
    const s = statsReport(
      { nominated: true, state: "succeeded", localCandidateId: "l", remoteCandidateId: "r" },
      { l: "srflx", r: "host" },
    );
    expect(classifyPath(s)).toBe("p2p");
  });

  it("reports relay when either end is a TURN relay", () => {
    const s = statsReport(
      { nominated: true, state: "succeeded", localCandidateId: "l", remoteCandidateId: "r" },
      { l: "host", r: "relay" },
    );
    expect(classifyPath(s)).toBe("relay");
  });

  it("honours Firefox's `selected` flag without `nominated`", () => {
    const s = statsReport(
      { selected: true, localCandidateId: "l", remoteCandidateId: "r" },
      { l: "host", r: "host" },
    );
    expect(classifyPath(s)).toBe("lan");
  });

  it("is unknown when no pair is selected yet", () => {
    const s = statsReport(
      { nominated: true, state: "in-progress", localCandidateId: "l", remoteCandidateId: "r" },
      { l: "host", r: "host" },
    );
    expect(classifyPath(s)).toBe("unknown");
  });
});

// A richer report: the selected pair carries RTT/bitrate/byte counters and points
// at two candidates whose protocol/relayProtocol/address we surface in the panel.
function richReport() {
  const m = new Map<string, unknown>();
  m.set("cp", {
    type: "candidate-pair", nominated: true, state: "succeeded",
    localCandidateId: "lc", remoteCandidateId: "rc",
    currentRoundTripTime: 0.32, availableOutgoingBitrate: 350_000,
    bytesSent: 4096, bytesReceived: 8192,
  });
  m.set("lc", { type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "tls", address: "203.0.113.7", port: 49500 });
  m.set("rc", { type: "remote-candidate", candidateType: "relay", protocol: "udp", address: "198.51.100.9", port: 51000 });
  m.set("dc", { type: "data-channel", state: "open", messagesSent: 20, messagesReceived: 0, bytesSent: 4000, bytesReceived: 0 });
  return m as unknown as RTCStatsReport;
}

describe("summarizeStats", () => {
  it("extracts path, RTT (ms), bitrate (kbps), relayProtocol and channel counters", () => {
    const d = summarizeStats(richReport());
    expect(d.path).toBe("relay");
    expect(d.rttMs).toBe(320);
    expect(d.outgoingBitrateKbps).toBe(350);
    expect(d.local?.relayProtocol).toBe("tls"); // the tell for a slow TLS relay fallback
    expect(d.local?.candidateType).toBe("relay");
    expect(d.dataChannel).toMatchObject({ state: "open", messagesSent: 20 });
  });

  it("redacts IP/port by default and reveals them only when asked", () => {
    expect(summarizeStats(richReport()).local?.address).toBe("•••");
    expect(summarizeStats(richReport()).local?.port).toBeUndefined();
    const shown = summarizeStats(richReport(), true);
    expect(shown.local?.address).toBe("203.0.113.7");
    expect(shown.local?.port).toBe(49500);
  });

  it("returns just the path when no pair is selected", () => {
    const m = new Map<string, unknown>([["cp", { type: "candidate-pair", state: "in-progress" }]]);
    const d = summarizeStats(m as unknown as RTCStatsReport);
    expect(d).toEqual({ path: "unknown" });
  });
});

// connectResume is the transport-only mirror of connect(): no commit/reveal, and
// every signal tagged `resume: true` so a dying original connection and its
// replacement can't cross-route each other's SDP. Both properties are load-bearing
// (a mid-transfer resume is exactly when both generations are alive at once), and
// neither had a test before the connect/connectResume dedup.
describe("connectResume", () => {
  it("establishes a channel with no commit/reveal exchange", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    const iP = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });

    await flush();
    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    expect(ic.channel).toBeTruthy();
    expect(rc.channel).toBeTruthy();
    // No key material on the wire — the caller reuses the original session keys.
    for (const side of ["I", "R"] as const) {
      expect(hub.sent[side].some((m) => m.commit || m.reveal)).toBe(false);
    }
    ic.close();
    rc.close();
  });

  it("tags every outgoing signal with resume:true", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    const iP = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);

    expect(hub.sent.I.length).toBeGreaterThan(0);
    expect(hub.sent.R.length).toBeGreaterThan(0);
    for (const side of ["I", "R"] as const) {
      expect(hub.sent[side].every((m) => m.resume === true)).toBe(true);
    }
    ic.close();
    rc.close();
  });

  it("ignores untagged signals — the dying original connection can't feed it SDP", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    await flush();
    // An offer from the *original* generation (no resume tag) must not be answered.
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "stale" } });
    await flush();
    expect(hub.sent.R.length).toBe(0);

    // The properly tagged (and properly signed) offer is answered.
    const fresh: InboundSignal = { sdp: { type: "offer", sdp: "fresh" }, resume: true };
    fresh.auth = await a.I.sign(authPayload(fresh));
    hub.inject("R", "I", fresh);
    await flush();
    expect(hub.sent.R.some((m) => m.sdp?.type === "answer")).toBe(true);
    openAll();
    (await rP).close();
  });

  it("connect() ignores resume-tagged signals for the same reason", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const rKey = generateKeyPair();
    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {} });
    await flush();
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "resume-gen" }, resume: true });
    await flush();
    expect(hub.sent.R.length).toBe(0);
    // rP never resolves (no offer was ever accepted) — that IS the assertion.
    // Swallow its eventual 30s timeout rejection so it can't leak past this test.
    rP.catch(() => {});
  });

  it("rejects when the peer connection fails before the channel opens", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const p = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    const rejected = expect(p).rejects.toThrow(/resume connection failed/);
    await flush();
    const pc = instances[0];
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    await rejected;
  });

  it("reports state changes to the caller (how the app notices a re-drop)", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const seen: string[] = [];
    const p = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I, onStateChange: (s) => seen.push(s) });
    await flush();
    openAll();
    const c = await p;
    const pc = instances[0];
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    expect(seen).toContain("connected");
    c.close();
  });
});

// connectResumeLink is connectResume for a mixed link: the same transport-only
// generation and the same mandatory signalling authentication, but a connection
// is not usable until BOTH lanes exist. The tests below pin that difference in
// both directions — the link path must never resolve on one lane, and the legacy
// path must never grow a second one.
// The leave signal rides the `link` generation, so every handler that filters by
// generation alone — which is all of them — sees it. What keeps it harmless is
// that it carries nothing any of them acts on, and that its tag covers bytes no
// other signal can produce.
describe("link leave signal domain", () => {
  it("is a distinct canonical payload that binds direction", () => {
    expect(linkLeavePayload("a", "b")).toBe('{"kind":"link-leave","from":"a","to":"b"}');
    // Reversing the tuple is a different string, so a reflected leave fails.
    expect(linkLeavePayload("a", "b")).not.toBe(linkLeavePayload("b", "a"));
  });

  it("can never collide with an authPayload string", () => {
    // authPayload always starts with sdpType; a leave payload always starts with
    // kind. Even the degenerate all-null resume payload is a different string.
    expect(linkLeavePayload("a", "b")).not.toBe(authPayload({ link: true, leave: true }));
    expect(authPayload({ link: true, leave: true })).toBe(
      '{"sdpType":null,"sdp":null,"candidate":null,"sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}',
    );
  });

  it("a tag over one payload never verifies against the other", async () => {
    const a = await pairAuth();
    const leaveTag = await a.I.sign(linkLeavePayload("I", "R"));
    expect(await a.R.verify(authPayload({ link: true, leave: true }), leaveTag)).toBe(false);
    const resumeTag = await a.I.sign(authPayload({ link: true, leave: true }));
    expect(await a.R.verify(linkLeavePayload("I", "R"), resumeTag)).toBe(false);
  });

  // The real reason for the strict shape: a link establishment in flight for the
  // same peer receives this message too. It must do absolutely nothing there.
  it("is inert against a link establishment in flight for the same peer", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = [...LINK_CHANNEL_LABELS];
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    let iPeer: Uint8Array | undefined;
    let rPeer: Uint8Array | undefined;
    const capsSeen: string[][] = [];

    const rP = connectLink({
      signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder",
      onPeerKey: (k) => (rPeer = k), onPeerCaps: (c) => capsSeen.push(c),
    });
    const iP = connectLink({
      signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator",
      onPeerKey: (k) => (iPeer = k),
    });

    // Mid-handshake, from the peer this connection is talking to.
    hub.inject("R", "I", { link: true, leave: true, auth: "not-a-real-tag" });
    await flush();
    hub.inject("R", "I", { link: true, leave: true, auth: "not-a-real-tag" });
    await flush();

    // The handshake is untouched: same keys, same SAS, no extra caps report.
    expect(iPeer && Array.from(iPeer)).toEqual(Array.from(rKey.publicKey));
    expect(rPeer && Array.from(rPeer)).toEqual(Array.from(iKey.publicKey));
    expect(sas(iKey.publicKey, iPeer!)).toBe(sas(rKey.publicKey, rPeer!));
    expect(capsSeen).toHaveLength(1);
    expect(capsSeen[0]).toEqual([...localCaps()]);

    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    ic.close();
    rc.close();
  });
});

describe("connectResumeLink", () => {
  it("rebuilds both lanes with no commit/reveal and resolves only when both open", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = ["relayium-text", "relayium"]; // reverse arrival is intentional
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResumeLink({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    const iP = connectResumeLink({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();

    // No key material on the wire: the link keeps the SessionKeys and the SAS
    // the first connection anchored.
    for (const side of ["I", "R"] as const) {
      expect(hub.sent[side].some((m) => m.commit || m.reveal)).toBe(false);
    }

    let settled = false;
    void Promise.all([iP, rP]).then(() => (settled = true));
    for (const pc of instances) pc.channels.find((ch) => ch.label === "relayium")?._open();
    await flush();
    expect(settled).toBe(false); // one lane is not a link

    for (const pc of instances) pc.channels.find((ch) => ch.label === "relayium-text")?._open();
    const [ic, rc] = await Promise.all([iP, rP]);
    for (const c of [ic, rc]) {
      expect(c.channel.label).toBe("relayium");
      expect(c.getChannel("relayium")?.label).toBe("relayium");
      expect(c.getChannel("relayium-text")?.label).toBe("relayium-text");
    }
    expect([...LINK_CHANNEL_LABELS]).toEqual(["relayium", "relayium-text"]);
    ic.close();
    rc.close();
  });

  // Drive a genuine, correctly-signed offer at a waiting responder so it answers
  // and collects its inbound lanes — without standing up a second peer.
  async function offerTo(hub: ReturnType<typeof makeHub>, auth: SignalAuth) {
    const offer: InboundSignal = { sdp: { type: "offer", sdp: "real" }, resume: true };
    offer.auth = await auth.sign(authPayload(offer));
    hub.inject("R", "I", offer);
    await flush();
  }

  // Regression: hosted Chrome (run 31550922651) opened both responder lanes at
  // ~554/557ms, yet the responder never returned from transport setup and the
  // no-progress timeout tore the connection down 30s later. Collecting a lane
  // must not depend on readyState and the open dispatch being observed in a
  // consistent order.
  it("resolves when a lane opens between the readyState read and the handler", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = [...LINK_CHANNEL_LABELS];
    FakePC.inboundChannel = (label) => new RacingDataChannel(label) as unknown as FakeDataChannel;
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResumeLink({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    let settled = false;
    void rP.then(() => (settled = true), () => {});
    await flush();
    await offerTo(hub, a.I);

    // Asserted before awaiting rP: under the losing order this is a clean
    // failure here, not a test that hangs until the suite times out.
    expect(settled).toBe(true);
    const rc = await rP;
    expect(rc.getChannel("relayium")?.label).toBe("relayium");
    expect(rc.getChannel("relayium-text")?.label).toBe("relayium-text");
    rc.close();
  });

  // The collector's other two jobs, pinned so the ordering fix cannot quietly
  // drop them: a second lane on a label already held and a label nobody asked
  // for are both closed, and neither counts toward readiness.
  it("closes duplicate and unexpected lanes while both real lanes still open", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = ["relayium", "relayium", "relayium-text", "bogus"];
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResumeLink({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    let settled = false;
    void rP.then(() => (settled = true), () => {});
    await flush();
    await offerTo(hub, a.I);

    const [file, dupe, text, bogus] = instances[0].channels;
    expect(dupe.readyState).toBe("closed");
    expect(bogus.readyState).toBe("closed");

    file._open();
    await flush();
    expect(settled).toBe(false); // the duplicate never stood in for the text lane
    text._open();
    await flush();
    expect(settled).toBe(true);
    const rc = await rP;
    expect(rc.getChannel("relayium")).toBe(file);
    expect(rc.getChannel("relayium-text")).toBe(text);
    rc.close();
  });

  it("signs and tags every outgoing signal exactly like the legacy resume path", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = [...LINK_CHANNEL_LABELS];
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResumeLink({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    const iP = connectResumeLink({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);

    for (const side of ["I", "R"] as const) {
      expect(hub.sent[side].length).toBeGreaterThan(0);
      expect(hub.sent[side].every((m) => m.resume === true)).toBe(true);
      expect(hub.sent[side].every((m) => typeof m.auth === "string" && m.auth.length > 0)).toBe(true);
    }
    // And the tags verify under the peer's mirrored key — the SDP and ICE of a
    // rebuilt link are bound to the session the user already compared.
    for (const m of hub.sent.I) expect(await a.R.verify(authPayload(m), m.auth)).toBe(true);
    for (const m of hub.sent.R) expect(await a.I.verify(authPayload(m), m.auth)).toBe(true);
    ic.close();
    rc.close();
  });

  it("never answers a resume-link offer signed with another session's key", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = [...LINK_CHANNEL_LABELS];
    const hub = makeHub();
    const a = await pairAuth();
    const other = await pairAuth(); // a signalling relay running its own exchange
    const rP = connectResumeLink({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    await flush();

    const forged: InboundSignal = { sdp: { type: "offer", sdp: "mitm" }, resume: true };
    forged.auth = await other.I.sign(authPayload(forged));
    hub.inject("R", "I", forged);
    const untagged: InboundSignal = { sdp: { type: "offer", sdp: "mitm2" }, resume: true };
    hub.inject("R", "I", untagged);
    await flush();
    expect(hub.sent.R.length).toBe(0); // neither was ever answered

    const genuine: InboundSignal = { sdp: { type: "offer", sdp: "real" }, resume: true };
    genuine.auth = await a.I.sign(authPayload(genuine));
    hub.inject("R", "I", genuine);
    await flush();
    expect(hub.sent.R.some((m) => m.sdp?.type === "answer")).toBe(true);
    openAll();
    (await rP).close();
  });

  it("captures each lane from collection and drains it exactly once", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const iP = connectResumeLink({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    const pc = instances[0];
    const file = pc.channels.find((ch) => ch.label === "relayium")!;
    const text = pc.channels.find((ch) => ch.label === "relayium-text")!;
    // The peer speaks on the rebuilt file lane while the text lane is still
    // completing DCEP. Those frames belong to codecs that already exist.
    file._open();
    file._message(new Uint8Array([1]).buffer);
    file._message(new Uint8Array([2]).buffer);
    text._open();
    text._message(new Uint8Array([9]).buffer);

    const conn = await iP;
    expect(conn.takeCaptured?.("relayium").frames.map((f) => [...new Uint8Array(f)]))
      .toEqual([[1], [2]]);
    expect(conn.takeCaptured?.("relayium-text").frames.map((f) => [...new Uint8Array(f)]))
      .toEqual([[9]]);
    expect(conn.takeCaptured?.("relayium").frames).toEqual([]); // no replay
    conn.close();
  });

  it("bounds that capture and reports overflow instead of truncating silently", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const iP = connectResumeLink({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    const pc = instances[0];
    const file = pc.channels.find((ch) => ch.label === "relayium")!;
    file._open();
    file._message(new ArrayBuffer(LINK_CAPTURE_MAX_BYTES + 1));
    pc.channels.find((ch) => ch.label === "relayium-text")!._open();
    const conn = await iP;
    expect(conn.takeCaptured?.("relayium")).toEqual({ frames: [], overflow: true });
    expect(conn.takeCaptured?.("relayium-text")).toEqual({ frames: [], overflow: true });
    conn.close();
  });

  // Both kinds of resume ride the same generation tag, so what keeps them apart
  // is the auth tag alone. Two of them alive on one signalling link — a legacy
  // file transfer's and a link's — must not consume each other's offers.
  it("cannot be cross-routed with a legacy resume on the same signalling link", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = [...LINK_CHANNEL_LABELS];
    const hub = makeHub();
    const legacy = await pairAuth();
    const linked = await pairAuth();
    const legacyP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: legacy.R });
    const linkP = connectResumeLink({ signaling: hub.R, peerId: "I", role: "responder", auth: linked.R });
    await flush();

    const offer: InboundSignal = { sdp: { type: "offer", sdp: "link-rebuild" }, resume: true };
    offer.auth = await linked.I.sign(authPayload(offer));
    hub.inject("R", "I", offer);
    await flush();
    // Exactly one of the two answered it, and it was the link's connection —
    // the legacy one never even got as far as collecting a channel.
    expect(hub.sent.R.filter((m) => m.sdp?.type === "answer")).toHaveLength(1);
    expect(instances[0].channels).toHaveLength(0);
    expect(instances[1].channels.map((ch) => ch.label)).toEqual([...LINK_CHANNEL_LABELS]);

    const foreign: InboundSignal = { sdp: { type: "offer", sdp: "foreign" }, resume: true };
    foreign.auth = await (await pairAuth()).I.sign(authPayload(foreign));
    hub.inject("R", "I", foreign);
    await flush();
    expect(hub.sent.R.filter((m) => m.sdp?.type === "answer")).toHaveLength(1);
    legacyP.catch(() => {});
    linkP.catch(() => {});
  });

  // The legacy contract, asserted next to the new one: connectResume still opens
  // exactly one lane and still captures nothing. A resumed one-shot file
  // transfer must not start waiting for a text channel an older peer never opens.
  it("leaves the legacy connectResume single-lane and capture-free", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const p = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    expect(instances[0].channels.map((ch) => ch.label)).toEqual(["relayium"]);
    openAll();
    const conn = await p;
    expect(conn.channel.label).toBe("relayium");
    expect(conn.getChannel("relayium-text")).toBeUndefined();
    expect(conn.takeCaptured).toBeUndefined();
    conn.close();
  });
});

// L3: a resume connection runs no commit-reveal, so without a binding the
// signalling server (or anyone who can rewrite signalling) could send its own
// resume offer and take over that half of the session. It never learns the
// session keys, so it can't produce the tag.
describe("resume signalling is bound to the session keys", () => {
  it("signs every outgoing resume signal", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    const iP = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    for (const side of ["I", "R"] as const) {
      expect(hub.sent[side].length).toBeGreaterThan(0);
      expect(hub.sent[side].every((m) => typeof m.auth === "string" && m.auth.length > 0)).toBe(true);
    }
    // And the tags actually verify under the OTHER side's key — i.e. the two
    // sides really did derive the same value from their mirrored secrets.
    for (const m of hub.sent.I) {
      expect(await a.R.verify(authPayload(m), m.auth)).toBe(true);
    }
    ic.close();
    rc.close();
  });

  it("drops an injected resume offer that carries no tag", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    await flush();
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "mitm" }, resume: true });
    await flush();
    expect(hub.sent.R.length).toBe(0); // never answered
    rP.catch(() => {});
  });

  it("drops a resume offer signed with the wrong session's key", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const other = await pairAuth(); // an attacker running its own key exchange
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    await flush();
    const forged: InboundSignal = { sdp: { type: "offer", sdp: "mitm" }, resume: true };
    forged.auth = await other.I.sign(authPayload(forged));
    hub.inject("R", "I", forged);
    await flush();
    expect(hub.sent.R.length).toBe(0);
    rP.catch(() => {});
  });

  it("drops a genuine offer whose SDP was rewritten in flight", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    // The MITM keeps the real tag but swaps the SDP for one pointing at itself.
    hub.setIntercept((d) => (d.sdp ? { ...d, sdp: { ...d.sdp, sdp: "attacker-sdp" } } : d));
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder", auth: a.R });
    const iP = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    // The responder never answers a tampered offer, so no channel is ever built.
    expect(hub.sent.R.some((m) => m.sdp?.type === "answer")).toBe(false);
    iP.catch(() => {});
    rP.catch(() => {});
  });
});

describe("capability piggyback", () => {
  // ── THE compatibility gate for the whole text feature ──────────────────────
  // authPayload lists its fields explicitly (webrtc-core.ts) precisely so that
  // adding a field to InboundSignal cannot change what a resume tag covers. If
  // this drifts, an old and a new client compute different tags for the same
  // offer and every resume across a rolling deploy breaks.
  const BASE: InboundSignal = { sdp: { type: "offer", sdp: "v=0" } };
  const EXPECTED =
    '{"sdpType":"offer","sdp":"v=0","candidate":null,"sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}';

  it("authPayload output is byte-for-byte what it was before caps existed", () => {
    expect(authPayload(BASE)).toBe(EXPECTED);
  });

  it("authPayload ignores caps and the text generation tag", () => {
    expect(authPayload({ ...BASE, caps: ["text/1"] })).toBe(EXPECTED);
    expect(authPayload({ ...BASE, text: true })).toBe(EXPECTED);
    expect(authPayload({ ...BASE, caps: ["text/1"], text: true })).toBe(EXPECTED);
    // An ICE signal carrying caps must be unaffected too.
    const ice: InboundSignal = { ice: { candidate: "cand", sdpMid: "0", sdpMLineIndex: 0 } };
    expect(authPayload({ ...ice, caps: ["text/1"] })).toBe(authPayload(ice));
  });

  // The property that actually matters, with the real HMAC: a tag computed by a
  // peer that has never heard of caps still verifies against the payload a
  // caps-carrying signal produces.
  it("a resume tag computed without caps verifies against a signal carrying them", async () => {
    const a = await pairAuth();
    const tagFromOldPeer = await a.I.sign(authPayload(BASE));
    const withCaps: InboundSignal = { ...BASE, caps: ["text/1"], auth: tagFromOldPeer };
    expect(await a.R.verify(authPayload(withCaps), withCaps.auth)).toBe(true);
  });

  it("and the reverse: a tag computed with caps verifies for a peer that ignores them", async () => {
    const a = await pairAuth();
    const withCaps: InboundSignal = { ...BASE, caps: ["text/1"] };
    const tagFromNewPeer = await a.I.sign(authPayload(withCaps));
    expect(await a.R.verify(authPayload(BASE), tagFromNewPeer)).toBe(true);
  });

  it("advertises text/1", () => {
    expect(localCaps()).toContain("text/1");
  });

  // The per-connection confirmation is derived from `advertisedCaps()` and is
  // sampled per connection, not frozen at import. A pairing-code room now
  // announces the same pair the LAN room does (DECISION-LOG 2026-08-10), so what
  // this pins is the SYMMETRY: whatever the roster hello says, a connection made
  // after a live room switch (no reload) confirms exactly that. Advertised
  // there, refused here — or the reverse — is the asymmetry that strands a peer.
  it("confirms exactly what the roster hello announces, in either room", () => {
    expect(localCaps()).toEqual(["text/1", "link/1", "preupload/1"]);
    expect([...localCaps()]).toEqual([...advertisedCaps()]);
    enterRoom({ code: "123456" });
    expect(localCaps()).toEqual(["text/1", "link/1", "preupload/1"]);
    expect([...localCaps()]).toEqual([...advertisedCaps()]);
    clearRoom();
    expect([...localCaps()]).toEqual([...advertisedCaps()]);
  });

  // Adding `leave` to InboundSignal must be exactly as inert as adding `caps`
  // was. If this drifts, every resume across a rolling deploy breaks.
  it("authPayload ignores the leave marker", () => {
    expect(authPayload({ ...BASE, leave: true })).toBe(EXPECTED);
    expect(authPayload({ ...BASE, link: true, leave: true })).toBe(EXPECTED);
  });

  it("carries caps on the offer and on the answer, and reports the peer's", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    let iSaw: string[] | undefined;
    let rSaw: string[] | undefined;

    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {}, onPeerCaps: (c) => (rSaw = c) });
    const iP = connect({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {}, onPeerCaps: (c) => (iSaw = c) });
    await flush();

    const offer = hub.sent.I.find((m) => m.sdp?.type === "offer");
    const answer = hub.sent.R.find((m) => m.sdp?.type === "answer");
    expect(offer?.caps).toEqual([...localCaps()]);
    expect(answer?.caps).toEqual([...localCaps()]);
    // Both sides know the peer's capabilities before the channel opens.
    expect(iSaw).toEqual([...localCaps()]);
    expect(rSaw).toEqual([...localCaps()]);

    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    ic.close();
    rc.close();
  });

  it("still completes the handshake against a peer that sends no caps", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    let iSaw: string[] | undefined;
    // Stand in for a peer on the current release: strip caps in flight.
    hub.setIntercept((d) => { const { caps: _drop, ...rest } = d; return rest as InboundSignal; });

    let iPeer: Uint8Array | undefined;
    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {} });
    const iP = connect({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: (k) => (iPeer = k), onPeerCaps: (c) => (iSaw = c) });
    await flush();

    // The SAS handshake is unaffected; we simply learn nothing about caps.
    expect(iPeer && Array.from(iPeer)).toEqual(Array.from(rKey.publicKey));
    expect(iSaw).toBeUndefined();

    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    ic.close();
    rc.close();
  });

  it("filters a malformed caps array off the wire before reporting it", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const rKey = generateKeyPair();
    let rSaw: string[] | undefined;
    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {}, onPeerCaps: (c) => (rSaw = c) });
    await flush();
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "v=0" }, caps: [1, "text/1", null] as unknown as string[] });
    await flush();
    expect(rSaw).toEqual(["text/1"]);
    rP.catch(() => {});
  });

  it("does not report caps when the field is not an array", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const rKey = generateKeyPair();
    let called = false;
    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {}, onPeerCaps: () => (called = true) });
    await flush();
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "v=0" }, caps: "text/1" as unknown as string[] });
    await flush();
    expect(called).toBe(false);
    rP.catch(() => {});
  });
});

describe("signalling generations", () => {
  it("classifies each generation from its tags", () => {
    expect(signalGeneration({})).toBe("file");
    expect(signalGeneration({ sdp: { type: "offer", sdp: "v=0" } })).toBe("file");
    expect(signalGeneration({ resume: true })).toBe("resume");
    expect(signalGeneration({ text: true })).toBe("text");
    expect(signalGeneration({ link: true })).toBe("link");
  });

  // Untagged is the file generation, which is what every already-deployed peer
  // sends. A falsy tag must not read as its generation either.
  it("treats an absent or falsy tag as the file generation", () => {
    expect(signalGeneration({ resume: false })).toBe("file");
    expect(signalGeneration({ text: false })).toBe("file");
    expect(signalGeneration({ resume: false, text: false })).toBe("file");
    expect(signalGeneration({ link: false })).toBe("file");
  });

  // Pinned so the precedence is a decision rather than an accident. Phase 1
  // never produces both (connectText does not resume); phase 2 must revisit this
  // if it resumes a message session.
  it("pins resume > link > text precedence when tags overlap", () => {
    expect(signalGeneration({ resume: true, link: true, text: true })).toBe("resume");
    expect(signalGeneration({ link: true, text: true })).toBe("link");
  });

  it("opens both link channels through DCEP and resolves only after both are open", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = ["relayium-text", "relayium"]; // reverse arrival is intentional
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();

    const rP = connectLink({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {} });
    const iP = connectLink({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {} });
    await flush();

    expect(instances).toHaveLength(2);
    expect(instances.find((pc) => pc.channels.some((ch) => ch.label === "relayium-text"))?.channels.map((ch) => ch.label))
      .toEqual(expect.arrayContaining(["relayium", "relayium-text"]));
    for (const m of [...hub.sent.I, ...hub.sent.R]) expect(m.link).toBe(true);

    // Opening only the primary lane must not resolve the link.
    for (const pc of instances) pc.channels.find((ch) => ch.label === "relayium")?._open();
    for (const pc of instances) {
      pc.channels.find((ch) => ch.label === "relayium")?._message(new Uint8Array([1, 2, 3]).buffer);
    }
    let settled = false;
    void Promise.all([iP, rP]).then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);

    for (const pc of instances) pc.channels.find((ch) => ch.label === "relayium-text")?._open();
    const [ic, rc] = await Promise.all([iP, rP]);
    expect(ic.channel.label).toBe("relayium");
    expect(ic.getChannel("relayium-text")?.label).toBe("relayium-text");
    expect(rc.channel.label).toBe("relayium");
    expect(rc.getChannel("relayium-text")?.label).toBe("relayium-text");
    // The primary lane had a sink before its sibling opened; draining it is
    // atomic and a second drain cannot replay the same frame.
    expect(ic.takeCaptured?.("relayium").frames.map((f) => [...new Uint8Array(f)]))
      .toEqual([[1, 2, 3]]);
    expect(ic.takeCaptured?.("relayium").frames).toEqual([]);
    expect(rc.takeCaptured?.("relayium").frames.map((f) => [...new Uint8Array(f)]))
      .toEqual([[1, 2, 3]]);
    ic.close();
    rc.close();
  });

  it("bounds pre-ready mixed capture independently of the file flow window", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    FakePC.inboundLabels = [...LINK_CHANNEL_LABELS];
    const hub = makeHub();
    // A real responder, so the commit-reveal actually completes: connect() now
    // resolves on the handshake, not merely on the channels opening.
    const rP = connectLink({
      signaling: hub.R, peerId: "I", selfKey: generateKeyPair().publicKey,
      role: "responder", onPeerKey: () => {},
    });
    const iP = connectLink({
      signaling: hub.I, peerId: "R", selfKey: generateKeyPair().publicKey,
      role: "initiator", onPeerKey: () => {},
    });
    await flush();
    const pc = instances[1]; // [0] is the responder, which is constructed first
    const file = pc.channels.find((ch) => ch.label === "relayium")!;
    file._open();
    file._message(new ArrayBuffer(LINK_CAPTURE_MAX_BYTES + 1));
    pc.channels.find((ch) => ch.label === "relayium-text")!._open();
    openAll();
    await flush();
    const conn = await iP;
    expect(conn.takeCaptured?.("relayium")).toEqual({ frames: [], overflow: true });
    conn.close();
    (await rP).close();
  });

  it("still tags a resume connection's outbound signals", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const a = await pairAuth();
    const iP = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", auth: a.I });
    await flush();
    const offer = hub.sent.I.find((m) => m.sdp?.type === "offer");
    expect(offer?.resume).toBe(true);
    expect(offer?.text).toBeUndefined();
    iP.catch(() => {});
  });

  // The compatibility assertion: a file-generation signal is byte-identical to
  // what this code sent before generations were named, so an older peer sees no
  // new field at all.
  it("leaves a file connection's outbound signals untagged", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const iP = connect({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {} });
    await flush();
    for (const m of hub.sent.I) {
      expect("resume" in m).toBe(false);
      expect("text" in m).toBe(false);
    }
    expect(hub.sent.I.some((m) => m.sdp?.type === "offer")).toBe(true);
    iP.catch(() => {});
  });

  it("tags a text connection's outbound signals and completes its own handshake", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    let iPeer: Uint8Array | undefined;
    let rPeer: Uint8Array | undefined;

    const rP = connectText({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: (k) => (rPeer = k) });
    const iP = connectText({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: (k) => (iPeer = k) });
    await flush();

    // A full commit-reveal, not a resume: both sides learn the peer's real key
    // and agree a SAS of their own.
    expect(iPeer && Array.from(iPeer)).toEqual(Array.from(rKey.publicKey));
    expect(rPeer && Array.from(rPeer)).toEqual(Array.from(iKey.publicKey));
    expect(sas(iKey.publicKey, iPeer!)).toBe(sas(rKey.publicKey, rPeer!));
    // Every signal it sends is tagged.
    expect(hub.sent.I.length).toBeGreaterThan(0);
    for (const m of hub.sent.I) expect(m.text).toBe(true);
    for (const m of hub.sent.R) expect(m.text).toBe(true);

    openAll();
    const [ic, rc] = await Promise.all([iP, rP]);
    ic.close();
    rc.close();
  });

  // The channel opens well before connectText resolves -- the key handshake and
  // the caller's path sample both run after it -- and an auto-accepting peer
  // speaks in exactly that window. Retention is bounded and the drain is
  // one-shot; the caller replays it under its own ordering rules.
  it("retains a text lane's frames from open, bounded, until the caller drains them", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    const rP = connectText({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {} });
    const iP = connectText({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {} });
    await flush();
    openAll();
    // The peer's ACCEPT byte, before the caller awaiting connectText can attach
    // anything. Delivered on both sides' lanes: each captures its own.
    for (const pc of instances) for (const ch of pc.channels) ch._message(new Uint8Array([0xfe]).buffer);
    const [ic, rc] = await Promise.all([iP, rP]);

    expect(ic.takeCaptured?.("relayium").frames.map((f) => [...new Uint8Array(f)])).toEqual([[0xfe]]);
    expect(ic.takeCaptured?.("relayium").frames).toEqual([]); // one-shot; never replayed
    expect(rc.takeCaptured?.("relayium").frames).toHaveLength(1);
    // The bound must admit a full-size message frame (64 KiB + 21 B) -- a first
    // message that legitimately lands here must not fail the session it starts.
    expect(TEXT_CAPTURE_MAX_BYTES).toBeGreaterThan(TEXT_MAX_BYTES + TEXT_FRAME_OVERHEAD);
    // And must stay well under a link's: this window holds control bytes and a
    // message or two, not a manifest.
    expect(TEXT_CAPTURE_MAX_BYTES).toBeLessThan(LINK_CAPTURE_MAX_BYTES);
    ic.close();
    rc.close();
  });

  // The owner reported the lost-first-frame symptom on the cross-network
  // pairing-code path, not only on LAN. That path differs from the one above in
  // exactly one respect -- it forces ICE through a TURN relay -- so the capture
  // has to be proven under that configuration too, rather than assumed to carry
  // over. The config assertions are the point: without them this test would
  // silently degrade into a duplicate of the LAN case.
  it("retains an early text frame on the relay-only cross-network config too", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    // Shaped like what rtcConfig() hands the pairing-code path: server-issued
    // TURN plus the relay-only policy that skips the doomed direct checks.
    const relayOnly: RtcConfig = {
      iceServers: [{ urls: "turn:turn.relayium.test:3478?transport=udp", username: "u", credential: "c" }],
      iceTransportPolicy: "relay",
    };
    const rP = connectText({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {}, config: relayOnly });
    const iP = connectText({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {}, config: relayOnly });
    await flush();

    // Both ends really are on the relay-only path -- not silently on DEFAULT_ICE.
    expect(instances).toHaveLength(2);
    for (const pc of instances) {
      expect(pc.config?.iceTransportPolicy).toBe("relay");
      expect(pc.config?.iceServers).toEqual(relayOnly.iceServers);
    }

    openAll();
    // The auto-accepting peer's ACCEPT byte, spoken before the caller awaiting
    // connectText can attach a handler.
    for (const pc of instances) for (const ch of pc.channels) ch._message(new Uint8Array([0xfe]).buffer);
    const [ic, rc] = await Promise.all([iP, rP]);

    expect(ic.takeCaptured?.("relayium").frames.map((f) => [...new Uint8Array(f)])).toEqual([[0xfe]]);
    expect(rc.takeCaptured?.("relayium").frames).toHaveLength(1);
    ic.close();
    rc.close();
  });

  it("reports text-lane capture overflow instead of truncating it silently", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    const rP = connectText({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {} });
    const iP = connectText({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {} });
    await flush();
    openAll();
    for (const pc of instances) for (const ch of pc.channels) ch._message(new ArrayBuffer(TEXT_CAPTURE_MAX_BYTES + 1));
    const [ic, rc] = await Promise.all([iP, rP]);
    expect(ic.takeCaptured?.("relayium")).toEqual({ frames: [], overflow: true });
    ic.close();
    rc.close();
  });

  // The MITM defence is not weakened by running on its own generation: the same
  // commit-reveal, so the same refusal. Shaped after the file-path MITM test
  // above -- the responder rejects mid-flush, so the expectation is attached
  // before the flush rather than after it.
  it("aborts a text connection on a commitment mismatch, like the file one", async () => {
    useJumpableClock();
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iKey = generateKeyPair();
    const rKey = generateKeyPair();
    const attacker = generateKeyPair();
    const attackerB64 = btoa(String.fromCharCode(...attacker.publicKey));
    hub.setIntercept((d) => (d.reveal ? { ...d, reveal: { ...d.reveal, key: attackerB64 } } : d));

    let rPeer: Uint8Array | undefined;
    const rP = connectText({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: (k) => (rPeer = k) });
    const iP = connectText({ signaling: hub.I, peerId: "R", selfKey: iKey.publicKey, role: "initiator", onPeerKey: () => {} });
    const rejected = expect(rP).rejects.toThrow(/commitment|MITM/);

    await flush();
    await rejected;
    expect(rPeer).toBeUndefined();

    // Same as the file path: the text initiator is bounded by the handshake
    // deadline rather than left holding a keyless connection forever.
    openAll();
    await expectHandshakeTimeout(iP);
  });

  // The same property webrtc.test.ts already pins for resume, now across the
  // pair that matters: without it, a text offer lands in listenForIncoming and
  // starts a file receive on the peer.
  // The reported symptom was "正在建立加密连接 at 0% for a long time". The
  // transport timeout in webrtc-core only covers "did a channel open"; it is
  // cleared the moment one does. But the reveal that completes commit-reveal
  // travels over the SIGNALLING socket, not the channel — so a peer whose
  // WebSocket dies after answering (a phone that got backgrounded or lost its
  // cell connection between the answer and the reveal) leaves a perfectly open
  // channel whose keys never arrive. Before this deadline the caller's
  // `while (!keys)` spin had no upper bound at all, so "a long time" could be
  // forever: no failure, no progress, and only the cancel button as an exit.
  it("fails a handshake whose reveal never arrives instead of waiting forever", async () => {
    useJumpableClock();
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();

    // A responder that answers the offer (so the transport comes up and the
    // connect timer is cleared) but never sends its reveal — signalling died
    // right after the answer.
    hub.R.onSignal((from, data) => {
      const msg = data as InboundSignal;
      if (msg.sdp?.type === "offer") hub.R.sendSignal(from, { sdp: { type: "answer", sdp: "answer" }, commit: "AAAA" });
    });

    const iP = connect({
      signaling: hub.I, peerId: "R", selfKey: generateKeyPair().publicKey,
      role: "initiator", onPeerKey: () => {},
    });
    await flush();
    openAll(); // the channel is genuinely open; only the handshake is stuck
    await expectHandshakeTimeout(iP);
    // And the peer connection is torn down rather than left alive and keyless.
    expect(instances[0].connectionState).toBe("closed");
  });

  it("does not cross-route between a live file connection and a live text one", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const iFileKey = generateKeyPair();
    const iTextKey = generateKeyPair();
    const rFileKey = generateKeyPair();
    const rTextKey = generateKeyPair();

    // Both generations listening on the same signalling link, at the same time.
    const rFile = connect({ signaling: hub.R, peerId: "I", selfKey: rFileKey.publicKey, role: "responder", onPeerKey: () => {} });
    const rText = connectText({ signaling: hub.R, peerId: "I", selfKey: rTextKey.publicKey, role: "responder", onPeerKey: () => {} });

    const iFile = connect({ signaling: hub.I, peerId: "R", selfKey: iFileKey.publicKey, role: "initiator", onPeerKey: () => {} });
    await flush();
    // Exactly one answer, from the file side, and it is untagged.
    const answers1 = hub.sent.R.filter((m) => m.sdp?.type === "answer");
    expect(answers1.length).toBe(1);
    expect(answers1[0].text).toBeUndefined();

    const iText = connectText({ signaling: hub.I, peerId: "R", selfKey: iTextKey.publicKey, role: "initiator", onPeerKey: () => {} });
    await flush();
    const answers2 = hub.sent.R.filter((m) => m.sdp?.type === "answer");
    expect(answers2.length).toBe(2);
    expect(answers2.filter((m) => m.text === true).length).toBe(1);
    expect(answers2.filter((m) => m.text === undefined).length).toBe(1);

    openAll();
    for (const p of [rFile, rText, iFile, iText]) (await p.catch(() => null))?.close();
  });

  it("a text-tagged offer never reaches a file connection", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const rKey = generateKeyPair();
    const rP = connect({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {} });
    await flush();
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "v=0" }, text: true, commit: btoa("c".repeat(32)) });
    await flush();
    expect(hub.sent.R.length).toBe(0);
    rP.catch(() => {});
  });

  it("an untagged offer never reaches a text connection", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePC);
    const hub = makeHub();
    const rKey = generateKeyPair();
    const rP = connectText({ signaling: hub.R, peerId: "I", selfKey: rKey.publicKey, role: "responder", onPeerKey: () => {} });
    await flush();
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "v=0" }, commit: btoa("c".repeat(32)) });
    await flush();
    expect(hub.sent.R.length).toBe(0);
    rP.catch(() => {});
  });
});

describe("resume signal authentication surface", () => {
  it("re-exports the one authPayload, so a verifier cannot re-derive the bytes", () => {
    // A caller that pre-verifies an inbound resume offer has to cover EXACTLY the
    // bytes the connection primitive will sign. Sharing the function, rather than
    // the field list, is what makes that structural instead of a convention.
    expect(reExportedAuthPayload).toBe(authPayload);
  });
});
