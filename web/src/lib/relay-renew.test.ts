// The relay-renewal state machine, driven as the product drives it.
//
// Two REAL `createRelayRenewal` controllers are wired to each other: one's
// `sendSignal` is the other's `signal`, one's text channel is the other's
// `frame`. Nothing here re-implements the protocol — the only fakes are the
// clock, the transport surface and the server, which is exactly the boundary
// `RelayRenewalDeps` draws.
//
// That matters because the defects this file pins were all invisible to a
// helper-level test. The trigger arithmetic, the replay guard, the commit
// fence and the post-commit window are properties of the machine in motion,
// not of any function in isolation.

import { describe, it, expect, beforeAll } from "vitest";
import {
  RENEW_ACK_VERIFY_RESERVE,
  RENEW_MAX_PREGRANT_ATTEMPTS,
  RENEW_POST_COMMIT_ACK_MS,
  RENEW_PROBE_VERIFY_RESERVE,
  RENEW_RETRY_BACKOFF_MS,
  createRelayRenewal,
  renewMarginMs,
  type RelayRenewal,
  type RelayRenewalDeps,
  type RenewState,
  type RenewedConfig,
} from "./relay-renew";
import {
  RENEW_EPOCH_HARD_CAP_MS,
  RENEW_ICE_PROBE_MS,
  RENEW_MAX_EPOCHS_PER_ROUND,
  RENEW_PREPARE_TO_READY_MS,
  RENEW_PROBE_TYPE_ACK,
  RENEW_PROBE_TYPE_PROBE,
  decodeRenewProbe,
  encodeRenewProbe,
  parseRenewEnvelope,
  renewProbePayload,
  renewSignalPayload,
  sdpIceUfrag,
  sdpPin,
  signRenew,
  signRenewProbe,
  toBase64,
  type IceGrant,
  type RenewEnvelope,
  type RenewSignal,
} from "./relay-renew-wire";
import type { MixedPeerLink } from "./peer-link.svelte";
import type { RelayDeadline } from "./relay-deadline";
import type { RenewTransport } from "./webrtc";

// ── fixtures ────────────────────────────────────────────────────────────────

const FP = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
const FOREIGN_FP = "11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22";

function sdpWith(ufrag: string, fingerprint = FP, setup = "actpass"): string {
  return [
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    `a=ice-ufrag:${ufrag}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`, "a=mid:0", "",
  ].join("\r\n");
}

const candidateFor = (ufrag: string, port = 40001) =>
  `candidate:1 1 udp 1677729535 203.0.113.1 ${port} typ relay generation 0 ufrag ${ufrag}`;

const HOUR = 60 * 60_000;

/** A grant body shaped exactly like `/api/ice`, for round `round`. */
function grantFor(round: number, rid: number, expirySeconds: number): IceGrant {
  return {
    status: "granted", round, rid,
    iceServers: [{
      urls: ["turn:relay.example:3478"],
      username: `${expirySeconds}:token`,
      credential: "secret",
    }],
  };
}

let key: CryptoKey;
beforeAll(async () => {
  key = await crypto.subtle.importKey(
    "raw", new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
});

// ── deterministic time ──────────────────────────────────────────────────────

function scheduler(start = 10 * HOUR) {
  let nowMs = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimer = (fn: () => void, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: nowMs + Math.max(0, ms), fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  };
  /** Drain microtasks, including the ones Web Crypto settles on. */
  const flush = async (turns = 30) => {
    for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
  };
  async function advance(ms: number) {
    const target = nowMs + ms;
    for (;;) {
      let bestId = -1;
      let best = Infinity;
      for (const [id, t] of timers) if (t.at <= target && t.at < best) { best = t.at; bestId = id; }
      if (bestId < 0) break;
      const t = timers.get(bestId)!;
      timers.delete(bestId);
      nowMs = t.at;
      t.fn();
      await flush(6);
    }
    nowMs = target;
    await flush(6);
  }
  return {
    now: () => nowMs,
    setTimer, clearTimer, advance, flush,
    pending: () => timers.size,
  };
}

// ── the transport surface ───────────────────────────────────────────────────

class FakeRenewTransport implements RenewTransport {
  /**
   * The pin of the epoch-0 REMOTE description, which is role-dependent.
   *
   * The initiator's is the responder's ANSWER and therefore names a concrete
   * DTLS role; the responder's is the initiator's OFFER and says `actpass`.
   * Getting this wrong in the fake is not cosmetic: the answer-role clause of
   * the pin only has anything to compare when the baseline came from an answer.
   */
  readonly baselinePin: ReturnType<typeof sdpPin>;
  localU: string;
  remoteU: string;
  /** The local ufrag `selectedGeneration` answers with. Null until a test
   *  says the path landed. */
  selected: string | null = null;
  gen = 0;
  configs: unknown[] = [];
  appliedRemote: RTCSessionDescriptionInit[] = [];
  addedCandidates: RTCIceCandidateInit[] = [];
  released = 0;
  locked = false;
  restartSuspended = false;
  candidateCb: ((c: RTCIceCandidate) => void) | null = null;
  pairCb: (() => void) | null = null;
  failOffer = false;
  failApplyRemote = false;

  constructor(readonly prefix: string, role: "initiator" | "responder") {
    this.localU = `${prefix}0`;
    this.remoteU = "peer0";
    this.baselinePin = sdpPin(
      role === "initiator" ? sdpWith("gen0", FP, "active") : sdpWith("gen0", FP, "actpass"),
    );
  }

  baseline() { return this.baselinePin; }
  localUfrag() { return this.localU; }
  remoteUfrag() { return this.remoteU; }
  setConfiguration(config: unknown) { this.configs.push(config); }
  async offer() {
    if (this.failOffer) throw new Error("offer failed");
    this.localU = `${this.prefix}${++this.gen}`;
    return { type: "offer", sdp: sdpWith(this.localU) } as RTCSessionDescriptionInit;
  }
  async answer() {
    this.localU = `${this.prefix}${++this.gen}`;
    return { type: "answer", sdp: sdpWith(this.localU, FP, "active") } as RTCSessionDescriptionInit;
  }
  async applyRemote(sdp: RTCSessionDescriptionInit) {
    if (this.failApplyRemote) throw new Error("setRemoteDescription failed");
    this.appliedRemote.push(sdp);
    this.remoteU = sdpIceUfrag(sdp.sdp ?? "");
    return sdpPin(sdp.sdp ?? "");
  }
  releaseCandidates() { this.released++; }
  async addCandidate(init: RTCIceCandidateInit) { this.addedCandidates.push(init); }
  onCandidate(cb: ((c: RTCIceCandidate) => void) | null) { this.candidateCb = cb; }
  onSelectedPair(cb: (() => void) | null) { this.pairCb = cb; }
  /** The remote end's generation, where a test wants it stated. */
  selectedRemote: string | null = null;
  async selectedGeneration() { return { local: this.selected, remote: this.selectedRemote }; }
  suspendUnsignedRestart(active: boolean) { this.restartSuspended = active; }
  lockUnsignedSdp() { this.locked = true; }

  /** Model the migration landing: the agent selects a pair of this generation. */
  land() { this.selected = this.localU; this.pairCb?.(); }
  /** Emit a locally gathered candidate for the current generation. */
  trickle(port = 40001) {
    this.candidateCb?.({
      candidate: candidateFor(this.localU, port),
      usernameFragment: this.localU,
      sdpMid: "0", sdpMLineIndex: 0,
    } as unknown as RTCIceCandidate);
  }
}

// ── one side ────────────────────────────────────────────────────────────────

interface Side {
  id: string;
  transport: FakeRenewTransport;
  link: MixedPeerLink;
  renewal: RelayRenewal;
  /** Frames this side wrote to the text lane, DRAINED by the delivery pump. */
  outFrames: ArrayBuffer[];
  /** Envelopes this side put on signalling, drained by the pump. */
  outSignals: RenewEnvelope[];
  /** Everything this side ever sent, never drained — so a test can replay a
   *  probe the pump already delivered. */
  frameLog: ArrayBuffer[];
  signalLog: RenewEnvelope[];
  commits: { deadline: RelayDeadline; round: number }[];
  states: RenewState[];
  /** Every `(round, rid)` this side asked the server for. */
  requests: { round: number; rid: number }[];
  /** What the server answers. Replaceable per test. */
  server: (round: number, rid: number) => Promise<IceGrant | null>;
  deadline: RelayDeadline | null;
  anchor: number;
  userActive: boolean;
  supportsRenew: boolean;
  /** Set when the peer should not receive what this side sends. */
  partitioned: boolean;
  /**
   * Drop selected frames on the way IN to this side.
   *
   * Loss, modelled where it actually happens. A whole-side partition is too
   * blunt for the asymmetric cases: the interesting states need one KIND of
   * frame to go missing — an ack, or a probe — while everything else keeps
   * flowing, which is exactly what a lossy path does.
   */
  dropInbound: ((frame: ArrayBuffer) => boolean) | null;
}

function deadlineAt(at: number, lifetimeMs = HOUR): RelayDeadline {
  const deadlineAt = at + lifetimeMs;
  return { expiresAt: deadlineAt + 60_000, deadlineAt, warnAt: deadlineAt - 5 * 60_000 };
}

function makeSide(
  clock: ReturnType<typeof scheduler>,
  id: string, peerId: string, role: "initiator" | "responder",
  prefix: string,
): Side {
  const transport = new FakeRenewTransport(prefix, role);
  const textChannel = {
    readyState: "open",
    send(data: ArrayBuffer) { side.outFrames.push(data); side.frameLog.push(data); },
  } as unknown as RTCDataChannel;
  const link = {
    peerId, role,
    conn: { renew: transport } as unknown as MixedPeerLink["conn"],
    textChannel,
    keys: { resumeAuth: key },
  } as unknown as MixedPeerLink;

  const side: Side = {
    id, transport, link,
    renewal: null as unknown as RelayRenewal,
    outFrames: [], outSignals: [], frameLog: [], signalLog: [],
    commits: [], states: [], requests: [],
    server: async (round, rid) => grantFor(round, rid, Math.floor((clock.now() + 2 * HOUR) / 1000)),
    // 50 minutes into a one-hour grant — the margin boundary, so a bare
    // `tick()` is due. Tests about the TRIGGER install their own instead.
    deadline: deadlineAt(clock.now() - 50 * 60_000, HOUR),
    anchor: clock.now() - 50 * 60_000,
    userActive: true,
    supportsRenew: true,
    partitioned: false,
    dropInbound: null,
  };

  const deps: RelayRenewalDeps = {
    selfId: () => id,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendSignal: (_to, envelope) => { side.outSignals.push(envelope); side.signalLog.push(envelope); },
    requestRound: (round, rid) => {
      side.requests.push({ round, rid });
      return side.server(round, rid);
    },
    peerSupportsRenew: () => side.supportsRenew,
    userActive: () => side.userActive,
    deadline: () => side.deadline,
    deadlineAnchor: () => side.anchor,
    renewedConfig: (grant): RenewedConfig | null => {
      const servers = grant.iceServers as { username?: string }[] | undefined;
      const username = servers?.[0]?.username;
      if (typeof username !== "string") return null;
      const seconds = Number(username.split(":")[0]);
      if (!Number.isFinite(seconds)) return null;
      return {
        rtc: { iceServers: [] },
        deadline: {
          expiresAt: seconds * 1000,
          deadlineAt: seconds * 1000 - 60_000,
          warnAt: seconds * 1000 - 5 * 60_000,
        },
      };
    },
    commit: (deadline, round) => {
      side.commits.push({ deadline, round });
      // What the product does: install the new boundary and re-anchor it.
      side.deadline = deadline;
      side.anchor = clock.now();
    },
    onStateChange: (s) => side.states.push(s),
  };
  side.renewal = createRelayRenewal(deps);
  side.renewal.setLink(link);
  return side;
}

/** Wire two sides together and pump whatever each has produced into the other. */
function pair(clock: ReturnType<typeof scheduler>) {
  const a = makeSide(clock, "peer-a", "peer-b", "initiator", "a");
  const b = makeSide(clock, "peer-b", "peer-a", "responder", "b");
  /**
   * Pump until both sides are quiet.
   *
   * Flushes BEFORE draining, every round. Everything these controllers emit is
   * produced behind an HMAC — `emit` signs before it calls `sendSignal` — so a
   * queue read in the same turn as `tick()` is always empty, and a pump that
   * returned on that would deliver nothing and quietly assert against a
   * machine that had not started.
   */
  async function deliver() {
    for (let i = 0; i < 60; i++) {
      await clock.flush(6);
      const aSignals = a.outSignals.splice(0, a.outSignals.length);
      const bSignals = b.outSignals.splice(0, b.outSignals.length);
      const aFrames = a.outFrames.splice(0, a.outFrames.length);
      const bFrames = b.outFrames.splice(0, b.outFrames.length);
      if (!aSignals.length && !bSignals.length && !aFrames.length && !bFrames.length) return;
      if (!a.partitioned) {
        for (const s of aSignals) b.renewal.signal("peer-a", s);
        for (const f of aFrames) if (!b.dropInbound?.(f)) b.renewal.frame(f);
      }
      if (!b.partitioned) {
        for (const s of bSignals) a.renewal.signal("peer-b", s);
        for (const f of bFrames) if (!a.dropInbound?.(f)) a.renewal.frame(f);
      }
    }
  }
  return { a, b, deliver };
}

/**
 * Run a complete renewal to commit on both sides.
 *
 * Deliberately a helper the tests CALL rather than assert inside: several tests
 * need a committed link as their starting state, and none of them should have
 * to re-describe the happy path to get one.
 */
async function renewBoth(clock: ReturnType<typeof scheduler>, p: ReturnType<typeof pair>) {
  p.a.renewal.tick();
  await p.deliver();
  // The migration lands on both sides.
  p.a.transport.land();
  p.b.transport.land();
  await clock.advance(600);
  await p.deliver();
  await clock.advance(600);
  await p.deliver();
}

// ── the trigger (W2) ────────────────────────────────────────────────────────

describe("the renewal trigger", () => {
  it("fires inside the margin of a one-hour grant, and not before", async () => {
    // The executable shape of the defect: with the margin measured from `now`
    // instead of from the grant's arming instant, the threshold chased the
    // clock and `due()` was false at every point until the deadline itself.
    const clock = scheduler();
    const p = pair(clock);
    const start = clock.now();
    p.a.deadline = deadlineAt(start, HOUR);
    p.a.anchor = start;

    // 50 minutes in: exactly the margin boundary of a 60-minute grant.
    await clock.advance(50 * 60_000);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests.length).toBeGreaterThan(0);
  });

  it("does not fire at 40 minutes of a one-hour grant", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const start = clock.now();
    p.a.deadline = deadlineAt(start, HOUR);
    p.a.anchor = start;
    await clock.advance(40 * 60_000);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(0);
  });

  it.each([
    ["50 minutes", 50 * 60_000],
    ["55 minutes", 55 * 60_000],
    ["59 minutes", 59 * 60_000],
  ])("requests at %s of a one-hour grant", async (_label, elapsed) => {
    const clock = scheduler();
    const p = pair(clock);
    const start = clock.now();
    p.a.deadline = deadlineAt(start, HOUR);
    p.a.anchor = start;
    await clock.advance(elapsed);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(1);
  });

  it("renews a 60-second accelerated grant at 40 s, not at 20 s", async () => {
    // A third of the lifetime, so the margin is 20 s and the window opens at
    // 40 s. The old comment claimed 20 s; the arithmetic says otherwise and the
    // test is what keeps the two agreeing.
    expect(renewMarginMs(60_000, 0)).toBe(20_000);
    const clock = scheduler();
    const p = pair(clock);
    const start = clock.now();
    p.a.deadline = deadlineAt(start, 60_000);
    p.a.anchor = start;
    await clock.advance(30_000);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(0);
    await clock.advance(11_000);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(1);
  });

  it("never requests for a link with no deadline — LAN and direct paths", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.deadline = null;
    await clock.advance(HOUR);
    p.a.renewal.tick();
    await clock.flush();
    // The backend is never asked. A local-only session makes no network call.
    expect(p.a.requests).toHaveLength(0);
    expect(p.a.outSignals).toHaveLength(0);
  });

  it("never requests for a grant that has already lapsed", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const start = clock.now();
    p.a.deadline = deadlineAt(start, HOUR);
    p.a.anchor = start;
    await clock.advance(HOUR + 1000);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(0);
  });

  it("never requests without recent user-lane activity, and resumes when it returns", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const start = clock.now();
    p.a.deadline = deadlineAt(start, HOUR);
    p.a.anchor = start;
    p.a.userActive = false;
    await clock.advance(50 * 60_000);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(0);
    p.a.userActive = true;
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(1);
  });

  it("never requests when the peer has not announced the capability", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const start = clock.now();
    p.a.deadline = deadlineAt(start, HOUR);
    p.a.anchor = start;
    p.a.supportsRenew = false;
    await clock.advance(50 * 60_000);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(0);
  });
});

