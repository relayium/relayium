// ICE candidate ORDERING and LIFETIME in the shared establishment core.
//
// Two defects, one on each side of the wire, and they are each other's mirror:
//
//  · INBOUND (the reachable one). `addIceCandidate` requires a remote
//    description, and this module used to call it inside a bare `try {} catch
//    {}` — so every candidate that arrived before the peer's answer was
//    silently destroyed. As the initiator, this page has NO remote description
//    between sending its offer and receiving the answer, and a peer that
//    trickles candidates before its own answer lands (Android's
//    `onIceCandidate` sends unconditionally) drops all of them into that catch.
//    On a LAN the SDP's host candidates cover the loss; across a network the
//    candidate that was destroyed is the relay one.
//
//  · OUTBOUND (hardening). The SDP is handed to `send` only AFTER
//    `await setLocalDescription(...)`, while candidates are handed over from
//    inside that await — so the serial send chain preserved the wrong order.
//    `FakePC` below reproduces it by dispatching `onicecandidate`
//    synchronously inside `setLocalDescription`. **That models a NATIVE stack
//    (libwebrtc/Android), not a browser one.** Under webrtc-pc a conformant
//    browser resolves `setLocalDescription` in a queued task and surfaces
//    candidates in tasks queued after it, so it emits the SDP first; there is
//    no real-browser reproduction here and none is claimed. What these tests
//    pin is that the module has an ordering defence at all — this file is
//    shared with the Electron renderer, and the invariant has to hold again on
//    every ICE restart.
import { describe, it, expect, vi, afterEach } from "vitest";
import { establish, LINK_CHANNEL_LABELS, type InboundSignal, type SignalAuth } from "./webrtc-core";
import type { SignalingClient } from "./signaling";

const PEER = "peer-1";

class FakeChannel {
  binaryType = "";
  bufferedAmountLowThreshold = 0;
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  constructor(readonly label: string) {}
  send() {}
  close() { this.readyState = "closed"; }
  open() { this.readyState = "open"; this.onopen?.(); }
}

class FakePC {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  sctp = null;
  channels: FakeChannel[] = [];
  localDescriptions: RTCSessionDescriptionInit[] = [];
  remoteDescriptions: RTCSessionDescriptionInit[] = [];
  added: RTCIceCandidateInit[] = [];
  closed = false;
  /** Candidates dispatched SYNCHRONOUSLY from inside setLocalDescription, i.e.
   *  before its promise resolves. The native ordering — see the file header. */
  emitDuringSetLocal: RTCIceCandidateInit[] = [];
  /** `candidate` values addIceCandidate refuses, modelling a malformed one. */
  rejectCandidates = new Set<string>();
  /** Make setLocalDescription fail AFTER it has gathered — the shape where a
   *  description the hold was opened for never comes into existence. */
  failSetLocal = false;
  /** Hold setRemoteDescription open so a test can cancel while it is pending. */
  pendingSetRemote = false;
  finishSetRemote: (() => void) | undefined;

