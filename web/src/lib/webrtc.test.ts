import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { connect, type InboundSignal } from "./webrtc";
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
  let intercept: ((data: InboundSignal) => InboundSignal) | null = null;
  const clone = (d: unknown) => JSON.parse(JSON.stringify(d)) as InboundSignal;
  function side(self: "I" | "R", peer: "I" | "R"): SignalingClient {
    return {
      onSignal(cb: (from: string, data: unknown) => void) {
        listeners[self].push(cb);
        return () => {};
      },
      sendSignal(_to: string, data: unknown) {
        let d = clone(data);
        if (intercept) d = intercept(d);
        setTimeout(() => listeners[peer].forEach((cb) => cb(self, clone(d))), 0);
      },
    } as unknown as SignalingClient;
  }
  return { I: side("I", "R"), R: side("R", "I"), setIntercept: (fn: typeof intercept) => (intercept = fn) };
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
