import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
import { generateKeyPair, ready } from "./crypto";
import { createMixedSession, type MixedSession, type MixedSessionDeps } from "./mixed-session.svelte";
import { LINK_RECOVERY_WINDOW_MS } from "./peer-link.svelte";
import { relayDeadline } from "./relay-deadline";
import type { SignalingClient } from "./signaling";
import type { Conn, ConnectOpts, InboundSignal } from "./webrtc";

// The bounded lifetime of a RELAYED unified link, and the correlated-loss
// boundary between the signalling socket and a live DataChannel.
//
// Every case here is deterministic: fake timers, an injected clock, an injected
// deadline and a transport whose terminal callback is fired by hand. That is the
// point — the two failures this covers (a TURN credential lapsing with no
// transport event at all, and a socket drop that must NOT abort a transfer) are
// precisely the ones a real browser cannot be made to produce on demand.

beforeAll(async () => { await ready(); });
afterEach(() => { vi.useRealTimers(); });

function channel(label: string) {
  return {
    label, readyState: "open", binaryType: "blob", bufferedAmount: 0,
    onmessage: null, onclose: null, send: vi.fn(), close: vi.fn(),
  } as unknown as RTCDataChannel;
}

type Path = "lan" | "p2p" | "relay" | "unknown";

function harness(path: Path) {
  const listeners: ((from: string, data: unknown) => void)[] = [];
  const sent: { to: string; data: InboundSignal }[] = [];
  const signaling = {
    onSignal(cb: (from: string, data: unknown) => void) {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    sendSignal(to: string, data: unknown) { sent.push({ to, data: data as InboundSignal }); },
  } as unknown as SignalingClient;
  const conns: Conn[] = [];
  const connect = vi.fn(async (opts: ConnectOpts): Promise<Conn> => {
    const file = channel("relayium");
    const text = channel("relayium-text");
    const conn: Conn = {
      channel: file,
      getChannel: (l) => l === "relayium" ? file : l === "relayium-text" ? text : undefined,
      close: vi.fn(),
      maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES,
      path: async () => path,
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    conns.push(conn);
    opts.onPeerKey(generateKeyPair().publicKey);
    return conn;
  });
  return { signaling, sent, conns, connect };
}

/** A rebuild seam that never resolves, so a held link can be observed. Also the
 *  witness for "no stale-credential recovery": if it was ever called, one was
 *  attempted. */
const stalledResume = () => vi.fn((_opts: { signal?: AbortSignal }) => new Promise<Conn>(() => {}));

interface WorldOpts {
  path?: Path;
  deadline?: MixedSessionDeps["relayDeadline"];
  joined?: () => boolean;
  selfId?: () => string;
  rejoinRefused?: () => boolean;
  peerPresent?: (peerId: string) => boolean;
}

function world(opts: WorldOpts = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const h = harness(opts.path ?? "relay");
  const resume = stalledResume();
  const mixed = createMixedSession({
    selfId: opts.selfId ?? (() => "a"),
    joined: opts.joined ?? (() => true),
    rejoinRefused: opts.rejoinRefused,
    peerPresent: opts.peerPresent,
    relayDeadline: opts.deadline,
    signaling: () => h.signaling,
    rtcConfig: () => ({ iceServers: [] }),
    supportsLink: () => true,
    connect: h.connect,
    resume,
  });
  return {
    h, mixed, resume,
    drop: (state: "failed" | "closed" = "failed") =>
      h.connect.mock.calls[0][0].onStateChange?.(state),
  };
}

const picked = (name: string) => [{ file: new File(["payload"], name) }];

/**
 * A batch waiting for the peer's accept: real lane work, so the link is worth
 * recovering and `needsRecovery()` is true at the gap. It also holds the idle
 * lease open, which is what keeps these cases about the CREDENTIAL rather than
 * about the ten-minute inactive close.
 *
 * Deliberately not `vi.waitFor`: with fake timers installed that helper advances
 * them, which would run the very deadline the test is about before its first
 * assertion.
 */
async function inFlightBatch(mixed: MixedSession) {
  mixed.file.enqueue("b", picked("held.txt"));
  // Advancing by zero runs only what is already due, so the credential timers
  // this file is about stay exactly where they were armed.
  for (let i = 0; i < 64 && mixed.file.send?.status !== "waitingAccept"; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(mixed.file.send?.status).toBe("waitingAccept");
}

/** Eight minutes out, warning at three. Deliberately INSIDE the ten-minute idle
 *  close, so a case that lets the credential expire is not silently proving the
 *  idle timer instead; and comfortably longer than the 90-second recovery
 *  window, so a case that clips the window has to say so itself. */
const EIGHT_MIN = { expiresAt: 540_000, deadlineAt: 480_000, warnAt: 180_000 };

describe("relay credential deadline", () => {
  it("warns before the boundary and ends the link AT it with no transport event", async () => {
    const { h, mixed, resume } = world({ deadline: () => EIGHT_MIN });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    await vi.advanceTimersByTimeAsync(0);
    expect(mixed.path).toBe("relay");
    expect(mixed.relayExpiring).toBe(false);

    await vi.advanceTimersByTimeAsync(179_999);
    expect(mixed.relayExpiring).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Warned, and still fully live: a warning is not a teardown.
    expect(mixed.relayExpiring).toBe(true);
    expect(mixed.link).toBe(link);
    expect(mixed.status).toBe("open");
    expect(mixed.endReason).toBe("");

    await vi.advanceTimersByTimeAsync(299_999);
    expect(mixed.link).toBe(link);
    await vi.advanceTimersByTimeAsync(1);

    // Terminal, truthfully, with nothing having happened to the transport.
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("relayExpired");
    expect(h.conns[0].close).toHaveBeenCalled();
    // And no rebuild was even considered — the credential is the thing that died.
    expect(resume).not.toHaveBeenCalled();
    mixed.stop();
  });

  it("warns immediately when the link opens inside the warning window", async () => {
    const { mixed } = world({ deadline: () => ({ expiresAt: 120_000, deadlineAt: 60_000, warnAt: 0 }) });
    await mixed.ensure("b");
    expect(mixed.relayExpiring).toBe(true);
    expect(mixed.link).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mixed.endReason).toBe("relayExpired");
    mixed.stop();
  });

  it("ends a link opened with an already-expired credential rather than running it unbounded", async () => {
    // relayDeadline clamps a lapsed credential to `now`, so the boundary is
    // immediate. The link must not simply run on.
    const { mixed } = world({
      deadline: () => relayDeadline({ iceServers: [{ urls: "turn:r:3478", username: "1:o", credential: "c" }] }, 0),
    });
    await mixed.ensure("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("relayExpired");
    mixed.stop();
  });

  it.each([["lan"], ["p2p"]] as const)("never bounds a %s link, even with a TURN credential in the config", async (path) => {
    // A direct path holds no TURN allocation, so the credential's expiry says
    // nothing about it. Its only bound stays the ten-minute idle close.
    const { mixed } = world({ path, deadline: () => EIGHT_MIN });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed); // keeps the idle lease alive across the advance
    await vi.advanceTimersByTimeAsync(0);
    expect(mixed.path).toBe(path);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mixed.link).toBe(link);
    expect(mixed.relayExpiring).toBe(false);
    expect(mixed.endReason).toBe("");
    mixed.stop();
  });

  it("has no deadline at all when the room's ICE config carries no TURN username", async () => {
    // STUN-only: LAN, and a code room the deployment issued nothing usable for.
    const { mixed } = world({
      deadline: () => relayDeadline({ iceServers: [{ urls: "stun:stun.example:3478" }] }, 0),
    });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    // Well past where EIGHT_MIN would have ended it, and inside the idle lease
    // the in-flight batch keeps renewing.
    await vi.advanceTimersByTimeAsync(540_000);
    expect(mixed.link).toBe(link);
    expect(mixed.relayExpiring).toBe(false);
    expect(mixed.endReason).toBe("");
    mixed.stop();
  });

  it("bounds a relayed link even while its path is still unclassified", async () => {
    // Path classification is asynchronous and can stay "unknown" for seconds.
    // Waiting for it before arming would leave exactly that long unbounded.
    const { mixed } = world({ path: "unknown", deadline: () => EIGHT_MIN });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    await vi.advanceTimersByTimeAsync(480_000);
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("relayExpired");
    mixed.stop();
  });
});

describe("no stale-credential recovery", () => {
  it("fails terminally instead of holding a link whose credential has expired", async () => {
    // The deadline timer and the transport loss race at the same instant. Either
    // order has to reach the same truthful terminal state, and neither may put
    // an unusable credential behind a "Connecting…" that can only expire.
    const { mixed, resume, drop } = world({
      deadline: () => ({ expiresAt: 65_000, deadlineAt: 5_000, warnAt: 0 }),
    });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    vi.setSystemTime(6_000);

    drop("failed");
    expect(mixed.status).toBe("failed");
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("relayExpired");
    expect(resume).not.toHaveBeenCalled();
    mixed.stop();
  });

  it("clips the recovery window to the credential rather than the full 90 seconds", async () => {
    // 20 seconds of credential left: the driver must stop at 20s, not at 90s,
    // and the terminal state must name the credential rather than a generic
    // failure — "try again" and "re-pair" are different instructions.
    const { mixed, resume, drop } = world({
      deadline: () => ({ expiresAt: 80_000, deadlineAt: 20_000, warnAt: 0 }),
    });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    drop("failed");
    expect(mixed.status).toBe("interrupted");
    expect(resume).toHaveBeenCalled(); // inside the credential, a rebuild is real

    await vi.advanceTimersByTimeAsync(19_999);
    expect(mixed.status).toBe("interrupted");
    await vi.advanceTimersByTimeAsync(1);
    // Gone at the credential boundary, not at 90 seconds, and naming it — the
    // header reads `endReason` ahead of the raw status for exactly this reason.
    expect(mixed.status).not.toBe("interrupted");
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("relayExpired");
    expect(20_000).toBeLessThan(LINK_RECOVERY_WINDOW_MS);
    mixed.stop();
  });

  it("attempts nothing at all once the deadline has already passed", async () => {
    const { mixed, resume, drop } = world({
      deadline: () => ({ expiresAt: 60_500, deadlineAt: 500, warnAt: 0 }),
    });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    // Move the clock past the boundary WITHOUT running the deadline timer: the
    // credential is dead whether or not our own timer noticed first, and a
    // suspended tab is exactly how that happens in the field.
    vi.setSystemTime(1_000);

    drop("failed");
    expect(mixed.status).toBe("failed");
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("relayExpired");
    expect(resume).not.toHaveBeenCalled();
    mixed.stop();
  });
});

describe("correlated signalling / transport loss", () => {
  it("keeps a healthy link and an in-flight batch when signalling alone drops", async () => {
    let joined = true;
    let selfId = "a";
    const { mixed, resume } = world({ joined: () => joined, selfId: () => selfId });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    expect(mixed.recoveryAvailable).toBe(true);

    // The socket drops. App clears its roster and identity; nothing touches the
    // DataChannel, which is a separate transport and still carrying the batch.
    joined = false;
    selfId = "";

    expect(mixed.link).toBe(link);
    expect(mixed.status).toBe("open");
    expect(mixed.file.send?.status).toBe("waitingAccept");
    expect(link.fileChannel.close).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    // …but the link is now unrecoverable, and says so BEFORE anything goes wrong.
    expect(mixed.recoveryAvailable).toBe(false);
    expect(mixed.endReason).toBe("");
    mixed.stop();
  });

  it("recovers normally when the socket comes back with the SAME identity", async () => {
    let joined = true;
    const { mixed, resume, drop } = world({ joined: () => joined });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    joined = false;
    expect(mixed.recoveryAvailable).toBe(false);
    joined = true;
    expect(mixed.recoveryAvailable).toBe(true);

    drop("failed");
    expect(mixed.status).toBe("interrupted");
    expect(resume).toHaveBeenCalled();
    expect(mixed.endReason).toBe("");
    mixed.stop();
  });

  it.each([
    ["the socket never came back", { joined: false, selfId: "" }],
    ["the rejoin issued a NEW identity", { joined: true, selfId: "a2" }],
  ])("fails terminally when the transport dies later and %s", async (_label, after) => {
    let joined = true;
    let selfId = "a";
    const { mixed, resume, drop } = world({ joined: () => joined, selfId: () => selfId });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    joined = after.joined;
    selfId = after.selfId;

    drop("failed");

    // Terminal, not "interrupted": there is no socket to carry an authenticated
    // rebuild offer, or none that the peer would still answer.
    expect(mixed.status).toBe("failed");
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("signalingLost");
    expect(resume).not.toHaveBeenCalled();
    // And no window is left running that could resurrect it later.
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS * 2);
    expect(mixed.status).toBe("failed");
    mixed.stop();
  });

  it("fails terminally when the room refused or expired the rejoin", async () => {
    let refused = false;
    const { mixed, resume, drop } = world({ rejoinRefused: () => refused });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    refused = true;
    expect(mixed.recoveryAvailable).toBe(false);

    drop("failed");
    expect(mixed.status).toBe("failed");
    expect(mixed.endReason).toBe("signalingLost");
    expect(resume).not.toHaveBeenCalled();
    mixed.stop();
  });

  it("still tears an IDLE link down silently, with no terminal card", async () => {
    // No lane had work worth reconnecting for, so this is the pre-existing
    // teardown and must stay one: a notice here would put a "start again" card
    // on screen for a link nobody was using.
    let joined = true;
    const { mixed, drop } = world();
    await mixed.ensure("b");
    joined = false;
    void joined;
    drop("closed");
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("");
    mixed.stop();
  });

  // The same invariant read from the FAR side. Side A losing only its WebSocket
  // is what makes the server tell side B "A left", and B's DataChannel to A is a
  // different transport that is still carrying the batch.
  it("keeps a healthy link when the PEER's socket leaves, and never resumes if it dies later", async () => {
    const gone = new Set<string>();
    const { mixed, resume, drop } = world({ peerPresent: (id) => !gone.has(id) });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    expect(mixed.recoveryAvailable).toBe(true);

    gone.add("b");
    expect(mixed.peerDeparted("b")).toBe(true);

    expect(mixed.link).toBe(link);
    expect(mixed.status).toBe("open");
    expect(mixed.file.send?.status).toBe("waitingAccept");
    expect(link.fileChannel.close).not.toHaveBeenCalled();
    expect(mixed.recoveryAvailable).toBe(false);
    expect(mixed.endReason).toBe("");
    expect(resume).not.toHaveBeenCalled();

    drop("failed");
    expect(mixed.status).toBe("failed");
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("signalingLost");
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS * 2);
    expect(resume).not.toHaveBeenCalled();
    mixed.stop();
  });

  it("ends a HELD link the moment its peer leaves, rather than re-offering to nobody", async () => {
    const gone = new Set<string>();
    const { mixed, resume, drop } = world({ peerPresent: (id) => !gone.has(id) });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    drop("failed");
    expect(mixed.status).toBe("interrupted");
    expect(resume).toHaveBeenCalledTimes(1);

    gone.add("b");
    expect(mixed.peerDeparted("b")).toBe(true);
    expect(mixed.link).toBeNull();
    expect(mixed.endReason).toBe("signalingLost");
    // No further attempt for the rest of a window it could never have won.
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS * 2);
    expect(resume).toHaveBeenCalledTimes(1);
    mixed.stop();
  });

  it("absorbs nothing for a peer this session does not hold a link to", async () => {
    const { mixed } = world();
    const link = await mixed.ensure("b");
    expect(mixed.peerDeparted("c")).toBe(false);
    expect(mixed.link).toBe(link);
    expect(mixed.status).toBe("open");
    mixed.stop();
  });

  it("reports the credential first when both are gone", async () => {
    const { mixed, drop } = world({
      joined: () => false,
      selfId: () => "",
      deadline: () => ({ expiresAt: 60_500, deadlineAt: 500, warnAt: 0 }),
    });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    vi.setSystemTime(1_000);
    drop("failed");
    expect(mixed.endReason).toBe("relayExpired");
    mixed.stop();
  });
});