  createDataChannel(label: string) {
    const ch = new FakeChannel(label);
    this.channels.push(ch);
    return ch;
  }
  async createOffer(options?: RTCOfferOptions) {
    return { type: "offer", sdp: options?.iceRestart ? "restart-offer" : "offer" } as RTCSessionDescriptionInit;
  }
  async createAnswer() { return { type: "answer", sdp: "answer" } as RTCSessionDescriptionInit; }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    for (const candidate of this.emitDuringSetLocal.splice(0, this.emitDuringSetLocal.length)) {
      this.onicecandidate?.({ candidate });
    }
    if (this.failSetLocal) throw new Error("setLocalDescription failed");
    this.localDescriptions.push(description);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (this.pendingSetRemote) {
      await new Promise<void>((resolve) => { this.finishSetRemote = resolve; });
    }
    this.remoteDescriptions.push(description);
    if (description.type === "offer" && this.ondatachannel) {
      for (const label of LINK_CHANNEL_LABELS) {
        const ch = new FakeChannel(label);
        this.channels.push(ch);
        this.ondatachannel({ channel: ch });
      }
    }
  }
  /** The spec rule this whole file is about: no remote description, no
   *  candidate. A real browser rejects here, which is exactly what the old
   *  empty catch was swallowing. */
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.remoteDescriptions.length === 0) {
      throw Object.assign(new Error("InvalidStateError"), { name: "InvalidStateError" });
    }
    // A candidate naming a ufrag that belongs to no current remote description
    // is an OperationError per webrtc-pc — which is what makes an ICE restart's
    // early candidates a second instance of the same hole, not a new one. The
    // description's `sdp` stands in for its ufrag.
    const ufrag = candidate?.usernameFragment;
    if (ufrag != null && ufrag !== this.remoteDescriptions[this.remoteDescriptions.length - 1].sdp) {
      throw new Error("OperationError: unknown ufrag");
    }
    if (typeof candidate?.candidate === "string" && this.rejectCandidates.has(candidate.candidate)) {
      throw new Error("OperationError");
    }
    this.added.push(candidate);
  }
  getStats() { return Promise.resolve(new Map() as unknown as RTCStatsReport); }
  close() { this.closed = true; this.connectionState = "closed"; }
}

function harness(role: "initiator" | "responder", extra: Partial<Parameters<typeof establish>[0]> = {}) {
  const pcs: FakePC[] = [];
  vi.stubGlobal("RTCPeerConnection", class extends FakePC {
    constructor() { super(); pcs.push(this as unknown as FakePC); }
  });
  const sent: InboundSignal[] = [];
  const states: RTCPeerConnectionState[] = [];
  let listener: ((from: string, data: unknown) => void) | undefined;
  const signaling = {
    onSignal(cb: (from: string, data: unknown) => void) {
      listener = cb;
      return () => { listener = undefined; };
    },
    sendSignal(_to: string, data: unknown) { sent.push(data as InboundSignal); },
  } as unknown as SignalingClient;
  const controller = new AbortController();
  const conn = establish({
    signaling, peerId: PEER, role,
    generation: "link",
    channelLabels: LINK_CHANNEL_LABELS,
    signal: controller.signal,
    onStateChange: (s) => states.push(s),
    ...extra,
  } as Parameters<typeof establish>[0]);
  void conn.catch(() => {});
  return {
    conn,
    sent,
    states,
    pc: () => pcs[0],
    inject: (msg: InboundSignal) => listener?.(PEER, msg),
    hasListener: () => listener !== undefined,
    abort: () => controller.abort(),
    /** Open every collected lane, which is what resolves `establish`. */
    openLanes: () => { for (const ch of pcs[0].channels) ch.open(); },
    /** Drive the initiator's one ICE restart. */
    goDisconnected: () => { pcs[0].connectionState = "disconnected"; pcs[0].onconnectionstatechange?.(); },
  };
}

/** Let the send chain, the receive chain and every microtask behind them run.
 *  Fake-timer aware: a real `setTimeout` never fires under `vi.useFakeTimers`,
 *  and the tests that assert on timer counts need both. */
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((r) => setTimeout(r, 0));
  }
};

const kinds = (sent: InboundSignal[]) => sent.map((m) => (m.sdp ? `sdp:${m.sdp.type}` : m.ice ? "ice" : "other"));
const candidate = (id: string): RTCIceCandidateInit => ({ candidate: id, sdpMid: "0", sdpMLineIndex: 0 });

// One `vi.stubGlobal` per harness; unstubbed between tests so a leaked PC class
// cannot make the next test pass for the wrong reason.
afterEach(() => vi.unstubAllGlobals());