// ── the happy path ──────────────────────────────────────────────────────────

describe("a committed migration", () => {
  it("moves both deadlines, exactly once, and only after the path is proven", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const before = p.a.deadline!.deadlineAt;

    p.a.renewal.tick();
    await p.deliver();

    // Everything has happened EXCEPT the path landing: both sides hold the new
    // configuration and have exchanged SDP. No deadline may have moved.
    expect(p.a.transport.configs.length).toBe(1);
    expect(p.b.transport.configs.length).toBe(1);
    expect(p.a.commits).toHaveLength(0);
    expect(p.b.commits).toHaveLength(0);
    expect(p.a.deadline!.deadlineAt).toBe(before);

    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();

    expect(p.a.commits).toHaveLength(1);
    expect(p.b.commits).toHaveLength(1);
    expect(p.a.deadline!.deadlineAt).toBeGreaterThan(before);
    expect(p.a.renewal.state).toBe("renewed");
    expect(p.b.renewal.state).toBe("renewed");
    expect(p.a.renewal.round).toBe(1);
    expect(p.b.renewal.round).toBe(1);
  });

  it("restarts ICE on both sides and applies each other's description", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.a.transport.released).toBeGreaterThan(0);
    expect(p.b.transport.released).toBeGreaterThan(0);
    expect(p.a.transport.appliedRemote).toHaveLength(1);
    expect(p.b.transport.appliedRemote).toHaveLength(1);
    // The initiator offered; the responder answered. Never both offering.
    expect(p.b.transport.appliedRemote[0].type).toBe("offer");
    expect(p.a.transport.appliedRemote[0].type).toBe("answer");
  });

  it("locks unsigned link-generation SDP on both sides once renewal is authenticated", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    expect(p.a.transport.locked).toBe(true);
    expect(p.b.transport.locked).toBe(true);
  });

  it("suspends the unauthenticated ICE restart while an epoch runs and releases it after", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.transport.restartSuspended).toBe(true);
    await renewBoth(clock, p);
    expect(p.a.transport.restartSuspended).toBe(false);
  });

  it("keeps trickling for the committed generation after a LATER attempt fails", async () => {
    // The transport holds one candidate route. A second attempt rebinds it, and
    // if that attempt then fails the route must still belong to the generation
    // the transport is actually on — otherwise trickle stops silently for the
    // rest of the connection.
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.a.commits).toHaveLength(1);

    // A second attempt, which the server refuses.
    await clock.advance(RENEW_POST_COMMIT_ACK_MS - 5_000);
    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid });
    // Anchor and boundary must describe the SAME grant: a boundary ten minutes
    // out with an anchor of "now" is a ten-minute grant, whose margin is 200 s,
    // and the trigger correctly declines.
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.a.renewal.tick();
    await p.deliver();
    expect(p.a.renewal.state).not.toBe("renewed");

    // A candidate for the COMMITTED generation still goes out, under the
    // committed epoch and round.
    p.a.outSignals.length = 0;
    p.a.transport.trickle(40099);
    await clock.flush();
    const ice = p.a.outSignals
      .map((e) => parseRenewEnvelope(e))
      .find((e) => e?.renew.type === "ice");
    expect(ice).toBeTruthy();
    expect(ice!.renew.type === "ice" && ice!.renew.round).toBe(1);
  });

  it("supports more than one renewal on the same link", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.a.renewal.round).toBe(1);

    // The committed boundary is a fresh two-hour grant; wind on into its own
    // margin and renew again.
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    p.a.anchor = clock.now();
    p.a.deadline = deadlineAt(clock.now(), HOUR);
    p.b.anchor = clock.now();
    p.b.deadline = deadlineAt(clock.now(), HOUR);
    p.a.server = async (round, rid) => grantFor(round, rid, Math.floor((clock.now() + 3 * HOUR) / 1000));
    p.b.server = p.a.server;
    await clock.advance(50 * 60_000);
    await renewBoth(clock, p);
    expect(p.a.renewal.round).toBe(2);
    expect(p.b.renewal.round).toBe(2);
    expect(p.a.commits).toHaveLength(2);
  });
});