describe("the terminal explanation's own lifetime", () => {
  it("is cleared by asking for a new link", async () => {
    const { mixed, drop } = world({ joined: () => false, selfId: () => "" });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    drop("failed");
    expect(mixed.endReason).toBe("signalingLost");

    await mixed.ensure("b");
    expect(mixed.endReason).toBe("");
    mixed.stop();
  });

  it("is cleared by an explicit dismissal, which tears nothing down", async () => {
    const { mixed, drop } = world({ joined: () => false, selfId: () => "" });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    drop("failed");
    expect(mixed.endReason).toBe("signalingLost");

    mixed.dismissEnded();
    expect(mixed.endReason).toBe("");
    // Nothing else moved: there was no link left to tear down either way.
    expect(mixed.link).toBeNull();
    expect(link.fileChannel.onmessage).toBeNull();
    mixed.stop();
  });

  it("does not survive stop()", async () => {
    const { mixed, drop } = world({ joined: () => false, selfId: () => "" });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    drop("failed");
    mixed.stop();
    expect(mixed.endReason).toBe("");
  });

  it("says nothing about recovery when there is no link", async () => {
    const { mixed } = world({ joined: () => false, selfId: () => "" });
    expect(mixed.recoveryAvailable).toBe(true);
    mixed.stop();
  });
});
