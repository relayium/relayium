// The `RenewTransport` surface `establish()` builds, driven against a peer
// connection that reproduces the three real-browser behaviours an independent
// review captured against Chrome.
//
// Each block below names the capture it stands in for. They are regressions in
// the strict sense: every one of them passed the earlier implementation's own
// unit tests and still produced a migration that either could not complete or
// completed against the wrong generation.
//
//  · W1  `browser-selected-generation.json` — after an ICE restart Chrome keeps
//        the PREVIOUS generation's candidate-pair in `getStats()`, still
//        flagged `nominated` + `succeeded`, ahead of the new one in iteration
//        order. The transport's `selectedCandidatePairId` is the only
//        authoritative answer.
//  · W5  A transport address (protocol/ip/port/type) is NOT unique across ICE
//        generations — TCP-active candidates are published on port 9 by every
//        generation — so the ufrag fallback map must refuse an ambiguous key
//        rather than answer with whichever generation wrote it last.
//  · W7  `browser-pending-remote.json` — after `setRemoteDescription(offer)`
//        the responder's `currentRemoteDescription` is still the PREVIOUS
//        generation; the new offer is the PENDING one. Reading `current` made
//        the responder bind candidates to the old ufrag and validate the old
//        SDP against the pin.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LINK_CHANNEL_LABELS,
  classifyPath,
  establish,
  selectedCandidatePair,
  type Conn,
  type InboundSignal,
} from "./webrtc-core";
import type { SignalingClient } from "./signaling";

const PEER = "peer-1";

/** The epoch-0 description both ends are established on. */
const BASE_FINGERPRINT =
  "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

function sdpWith(ufrag: string, fingerprint = BASE_FINGERPRINT, setup = "actpass"): string {
  return [
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${ufrag}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    "a=mid:0", "a=sctp-port:5000", "",
  ].join("\r\n");
}

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

/**
 * A peer connection with the offer/answer state machine's REAL description
 * semantics — the part `webrtc-core.candidates.test.ts`'s fake does not model,
 * because it never needed to.
 *
 * `setRemoteDescription(offer)` sets `pendingRemoteDescription` and leaves
 * `currentRemoteDescription` alone. It is promoted to current only when the
 * answer completes the exchange. That is webrtc-pc §4.4.2 and it is what the
 * Chrome capture shows.
 */
class RenewPC {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  sctp: unknown = null;
  channels: FakeChannel[] = [];
  added: RTCIceCandidateInit[] = [];
  configurations: RTCConfiguration[] = [];
  closed = false;

  currentLocalDescription: RTCSessionDescriptionInit | null = null;
  pendingLocalDescription: RTCSessionDescriptionInit | null = null;
  currentRemoteDescription: RTCSessionDescriptionInit | null = null;
  pendingRemoteDescription: RTCSessionDescriptionInit | null = null;

  /** What `getStats()` answers with. Tests install the shape they are about. */
  stats: Map<string, unknown> = new Map();
  /** The ufrag `createOffer`/`createAnswer` will mint next. */
  nextUfrag = "gen1";

  get localDescription() { return this.pendingLocalDescription ?? this.currentLocalDescription; }
  get remoteDescription() { return this.pendingRemoteDescription ?? this.currentRemoteDescription; }

  createDataChannel(label: string) {
    const ch = new FakeChannel(label);
    this.channels.push(ch);
    return ch;
  }
  async createOffer(options?: RTCOfferOptions) {
    return {
      type: "offer",
      sdp: sdpWith(options?.iceRestart ? this.nextUfrag : "gen0"),
    } as RTCSessionDescriptionInit;
  }
  async createAnswer() {
    return { type: "answer", sdp: sdpWith(this.nextUfrag, BASE_FINGERPRINT, "active") } as RTCSessionDescriptionInit;
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    if (description.type === "offer") this.pendingLocalDescription = description;
    else {
      this.currentLocalDescription = description;
      this.pendingLocalDescription = null;
      // An answer completes the exchange in both directions.
      if (this.pendingRemoteDescription) {
        this.currentRemoteDescription = this.pendingRemoteDescription;
        this.pendingRemoteDescription = null;
      }
    }
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (description.type === "offer") {
      // **The behaviour this file exists for.** Pending, not current.
      this.pendingRemoteDescription = description;
    } else {
      this.currentRemoteDescription = description;
      this.pendingRemoteDescription = null;
      if (this.pendingLocalDescription) {
        this.currentLocalDescription = this.pendingLocalDescription;
        this.pendingLocalDescription = null;
      }
    }
    if (description.type === "offer" && this.ondatachannel) {
      for (const label of LINK_CHANNEL_LABELS) {
        const ch = new FakeChannel(label);
        this.channels.push(ch);
        this.ondatachannel({ channel: ch });
      }
    }
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) { this.added.push(candidate); }
  setConfiguration(config: RTCConfiguration) { this.configurations.push(config); }
  getStats() { return Promise.resolve(this.stats as unknown as RTCStatsReport); }
  close() { this.closed = true; this.connectionState = "closed"; }
}