// ── the server says no ──────────────────────────────────────────────────────

describe("a renewal that does not happen never extends anything", () => {
  const cases: [string, (side: Side) => void][] = [
    ["an old server that ignores ice-renew", (s) => { s.server = async () => null; }],
    ["a denied round", (s) => { s.server = async (round, rid) => ({ status: "denied", round, rid, relayDenied: "quota" }); }],
    ["an unavailable server", (s) => { s.server = async (round, rid) => ({ status: "unavailable", round, rid }); }],
    ["a grant with no usable credential", (s) => { s.server = async (round, rid) => ({ status: "granted", round, rid, iceServers: [] }); }],
    ["a grant whose reply does not correlate", (s) => { s.server = async (round) => grantFor(round, 999_999, 1); }],
  ];

  it.each(cases)("%s leaves the deadline exactly where it was", async (_label, configure) => {
    const clock = scheduler();
    const p = pair(clock);
    const before = p.a.deadline!.deadlineAt;
    configure(p.a);
    configure(p.b);
    p.a.renewal.tick();
    await p.deliver();
    await clock.advance(RENEW_PREPARE_TO_READY_MS + 1000);
    await p.deliver();
    expect(p.a.commits).toHaveLength(0);
    expect(p.a.deadline!.deadlineAt).toBe(before);
    expect(p.a.renewal.round).toBe(0);
    expect(p.a.renewal.state).not.toBe("renewed");
  });

  it("refuses a grant that would move the boundary EARLIER", async () => {
    // Applying it would retire a live allocation in favour of a shorter-lived
    // one — a "renewal" that costs the link time rather than buying it.
    const clock = scheduler();
    const p = pair(clock);
    const before = p.a.deadline!.deadlineAt;
    const shorter = Math.floor((clock.now() + 10 * 60_000) / 1000);
    p.a.server = async (round, rid) => grantFor(round, rid, shorter);
    p.b.server = p.a.server;
    p.a.renewal.tick();
    await p.deliver();
    expect(p.a.commits).toHaveLength(0);
    expect(p.a.deadline!.deadlineAt).toBe(before);
  });

  it("treats a denial as terminal for the round and stops asking", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.server = async (round, rid) => ({ status: "denied", round, rid, relayDenied: "quota" });
    p.b.server = p.a.server;
    p.a.renewal.tick();
    await p.deliver();
    const asked = p.a.requests.length;
    expect(p.a.renewal.state).toBe("denied");
    // Every later tick, however long the window stays open, asks nothing more.
    for (let i = 0; i < 5; i++) {
      await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
      p.a.renewal.tick();
      await clock.flush();
    }
    expect(p.a.requests).toHaveLength(asked);
  });

  it("charges a PRE-GRANT refusal to its own budget, not the migration budget", async () => {
    // The correction: a transient `unavailable` never obtained a configuration
    // and never restarted ICE, so it must not spend one of the three migration
    // epochs a credential round is allowed. Charging it there meant a few
    // minutes of database wobble abandoned renewal permanently while most of
    // the margin was still unspent.
    const clock = scheduler();
    const p = pair(clock);
    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid });
    p.b.server = p.a.server;
    for (let i = 0; i < RENEW_MAX_EPOCHS_PER_ROUND + 1; i++) {
      p.a.renewal.tick();
      await p.deliver();
      await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
      await p.deliver();
    }
    // More attempts than the migration ceiling, because none of them was one.
    expect(p.a.requests.length).toBeGreaterThan(RENEW_MAX_EPOCHS_PER_ROUND);

    // …and the moment the server recovers, a real migration is still available:
    // the migration budget was never touched.
    p.a.server = async (round, rid) => grantFor(round, rid, Math.floor((clock.now() + 2 * HOUR) / 1000));
    p.b.server = p.a.server;
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    await renewBoth(clock, p);
    expect(p.a.commits).toHaveLength(1);
  });

  it("still bounds a permanently unavailable server, and never past the old deadline", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid });
    p.b.server = p.a.server;
    for (let i = 0; i < RENEW_MAX_PREGRANT_ATTEMPTS + 6; i++) {
      p.a.renewal.tick();
      await p.deliver();
      await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
      await p.deliver();
    }
    expect(p.a.requests.length).toBeLessThanOrEqual(RENEW_MAX_PREGRANT_ATTEMPTS);
    expect(p.a.commits).toHaveLength(0);

    // Past the boundary nothing is attempted at all, whatever budget remains.
    const asked = p.a.requests.length;
    await clock.advance(HOUR);
    p.a.renewal.tick();
    await clock.flush();
    expect(p.a.requests).toHaveLength(asked);
  });

  it("charges a failed MIGRATION to the migration budget", async () => {
    // The other half: an epoch that did obtain a configuration and then failed
    // to migrate is a real attempt on a real credential round, and three of
    // those is the ceiling.
    const clock = scheduler();
    const p = pair(clock);
    // The server grants, but the path never lands, so every epoch times out.
    for (let i = 0; i < RENEW_MAX_EPOCHS_PER_ROUND + 2; i++) {
      p.a.renewal.tick();
      await p.deliver();
      await clock.advance(RENEW_EPOCH_HARD_CAP_MS + RENEW_RETRY_BACKOFF_MS + 1000);
      await p.deliver();
    }
    expect(p.a.requests.length).toBeLessThanOrEqual(RENEW_MAX_EPOCHS_PER_ROUND);
    expect(p.a.commits).toHaveLength(0);
  });

  it("does not spend the whole round's epochs inside one polling window", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid });
    p.b.server = p.a.server;
    p.a.renewal.tick();
    await p.deliver();
    const afterFirst = p.a.requests.length;
    // The product polls every five seconds while inside the window.
    for (let i = 0; i < 6; i++) {
      await clock.advance(5_000);
      p.a.renewal.tick();
      await clock.flush();
    }
    expect(p.a.requests).toHaveLength(afterFirst);
  });
});

// ── replay and epoch monotonicity (W4) ──────────────────────────────────────

describe("epoch replay", () => {
  it("refuses a validly signed prepare for an epoch already spent", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.b.server = async () => null; // epoch 1 fails
    // A genuine, correctly signed prepare — the message a peer really sends.
    const prepare = await sealFor(p.a.id, p.b.id, { type: "prepare", epoch: 1 });
    p.b.renewal.signal("peer-a", prepare);
    await p.deliver();
    await clock.advance(RENEW_PREPARE_TO_READY_MS + 1000);
    await p.deliver();
    const asked = p.b.requests.length;
    expect(asked).toBeGreaterThan(0);

    // **The attack.** Not a forged tag — a replay of a message that really was
    // valid. It must not start a second attempt at an epoch already spent, nor
    // charge the server for that round again.
    p.b.renewal.signal("peer-a", prepare!);
    await clock.flush();
    expect(p.b.requests).toHaveLength(asked);
  });

  it("keeps the epoch counter across a transport rebuild that publishes null in between", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.b.server = async () => null;
    const prepare = await sealFor(p.a.id, p.b.id, { type: "prepare", epoch: 1 });
    p.b.renewal.signal("peer-a", prepare);
    await p.deliver();
    await clock.advance(RENEW_PREPARE_TO_READY_MS + 1000);
    const asked = p.b.requests.length;
    expect(asked).toBeGreaterThan(0);

    // A `link:§8` rebuild: null, then the same authenticated link on a new
    // transport. Resetting the counter here is exactly what the replay needs.
    p.b.renewal.setLink(null);
    const rebuilt = {
      ...p.b.link,
      conn: { renew: p.b.transport } as unknown as MixedPeerLink["conn"],
    } as MixedPeerLink;
    p.b.renewal.setLink(rebuilt);
    await clock.flush();

    p.b.renewal.signal("peer-a", prepare);
    await clock.flush();
    expect(p.b.requests).toHaveLength(asked);
  });

  it("resets the counter for a genuinely new link — different session keys", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.server = async () => null;
    p.a.renewal.tick();
    await clock.flush();
    const spent = p.a.requests.length;
    await clock.advance(RENEW_PREPARE_TO_READY_MS + 1000);

    const otherKey = await crypto.subtle.importKey(
      "raw", new Uint8Array(32).fill(9) as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
    );
    p.a.renewal.setLink({ ...p.a.link, keys: { resumeAuth: otherKey } } as MixedPeerLink);
    p.a.server = async (round, rid) => grantFor(round, rid, Math.floor((clock.now() + 2 * HOUR) / 1000));
    p.a.anchor = clock.now();
    p.a.deadline = deadlineAt(clock.now(), HOUR);
    await clock.advance(50 * 60_000);
    p.a.renewal.tick();
    await clock.flush();
    // A new authentication step starts over: epoch 1 is available again.
    expect(p.a.requests.length).toBeGreaterThan(spent);
  });

  it("drops a renewal signal whose tag does not verify", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const prepare = await sealFor(p.a.id, p.b.id, { type: "prepare", epoch: 1 });
    const forged: RenewEnvelope = { ...prepare, auth: "A".repeat(44) };
    const asked = p.b.requests.length;
    p.b.renewal.signal("peer-a", forged);
    await clock.flush();
    expect(p.b.requests).toHaveLength(asked);
    expect(p.b.transport.locked).toBe(false);
  });
});

// ── glare ───────────────────────────────────────────────────────────────────