describe("local candidates never precede their own description", () => {
  // THE PROBE. Reproduced against this module before the fix as ["ice","sdp"].
  // Fake-native ordering, honestly labelled — see the file header.
  it("sends the initial offer before candidates gathered while it was being set", async () => {
    const h = harness("initiator");
    h.pc().emitDuringSetLocal = [candidate("c1"), candidate("c2")];
    await settle();
    expect(kinds(h.sent)).toEqual(["sdp:offer", "ice", "ice"]);
    expect(h.sent.slice(1).map((m) => m.ice?.candidate)).toEqual(["c1", "c2"]);
    h.abort();
  });

  it("sends the answer before candidates gathered while it was being set", async () => {
    const h = harness("responder", { initialSignal: { link: true, sdp: { type: "offer", sdp: "offer" } } });
    h.pc().emitDuringSetLocal = [candidate("a1")];
    await settle();
    expect(kinds(h.sent)).toEqual(["sdp:answer", "ice"]);
    h.abort();
  });

  // The restart gathers under a NEW ufrag, so the gate has to close again. A
  // one-shot "have we ever sent an SDP" flag passes the two tests above and
  // fails this one.
  it("sends a restart offer before the candidates the restart gathers", async () => {
    const h = harness("initiator");
    await settle();
    h.sent.length = 0;
    const pc = h.pc();
    pc.emitDuringSetLocal = [candidate("r1")];
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    await settle();
    expect(kinds(h.sent)).toEqual(["sdp:offer", "ice"]);
    expect(h.sent[0].sdp?.sdp).toBe("restart-offer");
    h.abort();
  });

  // Candidates gathered after the description is out carry no delay at all.
  it("sends later candidates straight through", async () => {
    const h = harness("initiator");
    await settle();
    h.pc().onicecandidate?.({ candidate: candidate("late") });
    await settle();
    expect(kinds(h.sent)).toEqual(["sdp:offer", "ice"]);
    h.abort();
  });

  // FAIL CLOSED, the same rule the remote hold uses. A local queue only grows
  // while this side is waiting on its OWN description, so 64 entries means the
  // connection hit something it cannot explain — and truncating would dress a
  // resource-limit failure up as "connected, just a few candidates short",
  // where the missing ones are the only usable ones across a network.
  it("tears down rather than truncating an overflowing local hold", async () => {
    const h = harness("initiator");
    h.pc().emitDuringSetLocal = Array.from({ length: 70 }, (_, i) => candidate(`c${i}`));
    await settle();
    await expect(h.conn).rejects.toThrow(/too many candidates before its description/);
    expect(h.pc().closed).toBe(true);
    expect(h.sent).toEqual([]); // not even a truncated prefix reached the peer
  });

  // `failReady` alone is not a notification once the lanes are open: nothing is
  // awaiting `ready` any more. An ICE restart is where an ESTABLISHED link can
  // reach this, so the owner has to be told through the seam it already
  // watches, or it keeps a link whose peer connection we just closed.
  it("notifies the owner when an established link overflows during a restart", async () => {
    const h = harness("initiator");
    await settle();
    h.openLanes();
    await expect(h.conn).resolves.toBeDefined();
    h.pc().emitDuringSetLocal = Array.from({ length: 70 }, (_, i) => candidate(`r${i}`));
    h.goDisconnected();
    await settle();
    expect(h.states).toContain("failed");
    expect(h.pc().closed).toBe(true);
  });

  // Cancel lands while setLocalDescription is still pending. The await resumes
  // regardless, and what it resumes into must not put a tagged offer for an
  // abandoned connection on the wire.
  it("sends nothing once the establishment has been aborted", async () => {
    const h = harness("initiator");
    h.abort();
    h.pc().emitDuringSetLocal = [candidate("c1")];
    await settle();
    expect(h.sent).toEqual([]);
    await expect(h.conn).rejects.toThrow();
  });

  // A description that never came into existence cannot be what orders these
  // candidates. Emitting them anyway would put exactly the "candidate before
  // any SDP" frame on the wire that this gate exists to prevent.
  it("drops candidates gathered for a description that failed to install", async () => {
    const h = harness("initiator");
    const pc = h.pc();
    pc.failSetLocal = true;
    pc.emitDuringSetLocal = [candidate("orphan")];
    await settle();
    expect(h.sent).toEqual([]);
    await expect(h.conn).rejects.toThrow(/setLocalDescription failed/);
  });

  // The same rule on a live link, where the connection SURVIVES the failure.
  // `setLocalDescription` may fail AFTER it has begun gathering for the ufrag
  // it is installing, so a candidate held across a failed restart cannot be
  // assumed to belong to the description still in place — it is dropped. What
  // must not break is the gate: candidates gathered afterwards belong to the
  // description the peer really does hold, and have to keep flowing.
  it("drops a failed restart's candidates but keeps the gate open afterwards", async () => {
    const h = harness("initiator");
    await settle();
    h.openLanes();
    await expect(h.conn).resolves.toBeDefined();
    h.sent.length = 0;
    const pc = h.pc();
    pc.failSetLocal = true;
    pc.emitDuringSetLocal = [candidate("unsignalled-ufrag")];
    h.goDisconnected();
    await settle();
    expect(h.sent).toEqual([]); // nothing for a ufrag the peer was never told about

    pc.failSetLocal = false;
    pc.onicecandidate?.({ candidate: candidate("still-the-old-description") });
    await settle();
    expect(h.sent.map((m) => m.ice?.candidate)).toEqual(["still-the-old-description"]);
    expect(h.pc().closed).toBe(false);
  });

  it("stops sending candidates the moment it is aborted", async () => {
    const h = harness("initiator");
    await settle();
    expect(kinds(h.sent)).toEqual(["sdp:offer"]);
    h.abort();
    h.pc().onicecandidate?.({ candidate: candidate("after-abort") });
    await settle();
    expect(kinds(h.sent)).toEqual(["sdp:offer"]);
  });
});

