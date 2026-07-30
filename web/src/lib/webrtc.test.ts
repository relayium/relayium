import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { connect, connectResume, classifyPath, summarizeStats, PeerBusyError, LOCAL_CAPS, type InboundSignal } from "./webrtc";
import type { SignalingClient } from "./signaling";
import { ready, generateKeyPair, deriveSession, signResume, verifyResume, type SessionKeys } from "./crypto";
import { sas } from "./crypto";
import { authPayload, type SignalAuth } from "./webrtc-core";

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
    expect(LOCAL_CAPS).toContain("text/1");
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
    expect(offer?.caps).toEqual([...LOCAL_CAPS]);
    expect(answer?.caps).toEqual([...LOCAL_CAPS]);
    // Both sides know the peer's capabilities before the channel opens.
    expect(iSaw).toEqual([...LOCAL_CAPS]);
    expect(rSaw).toEqual([...LOCAL_CAPS]);

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