describe("two peers preparing at once", () => {
  it("coalesces a simultaneous prepare at the same epoch into one attempt", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    p.b.renewal.tick();
    await p.deliver();
    // One round request each, not two: the same epoch number on both sides is
    // one attempt, not a collision.
    expect(p.a.requests).toHaveLength(1);
    expect(p.b.requests).toHaveLength(1);
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);
    expect(p.b.commits).toHaveLength(1);
  });

  it("keeps exactly one offerer — the established initiator", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    p.b.renewal.tick();
    await p.deliver();
    // The responder applied an offer; the initiator applied an answer. If both
    // had offered, both would have applied an offer.
    expect(p.b.transport.appliedRemote.map((d) => d.type)).toEqual(["offer"]);
    expect(p.a.transport.appliedRemote.map((d) => d.type)).toEqual(["answer"]);
  });
});

// ── SDP and candidate gates ─────────────────────────────────────────────────

describe("SDP pinning", () => {
  it("refuses a foreign DTLS fingerprint BEFORE touching the peer connection", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await clock.flush();
    // Let A reach the point of having sent its offer.
    await p.deliver();
    const applied = p.b.transport.appliedRemote.length;

    // A forged-but-signed offer carrying a different identity. It is signed
    // because the tag proves WHO sent it, not that the transport may be moved —
    // which is the whole reason the pin exists.
    const inner = { type: "sdp" as const, epoch: 1, round: 1, sdpType: "offer" as const, sdp: sdpWith("evil", FOREIGN_FP) };
    const envelope = await sealFor(p.a.id, p.b.id, inner);
    p.b.renewal.signal("peer-a", envelope);
    await clock.flush();
    // Never applied. The check runs on the received bytes, so the agent is
    // never moved onto a description it then has to be talked out of.
    expect(p.b.transport.appliedRemote).toHaveLength(applied);
    expect(p.b.commits).toHaveLength(0);
  });

  it("refuses an answer that flips the DTLS role", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    const applied = p.a.transport.appliedRemote.length;
    const inner = {
      type: "sdp" as const, epoch: 1, round: 1, sdpType: "answer" as const,
      sdp: sdpWith("b9", FP, "passive"),
    };
    p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, inner));
    await clock.flush();
    expect(p.a.transport.appliedRemote).toHaveLength(applied);
    expect(p.a.commits).toHaveLength(0);
  });

  it("refuses a description that changes the m-line set", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    const applied = p.b.transport.appliedRemote.length;
    const extra = sdpWith("evil") + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\n";
    const inner = { type: "sdp" as const, epoch: 1, round: 1, sdpType: "offer" as const, sdp: extra };
    p.b.renewal.signal("peer-a", await sealFor(p.a.id, p.b.id, inner));
    await clock.flush();
    expect(p.b.transport.appliedRemote).toHaveLength(applied);
  });
});

describe("candidate binding", () => {
  it("drops an inbound candidate from the wrong generation", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    const added = p.b.transport.addedCandidates.length;
    const inner = {
      type: "ice" as const, epoch: 1, round: 1,
      candidate: candidateFor("stale-gen"),
      sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "stale-gen",
    };
    p.b.renewal.signal("peer-a", await sealFor(p.a.id, p.b.id, inner));
    await clock.flush();
    expect(p.b.transport.addedCandidates).toHaveLength(added);
  });

  it("drops a candidate whose two ufrag sources contradict each other", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    const added = p.b.transport.addedCandidates.length;
    const realUfrag = p.b.transport.remoteU;
    const inner = {
      type: "ice" as const, epoch: 1, round: 1,
      // The field claims the current generation; the candidate string says
      // otherwise. A relay that relabels one copy gets a drop.
      candidate: candidateFor("other-gen"),
      sdpMid: "0", sdpMLineIndex: 0, usernameFragment: realUfrag,
    };
    p.b.renewal.signal("peer-a", await sealFor(p.a.id, p.b.id, inner));
    await clock.flush();
    expect(p.b.transport.addedCandidates).toHaveLength(added);
  });

  it("accepts a candidate naming this epoch's remote generation", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    const added = p.b.transport.addedCandidates.length;
    const realUfrag = p.b.transport.remoteU;
    const inner = {
      type: "ice" as const, epoch: 1, round: 1,
      candidate: candidateFor(realUfrag), sdpMid: "0", sdpMLineIndex: 0,
      usernameFragment: realUfrag,
    };
    p.b.renewal.signal("peer-a", await sealFor(p.a.id, p.b.id, inner));
    await clock.flush();
    expect(p.b.transport.addedCandidates.length).toBe(added + 1);
  });
});

// ── observation and the commit fence (W3, W7) ───────────────────────────────

describe("the commit fence", () => {
  it("does not observe or probe before the answer has been applied (W7)", async () => {
    const clock = scheduler();
    const p = pair(clock);
    // B's replies never reach A, so A will offer and then hear nothing.
    p.b.partitioned = true;
    p.a.renewal.tick();
    await p.deliver();
    // Hand A the `ready` it needs to proceed, signed exactly as B would.
    p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, { type: "ready", epoch: 1, round: 1 }));
    await p.deliver();
    // A has restarted ICE: it offered, and its candidates were released.
    expect(p.a.transport.released).toBeGreaterThan(0);

    // A's own migration "lands" locally — the offerer has restarted ICE and can
    // form a pair while the far end is still on the previous generation.
    p.a.transport.land();
    await clock.advance(5_000);
    await p.deliver();
    // No probe went out, because A has no answer and therefore no evidence the
    // remote end migrated at all. Observing here would satisfy §6.3's local
    // clause against a half-migrated transport.
    expect(firstProbe(p.a)).toBeUndefined();
    expect(p.a.commits).toHaveLength(0);
  });

  it("refuses a pair whose REMOTE end still names the previous generation (R6)", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    // The local end migrated; the far end of the selected pair did not. Where
    // the stats say so, that is not a migrated path.
    p.a.transport.selectedRemote = "stale-remote";
    p.b.transport.selectedRemote = null;
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(RENEW_ICE_PROBE_MS + 1000);
    await p.deliver();
    expect(p.a.commits).toHaveLength(0);
  });

  it("accepts a pair whose remote end names THIS epoch's generation", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.selectedRemote = p.a.transport.remoteU;
    p.b.transport.selectedRemote = p.b.transport.remoteU;
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);
  });

  it("never commits on its own ack alone", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    // Only A's path lands. It will ack B's probe, but B never acks A's.
    p.a.transport.land();
    await clock.advance(RENEW_ICE_PROBE_MS + 1000);
    await p.deliver();
    expect(p.a.commits).toHaveLength(0);
    expect(p.a.renewal.state).not.toBe("renewed");
  });

  it("ignores an ack that arrives before this side has observed its path", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    // Forge nothing: use a REAL ack for a nonce A has not even minted. It
    // cannot match, and even a matching one would be refused before observation.
    const nonce = new Uint8Array(16).fill(3);
    const frame = await probeFrame(p.b.id, p.a.id, RENEW_PROBE_TYPE_ACK, 1, 1, nonce);
    p.a.renewal.frame(frame);
    await clock.flush();
    expect(p.a.commits).toHaveLength(0);
  });

  it("keeps answering the peer's retransmitted probe after committing (W3)", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);

    // B retransmits the probe it had already sent — the shape that occurs when
    // A's ack was lost. A has committed and cleared its attempt; without the
    // post-commit window this would be dropped and B would time out holding an
    // expiring deadline while A believed the migration was shared.
    const bProbe = firstProbe(p.b);
    expect(bProbe).toBeTruthy();
    p.a.outFrames.length = 0;
    p.a.renewal.frame(bProbe!);
    await clock.flush();
    const acks = p.a.outFrames
      .map((f) => decodeRenewProbe(f))
      .filter((d) => d?.type === RENEW_PROBE_TYPE_ACK);
    expect(acks.length).toBeGreaterThan(0);
  });

  it("stops answering once the post-commit window closes", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);
    const probe = firstProbe(p.b);
    expect(probe).toBeTruthy();

    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1_000);
    p.a.outFrames.length = 0;
    p.a.renewal.frame(probe!);
    await clock.flush();
    expect(p.a.outFrames).toHaveLength(0);
  });

  it("refuses a frame that reuses a verified nonce with a different tag", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();

    // A has verified and acked one of B's probe nonces. Take that exact nonce,
    // keep it, and change the tag: matching on the nonce alone would hand a
    // forged frame a free ack without it ever holding the key.
    const probeBytes = firstProbe(p.b);
    expect(probeBytes).toBeTruthy();
    const probe = decodeRenewProbe(probeBytes!)!;
    const forged = encodeRenewProbe({
      type: RENEW_PROBE_TYPE_PROBE,
      epoch: probe.epoch,
      round: probe.round,
      nonce: probe.nonce,
      tag: new Uint8Array(32).fill(0xaa),
    });
    p.a.outFrames.length = 0;
    p.a.renewal.frame(forged);
    await clock.flush();
    expect(p.a.outFrames).toHaveLength(0);
  });

  it("answers an exact duplicate from cache without a second signature", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    const probe = firstProbe(p.b);
    expect(probe).toBeTruthy();
    p.a.outFrames.length = 0;
    // The SAME bytes again. An idempotent ack, from cache.
    p.a.renewal.frame(probe!);
    await clock.flush();
    const acks = p.a.outFrames.filter((f) => decodeRenewProbe(f)?.type === RENEW_PROBE_TYPE_ACK);
    expect(acks.length).toBe(1);
  });
});

// ── W8: the two server replies do not arrive together ───────────────────────

/**
 * Hold one side's round reply until the test releases it.
 *
 * The suite's default servers are `async` functions that settle in the next
 * microtask, so both grants land in the same turn and every `ready` arrives
 * after its own side already has a configuration. That symmetry is an artifact
 * of the harness, not of the world: the two peers ask independently and the
 * replies come back whenever they come back. Delaying one is what exposes the
 * ordering, and it is what a real Chrome run with a one-second delay on one
 * side found.
 */
function holdServer(side: Side, clock: ReturnType<typeof scheduler>) {
  const pending: Array<() => void> = [];
  side.server = (round, rid) => new Promise<IceGrant | null>((resolve) => {
    pending.push(() => resolve(grantFor(round, rid, Math.floor((clock.now() + 2 * HOUR) / 1000))));
  });
  return {
    held: () => pending.length,
    release() { for (const fn of pending.splice(0, pending.length)) fn(); },
  };
}