/** A candidate string carrying its own generation, as every stack emits. */
function candidateLine(ufrag: string, ip: string, port: number, type = "relay", protocol = "udp") {
  return `candidate:1 1 ${protocol} 1677729535 ${ip} ${port} typ ${type} generation 0 ufrag ${ufrag}`;
}

function statsReport(rows: Record<string, Record<string, unknown>>): RTCStatsReport {
  const map = new Map<string, unknown>();
  for (const [id, row] of Object.entries(rows)) map.set(id, { id, ...row });
  return map as unknown as RTCStatsReport;
}

async function openLink(): Promise<{ conn: Conn; pc: RenewPC; sent: InboundSignal[] }> {
  const pcs: RenewPC[] = [];
  vi.stubGlobal("RTCPeerConnection", class extends RenewPC {
    constructor() { super(); pcs.push(this as unknown as RenewPC); }
  });
  const sent: InboundSignal[] = [];
  let listener: ((from: string, data: unknown) => void) | undefined;
  const signaling = {
    onSignal(cb: (from: string, data: unknown) => void) {
      listener = cb;
      return () => { listener = undefined; };
    },
    sendSignal(_to: string, data: unknown) { sent.push(data as InboundSignal); },
  } as unknown as SignalingClient;

  const pending = establish({
    signaling, peerId: PEER, role: "responder",
    generation: "link",
    channelLabels: LINK_CHANNEL_LABELS,
    // Epoch 0: the peer's original offer. This is what pins the baseline.
    initialSignal: { link: true, sdp: { type: "offer", sdp: sdpWith("gen0") } },
  } as Parameters<typeof establish>[0]);
  void pending.catch(() => {});
  // Let the responder apply the offer and collect its lanes.
  await new Promise((r) => setTimeout(r, 0));
  const pc = pcs[0];
  for (const ch of pc.channels) ch.open();
  const conn = await pending;
  // The answer completed the exchange, so epoch 0's remote is now `current`.
  expect(listener).toBeTypeOf("function");
  return { conn, pc, sent };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("selectedCandidatePair: the authoritative selection (W1)", () => {
  it("prefers the transport's selectedCandidatePairId over a stale nominated pair", () => {
    // The captured Chrome shape: the OLD pair is still nominated+succeeded and
    // comes first in iteration order; the transport points at the new one.
    const stats = statsReport({
      "CP-old": {
        type: "candidate-pair", nominated: true, state: "succeeded",
        localCandidateId: "L-old", remoteCandidateId: "R-old",
      },
      "CP-new": {
        type: "candidate-pair", nominated: true, state: "succeeded",
        localCandidateId: "L-new", remoteCandidateId: "R-new",
      },
      T1: { type: "transport", selectedCandidatePairId: "CP-new" },
    });
    expect((selectedCandidatePair(stats) as { localCandidateId: string }).localCandidateId)
      .toBe("L-new");
  });

  it("refuses to guess when two pairs qualify and no transport row says which", () => {
    // Without the authoritative row this is genuinely undecidable, and the
    // conservative answer is the one that keeps the old deadline.
    const stats = statsReport({
      "CP-old": { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L-old" },
      "CP-new": { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L-new" },
    });
    expect(selectedCandidatePair(stats)).toBeNull();
  });

  it("still answers from a single unambiguous pair, so pre-restart reports work", () => {
    const stats = statsReport({
      CP1: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L1" },
    });
    expect((selectedCandidatePair(stats) as { localCandidateId: string }).localCandidateId).toBe("L1");
  });

  it("returns null when the transport names a pair the report does not contain", () => {
    // A malformed report is not a licence to fall back to scanning: the agent
    // told us which pair it chose and we could not read it.
    const stats = statsReport({
      CP1: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L1" },
      T1: { type: "transport", selectedCandidatePairId: "CP-missing" },
    });
    expect(selectedCandidatePair(stats)).toBeNull();
  });

  it("classifyPath reads the same authoritative selection", () => {
    // The stale pair is a relay; the selected one is host↔host. First-match
    // would report "relay" for a link that has migrated to the LAN.
    const stats = statsReport({
      "CP-old": {
        type: "candidate-pair", nominated: true, state: "succeeded",
        localCandidateId: "L-relay", remoteCandidateId: "R-relay",
      },
      "CP-new": {
        type: "candidate-pair", nominated: true, state: "succeeded",
        localCandidateId: "L-host", remoteCandidateId: "R-host",
      },
      T1: { type: "transport", selectedCandidatePairId: "CP-new" },
      "L-relay": { type: "local-candidate", candidateType: "relay" },
      "R-relay": { type: "remote-candidate", candidateType: "relay" },
      "L-host": { type: "local-candidate", candidateType: "host" },
      "R-host": { type: "remote-candidate", candidateType: "host" },
    });
    expect(classifyPath(stats)).toBe("lan");
  });

  it.each([
    ["transport row first", ["T1", "CP-old", "CP-new"]],
    ["transport row last", ["CP-old", "CP-new", "T1"]],
    ["new pair before old", ["CP-new", "CP-old", "T1"]],
  ])("is independent of iteration order: %s", (_label, order) => {
    const rows: Record<string, Record<string, unknown>> = {
      "CP-old": { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L-old" },
      "CP-new": { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L-new" },
      T1: { type: "transport", selectedCandidatePairId: "CP-new" },
    };
    const map = new Map<string, unknown>();
    for (const id of order) map.set(id, { id, ...rows[id] });
    const stats = map as unknown as RTCStatsReport;
    expect((selectedCandidatePair(stats) as { localCandidateId: string }).localCandidateId)
      .toBe("L-new");
  });
});

describe("RenewTransport.selectedGeneration", () => {
  it("reports the ufrag of the pair the transport actually selected", async () => {
    const { conn, pc } = await openLink();
    const renew = conn.renew!;
    // Gather one candidate per generation, as a restart does.
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen0", "203.0.113.1", 40001), usernameFragment: "gen0", sdpMid: "0", sdpMLineIndex: 0 } });
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen1", "203.0.113.1", 40002), usernameFragment: "gen1", sdpMid: "0", sdpMLineIndex: 0 } });
    pc.stats = statsReport({
      "CP-old": { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L-old" },
      "CP-new": { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L-new" },
      T1: { type: "transport", selectedCandidatePairId: "CP-new" },
      // No `usernameFragment` on the row: the fallback map has to answer.
      "L-old": { type: "local-candidate", protocol: "udp", address: "203.0.113.1", port: 40001, candidateType: "relay" },
      "L-new": { type: "local-candidate", protocol: "udp", address: "203.0.113.1", port: 40002, candidateType: "relay" },
    }) as unknown as Map<string, unknown>;
    await expect(renew.selectedGeneration()).resolves.toEqual({ local: "gen1", remote: null });
    conn.close();
  });

  it("prefers a usernameFragment the stats row carries over the fallback map", async () => {
    const { conn, pc } = await openLink();
    pc.stats = statsReport({
      CP1: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L1" },
      T1: { type: "transport", selectedCandidatePairId: "CP1" },
      L1: { type: "local-candidate", usernameFragment: "gen7" },
    }) as unknown as Map<string, unknown>;
    await expect(conn.renew!.selectedGeneration()).resolves.toEqual({ local: "gen7", remote: null });
    conn.close();
  });

  it("refuses an AMBIGUOUS transport address rather than naming a generation (W5)", async () => {
    const { conn, pc } = await openLink();
    // TCP-active: every generation publishes port 9 at the same address, so
    // the key names two ufrags and can identify neither.
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen0", "203.0.113.1", 9, "host", "tcp"), usernameFragment: "gen0" } });
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen1", "203.0.113.1", 9, "host", "tcp"), usernameFragment: "gen1" } });
    pc.stats = statsReport({
      CP1: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L1" },
      T1: { type: "transport", selectedCandidatePairId: "CP1" },
      L1: { type: "local-candidate", protocol: "tcp", address: "203.0.113.1", port: 9, candidateType: "host" },
    }) as unknown as Map<string, unknown>;
    // Not "gen1", and not "gen0". Unknown — which makes observation fail and
    // the link keep the deadline it already had.
    await expect((await conn.renew!.selectedGeneration()).local).toBeNull();
    conn.close();
  });

  it("reports the remote generation where the report states it", async () => {
    const { conn, pc } = await openLink();
    pc.stats = statsReport({
      CP1: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L1", remoteCandidateId: "R1" },
      T1: { type: "transport", selectedCandidatePairId: "CP1" },
      L1: { type: "local-candidate", usernameFragment: "mine1" },
      R1: { type: "remote-candidate", usernameFragment: "theirs1" },
    }) as unknown as Map<string, unknown>;
    await expect(conn.renew!.selectedGeneration())
      .resolves.toEqual({ local: "mine1", remote: "theirs1" });
    conn.close();
  });

  it("infers nothing about the remote end when the report is silent", async () => {
    // No local mapping can stand in for it: this side never gathered the
    // peer's candidates. Null means "not stated", and the caller must not read
    // it as agreement.
    const { conn, pc } = await openLink();
    pc.stats = statsReport({
      CP1: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L1", remoteCandidateId: "R1" },
      T1: { type: "transport", selectedCandidatePairId: "CP1" },
      L1: { type: "local-candidate", usernameFragment: "mine1" },
      R1: { type: "remote-candidate" },
    }) as unknown as Map<string, unknown>;
    await expect(conn.renew!.selectedGeneration())
      .resolves.toEqual({ local: "mine1", remote: null });
    conn.close();
  });

  it("answers null for a prflx candidate this side never gathered", async () => {
    const { conn, pc } = await openLink();
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen1", "203.0.113.1", 40002), usernameFragment: "gen1" } });
    pc.stats = statsReport({
      CP1: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L1" },
      T1: { type: "transport", selectedCandidatePairId: "CP1" },
      L1: { type: "local-candidate", protocol: "udp", address: "198.51.100.9", port: 50505, candidateType: "prflx" },
    }) as unknown as Map<string, unknown>;
    await expect((await conn.renew!.selectedGeneration()).local).toBeNull();
    conn.close();
  });
});

describe("RenewTransport remote description (W7)", () => {
  it("reads the PENDING remote description after applying a renewal offer", async () => {
    const { conn, pc } = await openLink();
    const renew = conn.renew!;
    // Epoch 0 is `current` and names gen0.
    expect(renew.remoteUfrag()).toBe("gen0");
    expect(pc.currentRemoteDescription?.sdp).toContain("a=ice-ufrag:gen0");

    const pin = await renew.applyRemote({ type: "offer", sdp: sdpWith("gen9") });
    // The capture: `current` is STILL the old generation at this point.
    expect(pc.currentRemoteDescription?.sdp).toContain("a=ice-ufrag:gen0");
    expect(pc.pendingRemoteDescription?.sdp).toContain("a=ice-ufrag:gen9");
    // …and the transport must nevertheless report the new one.
    expect(renew.remoteUfrag()).toBe("gen9");
    // The pin comes from the description that was actually applied. Reading
    // `current` here would have returned the OLD pin, which compares equal to
    // the baseline and so passes a check it never ran.
    expect(pin.fingerprints).toEqual(renew.baseline()!.fingerprints);
    conn.close();
  });

  it("returns the pin of a FOREIGN description rather than the stale current one", async () => {
    const { conn, pc } = await openLink();
    const renew = conn.renew!;
    const foreign = "11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22";
    const pin = await renew.applyRemote({ type: "offer", sdp: sdpWith("gen9", foreign) });
    expect(pc.currentRemoteDescription?.sdp).toContain(BASE_FINGERPRINT);
    // The whole point: the returned pin is the FOREIGN one, so the caller can
    // refuse it. Reading `currentRemoteDescription` returned the baseline's own
    // fingerprints and the comparison silently succeeded.
    expect(pin.fingerprints[0]).toContain("11:22:33:44");
    expect(pin.fingerprints).not.toEqual(renew.baseline()!.fingerprints);
    conn.close();
  });

  it("pins the baseline from epoch 0 and never moves it", async () => {
    const { conn } = await openLink();
    const renew = conn.renew!;
    const baseline = renew.baseline();
    expect(baseline).toBeTruthy();
    await renew.applyRemote({ type: "offer", sdp: sdpWith("gen9") });
    expect(renew.baseline()).toEqual(baseline);
    conn.close();
  });
});

describe("RenewTransport candidate routing", () => {
  it("routes local candidates to the renewal callback once an epoch owns them", async () => {
    const { conn, pc, sent } = await openLink();
    const renew = conn.renew!;
    const seen: string[] = [];
    renew.onCandidate((c) => seen.push(c.candidate));
    const before = sent.length;
    pc.nextUfrag = "gen1";
    await renew.offer();
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen1", "203.0.113.1", 40002), usernameFragment: "gen1" } });
    renew.releaseCandidates();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    // **Nothing unsigned went out.** A renewal candidate must never travel as a
    // top-level `link` ICE signal, which is what the pre-renewal path does.
    expect(sent.slice(before).filter((m) => m.ice)).toHaveLength(0);
    conn.close();
  });

  it("holds this epoch's candidates until its description is on the wire", async () => {
    const { conn, pc } = await openLink();
    const renew = conn.renew!;
    const seen: string[] = [];
    renew.onCandidate((c) => seen.push(c.candidate));
    pc.nextUfrag = "gen1";
    await renew.offer();
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen1", "203.0.113.1", 40002), usernameFragment: "gen1" } });
    // Gathered, but the peer has not been told the new ufrag yet.
    expect(seen).toHaveLength(0);
    renew.releaseCandidates();
    expect(seen).toHaveLength(1);
    conn.close();
  });

  it("drops every renewal callback when the connection closes", async () => {
    const { conn, pc } = await openLink();
    const renew = conn.renew!;
    let calls = 0;
    renew.onCandidate(() => { calls++; });
    pc.nextUfrag = "gen1";
    await renew.offer();
    renew.releaseCandidates();
    conn.close();
    pc.onicecandidate?.({ candidate: { candidate: candidateLine("gen1", "203.0.113.1", 40003), usernameFragment: "gen1" } });
    expect(calls).toBe(0);
  });
});

describe("RenewTransport signalling lock", () => {
  it("refuses unsigned link-generation SDP once a renewal has been verified", async () => {
    const pcs: RenewPC[] = [];
    vi.stubGlobal("RTCPeerConnection", class extends RenewPC {
      constructor() { super(); pcs.push(this as unknown as RenewPC); }
    });
    let listener: ((from: string, data: unknown) => void) | undefined;
    const signaling = {
      onSignal(cb: (from: string, data: unknown) => void) { listener = cb; return () => { listener = undefined; }; },
      sendSignal() {},
    } as unknown as SignalingClient;
    const pending = establish({
      signaling, peerId: PEER, role: "responder",
      generation: "link",
      channelLabels: LINK_CHANNEL_LABELS,
      initialSignal: { link: true, sdp: { type: "offer", sdp: sdpWith("gen0") } },
    } as Parameters<typeof establish>[0]);
    void pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const pc = pcs[0];
    for (const ch of pc.channels) ch.open();
    const conn = await pending;

    const before = pc.added.length;
    conn.renew!.lockUnsignedSdp();
    // An unsigned re-offer on the link generation — exactly what a signalling
    // relay would inject — must now be inert.
    listener?.(PEER, { link: true, sdp: { type: "offer", sdp: sdpWith("forged") } });
    listener?.(PEER, { link: true, ice: { candidate: candidateLine("forged", "1.2.3.4", 1) } });
    await new Promise((r) => setTimeout(r, 0));
    expect(pc.added.length).toBe(before);
    expect(pc.remoteDescription?.sdp).not.toContain("a=ice-ufrag:forged");
    conn.close();
  });
});