describe("remote candidates wait for a remote description", () => {
  // THE REGRESSION. An initiator has no remote description until the answer
  // arrives; every candidate the peer trickles before its own answer used to
  // hit `addIceCandidate`'s InvalidStateError and vanish into an empty catch.
  it("holds candidates that arrive before the answer and applies them in order", async () => {
    const h = harness("initiator");
    await settle();
    h.inject({ link: true, ice: candidate("early-1") });
    h.inject({ link: true, ice: candidate("early-2") });
    await settle();
    expect(h.pc().added).toEqual([]); // nothing to attach them to yet
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual(["early-1", "early-2"]);
    h.abort();
  });

  it("applies a candidate that arrives after the answer immediately", async () => {
    const h = harness("initiator");
    await settle();
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    h.inject({ link: true, ice: candidate("late") });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual(["late"]);
    h.abort();
  });

  // Flushed exactly once: a second description must not replay the first
  // flush's candidates into the agent again.
  it("flushes the hold exactly once", async () => {
    const h = harness("initiator");
    await settle();
    h.inject({ link: true, ice: candidate("early") });
    await settle();
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    h.inject({ link: true, sdp: { type: "offer", sdp: "restart" } });
    h.inject({ link: true, ice: candidate("after-restart") });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual(["early", "after-restart"]);
    h.abort();
  });

  // One candidate the agent refuses must not take the rest of the flush with
  // it — that is the whole reason the flush catches per candidate.
  it("does not let a refused candidate poison its siblings", async () => {
    const h = harness("initiator");
    await settle();
    h.pc().rejectCandidates.add("bad");
    h.inject({ link: true, ice: candidate("good-1") });
    h.inject({ link: true, ice: candidate("bad") });
    h.inject({ link: true, ice: candidate("good-2") });
    await settle();
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual(["good-1", "good-2"]);
    h.abort();
  });

  // FAIL CLOSED, not truncate. A link built from a prefix of its peer's
  // candidates is not the link the peer is establishing, and a silent
  // truncation looks exactly like a healthy connection that never finishes.
  it("tears the establishment down rather than truncating an unbounded hold", async () => {
    const h = harness("initiator");
    await settle();
    for (let i = 0; i < 65; i++) h.inject({ link: true, ice: candidate(`flood-${i}`) });
    await settle();
    await expect(h.conn).rejects.toThrow(/held too many early candidates/);
    expect(h.pc().closed).toBe(true);
    expect(h.hasListener()).toBe(false); // and it stopped routing this peer
  });

  it("accepts a full hold of exactly the bound", async () => {
    const h = harness("initiator");
    await settle();
    for (let i = 0; i < 64; i++) h.inject({ link: true, ice: candidate(`c${i}`) });
    await settle();
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    expect(h.pc().added).toHaveLength(64);
    h.abort();
  });

  // The hold window closes the instant a remote description exists, so a flush
  // skipped because the SDP handler threw would never get a second chance.
  it("still flushes the hold when the answer handler throws", async () => {
    const h = harness("initiator", { onAnswer: () => { throw new Error("reveal rejected"); } });
    await settle();
    h.inject({ link: true, ice: candidate("early") });
    await settle();
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual(["early"]);
    h.abort();
  });

  // An ICE RESTART reopens the same hole the initial offer has. Once this side
  // sends a restart offer, the peer's restart answer carries a NEW ufrag, and
  // the candidates it trickles ahead of that answer belong to it — applying
  // them against the description still installed makes the ICE agent reject
  // them on `usernameFragment`, exactly as it rejects a candidate that arrives
  // with no remote description at all. A one-shot "have we ever had a remote
  // description" flag passes every test above and loses these.
  it("holds a remote candidate that arrives before the restart answer", async () => {
    const h = harness("initiator");
    await settle();
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    h.goDisconnected();
    await settle();
    expect(h.sent.some((m) => m.sdp?.sdp === "restart-offer")).toBe(true);

    // Gathered under the restart's ufrag, sent before the restart answer.
    h.inject({ link: true, ice: { ...candidate("restart-early"), usernameFragment: "restart-answer" } });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual([]);

    h.inject({ link: true, sdp: { type: "answer", sdp: "restart-answer" } });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual(["restart-early"]);
    h.abort();
  });

  // Held candidates belong to the connection that was abandoned. Nothing may
  // reach the peer connection after it is gone.
  it("drops the hold on abort and applies nothing afterwards", async () => {
    const h = harness("initiator");
    await settle();
    h.inject({ link: true, ice: candidate("early") });
    await settle();
    h.abort();
    await settle();
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    expect(h.pc().added).toEqual([]);
    expect(h.pc().closed).toBe(true);
  });
});