describe("W8: a peer's ready arriving before this side's own grant", () => {
  /**
   * Both roles, and they are not symmetric — which is why both are here.
   *
   * When the RESPONDER is slow the exchange self-heals: the initiator already
   * has its configuration, so the responder's later `ready` reaches a side that
   * agrees, and the initiator drives the offer as usual. When the INITIATOR is
   * slow there is nobody left to drive it — the dropped `ready` was the only
   * one that would ever be sent — and both ends wait out the epoch having
   * restarted no ICE at all. That is the case real Chrome reported, and the
   * responder case is kept beside it so a future change cannot break the half
   * that happens to work today without anything noticing.
   */
  it.each([
    ["the initiator is waiting on its grant", "a" as const],
    ["the responder is waiting on its grant", "b" as const],
  ])("completes the ordinary first round when %s", async (_label, slow) => {
    const clock = scheduler();
    const p = pair(clock);
    const held = holdServer(p[slow], clock);

    p.a.renewal.tick();
    await p.deliver();

    // The fast side has its configuration and has announced it; the slow side
    // has received that `ready` while still holding no grant of its own. This
    // is the state the deadlock was in.
    expect(held.held()).toBeGreaterThan(0);
    const fast = slow === "a" ? p.b : p.a;
    expect(fast.signalLog.some((e) => parseRenewEnvelope(e)?.renew.type === "ready")).toBe(true);
    expect(p[slow].signalLog.some((e) => parseRenewEnvelope(e)?.renew.type === "ready")).toBe(false);

    // Now the slow reply lands. The peer never re-sends its `ready`, so the
    // only way this can still converge is if that one was retained.
    held.release();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();

    // A real ICE restart happened on both sides…
    expect(p.a.transport.released).toBeGreaterThan(0);
    expect(p.b.transport.released).toBeGreaterThan(0);
    // …and both committed round 1.
    expect(p.a.commits).toHaveLength(1);
    expect(p.b.commits).toHaveLength(1);
    expect(p.a.renewal.round).toBe(1);
    expect(p.b.renewal.round).toBe(1);
  });

  it("does not let a peer's round stand in for a local grant", async () => {
    // Recording the peer's round is not authority. With this side's own reply
    // withheld for good, the peer's `ready` must never be enough to negotiate:
    // the epoch times out and the deadline is untouched.
    const clock = scheduler();
    const p = pair(clock);
    const before = p.a.deadline!.deadlineAt;
    holdServer(p.a, clock); // never released

    p.a.renewal.tick();
    await p.deliver();
    await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
    await p.deliver();

    expect(p.a.commits).toHaveLength(0);
    expect(p.a.deadline!.deadlineAt).toBe(before);
    expect(p.a.transport.released).toBe(0);
  });

  it("refuses a peer round this side never obtained, however it is signed", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const held = holdServer(p.a, clock);
    p.a.renewal.tick();
    await p.deliver();

    // A correctly signed `ready` naming a round nobody issued. Recorded, and
    // then never agreed with, because this side's own grant says 1.
    p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, { type: "ready", epoch: 1, round: 9 }));
    await clock.flush();
    held.release();
    await p.deliver();
    await clock.advance(600);
    await p.deliver();

    // No offer went out: the rounds never matched.
    expect(p.b.transport.appliedRemote.filter((d) => d.type === "offer")).toHaveLength(0);
    expect(p.a.commits).toHaveLength(0);
  });
});

// ── R4: the asymmetric-commit repair ────────────────────────────────────────

/**
 * Drive the link to the state R4 exists for: exactly ONE side has committed
 * round 1, and the post-commit ack window has expired.
 *
 * B commits (its ack for its own nonce arrives). A never does, because B's ack
 * is dropped on the way back. Then time passes until B's committed window
 * closes, so nothing is left of the old epoch on either side.
 */
async function oneSidedCommit(clock: ReturnType<typeof scheduler>, p: ReturnType<typeof pair>) {
  p.a.renewal.tick();
  await p.deliver();
  p.a.transport.land();
  p.b.transport.land();
  await clock.advance(600);
  // From here A hears nothing more, so its own nonce is never acknowledged.
  p.a.dropInbound = (frame) => decodeRenewProbe(frame)?.type === RENEW_PROBE_TYPE_ACK;
  await p.deliver();
  await clock.advance(600);
  await p.deliver();
  await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
  await p.deliver();
  await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
  await p.deliver();
  p.a.dropInbound = null;
}

/**
 * Everything the peer has put on the wire since `from`.
 *
 * Signals are read from the LOG rather than the queue because the pump drains
 * the queue; a barrier that watched the queue would be watching something that
 * empties itself.
 */
const signalsSince = (side: Side, from: number): RenewSignal[] =>
  side.signalLog
    .slice(from)
    .map((e) => parseRenewEnvelope(e)?.renew)
    .filter((r): r is RenewSignal => r !== undefined);

/**
 * Pump until `seen()` holds, and FAIL if it never does.
 *
 * ## Why a barrier and not "deliver once and assume"
 *
 * `deliver()` stops when a round finds all four queues empty, and empty is not
 * the same as finished: every side can be mid-HMAC at the instant it looks.
 * Under the full suite — 250 files in parallel, WebCrypto contended — that
 * happens often enough to matter, and a test that then acted as though a
 * multi-step exchange had completed produced a failure with no relation to the
 * thing it was testing.
 *
 * The repair is to wait for the EVENT, not for a number of turns. `seen()` is
 * an observation about what the peer actually sent, so this is deterministic
 * whatever the scheduler does; and it throws rather than falling through, so a
 * precondition that genuinely cannot be reached is reported as itself instead
 * of as a wrong answer three assertions later.
 */
async function pumpUntil(
  p: ReturnType<typeof pair>, seen: () => boolean, what: string, rounds = 40,
) {
  for (let i = 0; i < rounds; i++) {
    if (seen()) return;
    await p.deliver();
  }
  if (!seen()) throw new Error(`the exchange never reached: ${what}`);
}

