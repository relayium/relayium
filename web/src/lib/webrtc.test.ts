import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { connect, connectResume, classifyPath, summarizeStats, PeerBusyError, type InboundSignal } from "./webrtc";
import type { SignalingClient } from "./signaling";
import { ready, generateKeyPair, sas } from "./crypto";

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
  send() {}
  close() { this.readyState = "closed"; }
  _open() { this.readyState = "open"; this.onopen?.(); }
}

const instances: FakePC[] = [];

class FakePC {
  onicecandidate: ((e: unknown) => void) | null = null;
  ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  channel: FakeDataChannel | null = null;
  constructor() { instances.push(this); }
  createDataChannel() { this.channel = new FakeDataChannel(); return this.channel; }
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async createAnswer() { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription() {}
  async setRemoteDescription(desc: { type: string }) {
    if (desc.type === "offer" && this.ondatachannel) {
      const ch = new FakeDataChannel();
      this.channel = ch;
      this.ondatachannel({ channel: ch });
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
const openAll = () => instances.forEach((pc) => { if (pc.channel && pc.channel.readyState !== "open") pc.channel._open(); });

beforeAll(async () => { await ready(); });
afterEach(() => { instances.length = 0; vi.unstubAllGlobals(); });

describe("webrtc commit-then-reveal handshake", () => {
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

    // Tidy the still-pending initiator side (channel-open clears its timer).
    openAll();
    try { (await iP).close(); } catch { /* also rejected — fine */ }
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
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder" });
    const iP = connectResume({ signaling: hub.I, peerId: "R", role: "initiator" });

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
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder" });
    const iP = connectResume({ signaling: hub.I, peerId: "R", role: "initiator" });
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
    const rP = connectResume({ signaling: hub.R, peerId: "I", role: "responder" });
    await flush();
    // An offer from the *original* generation (no resume tag) must not be answered.
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "stale" } });
    await flush();
    expect(hub.sent.R.length).toBe(0);

    // The properly tagged offer is answered.
    hub.inject("R", "I", { sdp: { type: "offer", sdp: "fresh" }, resume: true });
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
    const p = connectResume({ signaling: hub.I, peerId: "R", role: "initiator" });
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
    const seen: string[] = [];
    const p = connectResume({ signaling: hub.I, peerId: "R", role: "initiator", onStateChange: (s) => seen.push(s) });
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