// Root reproduced this against the real module with `probe-core-late-close.mjs`
// (`postCloseOnAnswer: 1, postCloseAfterSdp: 1`): cancellation was guarded in
// `send` alone, so every await inside the signal handler resumed into a
// connection that no longer existed.
describe("nothing runs on a connection that is already closed", () => {
  /** Establish, open the lanes, then park an inbound answer inside a pending
   *  `setRemoteDescription` — the exact window the probe cancels in. */
  async function parkedAnswer(extra: Record<string, unknown> = {}) {
    const h = harness("initiator", extra as Partial<Parameters<typeof establish>[0]>);
    await settle();
    h.openLanes();
    const conn = await h.conn;
    h.pc().pendingSetRemote = true;
    h.inject({ link: true, sdp: { type: "answer", sdp: "answer" } });
    await settle();
    expect(h.pc().finishSetRemote).toBeDefined(); // genuinely parked
    return { h, conn };
  }

  it("does not reveal a key through onAnswer after the connection is closed", async () => {
    let answers = 0;
    const { h, conn } = await parkedAnswer({ onAnswer: () => { answers++; } });
    conn.close();
    h.pc().finishSetRemote?.();
    await settle();
    expect(answers).toBe(0);
  });

  it("does not run afterSdp after the connection is closed", async () => {
    let after = 0;
    const { h, conn } = await parkedAnswer({ afterSdp: () => { after++; } });
    conn.close();
    h.pc().finishSetRemote?.();
    await settle();
    expect(after).toBe(0);
  });

  it("applies no candidate carried by a signal that completed after close", async () => {
    const { h, conn } = await parkedAnswer();
    conn.close();
    h.pc().finishSetRemote?.();
    await settle();
    expect(h.pc().added).toEqual([]);
  });

  // A re-armed no-progress timer would keep a timer alive for another 30 s
  // against a connection that is already gone.
  it("re-arms no timer after close", async () => {
    vi.useFakeTimers();
    try {
      const { h, conn } = await parkedAnswer();
      expect(vi.getTimerCount()).toBe(0); // the setup timers went with `ready`
      conn.close();
      h.pc().finishSetRemote?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Clearing the setup timers is only safe if `close()` also settles `ready`:
  // the timers were the last thing that would have. A hook that closes without
  // failing (`ctx.close()` alone) must not leave its caller awaiting forever.
  it("settles a pending establishment that is closed without being failed", async () => {
    vi.useFakeTimers();
    try {
      const h = harness("responder", {
        initialSignal: { link: true, sdp: { type: "offer", sdp: "offer" } },
        afterSdp: (_msg: InboundSignal, ctx: { close(): void }) => { ctx.close(); },
      } as unknown as Partial<Parameters<typeof establish>[0]>);
      await settle();
      await expect(h.conn).rejects.toThrow(/closed/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The setup timers are the other half: a close BEFORE the channels open must
  // take them with it rather than leave them to fire at 30 s and 90 s.
  it("clears the setup timers when a pending establishment is closed", async () => {
    vi.useFakeTimers();
    try {
      const h = harness("initiator");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      h.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(h.conn).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // Verification is asynchronous, so cancellation lands inside it just as
  // readily as inside setRemoteDescription.
  it("abandons a signal whose authentication finished after close", async () => {
    let releaseVerify!: (ok: boolean) => void;
    const h = harness("initiator", {
      generation: "resume",
      auth: { sign: async () => "mac", verify: () => new Promise<boolean>((r) => { releaseVerify = r; }) },
    } as unknown as Partial<Parameters<typeof establish>[0]>);
    await settle();
    h.openLanes();
    const conn = await h.conn;
    h.inject({ resume: true, sdp: { type: "answer", sdp: "answer" }, auth: "mac" });
    await settle();
    conn.close();
    releaseVerify(true);
    await settle();
    expect(h.pc().remoteDescriptions).toEqual([]);
  });
});

describe("an authenticated resume verifies before it buffers", () => {
  const auth = (verify: (payload: string, mac: string | undefined) => Promise<boolean>): SignalAuth => ({
    sign: async () => "mac",
    verify,
  });
  const resumeOpts = (verify: Parameters<typeof auth>[0]) => ({
    generation: "resume" as const,
    auth: auth(verify),
  });

  // The hold must sit BEHIND the signature check, never in front of it.
  // Buffering first would let anyone on the signalling path fill a verified
  // session's candidate hold — including all the way to its fail-closed bound.
  it("never holds a candidate whose tag does not verify", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness("initiator", resumeOpts(async (_p, mac) => mac === "mac"));
    await settle();
    h.inject({ resume: true, ice: candidate("forged"), auth: "wrong" });
    await settle();
    h.inject({ resume: true, sdp: { type: "answer", sdp: "answer" }, auth: "mac" });
    await settle();
    expect(h.pc().added).toEqual([]); // the forgery was never buffered
    h.abort();
    warn.mockRestore();
  });

  it("holds and applies a candidate whose tag does verify", async () => {
    const h = harness("initiator", resumeOpts(async (_p, mac) => mac === "mac"));
    await settle();
    h.inject({ resume: true, ice: candidate("genuine"), auth: "mac" });
    await settle();
    h.inject({ resume: true, sdp: { type: "answer", sdp: "answer" }, auth: "mac" });
    await settle();
    expect(h.pc().added.map((c) => c.candidate)).toEqual(["genuine"]);
    h.abort();
  });

  // A forged flood must not be able to reach the fail-closed bound either.
  it("cannot be pushed over the hold bound by unverified candidates", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness("initiator", resumeOpts(async (_p, mac) => mac === "mac"));
    await settle();
    for (let i = 0; i < 200; i++) h.inject({ resume: true, ice: candidate(`f${i}`), auth: "wrong" });
    await settle();
    h.inject({ resume: true, sdp: { type: "answer", sdp: "answer" }, auth: "mac" });
    await settle();
    expect(h.pc().added).toEqual([]);
    expect(h.pc().closed).toBe(false); // not torn down: nothing was ever held
    h.abort();
    warn.mockRestore();
  });
});