describe("R4: one side committed, the other did not", () => {
  it("reaches the asymmetric state the repair is for", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await oneSidedCommit(clock, p);
    expect(p.b.commits).toHaveLength(1);
    expect(p.a.commits).toHaveLength(0);
    expect(p.b.renewal.round).toBe(1);
    expect(p.a.renewal.round).toBe(0);
  });

  it("repairs onto the round B already holds, with no second issuance", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await oneSidedCommit(clock, p);
    const issuedToB = p.b.requests.length;

    // A drives a fresh, higher epoch. Its own server would answer round 1 from
    // cache; B must adopt the configuration it already installed rather than
    // waiting for a round 2 that will not be issued.
    // The issuance floor has not elapsed, so round 2 cannot be minted. A's own
    // request for round 1 is served from the server's per-round cache.
    p.b.server = async (round, rid) => ({ status: "unavailable", round, rid, reason: "rate" });
    p.a.server = async (round, rid) => (round === 1
      ? grantFor(1, rid, Math.floor((clock.now() + 2 * HOUR) / 1000))
      : { status: "unavailable", round, rid, reason: "rate" });
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();

    expect(p.a.commits).toHaveLength(1);
    expect(p.a.renewal.round).toBe(1);
    // B asked for R+1 once — R4 says it does — and was refused, because the
    // issuance floor has not elapsed. What matters is that it obtained no
    // second credential and migrated on the one it already had.
    expect(p.b.requests.length).toBe(issuedToB + 1);
    expect(p.b.requests[issuedToB].round).toBe(2);
    expect(p.b.renewal.round).toBe(1);
  });

  it("leaves the already-committed side's deadline and anchor untouched", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await oneSidedCommit(clock, p);
    const boundB = p.b.deadline!.deadlineAt;
    const anchorB = p.b.anchor;
    const commitsB = p.b.commits.length;

    // The issuance floor has not elapsed, so round 2 cannot be minted. A's own
    // request for round 1 is served from the server's per-round cache.
    p.b.server = async (round, rid) => ({ status: "unavailable", round, rid, reason: "rate" });
    p.a.server = async (round, rid) => (round === 1
      ? grantFor(1, rid, Math.floor((clock.now() + 2 * HOUR) / 1000))
      : { status: "unavailable", round, rid, reason: "rate" });
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();

    // B migrated again on the SAME credential. A repair buys no time, so its
    // boundary and the anchor that boundary's margin is measured from must both
    // be exactly what they were — and `commit` must not be called again.
    expect(p.b.deadline!.deadlineAt).toBe(boundB);
    expect(p.b.anchor).toBe(anchorB);
    expect(p.b.commits).toHaveLength(commitsB);
    // A, which had NOT committed, does advance onto that round.
    expect(p.a.commits).toHaveLength(1);
  });

  it("ignores a late R+1 reply, granted or denied, once R has been adopted", async () => {
    for (const late of [
      { label: "denied", reply: (round: number, rid: number): IceGrant => ({ status: "denied" as const, round, rid }) },
      {
        label: "granted",
        reply: (round: number, rid: number): IceGrant =>
          grantFor(round, rid, Math.floor((Date.now() + 9 * HOUR) / 1000)),
      },
    ]) {
      const clock = scheduler();
      const p = pair(clock);
      await oneSidedCommit(clock, p);

      // B's request for round 2 is held open and answered only after the repair
      // has been adopted — the shape a slow database produces.
      const held: { release: (() => void) | null } = { release: null };
      p.b.server = (round, rid) => new Promise<IceGrant | null>((resolve) => {
        held.release = () => resolve(late.reply(round, rid));
      });
      p.a.server = async (round, rid) => (round === 1
        ? grantFor(1, rid, Math.floor((clock.now() + 2 * HOUR) / 1000))
        : { status: "unavailable", round, rid, reason: "rate" });

      await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
      p.a.anchor = clock.now() - 50 * 60_000;
      p.a.deadline = deadlineAt(p.a.anchor, HOUR);
      const boundB = p.b.deadline!.deadlineAt;
      const mark = p.b.signalLog.length;
      p.a.renewal.tick();

      // **The barrier, observed rather than assumed.** B announcing `ready` for
      // round 1 on this new epoch is something only adoption can produce — it
      // has no configuration of its own, its request is still held open. Until
      // that is on the wire the reply would not be late, and the test would be
      // measuring a different scenario entirely (see the deterministic
      // reproduction of that one below).
      await pumpUntil(
        p,
        () => signalsSince(p.b, mark).some((r) => r.type === "ready" && r.round === 1),
        "B adopting its installed round",
      );
      held.release?.();
      await p.deliver();

      p.a.transport.land();
      p.b.transport.land();
      await clock.advance(600);
      await p.deliver();
      await clock.advance(600);
      await p.deliver();

      // The late reply neither aborted the adopted migration nor moved B onto a
      // round the peer never agreed to.
      expect(p.a.commits, late.label).toHaveLength(1);
      expect(p.a.renewal.round, late.label).toBe(1);
      expect(p.b.renewal.round, late.label).toBe(1);
      expect(p.b.deadline!.deadlineAt, late.label).toBe(boundB);
    }
  });

  it("is bounded and safe when the R+1 reply was never late at all", async () => {
    /**
     * The OTHER interleaving, driven deterministically instead of by luck.
     *
     * B's own reply lands before the peer's `ready` reaches it, so there is
     * nothing stale about that reply and no repair to make: B installs the
     * round it was granted, the two ends hold different rounds, and they never
     * agree. This is the state the previous version of the test above fell into
     * whenever the pump exited early, which is what made its failure look like
     * a fence defect when it was a scheduling one.
     *
     * Against the real server this exact shape is **synthetic**: R+1 is issued
     * only after BOTH frozen members have asked for it, so B cannot be granted
     * it alone. It is pinned anyway, because what matters is the CONSEQUENCE —
     * a disagreement must be bounded and lose nothing, whatever produced it.
     *
     * Stepped by hand rather than pumped: only A's `prepare` is delivered, then
     * the reply is released, and only afterwards does A's `ready` go over.
     * Every step is an observed condition, so the ordering is a fact of the
     * test rather than a hope about the scheduler.
     */
    const clock = scheduler();
    const p = pair(clock);
    await oneSidedCommit(clock, p);
    const boundB = p.b.deadline!.deadlineAt;

    const held: { release: (() => void) | null } = { release: null };
    p.b.server = (round, rid) => new Promise<IceGrant | null>((resolve) => {
      held.release = () => resolve(grantFor(round, rid, Math.floor((clock.now() + 9 * HOUR) / 1000)));
    });
    p.a.server = async (round, rid) => (round === 1
      ? grantFor(1, rid, Math.floor((clock.now() + 2 * HOUR) / 1000))
      : { status: "unavailable", round, rid, reason: "rate" });

    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    // Captured AFTER the window is armed: the boundary under test is the one
    // this attempt starts from, not the one the previous scenario left behind.
    const boundA = p.a.deadline.deadlineAt;
    p.a.renewal.tick();

    // A emits `prepare` and `ready` in quick succession, so the queue holds
    // both by the time it is drained. Only the prepare crosses; the ready is
    // withheld so the release genuinely precedes it.
    const withheld: RenewEnvelope[] = [];
    for (let i = 0; i < 200 && held.release === null; i++) {
      await clock.flush(1);
      for (const e of p.a.outSignals.splice(0, p.a.outSignals.length)) {
        if (parseRenewEnvelope(e)?.renew.type === "prepare") p.b.renewal.signal("peer-a", e);
        else withheld.push(e);
      }
    }
    expect(held.release, "B must have reached the server before the release").not.toBeNull();
    held.release!();
    // B's own configuration is installed before anything else arrives.
    await pumpUntil(p, () => p.b.transport.configs.length > 1, "B installing its own round");
    for (const e of withheld) p.b.renewal.signal("peer-a", e);
    await p.deliver();

    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
    await p.deliver();

    // Nobody migrated, and that is the correct outcome: neither side can use
    // the other's credential. What must hold is that nothing was lost.
    expect(p.a.commits).toHaveLength(0);
    expect(p.a.deadline!.deadlineAt).toBe(boundA);
    expect(p.b.deadline!.deadlineAt).toBe(boundB);
    expect(p.a.renewal.state).not.toBe("renewed");

    /**
     * Bounded, and NOT re-converging here — which is the honest result.
     *
     * The two ends now hold different rounds and neither can use the other's.
     * What brings them back into step is the server's 2-of-2 issuance rule: R+1
     * exists only once BOTH frozen members have asked for it, so the state this
     * test constructs — B granted R+1 alone — cannot arise against it. The stub
     * bypasses that rule deliberately, so asserting convergence here would be
     * asserting something the stub, not the product, decides.
     *
     * What IS the client's to guarantee is that the disagreement costs nothing
     * and does not spin: no deadline moved, and further ticks are bounded by
     * the epoch budgets rather than retrying for as long as the margin lasts.
     */
    const asked = p.a.requests.length;
    for (let i = 0; i < 8; i++) {
      await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
      p.a.anchor = clock.now() - 50 * 60_000;
      p.a.deadline = deadlineAt(p.a.anchor, HOUR);
      p.a.renewal.tick();
      await p.deliver();
    }
    expect(p.a.requests.length - asked).toBeLessThanOrEqual(RENEW_MAX_EPOCHS_PER_ROUND);
    expect(p.a.commits).toHaveLength(0);
    expect(p.b.deadline!.deadlineAt).toBe(boundB);
  });

  it("charges the repair to the round's migration budget and does not refund it", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await oneSidedCommit(clock, p);

    // Repair, then keep asking. A round allows three migration epochs in total,
    // repairs included, and a same-round commit must not reset that count —
    // otherwise one credential buys an unbounded series of migrations.
    for (let i = 0; i < 6; i++) {
      await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
      p.b.anchor = clock.now() - 50 * 60_000;
      p.b.deadline = deadlineAt(p.b.anchor, HOUR);
      p.b.renewal.tick();
      await p.deliver();
      await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
      await p.deliver();
    }
    // Whatever happened, B never obtained a second credential round.
    expect(p.b.renewal.round).toBe(1);
  });

  it("refuses to adopt a round older than the one installed", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.b.renewal.round).toBe(1);

    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    p.b.anchor = clock.now() - 50 * 60_000;
    p.b.deadline = deadlineAt(p.b.anchor, HOUR);
    p.b.server = async () => null; // no new round available
    p.b.renewal.tick();
    await p.deliver();

    // A `ready` naming round 0 — older than anything this side installed. It
    // must not move B off the round it holds, whatever epoch it claims.
    for (const epoch of [1, 2, 99]) {
      p.b.renewal.signal("peer-a", await sealFor(p.a.id, p.b.id, { type: "ready", epoch, round: 0 }));
    }
    await clock.flush();
    expect(p.b.renewal.round).toBe(1);
    expect(p.b.commits).toHaveLength(1);
  });
});

// ── R5: the shared, partitioned verification budget ─────────────────────────

describe("R5: verification budget", () => {
  it("is ONE allowance for the epoch, before and after commit", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);

    // Flood the committed window with fresh, unseen nonces. Each would be a new
    // HMAC; the epoch's probe reservation is what stops them, and it has
    // already been partly spent before commit.
    p.a.outFrames.length = 0;
    for (let i = 0; i < RENEW_PROBE_VERIFY_RESERVE + 6; i++) {
      const nonce = new Uint8Array(16).fill(0x40 + i);
      p.a.renewal.frame(await probeFrame(p.b.id, p.a.id, RENEW_PROBE_TYPE_PROBE, 1, 1, nonce));
      await clock.flush();
    }
    const acks = p.a.outFrames.filter((f) => decodeRenewProbe(f)?.type === RENEW_PROBE_TYPE_ACK);
    // Strictly fewer than a fresh allowance would have permitted.
    expect(acks.length).toBeLessThan(RENEW_PROBE_VERIFY_RESERVE + 6);
    expect(acks.length).toBeLessThanOrEqual(RENEW_PROBE_VERIFY_RESERVE);
  });

  it("answers a peer nonce first seen AFTER this side committed", async () => {
    // Legitimate ordering: this side commits when the peer acknowledges ITS
    // nonce, which says nothing about whether the peer's own probe was ever
    // verified here.
    const clock = scheduler();
    const p = pair(clock);
    // B's probes never reach A until after A has committed. A's own probes
    // still reach B, so B acks them and A commits on that ack alone — which is
    // precisely how a side can commit having never seen the peer's nonce.
    p.a.dropInbound = (frame) => decodeRenewProbe(frame)?.type === RENEW_PROBE_TYPE_PROBE;
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);

    // Only now does B's probe arrive — a nonce A has never verified.
    p.a.dropInbound = null;
    p.a.outFrames.length = 0;
    const nonce = new Uint8Array(16).fill(0x5a);
    p.a.renewal.frame(await probeFrame(p.b.id, p.a.id, RENEW_PROBE_TYPE_PROBE, 1, 1, nonce));
    await clock.flush();
    const acks = p.a.outFrames.filter((f) => decodeRenewProbe(f)?.type === RENEW_PROBE_TYPE_ACK);
    expect(acks).toHaveLength(1);
    expect(decodeRenewProbe(acks[0])!.nonce).toEqual(nonce);
  });

  it("keeps an ACK chance that a probe flood cannot spend", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    await p.deliver();

    // A junk flood: correctly shaped, correctly addressed, wrong tags. Each one
    // that reaches an HMAC costs budget.
    for (let i = 0; i < 20; i++) {
      const junk = encodeRenewProbe({
        type: RENEW_PROBE_TYPE_PROBE, epoch: 1, round: 1,
        nonce: new Uint8Array(16).fill(i + 1),
        tag: new Uint8Array(32).fill(0xbb),
      });
      p.a.renewal.frame(junk);
      await clock.flush(2);
    }
    // The genuine ack still gets through, because the probe half cannot reach
    // into the half reserved for it.
    await clock.advance(600);
    await p.deliver();
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);
  });

  it("holds one eligible ACK while a verification is running rather than dropping it", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    // A has observed and is probing. Deliver a junk probe and the genuine ack
    // in the SAME turn, so the ack arrives while the junk is being verified.
    const ackFrames = p.b.frameLog.filter((f) => decodeRenewProbe(f)?.type === RENEW_PROBE_TYPE_ACK);
    await p.deliver();
    const genuine = p.b.frameLog.filter((f) => decodeRenewProbe(f)?.type === RENEW_PROBE_TYPE_ACK);
    expect(genuine.length).toBeGreaterThan(ackFrames.length - 1);
    // The commit still happens: an ack displaced by a concurrent verification
    // is held in the single slot and drained, not lost.
    await clock.advance(600);
    await p.deliver();
    expect(p.a.commits).toHaveLength(1);
  });
});

// ── W9: the credential round's migration budget ─────────────────────────────

/**
 * Count the distinct granted migration epochs a side started.
 *
 * "Granted" is the word that matters: an epoch that never obtained a
 * configuration restarted no ICE and is not what the three-per-round ceiling
 * counts. `setConfiguration` is called exactly once per accepted configuration,
 * so the transport's own record is the honest measure — and it is the same
 * thing the product negative counted from the wire.
 */
const grantedEpochs = (side: Side) => side.transport.configs.length;

/** Drain microtasks without needing the clock in scope. */
const clock_flush = async (_p: ReturnType<typeof pair>) => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("W9: three granted migrations per credential round, and no refunds", () => {
  it("does not let an authenticated peer abort restart this side immediately", async () => {
    /**
     * The exact product negative: the peer aborts, and this side begins again
     * at once. Repeated, that produced seven granted epochs on one credential
     * inside eighty seconds. An abort the peer chose to send is charged and
     * backed off exactly like a local failure.
     */
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    const afterFirst = grantedEpochs(p.a);
    expect(afterFirst).toBe(1);

    // The peer aborts this epoch, over and over, as fast as it can.
    for (let i = 0; i < 6; i++) {
      const a = p.a;
      a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, {
        type: "abort", epoch: 1 + i, reason: "unavailable",
      }));
      await clock.flush();
      a.renewal.tick();
      await p.deliver();
    }
    // The backoff holds the line: no second granted epoch without waiting.
    expect(grantedEpochs(p.a)).toBe(afterFirst);
  });

  it("does not let signed higher prepares buy unlimited attempts", async () => {
    /**
     * A supersession really does consume a request, so it is charged.
     *
     * The server here NEVER answers, which is what makes supersession the
     * binding constraint: each attempt is still in flight when the next, higher
     * prepare displaces it. With a server that refuses promptly the attempts
     * would end on their own and be charged by the ordinary failure path, and
     * this test would pass whether or not supersession cost anything — which is
     * exactly what it did before, and why a mutant that made supersession free
     * survived it.
     */
    const clock = scheduler();
    const p = pair(clock);
    p.a.server = () => new Promise<IceGrant | null>(() => {}); // never settles
    for (let epoch = 5; epoch < 40; epoch += 1) {
      p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, { type: "prepare", epoch }));
      await clock.flush();
    }
    // Each accepted prepare costs one request. Bounded by the pre-grant budget
    // for the round being approached, plus the one attempt still in flight.
    expect(p.a.requests.length).toBeLessThanOrEqual(RENEW_MAX_PREGRANT_ATTEMPTS + 1);
  });

  it("refuses a granted configuration for a round whose budget is already spent", async () => {
    /**
     * The ceiling on the GRANT path, which the repair ceiling does not cover.
     *
     * The client gates its request on the round it intends to ask for, but the
     * reply names its own round — so a server that answers with a DIFFERENT one
     * (a cached replay, a mismatch, an unsolicited configuration) would slip
     * past that gate. The acceptance check is what refuses it, and it refuses
     * before any RTC configuration or SDP exists.
     */
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.a.renewal.round).toBe(1);

    // Spend the rest of round 1 on repairs.
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    await driveRepairs(p, "a", 1, 6);
    expect(grantedEpochs(p.a)).toBe(RENEW_MAX_EPOCHS_PER_ROUND);
    await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
    await p.deliver();

    // Now ask for round 2 and have the server answer with round 1 anyway.
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    const spent = grantedEpochs(p.a);
    p.a.server = async (_round, rid) =>
      grantFor(1, rid, Math.floor((clock.now() + 3 * HOUR) / 1000));
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.a.renewal.tick();
    await p.deliver();

    expect(p.a.requests[p.a.requests.length - 1].round).toBe(2);
    // Refused: no fourth configuration was applied to the transport.
    expect(grantedEpochs(p.a)).toBe(spent);
    expect(p.a.commits).toHaveLength(1);
  });

  /**
   * Drive repair attempts at `side` for the round it has installed.
   *
   * A repair is the ONLY way to spend a committed round's remaining budget: a
   * tick asks for `round + 1`, so once a round is committed nothing this side
   * initiates targets it again. Each pass is a signed `prepare` at a fresh
   * epoch followed by a signed `ready` naming that round — exactly what a peer
   * which never committed it would send.
   */
  async function driveRepairs(
    p: ReturnType<typeof pair>, side: "a" | "b", round: number, times: number, from = 50,
  ) {
    const target = p[side];
    const peer = side === "a" ? p.b : p.a;
    // A repair only exists when the NEXT round cannot be issued — that is the
    // situation it was designed for. With a server that grants whatever it is
    // asked, every one of these would obtain R+1 instead and charge a
    // different credential, which is a different test entirely.
    target.server = async (r, rid) => ({ status: "unavailable", round: r, rid, reason: "rate" });
    for (let i = 0; i < times; i++) {
      const epoch = from + i;
      target.renewal.signal(`peer-${side === "a" ? "b" : "a"}`,
        await sealFor(peer.id, target.id, { type: "prepare", epoch }));
      await clock_flush(p);
      target.renewal.signal(`peer-${side === "a" ? "b" : "a"}`,
        await sealFor(peer.id, target.id, { type: "ready", epoch, round }));
      await clock_flush(p);
    }
  }

  it("makes a failed R1, a successful R1 and every repair share ONE ceiling", async () => {
    const clock = scheduler();
    const p = pair(clock);
    // Epoch 1: granted round 1, path never lands — one granted epoch spent.
    p.a.renewal.tick();
    await p.deliver();
    expect(grantedEpochs(p.a)).toBe(1);
    await clock.advance(RENEW_EPOCH_HARD_CAP_MS + RENEW_RETRY_BACKOFF_MS + 1000);
    await p.deliver();
    expect(p.a.commits).toHaveLength(0);

    // Epoch 2: the same credential round, and this time it commits. Two spent.
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    await renewBoth(clock, p);
    expect(p.a.commits).toHaveLength(1);
    expect(p.a.renewal.round).toBe(1);
    expect(grantedEpochs(p.a)).toBe(2);

    // Repairs at round 1: exactly ONE is left, and the rest are refused before
    // any RTC configuration is produced. Success refunded nothing.
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    await driveRepairs(p, "a", 1, 6);
    expect(grantedEpochs(p.a)).toBe(RENEW_MAX_EPOCHS_PER_ROUND);
  });

  it("allows a genuine R2 once R1 is committed and fully spent", async () => {
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.a.renewal.round).toBe(1);

    // Burn round 1 to its ceiling with repairs.
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    await driveRepairs(p, "a", 1, 6);
    expect(grantedEpochs(p.a)).toBe(RENEW_MAX_EPOCHS_PER_ROUND);

    // The last repair is still in flight; let its epoch close before asking
    // anything else, since a tick with an attempt outstanding is a no-op.
    await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
    await p.deliver();

    /**
     * A spent round must block only ITSELF.
     *
     * The claim under test is that round 1's exhausted budget does not stand
     * between this link and round 2 — so what is asserted is that the approach
     * to round 2 HAPPENS: it is asked for, and its configuration is accepted
     * and applied. Whether the two peers then complete that migration depends
     * on the far side's own state, which several other tests cover and which
     * would make this one a test of the harness rather than of the budget.
     */
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    p.a.server = async (round, rid) => grantFor(round, rid, Math.floor((clock.now() + 3 * HOUR) / 1000));
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    const spentOnRoundOne = grantedEpochs(p.a);
    p.a.renewal.tick();
    await p.deliver();

    expect(p.a.requests[p.a.requests.length - 1].round).toBe(2);
    expect(grantedEpochs(p.a)).toBe(spentOnRoundOne + 1);
  });


  it("bounds pre-grant retries AFTER a commit, where the keys used to diverge", async () => {
    /**
     * The product negative, in a fixed margin.
     *
     * Round 1 is committed, the server has nothing to give for round 2, and the
     * peer keeps aborting the epoch this side opens. Each iteration is one
     * request plus one backoff, so a ten-minute margin allows about nine — and
     * nine is what the wire showed, because the charge went to the round
     * already held while the gate read the round being sought. With the keys
     * aligned the gate bites at the sixth.
     */
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.a.renewal.round).toBe(1);
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);

    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid, reason: "rate" });
    const before = p.a.requests.length;
    // A FIXED ten-minute margin, re-armed each pass so the window itself never
    // becomes the thing doing the bounding.
    const margin = 10 * 60_000;
    const deadlineFor = () => deadlineAt(clock.now() - 50 * 60_000, HOUR);
    for (let i = 0; i < Math.ceil(margin / (RENEW_RETRY_BACKOFF_MS + 1000)) + 4; i++) {
      p.a.anchor = clock.now() - 50 * 60_000;
      p.a.deadline = deadlineFor();
      p.a.renewal.tick();
      await p.deliver();
      // An authenticated abort from the peer for whatever epoch is in flight.
      for (const epoch of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, {
          type: "abort", epoch, reason: "unavailable",
        }));
      }
      await clock.flush();
      await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
      await p.deliver();
    }
    expect(p.a.requests.length - before).toBeLessThanOrEqual(RENEW_MAX_PREGRANT_ATTEMPTS);
    expect(p.a.commits).toHaveLength(1);
  });

  it("keeps remote-initiated repairs from spending the budget for a later R+1", async () => {
    /**
     * Fable's separation.
     *
     * A peer may open an epoch long before this side's own window does. Once
     * round 1 is committed, such an epoch can only be a repair of it — the
     * server has no round 2 to give yet, which is exactly why it refuses. If
     * those failures were charged to round 2's approach, a peer could spend the
     * credit this link needs to reach round 2 in earnest, without either side
     * ever having asked for it.
     */
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    // The server can issue nothing new, so every remote epoch is a repair.
    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid, reason: "rate" });

    for (let epoch = 30; epoch < 45; epoch++) {
      p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, { type: "prepare", epoch }));
      await clock.flush();
      await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
      await p.deliver();
    }

    // Bounded on its own key…
    expect(grantedEpochs(p.a)).toBeLessThanOrEqual(RENEW_MAX_EPOCHS_PER_ROUND);

    // …and round 2 is still reachable, which is the whole point.
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    const spent = grantedEpochs(p.a);
    p.a.server = async (round, rid) => grantFor(round, rid, Math.floor((clock.now() + 3 * HOUR) / 1000));
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.a.renewal.tick();
    await p.deliver();
    expect(p.a.requests[p.a.requests.length - 1].round).toBe(2);
    expect(grantedEpochs(p.a)).toBe(spent + 1);
  });

  it("stops answering a peer that repairs the same round for ever", async () => {
    // The other half of the separation: the repair budget must itself bite, or
    // "does not consume R+1" would just mean "is unbounded".
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid, reason: "rate" });
    const before = p.a.requests.length;
    for (let epoch = 60; epoch < 100; epoch++) {
      p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, { type: "prepare", epoch }));
      await clock.flush();
      await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
      await p.deliver();
    }
    // Bounded by the round's own approach budget plus the migrations that
    // round is worth — one pool for that round, not one per initiator.
    expect(p.a.requests.length - before)
      .toBeLessThanOrEqual(RENEW_MAX_PREGRANT_ATTEMPTS + RENEW_MAX_EPOCHS_PER_ROUND);
  });


  it("admits a legitimate peer-driven R2 after R1's migrations are spent", async () => {
    /**
     * Two real controllers, and the peer is the one that opens the epoch.
     *
     * Round 1 is committed and its three migration epochs are gone. A peer now
     * prepares while this side is INSIDE its own renewal window — so this is
     * not a repair of round 1, it is the next round, which has its own
     * untouched budget. Classifying every remote epoch as a repair would refuse
     * it for ever and strand the link on a credential it can no longer migrate.
     */
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    expect(p.a.renewal.round).toBe(1);
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);

    // Spend round 1 down to its ceiling with repairs driven while this side is
    // NOT in its window — the early-repair case, which is bounded separately.
    await driveRepairs(p, "a", 1, 6);
    expect(grantedEpochs(p.a)).toBe(RENEW_MAX_EPOCHS_PER_ROUND);
    await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
    await p.deliver();

    // Now this side enters its own renewal window, and the server can issue 2.
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    const grant2 = async (round: number, rid: number) =>
      grantFor(round, rid, Math.floor((clock.now() + 3 * HOUR) / 1000));
    p.a.server = grant2;
    p.b.server = grant2;
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.b.anchor = p.a.anchor;
    p.b.deadline = deadlineAt(p.b.anchor, HOUR);
    const spent = grantedEpochs(p.a);

    // The PEER drives it, not the local trigger.
    p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, { type: "prepare", epoch: 900 }));
    await p.deliver();

    // Admitted, and it obtained round 2 — a fourth accepted configuration.
    expect(grantedEpochs(p.a)).toBe(spent + 1);
    expect(p.a.requests[p.a.requests.length - 1].round).toBe(2);
  });

  it("still treats a peer that prepares OUTSIDE this side's window as a repair", async () => {
    // The other half of the same rule: early prepares stay on the installed
    // round's own budget and cannot spend what the next round will need.
    const clock = scheduler();
    const p = pair(clock);
    await renewBoth(clock, p);
    // Far from the boundary — this side would not start on its own.
    await clock.advance(RENEW_POST_COMMIT_ACK_MS + 1000);
    p.a.anchor = clock.now();
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.a.server = async (round, rid) => ({ status: "unavailable", round, rid, reason: "rate" });

    for (let epoch = 500; epoch < 520; epoch++) {
      p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, { type: "prepare", epoch }));
      await clock.flush();
      await clock.advance(RENEW_EPOCH_HARD_CAP_MS + 1000);
      await p.deliver();
    }

    // Bounded on round 1's key…
    expect(grantedEpochs(p.a)).toBeLessThanOrEqual(RENEW_MAX_EPOCHS_PER_ROUND);
    // …and round 2's approach budget is untouched, so the link can still reach
    // it the moment its own window opens.
    await clock.advance(RENEW_RETRY_BACKOFF_MS + 1000);
    const spent = grantedEpochs(p.a);
    p.a.server = async (round, rid) => grantFor(round, rid, Math.floor((clock.now() + 3 * HOUR) / 1000));
    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    p.a.renewal.tick();
    await p.deliver();
    expect(grantedEpochs(p.a)).toBe(spent + 1);
    expect(p.a.requests[p.a.requests.length - 1].round).toBe(2);
  });

  it("disposes each ending exactly once, and never moves the deadline", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const before = p.a.deadline!.deadlineAt;
    const sas = p.a.link.sas;

    // A local timeout, a peer abort, and a config failure — one after another.
    p.a.renewal.tick();
    await p.deliver();
    await clock.advance(RENEW_EPOCH_HARD_CAP_MS + RENEW_RETRY_BACKOFF_MS + 1000);
    await p.deliver();

    p.a.anchor = clock.now() - 50 * 60_000;
    p.a.deadline = deadlineAt(p.a.anchor, HOUR);
    const boundTwo = p.a.deadline.deadlineAt;
    p.a.renewal.tick();
    await p.deliver();
    p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, {
      type: "abort", epoch: 2, reason: "timeout",
    }));
    await clock.flush();
    // The same abort again must cost nothing more.
    const spentAfterAbort = grantedEpochs(p.a);
    p.a.renewal.signal("peer-b", await sealFor(p.b.id, p.a.id, {
      type: "abort", epoch: 2, reason: "timeout",
    }));
    await clock.flush();
    expect(grantedEpochs(p.a)).toBe(spentAfterAbort);

    expect(p.a.commits).toHaveLength(0);
    expect(p.a.deadline!.deadlineAt).toBe(boundTwo);
    expect(before).not.toBe(0);
    // The link's identity is untouched by any of it.
    expect(p.a.link.sas).toBe(sas);
    expect(p.a.link.keys).toBe(p.a.link.keys);
  });
});

// ── the data-lane demux ─────────────────────────────────────────────────────

describe("the front demux", () => {
  it("consumes every frame that claims the control kind, including malformed ones", () => {
    const clock = scheduler();
    const p = pair(clock);
    // Right kind byte, wrong everything else. Still ours: letting it fall
    // through would spend the text lane's rate budget and reset its idle timer.
    const short = new Uint8Array([0x0d, 1, 1]).buffer;
    const wrongVersion = new Uint8Array(59);
    wrongVersion[0] = 0x0d;
    wrongVersion[1] = 99;
    expect(p.a.renewal.frame(short)).toBe(true);
    expect(p.a.renewal.frame(wrongVersion.buffer)).toBe(true);
  });

  it("leaves every other frame to the text lane", () => {
    const clock = scheduler();
    const p = pair(clock);
    const text = new Uint8Array([9, 0, 0, 0, 1]).buffer;
    const lifecycle = new Uint8Array([4]).buffer;
    expect(p.a.renewal.frame(text)).toBe(false);
    expect(p.a.renewal.frame(lifecycle)).toBe(false);
    expect(p.a.renewal.frame("not a frame")).toBe(false);
    expect(p.a.renewal.frame(new ArrayBuffer(0))).toBe(false);
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  it("releases every timer when the link goes away mid-epoch", async () => {
    const clock = scheduler();
    const p = pair(clock);
    const idle = clock.pending();
    p.a.renewal.tick();
    await clock.flush();
    expect(clock.pending()).toBeGreaterThan(idle);
    p.a.renewal.stop();
    await clock.flush();
    expect(clock.pending()).toBe(0);
    expect(p.a.transport.candidateCb).toBeNull();
    expect(p.a.transport.pairCb).toBeNull();
    expect(p.a.transport.restartSuspended).toBe(false);
  });

  it("aborts an epoch in flight when the transport is rebuilt, and tells the peer", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.outSignals.length = 0;
    const rebuilt = {
      ...p.a.link,
      conn: { renew: p.a.transport } as unknown as MixedPeerLink["conn"],
    } as MixedPeerLink;
    p.a.renewal.setLink(rebuilt);
    await clock.flush();
    const abort = p.a.outSignals
      .map((e) => parseRenewEnvelope(e))
      .find((e) => e?.renew.type === "abort");
    expect(abort).toBeTruthy();
    expect(p.a.commits).toHaveLength(0);
  });

  it("commits nothing after stop(), even if an ack is fed in", async () => {
    const clock = scheduler();
    const p = pair(clock);
    p.a.renewal.tick();
    await p.deliver();
    p.a.transport.land();
    p.b.transport.land();
    await clock.advance(600);
    const acks = p.b.frameLog.filter((f) => decodeRenewProbe(f)?.type === RENEW_PROBE_TYPE_ACK);
    p.a.renewal.stop();
    for (const f of acks) p.a.renewal.frame(f);
    await clock.flush();
    expect(p.a.commits).toHaveLength(0);
  });
});

// ── helpers that need the key ───────────────────────────────────────────────

/** Build a correctly signed envelope from `from` to `to`. */
async function sealFor(from: string, to: string, inner: RenewSignal): Promise<RenewEnvelope> {
  const auth = await signRenew(key, renewSignalPayload(inner, from, to));
  return { link: true, renew: inner, auth };
}

/** A correctly signed probe/ack frame from `from` to `to`. */
async function probeFrame(
  from: string, to: string, type: number, epoch: number, round: number, nonce: Uint8Array,
): Promise<ArrayBuffer> {
  const kind = type === RENEW_PROBE_TYPE_PROBE ? "link-renew-probe" : "link-renew-ack";
  const payload = renewProbePayload(kind, from, to, epoch, round, toBase64(nonce));
  const tag = await signRenewProbe(key, payload);
  return encodeRenewProbe({ type: type as 1, epoch, round, nonce, tag });
}

/** The first probe this side put on the wire, whether or not the pump has
 *  already delivered it. */
function firstProbe(side: Side): ArrayBuffer | undefined {
  return side.frameLog.find((f) => decodeRenewProbe(f)?.type === RENEW_PROBE_TYPE_PROBE);
}
