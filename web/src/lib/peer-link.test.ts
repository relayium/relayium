import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
import { deriveSession, generateKeyPair, ready, signResume, verifyResume } from "./crypto";
import {
  LINK_AUTH_TIMEOUT_MS, LINK_HELD_SIGNAL_MAX,
  LINK_LEAVE_AUTH_LENGTH, LINK_LEAVE_MAX_ATTEMPTS, LINK_RECOVERY_RETRY_MS,
  LINK_RECOVERY_WINDOW_MS,
  LINK_REQUEST_RETRY_MS, LINK_REQUEST_TIMEOUT_MS,
  LinkAuthenticationTimeoutError, LinkBusyError, LinkRecoveryTimeoutError,
  LinkRequestTimeoutError,
  LinkReplaceStaleError, LinkReplaceUnavailableError,
  UnsupportedLinkError, createPeerLinkManager,
  isLinkLeave, isLinkOffer, isLinkRequest, linkRole,
  type MixedPeerLink,
  type PeerLinkDeps,
} from "./peer-link.svelte";
import { LINK_CAPTURE_MAX_BYTES, connectLink, connectResumeLink, type Conn, type InboundSignal } from "./webrtc";
import { authPayload, linkLeavePayload } from "./webrtc-core";
import type { SignalingClient } from "./signaling";
import { FLOW_WINDOW } from "./transfer";

beforeAll(async () => { await ready(); });
afterEach(() => { vi.useRealTimers(); });

function signalingHarness() {
  const listeners: ((from: string, data: unknown) => void)[] = [];
  const sent: { to: string; data: InboundSignal }[] = [];
  const signaling = {
    onSignal(cb: (from: string, data: unknown) => void) {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    sendSignal(to: string, data: unknown) { sent.push({ to, data: data as InboundSignal }); },
  } as unknown as SignalingClient;
  return {
    signaling, sent,
    inject(from: string, data: InboundSignal) { for (const cb of [...listeners]) cb(from, data); },
  };
}

function transportHarness() {
  const conns: Conn[] = [];
  const connect = vi.fn(async (opts: Parameters<typeof connectLink>[0]): Promise<Conn> => {
    const peer = generateKeyPair();
    opts.onPeerKey(peer.publicKey);
    const file = { label: "relayium", readyState: "open" } as RTCDataChannel;
    const text = { label: "relayium-text", readyState: "open" } as RTCDataChannel;
    const conn: Conn = {
      channel: file,
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      close: vi.fn(),
      maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    conns.push(conn);
    return conn;
  });
  return { connect, conns };
}

/** A rebuilt transport, shaped like what connectResumeLink returns: two open
 *  lanes plus whatever the primitive captured before the caller could attach. */
function rebuiltConn(opts: {
  lanes?: "both" | "fileOnly";
  captured?: { file?: ArrayBuffer[]; text?: ArrayBuffer[]; overflow?: boolean };
} = {}) {
  const file = { label: "relayium", readyState: "open" } as RTCDataChannel;
  const text = { label: "relayium-text", readyState: "open" } as RTCDataChannel;
  const pending = {
    relayium: [...(opts.captured?.file ?? [])],
    "relayium-text": [...(opts.captured?.text ?? [])],
  } as Record<string, ArrayBuffer[]>;
  const conn: Conn = {
    channel: file,
    getChannel: (label) =>
      label === "relayium" ? file
      : label === "relayium-text" && opts.lanes !== "fileOnly" ? text
      : undefined,
    takeCaptured: opts.captured
      ? (label: string) => ({ frames: pending[label]?.splice(0) ?? [], overflow: opts.captured?.overflow === true })
      : undefined,
    close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
    stats: async () => new Map() as unknown as RTCStatsReport,
  };
  return { conn, file, text };
}

/** The connectResumeLink seam, with the calls it saw and the transports it made. */
function rebuild(opts: Parameters<typeof rebuiltConn>[0] & { gate?: Promise<unknown> } = {}) {
  const calls: Parameters<typeof connectResumeLink>[0][] = [];
  const conns: Conn[] = [];
  const resume = vi.fn(async (o: Parameters<typeof connectResumeLink>[0]): Promise<Conn> => {
    calls.push(o);
    if (opts.gate) await opts.gate;
    const { conn } = rebuiltConn(opts);
    conns.push(conn);
    return conn;
  });
  return { resume, calls, conns };
}

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("mixed peer link ownership", () => {
  it("assigns the smaller peer id as the only offerer", () => {
    expect(linkRole("a", "b")).toBe("initiator");
    expect(linkRole("b", "a")).toBe("responder");
  });

  it("recognises only exact content-free link requests and fresh link offers", () => {
    expect(isLinkRequest({ link: true, linkRequest: true })).toBe(true);
    expect(isLinkRequest({ linkRequest: true })).toBe(false);
    expect(isLinkRequest({ link: true, linkRequest: true, sdp: { type: "offer" } })).toBe(false);
    expect(isLinkOffer({ link: true, sdp: { type: "offer" } })).toBe(true);
    expect(isLinkOffer({ link: true, resume: true, sdp: { type: "offer" } })).toBe(false);
    expect(isLinkOffer({ link: true, sdp: { type: "answer" } })).toBe(false);
    expect(isLinkOffer({ link: 1, sdp: { type: "offer" } })).toBe(false);
    expect(isLinkOffer(null)).toBe(false);
    expect(isLinkRequest({ linkRequest: "true" })).toBe(false);
    expect(isLinkRequest({})).toBe(false);
  });

  it("opens once as initiator and keeps every nonce-bearing codec link-scoped", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });

    const first = await manager.ensure("b");
    const again = await manager.ensure("b");
    expect(again.peerId).toBe(first.peerId);
    expect(first.role).toBe("initiator");
    expect(manager.current).toBe(first);
    expect(first.fileChannel.label).toBe("relayium");
    expect(first.textChannel.label).toBe("relayium-text");
    expect(first.fileSender).toBe(again.fileSender);
    expect(first.fileReceiver).toBe(again.fileReceiver);
    expect(first.textSender).toBe(again.textSender);
    expect(first.textReceiver).toBe(again.textReceiver);
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(sig.sent).toEqual([]);
    manager.stop();
  });

  it("publishes an opened link synchronously before ensure resolves", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const events: string[] = [];
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
      onLinkChange(link, status) {
        events.push(`${status}:${link?.peerId ?? "none"}`);
        if (link) link.fileChannel.onmessage = vi.fn();
      },
    });

    const pending = manager.ensure("b").then((link) => {
      events.push(`resolved:${link.peerId}`);
      expect(link.fileChannel.onmessage).toBeTypeOf("function");
    });
    await pending;
    expect(events).toEqual(["open:b", "resolved:b"]);
    manager.stop();
    expect(events).toEqual(["open:b", "resolved:b", "idle:none"]);
  });

  it("captures pre-attachment frames FIFO within each lane", async () => {
    const sig = signalingHarness();
    const seen: { file: number[]; text: number[] } = { file: [], text: [] };
    const connect = vi.fn(async (opts: Parameters<typeof connectLink>[0]): Promise<Conn> => {
      const file = { label: "relayium", readyState: "open" } as RTCDataChannel;
      const text = { label: "relayium-text", readyState: "open" } as RTCDataChannel;
      const conn: Conn = {
        channel: file,
        getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
        close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
        stats: async () => new Map() as unknown as RTCStatsReport,
      };
      setTimeout(() => {
        file.onmessage?.({ data: new Uint8Array([1]).buffer } as MessageEvent);
        text.onmessage?.({ data: new Uint8Array([7]).buffer } as MessageEvent);
        file.onmessage?.({ data: new Uint8Array([2]).buffer } as MessageEvent);
        opts.onPeerKey(generateKeyPair().publicKey);
      }, 0);
      return conn;
    });
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true, connect,
      onLinkChange(link, _status, captured) {
        if (!link || !captured) return;
        seen.file = captured.file.map((frame) => new Uint8Array(frame)[0]);
        seen.text = captured.text.map((frame) => new Uint8Array(frame)[0]);
      },
    });
    await manager.ensure("b");
    expect(seen).toEqual({ file: [1, 2], text: [7] });
    manager.stop();
  });

  it("fails closed when the pre-attachment capture exceeds one flow window", async () => {
    const sig = signalingHarness();
    let conn!: Conn;
    const connect = vi.fn(async (opts: Parameters<typeof connectLink>[0]): Promise<Conn> => {
      const file = { label: "relayium", readyState: "open" } as RTCDataChannel;
      const text = { label: "relayium-text", readyState: "open" } as RTCDataChannel;
      conn = {
        channel: file,
        getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
        close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
        stats: async () => new Map() as unknown as RTCStatsReport,
      };
      setTimeout(() => {
        file.onmessage?.({ data: new ArrayBuffer(FLOW_WINDOW + 1) } as MessageEvent);
        opts.onPeerKey(generateKeyPair().publicKey);
      }, 0);
      return conn;
    });
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true, connect,
    });
    await expect(manager.ensure("b")).rejects.toThrow("incomplete or superseded mixed link");
    expect(manager.current).toBeNull();
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("fails closed when the synchronous lane owner cannot attach", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
      onLinkChange(link) { if (link) throw new Error("attach failed"); },
    });
    await expect(manager.ensure("b")).rejects.toThrow("attach failed");
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    expect(transport.conns[0].close).toHaveBeenCalledOnce();
  });

  it("requests the deterministic offerer and resolves from its inbound offer", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();

    const waiting = manager.ensure("a");
    expect(sig.sent).toEqual([{ to: "a", data: { linkRequest: true, link: true } }]);
    expect(transport.connect).not.toHaveBeenCalled();
    const offer: InboundSignal = { link: true, sdp: { type: "offer", sdp: "v=0" } };
    sig.inject("a", offer);
    await tick();
    const link = await waiting;
    expect(link.role).toBe("responder");
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.connect.mock.calls[0][0].initialSignal).toBe(offer);
    manager.stop();
  });

  it("turns a request into one initiator connection and ignores a duplicate", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();
    sig.inject("z", { link: true, linkRequest: true });
    sig.inject("z", { link: true, linkRequest: true });
    const link = await manager.ensure("z");
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(link.role).toBe("initiator");
    manager.stop();
  });

  it("does not signal or connect when exact link capability is absent", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => false,
      connect: transport.connect,
    });
    await expect(manager.ensure("b")).rejects.toBeInstanceOf(UnsupportedLinkError);
    expect(sig.sent).toEqual([]);
    expect(transport.connect).not.toHaveBeenCalled();
  });

  // The capability gate is about links that do not exist yet. An ESTABLISHED
  // one already carries the peer's answer — it was built, authenticated and
  // compared — so re-asking a roster-level announcement about it is asking the
  // wrong layer. The announcement arrives over signalling and is dropped when
  // the peer leaves the roster (peer-caps' retainPeers), so a peer whose socket
  // went away while its DataChannel stayed up would make `ensure` reject the
  // very link it is holding, and every lane intent with it.
  it("hands back an established, healthy link even after its capability is forgotten", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    let announced = true;
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => announced,
      connect: transport.connect,
    });
    const link = await manager.ensure("b");
    announced = false;

    await expect(manager.ensure("b")).resolves.toBe(link);
    // Nothing new was built: this is the same link, not a re-establishment that
    // slipped past the gate.
    expect(transport.connect).toHaveBeenCalledOnce();
    // …and the gate is untouched for everything that is not that link.
    await expect(manager.ensure("c")).rejects.toBeInstanceOf(UnsupportedLinkError);
    expect(transport.connect).toHaveBeenCalledOnce();
    manager.stop();
  });

  // The other half of the same rule, and the reason it is scoped to `open`: a
  // held link has no transport under it, and getting one back means a rebuild
  // addressed through the signalling layer whose answer just changed. Joining
  // that rebuild is a NEW connection attempt in every sense that matters, so it
  // stays behind the gate.
  it("still refuses a link whose transport is being rebuilt when capability is gone", async () => {
    vi.useFakeTimers();
    const sig = signalingHarness();
    const transport = transportHarness();
    let announced = true;
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => announced,
      connect: transport.connect,
      resume: vi.fn(() => new Promise<Conn>(() => {})) as unknown as PeerLinkDeps["resume"],
      onTransportLost: () => true,
    });
    await manager.ensure("b");
    transport.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(manager.status).toBe("interrupted");

    announced = false;
    await expect(manager.ensure("b")).rejects.toBeInstanceOf(UnsupportedLinkError);
    manager.stop();
  });

  it("keeps the global one-link bound across different peers", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    await manager.ensure("b");
    await expect(manager.ensure("c")).rejects.toBeInstanceOf(LinkBusyError);
    expect(transport.connect).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("aborts an opening transport immediately and cannot resurrect it", async () => {
    const sig = signalingHarness();
    let seenSignal: AbortSignal | undefined;
    const connect = vi.fn((opts: Parameters<typeof connectLink>[0]) => {
      seenSignal = opts.signal;
      return new Promise<Conn>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err = Object.assign(new Error("aborted"), { name: "AbortError" });
          reject(err);
        }, { once: true });
      });
    });
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect,
    });
    const pending = manager.ensure("b");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    manager.close();
    expect(seenSignal?.aborted).toBe(true);
    await rejected;
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("idle");
  });

  it.each([
    ["failed", "failed"],
    ["closed", "idle"],
  ] as const)("drops and closes a link whose transport becomes %s", async (terminal, expected) => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    await manager.ensure("b");
    transport.connect.mock.calls[0][0].onStateChange?.(terminal);
    expect(manager.current).toBeNull();
    expect(manager.status).toBe(expected);
    expect(transport.conns[0].close).toHaveBeenCalledOnce();
    await manager.ensure("b");
    expect(transport.connect).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("publishes terminal transport loss to lane owners", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const events: string[] = [];
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
      onLinkChange(link, status) { events.push(`${status}:${link?.peerId ?? "none"}`); },
    });
    await manager.ensure("b");
    transport.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(events).toEqual(["open:b", "failed:none"]);
    manager.stop();
  });

  it("reserves the sole link for the first requested peer", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "m", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();
    const waiting = manager.ensure("a");
    sig.inject("z", { link: true, linkRequest: true });
    expect(sig.sent).toContainEqual({ to: "z", data: { busy: true, link: true } });
    expect(transport.connect).not.toHaveBeenCalled();
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "v=0" } });
    await expect(waiting).resolves.toMatchObject({ peerId: "a" });
    expect(transport.connect).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("settles an inbound busy response and permits an immediate retry", async () => {
    const sig = signalingHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transportHarness().connect,
    });
    manager.listen();
    const first = manager.ensure("a");
    sig.inject("a", { link: true, busy: true });
    await expect(first).rejects.toBeInstanceOf(LinkBusyError);
    expect(manager.status).toBe("failed");
    void manager.ensure("a").catch(() => {});
    expect(sig.sent.filter((s) => s.to === "a" && s.data.linkRequest)).toHaveLength(2);
    manager.stop();
  });

  // `failed` is the one status this manager can be left sitting in with nothing
  // under it, and the workspace now holds the screen on it so the failure can be
  // read. `clearFailed` is what ANSWERS that card — and only that card.
  it("clears a settled failed status without closing anything", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();
    const first = manager.ensure("a");
    sig.inject("a", { link: true, busy: true });
    await expect(first).rejects.toBeInstanceOf(LinkBusyError);
    expect(manager.status).toBe("failed");

    expect(manager.clearFailed()).toBe(true);
    expect(manager.status).toBe("idle");
    expect(manager.current).toBeNull();
    // Nothing was torn down: no transport was ever built here, and asking again
    // still asks.
    expect(transport.connect).not.toHaveBeenCalled();
    void manager.ensure("a").catch(() => {});
    expect(sig.sent.filter((s) => s.to === "a" && s.data.linkRequest)).toHaveLength(2);
    manager.stop();
  });

  it("refuses to clear a status that is not a settled failure", async () => {
    // Reverse mutation for the call above: an unconditional `status = "idle"`
    // would satisfy it and would silently hide a live establishment behind an
    // idle screen.
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();

    // Idle: nothing to answer.
    expect(manager.clearFailed()).toBe(false);
    expect(manager.status).toBe("idle");

    // A request in flight.
    const waiting = manager.ensure("a");
    expect(manager.status).toBe("requesting");
    expect(manager.clearFailed()).toBe(false);
    expect(manager.status).toBe("requesting");

    // An open link.
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "v=0" } });
    await expect(waiting).resolves.toMatchObject({ peerId: "a" });
    expect(manager.status).toBe("open");
    expect(manager.clearFailed()).toBe(false);
    expect(manager.status).toBe("open");
    expect(manager.current).not.toBeNull();
    manager.stop();
  });

  it("does not let a third-party busy response cancel another peer's request", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();
    const waiting = manager.ensure("a");
    sig.inject("other", { link: true, busy: true });
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "v=0" } });
    await expect(waiting).resolves.toMatchObject({ peerId: "a" });
    expect(transport.connect).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("retries a dropped request and fails with a typed timeout", async () => {
    vi.useFakeTimers();
    const sig = signalingHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transportHarness().connect,
    });
    manager.listen();
    const waiting = manager.ensure("a");
    const rejected = expect(waiting).rejects.toBeInstanceOf(LinkRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(LINK_REQUEST_RETRY_MS * 2);
    expect(sig.sent.filter((s) => s.data.linkRequest)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(LINK_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(manager.status).toBe("failed");
    manager.stop();
  });

  it("consumes one late offer after request timeout, replies busy, then accepts a retry", async () => {
    vi.useFakeTimers();
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();
    const waiting = manager.ensure("a");
    const rejected = expect(waiting).rejects.toBeInstanceOf(LinkRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(LINK_REQUEST_TIMEOUT_MS);
    await rejected;

    const offer: InboundSignal = { link: true, sdp: { type: "offer", sdp: "late" } };
    sig.inject("a", offer);
    expect(sig.sent.at(-1)).toEqual({ to: "a", data: { busy: true, link: true } });
    expect(transport.connect).not.toHaveBeenCalled();

    sig.inject("a", { ...offer, sdp: { type: "offer", sdp: "retry" } });
    await manager.ensure("a");
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(manager.current?.peerId).toBe("a");
    manager.stop();
  });

  it("refuses an inbound link when the resource-admission gate is closed", () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      canAcceptLink: () => false, connect: transport.connect,
    });
    manager.listen();
    sig.inject("z", { link: true, linkRequest: true });
    expect(sig.sent).toEqual([{ to: "z", data: { busy: true, link: true } }]);
    expect(transport.connect).not.toHaveBeenCalled();
    manager.stop();
  });

  it("rejects its pending request when admission closes before the offer arrives", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      canAcceptLink: () => false, connect: transport.connect,
    });
    manager.listen();
    const waiting = manager.ensure("a");
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "v=0" } });
    await expect(waiting).rejects.toBeInstanceOf(LinkBusyError);
    expect(sig.sent.at(-1)).toEqual({ to: "a", data: { busy: true, link: true } });
    expect(transport.connect).not.toHaveBeenCalled();
    manager.stop();
  });

  it("times out authentication after transport opens without a peer reveal", async () => {
    vi.useFakeTimers();
    const sig = signalingHarness();
    const file = { label: "relayium" } as RTCDataChannel;
    const text = { label: "relayium-text" } as RTCDataChannel;
    const conn: Conn = {
      channel: file,
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    const connect = vi.fn(async () => conn);
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true, connect,
    });
    const pending = manager.ensure("b");
    const rejected = expect(pending).rejects.toBeInstanceOf(LinkAuthenticationTimeoutError);
    await tick();
    await vi.advanceTimersByTimeAsync(LINK_AUTH_TIMEOUT_MS);
    await rejected;
    expect(conn.close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    manager.stop();
  });

  it("fails authentication immediately when the opened transport becomes terminal", async () => {
    const sig = signalingHarness();
    let stateChange: ((state: RTCPeerConnectionState) => void) | undefined;
    const file = { label: "relayium" } as RTCDataChannel;
    const text = { label: "relayium-text" } as RTCDataChannel;
    const conn: Conn = {
      channel: file,
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    const connect = vi.fn(async (opts: Parameters<typeof connectLink>[0]) => {
      stateChange = opts.onStateChange;
      return conn;
    });
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true, connect,
    });
    const pending = manager.ensure("b");
    const rejected = expect(pending).rejects.toThrow(/transport failed/);
    await tick();
    stateChange!("failed");
    await rejected;
    expect(conn.close).toHaveBeenCalledOnce();
    expect(manager.status).toBe("failed");
    manager.stop();
  });

  it("observes a terminal authentication failure fired before transport resolution", async () => {
    const sig = signalingHarness();
    const file = { label: "relayium" } as RTCDataChannel;
    const text = { label: "relayium-text" } as RTCDataChannel;
    const conn: Conn = {
      channel: file,
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    const connect = vi.fn(async (opts: Parameters<typeof connectLink>[0]) => {
      opts.onStateChange?.("failed");
      return conn;
    });
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true, connect,
    });
    await expect(manager.ensure("b")).rejects.toThrow(/transport failed/);
    expect(conn.close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    manager.stop();
  });

  it("clears a late-offer marker on explicit manager close", async () => {
    vi.useFakeTimers();
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();
    const pending = manager.ensure("a");
    const rejected = expect(pending).rejects.toBeInstanceOf(LinkRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(LINK_REQUEST_TIMEOUT_MS);
    await rejected;
    manager.close();
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "fresh" } });
    await tick();
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(sig.sent.at(-1)?.data.busy).not.toBe(true);
    manager.stop();
  });

  it("answers a new offer with busy while the same peer's link is still open", async () => {
    const sig = signalingHarness();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transportHarness().connect,
    });
    manager.listen();
    const first = manager.ensure("a");
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "first" } });
    const link = await first;
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "replacement" } });
    expect(sig.sent.at(-1)).toEqual({ to: "a", data: { busy: true, link: true } });
    expect(manager.current).toBe(link);
    manager.stop();
  });

  it("closes and rejects a transport missing either required lane", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    transport.connect.mockImplementationOnce(async (opts) => {
      const peer = generateKeyPair();
      opts.onPeerKey(peer.publicKey);
      const file = { label: "relayium" } as RTCDataChannel;
      const conn: Conn = {
        channel: file, getChannel: (label) => label === "relayium" ? file : undefined,
        close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
        stats: async () => new Map() as unknown as RTCStatsReport,
      };
      transport.conns.push(conn);
      return conn;
    });
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    await expect(manager.ensure("b")).rejects.toThrow(/incomplete/);
    expect(transport.conns[0].close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();
    manager.stop();
  });

  it("closes a stale transport that resolves after cancellation", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    let release!: () => void;
    transport.connect.mockImplementationOnce(async (opts) => {
      await new Promise<void>((resolve) => { release = resolve; });
      const peer = generateKeyPair();
      opts.onPeerKey(peer.publicKey);
      const file = { label: "relayium" } as RTCDataChannel;
      const text = { label: "relayium-text" } as RTCDataChannel;
      const conn: Conn = {
        channel: file,
        getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
        close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
        stats: async () => new Map() as unknown as RTCStatsReport,
      };
      transport.conns.push(conn);
      return conn;
    });
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    const pending = manager.ensure("b");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    manager.close();
    release();
    await rejected;
    expect(transport.conns[0].close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("idle");
  });

  it("keeps the text nonce sequence continuous across repeated ensure calls", async () => {
    const sig = signalingHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transportHarness().connect,
    });
    const first = await manager.ensure("b");
    const f0 = await first.textSender.frame("one", first.keys.textSend);
    const again = await manager.ensure("b");
    const f1 = await again.textSender.frame("two", again.keys.textSend);
    expect(new DataView(f0.buffer, f0.byteOffset).getUint32(1)).toBe(0);
    expect(new DataView(f1.buffer, f1.byteOffset).getUint32(1)).toBe(1);
    manager.stop();
  });

  it("has no transport replacement to make before a link exists", async () => {
    const sig = signalingHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transportHarness().connect, resume: rebuild().resume,
    });
    await expect(manager.replaceTransport("b")).rejects.toBeInstanceOf(LinkReplaceUnavailableError);
    expect(manager.replacingTransport).toBe(false);
    manager.stop();
  });

  it("replaces its signal listener instead of duplicating it", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();
    manager.listen();
    sig.inject("z", { link: true, linkRequest: true });
    await tick();
    expect(transport.connect).toHaveBeenCalledTimes(1);
    manager.stop();
  });
});

// A transport replacement is the one operation allowed to change a live link.
// Everything it must NOT change — the keys, the SAS, the four codecs and their
// nonce sequences — is exactly what makes a link a link, so most of these tests
// are identity assertions rather than behaviour assertions.
describe("mixed link transport replacement", () => {
  async function opened(over: Partial<PeerLinkDeps> = {}) {
    const sig = signalingHarness();
    const transport = transportHarness();
    const events: { status: string; peerId: string | null }[] = [];
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
      onLinkChange(link, status) { events.push({ status, peerId: link?.peerId ?? null }); },
      ...over,
    });
    const link = await manager.ensure("b");
    return { sig, transport, manager, link, events };
  }

  it("reuses the keys, the SAS and all four codecs, replacing only the transport", async () => {
    const seam = rebuild();
    const { manager, link, transport } = await opened({ resume: seam.resume });

    const next = await manager.replaceTransport("b");

    expect(next).not.toBe(link);
    expect(manager.current).toBe(next);
    expect(next.peerId).toBe("b");
    // Only these three change.
    expect(next.conn).toBe(seam.conns[0]);
    expect(next.conn).not.toBe(link.conn);
    expect(next.fileChannel).not.toBe(link.fileChannel);
    expect(next.textChannel).not.toBe(link.textChannel);
    expect(next.fileChannel.label).toBe("relayium");
    expect(next.textChannel.label).toBe("relayium-text");
    // Everything the link owns is the SAME OBJECT, not an equal one.
    expect(next.keys).toBe(link.keys);
    expect(next.sas).toBe(link.sas);
    expect(next.role).toBe(link.role);
    expect(next.fileSender).toBe(link.fileSender);
    expect(next.fileReceiver).toBe(link.fileReceiver);
    expect(next.textSender).toBe(link.textSender);
    expect(next.textReceiver).toBe(link.textReceiver);
    // No second commit-reveal: a rebuilt transport never re-authenticates and so
    // can never present a second SAS.
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(seam.resume).toHaveBeenCalledTimes(1);
    // The old transport is retired, exactly once.
    expect(link.conn.close).toHaveBeenCalledOnce();
    expect(manager.replacingTransport).toBe(false);
    manager.stop();
  });

  it("keeps every codec's nonce sequence continuous across the replacement", async () => {
    const seam = rebuild();
    const { manager, link } = await opened({ resume: seam.resume });

    const before = await link.textSender.frame("one", link.keys.textSend);
    const next = await manager.replaceTransport("b");
    const after = await next.textSender.frame("two", next.keys.textSend);

    expect(new DataView(before.buffer, before.byteOffset).getUint32(1)).toBe(0);
    expect(new DataView(after.buffer, after.byteOffset).getUint32(1)).toBe(1);
    manager.stop();
  });

  it("authenticates the rebuild with the link's existing resumeAuth key", async () => {
    const seam = rebuild();
    const { manager, link } = await opened({ resume: seam.resume });
    const offer: InboundSignal = { link: true, resume: true, sdp: { type: "offer", sdp: "rebuild" } };

    await manager.replaceTransport("b", offer);

    const call = seam.calls[0];
    expect(call.peerId).toBe("b");
    expect(call.initialSignal).toBe(offer);
    expect(call.config).toEqual({ iceServers: [] });
    expect(call.signal).toBeInstanceOf(AbortSignal);
    // What it signs with is the link's key, not a fresh one: a tag this
    // connection produces verifies under the link's resumeAuth and vice versa.
    const payload = authPayload(offer);
    expect(await verifyResume(link.keys.resumeAuth, payload, await call.auth.sign(payload))).toBe(true);
    expect(await call.auth.verify(payload, await signResume(link.keys.resumeAuth, payload))).toBe(true);
    // And a signalling relay that ran its own key exchange cannot produce one.
    const attacker = generateKeyPair();
    const victim = generateKeyPair();
    const foreign = await deriveSession("initiator", attacker, victim.publicKey);
    expect(await call.auth.verify(payload, await signResume(foreign.resumeAuth, payload))).toBe(false);
    expect(await call.auth.verify(payload, undefined)).toBe(false);
    manager.stop();
  });

  it("rebuilds with the offerer role the link was established under", async () => {
    const initiating = rebuild();
    const asInitiator = await opened({ resume: initiating.resume });
    await asInitiator.manager.replaceTransport("b");
    expect(asInitiator.link.role).toBe("initiator");
    expect(initiating.calls[0].role).toBe("initiator");
    expect(initiating.calls[0].role).toBe(linkRole("a", "b"));
    asInitiator.manager.stop();

    // The larger peer id answers, on the first connection and on every rebuild.
    const sig = signalingHarness();
    const transport = transportHarness();
    const answering = rebuild();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect, resume: answering.resume,
    });
    manager.listen();
    const waiting = manager.ensure("a");
    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "v=0" } });
    const link = await waiting;
    expect(link.role).toBe("responder");
    await manager.replaceTransport("a");
    expect(answering.calls[0].role).toBe("responder");
    expect(answering.calls[0].role).toBe(linkRole("z", "a"));
    manager.stop();
  });

  it("hands both lanes' early frames to the owner in FIFO order, before it can be raced", async () => {
    const seam = rebuild({
      captured: { file: [bytes(1), bytes(2)], text: [bytes(9)] },
    });
    const attached: string[] = [];
    const replayed: { file: number[]; text: number[] } = { file: [], text: [] };
    const { manager, link } = await opened({
      resume: seam.resume,
      onLinkChange(next, status, captured) {
        if (!next) { attached.push(`${status}:none`); return; }
        attached.push(`${status}:${next.peerId}`);
        // The lane owner attaches here; only then are the captured frames its
        // problem. Replay through the handler it just installed.
        next.fileChannel.onmessage = (event: MessageEvent) => replayed.file.push(new Uint8Array(event.data)[0]);
        next.textChannel.onmessage = (event: MessageEvent) => replayed.text.push(new Uint8Array(event.data)[0]);
        for (const frame of captured?.file ?? []) next.fileChannel.onmessage?.({ data: frame } as MessageEvent);
        for (const frame of captured?.text ?? []) next.textChannel.onmessage?.({ data: frame } as MessageEvent);
      },
    });

    const next = await manager.replaceTransport("b");
    expect(attached).toEqual(["open:b", "open:b"]);
    expect(replayed).toEqual({ file: [1, 2], text: [9] });
    // The capture sinks are detached before the owner runs, so a second drain
    // cannot replay the same frame into the codecs.
    expect(next.conn.takeCaptured?.("relayium").frames).toEqual([]);
    expect(link.conn.close).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("leaves no capture sink behind when the owner attaches nothing", async () => {
    const seam = rebuild({ captured: { file: [bytes(1)] } });
    const { manager } = await opened({ resume: seam.resume, onLinkChange() {} });
    const next = await manager.replaceTransport("b");
    expect(next.fileChannel.onmessage).toBeNull();
    expect(next.textChannel.onmessage).toBeNull();
    manager.stop();
  });

  it("refuses a rebuild for a peer that is not the current link's", async () => {
    const seam = rebuild();
    const { manager, link } = await opened({ resume: seam.resume });
    await expect(manager.replaceTransport("c")).rejects.toBeInstanceOf(LinkReplaceUnavailableError);
    expect(seam.resume).not.toHaveBeenCalled();
    expect(manager.current).toBe(link);
    expect(link.conn.close).not.toHaveBeenCalled();
    manager.stop();
  });

  it("serializes a duplicate rebuild onto the one already in flight", async () => {
    let release!: () => void;
    const seam = rebuild({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const { manager, link } = await opened({ resume: seam.resume });

    const first = manager.replaceTransport("b");
    const second = manager.replaceTransport("b");
    expect(manager.replacingTransport).toBe(true);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(seam.resume).toHaveBeenCalledTimes(1);
    expect(manager.current).toBe(a);
    expect(link.conn.close).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("fails closed, keeping the link, when the rebuilt transport is missing a lane", async () => {
    const seam = rebuild({ lanes: "fileOnly" });
    const { manager, link, events } = await opened({ resume: seam.resume });

    await expect(manager.replaceTransport("b")).rejects.toThrow(/incomplete/);
    expect(seam.conns[0].close).toHaveBeenCalledOnce();
    // A half-built replacement is not a reason to throw away a link that is
    // still current; the caller may retry.
    expect(manager.current).toBe(link);
    expect(link.conn.close).not.toHaveBeenCalled();
    expect(events).toEqual([{ status: "open", peerId: "b" }]);
    expect(manager.replacingTransport).toBe(false);
    manager.stop();
  });

  it("fails the whole link when the rebuild's capture overflows", async () => {
    const seam = rebuild({
      captured: { file: [new ArrayBuffer(LINK_CAPTURE_MAX_BYTES + 1)], overflow: true },
    });
    const { manager, link, events } = await opened({ resume: seam.resume });

    // Dropped admitted frames are the one thing the reused receiver codecs
    // cannot survive, so this is not a retryable transport failure.
    await expect(manager.replaceTransport("b")).rejects.toThrow(/capture overflow/);
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    expect(link.conn.close).toHaveBeenCalledOnce();
    expect(seam.conns[0].close).toHaveBeenCalledOnce();
    expect(events).toEqual([{ status: "open", peerId: "b" }, { status: "failed", peerId: null }]);
    manager.stop();
  });

  it("fails closed when a lane owner cannot attach the replacement", async () => {
    const seam = rebuild();
    let established = false;
    const { manager, link } = await opened({
      resume: seam.resume,
      onLinkChange(next) {
        if (!next) return;
        if (established) throw new Error("attach failed");
        established = true;
      },
    });

    await expect(manager.replaceTransport("b")).rejects.toThrow("attach failed");
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    expect(seam.conns[0].close).toHaveBeenCalledOnce();
    expect(link.conn.close).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("never publishes a rebuilt transport that died before it could be attached", async () => {
    const conns: Conn[] = [];
    // The transport opens both lanes and then goes terminal in the same turn, so
    // the only teardown callback it will ever fire has already fired.
    const resume = vi.fn(async (o: Parameters<typeof connectResumeLink>[0]): Promise<Conn> => {
      const { conn } = rebuiltConn();
      conns.push(conn);
      o.onStateChange?.("failed");
      return conn;
    });
    const { manager, link, events } = await opened({ resume });

    await expect(manager.replaceTransport("b")).rejects.toThrow(/terminal/);
    expect(conns[0].close).toHaveBeenCalledOnce();
    expect(manager.current).toBe(link);
    expect(events).toEqual([{ status: "open", peerId: "b" }]);
    manager.stop();
  });

  it("chains replacements without letting an earlier one disturb a later one", async () => {
    const seam = rebuild();
    const { manager, link, events } = await opened({ resume: seam.resume });

    const second = await manager.replaceTransport("b");
    const third = await manager.replaceTransport("b");

    expect(manager.current).toBe(third);
    expect(third.keys).toBe(link.keys);
    expect(third.textSender).toBe(link.textSender);
    expect(third.fileReceiver).toBe(link.fileReceiver);
    expect(seam.conns[0].close).toHaveBeenCalledOnce(); // retired by the third
    expect(link.conn.close).toHaveBeenCalledOnce();
    // The middle transport's own terminal callback now belongs to nothing.
    seam.calls[0].onStateChange?.("closed");
    expect(manager.current).toBe(third);
    expect(events).toEqual([
      { status: "open", peerId: "b" },
      { status: "open", peerId: "b" },
      { status: "open", peerId: "b" },
    ]);
    expect(second).not.toBe(third);
    manager.stop();
  });

  it("does not hand back a replacement the manager stopped holding during attachment", async () => {
    const seam = rebuild();
    let attached = 0;
    const { manager, link } = await opened({
      resume: seam.resume,
      onLinkChange(next) {
        if (!next || ++attached < 2) return;
        // A lane owner's attachment killed the transport it was just handed.
        seam.calls[0].onStateChange?.("failed");
      },
    });

    await expect(manager.replaceTransport("b")).rejects.toBeInstanceOf(LinkReplaceStaleError);
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    expect(seam.conns[0].close).toHaveBeenCalled();
    expect(link.conn.close).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("cancels a rebuild in flight and closes the transport that arrives late", async () => {
    let release!: () => void;
    const seam = rebuild({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const { manager, link } = await opened({ resume: seam.resume });

    const pending = manager.replaceTransport("b");
    const rejected = expect(pending).rejects.toBeInstanceOf(LinkReplaceStaleError);
    manager.close();
    expect(seam.calls[0].signal?.aborted).toBe(true);
    release();
    await rejected;
    expect(seam.conns[0].close).toHaveBeenCalledOnce();
    expect(link.conn.close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("idle");
  });

  it("closes a rebuild that completes after its link was torn down", async () => {
    let release!: () => void;
    const seam = rebuild({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const { manager, transport, link } = await opened({ resume: seam.resume });

    const pending = manager.replaceTransport("b");
    const rejected = expect(pending).rejects.toBeInstanceOf(LinkReplaceStaleError);
    // The link the caller asked to rebuild stops being current mid-flight.
    transport.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(manager.current).toBeNull();
    release();
    await rejected;
    expect(seam.conns[0].close).toHaveBeenCalledOnce();
    expect(link.conn.close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();
    manager.stop();
  });

  it("never lets the retired transport's terminal callback tear down the replacement", async () => {
    const seam = rebuild();
    const { manager, transport, link, events } = await opened({ resume: seam.resume });
    const next = await manager.replaceTransport("b");

    // The old PeerConnection reports what closing it always reports. It is not
    // the link's transport any more, so it publishes nothing.
    transport.connect.mock.calls[0][0].onStateChange?.("closed");
    transport.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(manager.current).toBe(next);
    expect(manager.status).toBe("open");
    expect(events).toEqual([{ status: "open", peerId: "b" }, { status: "open", peerId: "b" }]);
    expect(seam.conns[0].close).not.toHaveBeenCalled();
    expect(link.conn.close).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("does publish a teardown when the replacement's own transport dies", async () => {
    const seam = rebuild();
    const { manager, events } = await opened({ resume: seam.resume });
    await manager.replaceTransport("b");

    seam.calls[0].onStateChange?.("failed");
    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    expect(seam.conns[0].close).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ status: "failed", peerId: null });
    manager.stop();
  });

  it("keeps the one-link bound: a rebuild for another peer's link is busy, not silent", async () => {
    let release!: () => void;
    const seam = rebuild({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const { manager, transport } = await opened({ resume: seam.resume });

    const pending = manager.replaceTransport("b");
    const rejected = expect(pending).rejects.toBeInstanceOf(LinkReplaceStaleError);
    // While that rebuild is in flight the link drops and another peer's link
    // takes the single slot.
    transport.connect.mock.calls[0][0].onStateChange?.("closed");
    const other = await manager.ensure("c");
    await expect(manager.replaceTransport("c")).rejects.toBeInstanceOf(LinkBusyError);
    release();
    await rejected;
    expect(manager.current).toBe(other);
    manager.stop();
  });
});

// A transport drop no longer destroys the link. What is pinned here is the whole
// decision surface around that: WHO may hold a link, WHO may offer its
// replacement, WHAT a signalling relay can do with a `resume` offer while the
// link is defenceless, and that every wait is bounded and cancellable.
describe("mixed link transport recovery", () => {
  /** An open link plus the seams needed to drop its transport underneath it. */
  async function linked(
    over: Partial<PeerLinkDeps> = {},
    selfId = "a",
    peerId = "b",
  ) {
    const sig = signalingHarness();
    const transport = transportHarness();
    const events: { status: string; peerId: string | null }[] = [];
    const lost: string[] = [];
    let hold = true;
    const manager = createPeerLinkManager({
      selfId: () => selfId,
      signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: transport.connect,
      onLinkChange(link, status) { events.push({ status, peerId: link?.peerId ?? null }); },
      onTransportLost(link) { lost.push(link.peerId); return hold; },
      ...over,
    });
    manager.listen();
    let link: MixedPeerLink;
    if (linkRole(selfId, peerId) === "initiator") link = await manager.ensure(peerId);
    else {
      const waiting = manager.ensure(peerId);
      sig.inject(peerId, { link: true, sdp: { type: "offer", sdp: "v=0" } });
      link = await waiting;
    }
    return {
      sig, transport, manager, link, events, lost,
      drop: (state: "failed" | "closed" = "failed") =>
        transport.connect.mock.calls[0][0].onStateChange?.(state),
      setHold(next: boolean) { hold = next; },
    };
  }

  /** A rebuild seam that never resolves, so the interrupted state can be
   *  observed without the driver immediately ending it. */
  const stalled = () => rebuild({ gate: new Promise<void>(() => {}) });

  /** An authenticated inbound rebuild offer for `link`. */
  async function resumeOffer(link: MixedPeerLink, sdp = "rebuild", key = link.keys.resumeAuth) {
    const offer: InboundSignal = { resume: true, sdp: { type: "offer", sdp } };
    offer.auth = await signResume(key, authPayload(offer));
    return offer;
  }

  it("holds the link, its SAS and its codecs when a lane owner asks for recovery", async () => {
    const seam = stalled();
    const { manager, link, events, lost, drop } = await linked({ resume: seam.resume });

    drop("failed");

    expect(manager.current).toBe(link);
    expect(manager.status).toBe("interrupted");
    expect(lost).toEqual(["b"]);
    // No teardown was published: the lanes keep the link they already own.
    expect(events).toEqual([{ status: "open", peerId: "b" }]);
    // The dead connection is still released.
    expect(link.conn.close).toHaveBeenCalledOnce();
    manager.stop();
  });

  it.each<[string, Pick<PeerLinkDeps, "onTransportLost">]>([
    ["a hook that declines", { onTransportLost: () => false }],
    ["no hook at all", { onTransportLost: undefined }],
    ["a hook that throws", { onTransportLost() { throw new Error("policy exploded"); } }],
  ])("tears the link down exactly as before with %s", async (_name, over) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { manager, link, events, drop } = await linked(over);

    drop("failed");

    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    expect(link.conn.close).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { status: "open", peerId: "b" },
      { status: "failed", peerId: null },
    ]);
    errors.mockRestore();
    manager.stop();
  });

  it("asks the policy once per dead transport, not once per callback", async () => {
    const seam = stalled();
    const { manager, lost, drop } = await linked({ resume: seam.resume });

    // A dying PeerConnection reports failed and then closed; closing it here
    // reports closed again. All of that is one gap.
    drop("failed");
    drop("closed");
    drop("failed");

    expect(lost).toEqual(["b"]);
    expect(manager.status).toBe("interrupted");
    manager.stop();
  });

  it("drives the rebuild from the initiator and republishes the same link identity", async () => {
    const seam = rebuild();
    const { manager, link, transport, drop } = await linked({ resume: seam.resume });

    drop("failed");
    await vi.waitFor(() => expect(manager.status).toBe("open"));

    const next = manager.current!;
    expect(next).not.toBe(link);
    expect(next.keys).toBe(link.keys);
    expect(next.sas).toBe(link.sas);
    expect(next.role).toBe(link.role);
    expect(next.fileSender).toBe(link.fileSender);
    expect(next.fileReceiver).toBe(link.fileReceiver);
    expect(next.textSender).toBe(link.textSender);
    expect(next.textReceiver).toBe(link.textReceiver);
    // No second commit-reveal, so no second SAS can exist.
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(seam.resume).toHaveBeenCalledTimes(1);
    expect(seam.calls[0].role).toBe("initiator");
    manager.stop();
  });

  it("retries a failed rebuild attempt on a bounded backoff", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const conns: Conn[] = [];
    const resume = vi.fn(async (): Promise<Conn> => {
      if (++attempts === 1) throw new Error("relayium: ICE went nowhere");
      const { conn } = rebuiltConn();
      conns.push(conn);
      return conn;
    });
    const { manager, link, drop } = await linked({ resume });

    drop("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    expect(manager.status).toBe("interrupted");

    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_RETRY_MS);
    expect(attempts).toBe(2);
    expect(manager.status).toBe("open");
    expect(manager.current?.keys).toBe(link.keys);
    manager.stop();
  });

  it("fails closed when the window expires, and rejects the joined intent", async () => {
    vi.useFakeTimers();
    const resume = vi.fn(async (): Promise<Conn> => { throw new Error("no route"); });
    const { manager, link, events, drop } = await linked({ resume });

    drop("failed");
    const joined = manager.ensure("b");
    const rejected = expect(joined).rejects.toBeInstanceOf(LinkRecoveryTimeoutError);
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS);
    await rejected;

    expect(manager.current).toBeNull();
    expect(manager.status).toBe("failed");
    expect(events).toEqual([
      { status: "open", peerId: "b" },
      { status: "failed", peerId: null },
    ]);
    expect(link.conn.close).toHaveBeenCalled();
    // Nothing keeps running after the window closed.
    const attempts = resume.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS);
    expect(resume.mock.calls.length).toBe(attempts);
    manager.stop();
  });

  it("never offers from the responder; it rebuilds from a verified inbound offer", async () => {
    const seam = rebuild();
    const { manager, link, sig, drop } = await linked({ resume: seam.resume }, "z", "a");
    const beforeDrop = sig.sent.length;

    drop("failed");
    await tick();
    // The larger peer id waits. It emits nothing at all, so two peers can never
    // both offer a replacement and there is no rebuild glare to resolve.
    expect(seam.resume).not.toHaveBeenCalled();
    expect(sig.sent).toHaveLength(beforeDrop);

    const offer = await resumeOffer(link);
    sig.inject("a", offer);
    await vi.waitFor(() => expect(manager.status).toBe("open"));
    expect(seam.resume).toHaveBeenCalledTimes(1);
    expect(seam.calls[0].initialSignal).toBe(offer);
    expect(seam.calls[0].role).toBe("responder");
    expect(manager.current?.keys).toBe(link.keys);
    expect(manager.current?.sas).toBe(link.sas);
    manager.stop();
  });

  it.each([
    ["carries no auth tag", async (link: MixedPeerLink) => {
      const offer = await resumeOffer(link);
      delete offer.auth;
      return offer;
    }],
    ["carries a non-string auth tag", async (link: MixedPeerLink) => ({
      ...await resumeOffer(link), auth: 1 as unknown as string,
    })],
    ["is signed under another session's key", async () => {
      const attacker = generateKeyPair();
      const victim = generateKeyPair();
      const foreign = await deriveSession("initiator", attacker, victim.publicKey);
      const offer: InboundSignal = { resume: true, sdp: { type: "offer", sdp: "hijack" } };
      offer.auth = await signResume(foreign.resumeAuth, authPayload(offer));
      return offer;
    }],
    ["is signed over different bytes", async (link: MixedPeerLink) => {
      const signed = await resumeOffer(link, "original");
      return { ...signed, sdp: { type: "offer" as const, sdp: "swapped" } };
    }],
  ])("ignores a rebuild offer that %s", async (_name, build) => {
    const seam = rebuild();
    const { manager, link, sig, drop } = await linked({ resume: seam.resume }, "z", "a");
    drop("failed");
    const before = sig.sent.length;

    sig.inject("a", await build(link));
    await tick();

    expect(seam.resume).not.toHaveBeenCalled();
    expect(manager.status).toBe("interrupted");
    expect(manager.current).toBe(link);
    // Silent: answering would tell a signalling relay which peer holds a link.
    expect(sig.sent).toHaveLength(before);
    manager.stop();
  });

  it("ignores a rebuild offer from a peer that is not the link's", async () => {
    const seam = rebuild();
    const { manager, link, sig, drop } = await linked({ resume: seam.resume }, "z", "a");
    drop("failed");

    sig.inject("stranger", await resumeOffer(link));
    await tick();

    expect(seam.resume).not.toHaveBeenCalled();
    expect(manager.status).toBe("interrupted");
    manager.stop();
  });

  it("ignores a rebuild offer for a healthy link", async () => {
    const seam = rebuild();
    const { manager, link, sig } = await linked({ resume: seam.resume }, "z", "a");

    // A signalling MITM cannot move a working link onto a transport it chose.
    sig.inject("a", await resumeOffer(link));
    await tick();

    expect(seam.resume).not.toHaveBeenCalled();
    expect(manager.status).toBe("open");
    expect(manager.current).toBe(link);
    manager.stop();
  });

  it("consumes at most one rebuild offer even when two arrive together", async () => {
    const seam = rebuild();
    const { manager, link, sig, drop } = await linked({ resume: seam.resume }, "z", "a");
    drop("failed");

    const first = await resumeOffer(link, "first");
    const second = await resumeOffer(link, "second");
    sig.inject("a", first);
    sig.inject("a", second);
    await vi.waitFor(() => expect(manager.status).toBe("open"));
    await tick();

    expect(seam.resume).toHaveBeenCalledTimes(1);
    expect(seam.calls[0].initialSignal).toBe(first);
    manager.stop();
  });

  it("closes a rebuild that lands after its window already expired", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const seam = rebuild({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const { manager, events, drop } = await linked({ resume: seam.resume });

    drop("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(seam.resume).toHaveBeenCalledTimes(1);
    expect(seam.calls[0].signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS);
    expect(manager.current).toBeNull();
    expect(seam.calls[0].signal?.aborted).toBe(true);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(seam.conns[0].close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();
    expect(events).toEqual([
      { status: "open", peerId: "b" },
      { status: "failed", peerId: null },
    ]);
    manager.stop();
  });

  it.each(["close", "stop"] as const)("cancels recovery and its timers on %s()", async (how) => {
    vi.useFakeTimers();
    const seam = stalled();
    const { manager, link, events, drop } = await linked({ resume: seam.resume });
    drop("failed");
    const joined = manager.ensure("b");
    const rejected = expect(joined).rejects.toThrow(/closed/);

    manager[how]();
    await rejected;

    expect(manager.current).toBeNull();
    expect(manager.status).toBe("idle");
    expect(events).toEqual([
      { status: "open", peerId: "b" },
      { status: "idle", peerId: null },
    ]);
    expect(seam.calls[0].signal?.aborted).toBe(true);
    // The window timer is gone: nothing publishes a second teardown later.
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS * 2);
    expect(events).toHaveLength(2);
    expect(link.conn.close).toHaveBeenCalled();
  });

  it("resolves a mid-gap intent onto the rebuilt link, never onto a second one", async () => {
    let release!: () => void;
    const seam = rebuild({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const { manager, link, transport, drop } = await linked({ resume: seam.resume });

    drop("failed");
    const joined = manager.ensure("b");
    release();
    const resolved = await joined;

    expect(resolved).toBe(manager.current);
    expect(resolved).not.toBe(link);
    expect(resolved.sas).toBe(link.sas);
    expect(resolved.keys).toBe(link.keys);
    expect(resolved.fileSender).toBe(link.fileSender);
    // One authentication step, one transport rebuild, no second connection.
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(seam.resume).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("answers a fresh link offer with busy while interrupted", async () => {
    const seam = stalled();
    const { manager, link, sig, drop } = await linked({ resume: seam.resume }, "z", "a");
    drop("failed");

    sig.inject("a", { link: true, sdp: { type: "offer", sdp: "second-link" } });

    expect(sig.sent.at(-1)).toEqual({ to: "a", data: { busy: true, link: true } });
    expect(manager.current).toBe(link);
    expect(manager.status).toBe("interrupted");
    manager.stop();
  });

  it("keeps a retrying rebuild from invalidating a later establishment", async () => {
    vi.useFakeTimers();
    const resume = vi.fn(async (): Promise<Conn> => { throw new Error("no route"); });
    const { manager, transport, drop } = await linked({ resume });

    drop("failed");
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_RETRY_MS * 3);
    expect(resume.mock.calls.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS);
    expect(manager.current).toBeNull();

    const fresh = await manager.ensure("b");
    expect(manager.current).toBe(fresh);
    expect(manager.status).toBe("open");
    expect(transport.connect).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("recovers again from a second gap on the rebuilt transport", async () => {
    const seam = rebuild();
    const { manager, link, lost, drop } = await linked({ resume: seam.resume });

    drop("failed");
    await vi.waitFor(() => expect(manager.status).toBe("open"));
    // The replacement's own transport now dies. It is the current one, so this
    // is a new gap — and the retired transport's callbacks stay inert.
    seam.calls[0].onStateChange?.("failed");
    expect(manager.status).toBe("interrupted");
    drop("closed");
    expect(manager.status).toBe("interrupted");
    expect(lost).toEqual(["b", "b"]);

    await vi.waitFor(() => expect(manager.status).toBe("open"));
    expect(manager.current?.keys).toBe(link.keys);
    expect(seam.resume).toHaveBeenCalledTimes(2);
    manager.stop();
  });
});

// An explicit disconnect used to be indistinguishable from a network drop, so
// the peer held an unrecoverable link for the whole 90 s recovery window. This
// is the one signal that tells it apart — and the one signal that can therefore
// end another peer's session, which is why nearly all of this file is about what
// must NOT be honoured.
describe("mixed link explicit leave", () => {
  async function linked(
    over: Partial<PeerLinkDeps> = {},
    selfId = "a",
    peerId = "b",
  ) {
    const sig = signalingHarness();
    const transport = transportHarness();
    const events: { status: string; peerId: string | null }[] = [];
    const manager = createPeerLinkManager({
      selfId: () => selfId,
      signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: transport.connect,
      onLinkChange(link, status) { events.push({ status, peerId: link?.peerId ?? null }); },
      onTransportLost: () => true,
      ...over,
    });
    manager.listen();
    let link: MixedPeerLink;
    if (linkRole(selfId, peerId) === "initiator") link = await manager.ensure(peerId);
    else {
      const waiting = manager.ensure(peerId);
      sig.inject(peerId, { link: true, sdp: { type: "offer", sdp: "v=0" } });
      link = await waiting;
    }
    return {
      sig, transport, manager, link, events,
      drop: (state: "failed" | "closed" = "failed") =>
        transport.connect.mock.calls[0][0].onStateChange?.(state),
    };
  }

  /** Exactly what a departing peer puts on the wire. */
  async function leaveFrom(
    link: MixedPeerLink,
    from = "b",
    to = "a",
    key: CryptoKey = link.keys.resumeAuth,
  ): Promise<InboundSignal> {
    return { link: true, leave: true, auth: await signResume(key, linkLeavePayload(from, to)) };
  }

  /** Web Crypto resolves off the microtask queue, so a leave verification needs
   *  real task turns to settle — not just `await Promise.resolve()`. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  describe("shape", () => {
    it("accepts only the three-key content-free form", () => {
      const auth = "A".repeat(LINK_LEAVE_AUTH_LENGTH);
      expect(isLinkLeave({ link: true, leave: true, auth })).toBe(true);
      expect(isLinkLeave({ auth, leave: true, link: true })).toBe(true); // key order
    });

    it.each<[string, unknown]>([
      ["no auth", { link: true, leave: true }],
      ["numeric auth", { link: true, leave: true, auth: 1 }],
      ["null auth", { link: true, leave: true, auth: null }],
      ["object auth", { link: true, leave: true, auth: { mac: "m" } }],
      ["short auth", { link: true, leave: true, auth: "A".repeat(LINK_LEAVE_AUTH_LENGTH - 1) }],
      ["oversized auth", { link: true, leave: true, auth: "A".repeat(1 << 20) }],
      ["truthy but not true link", { link: 1, leave: true, auth: "m" }],
      ["truthy but not true leave", { link: true, leave: "yes", auth: "m" }],
      ["no link tag", { leave: true, auth: "m" }],
      ["not an object", "leave"],
      ["null", null],
    ])("rejects %s", (_name, data) => {
      expect(isLinkLeave(data)).toBe(false);
    });

    // Every one of these fields is acted on by a handler that shares the `link`
    // generation: sdp/ice are handled outright, commit is recorded by
    // connectLink's beforeSdp, caps reach onPeerCaps, busy fails a connecting
    // link, and the generation tags would re-route the message entirely.
    it.each([
      "sdp", "ice", "commit", "reveal", "caps", "busy", "linkRequest",
      "resume", "text", "rename",
    ])("rejects a leave smuggling %s", (field) => {
      expect(isLinkLeave({
        link: true, leave: true, auth: "A".repeat(LINK_LEAVE_AUTH_LENGTH), [field]: true,
      })).toBe(false);
    });
  });

  describe("announcing", () => {
    it("signs the departure with the link's resumeAuth and closes synchronously", async () => {
      const { manager, link, sig, events } = await linked();
      const before = sig.sent.length;

      manager.close({ announce: true });

      // Teardown does not wait for Web Crypto or for the socket.
      expect(manager.current).toBeNull();
      expect(manager.status).toBe("idle");
      expect(events).toEqual([
        { status: "open", peerId: "b" },
        { status: "idle", peerId: null },
      ]);
      expect(sig.sent).toHaveLength(before);

      await settle();
      const out = sig.sent.at(-1)!;
      expect(out.to).toBe("b");
      expect(Object.keys(out.data).sort()).toEqual(["auth", "leave", "link"]);
      expect(out.data.link).toBe(true);
      expect(out.data.leave).toBe(true);
      expect(await verifyResume(
        link.keys.resumeAuth, linkLeavePayload("a", "b"), out.data.auth,
      )).toBe(true);
      // Signed in this side's direction only: the peer verifies (from, to) as it
      // sees them, so this tag cannot be reflected back to end our own link.
      expect(await verifyResume(
        link.keys.resumeAuth, linkLeavePayload("b", "a"), out.data.auth,
      )).toBe(false);
      manager.stop();
    });

    it("announces a departure from a held link too", async () => {
      const seam = rebuild({ gate: new Promise<void>(() => {}) });
      const { manager, link, sig, drop } = await linked({ resume: seam.resume });
      drop("failed");
      expect(manager.status).toBe("interrupted");

      manager.close({ announce: true });
      await settle();

      const out = sig.sent.at(-1)!;
      expect(out.data.leave).toBe(true);
      expect(await verifyResume(
        link.keys.resumeAuth, linkLeavePayload("a", "b"), out.data.auth,
      )).toBe(true);
      expect(seam.calls[0].signal?.aborted).toBe(true);
      manager.stop();
    });

    it("still disconnects when the announcement itself cannot be made", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const sig = signalingHarness();
      const transport = transportHarness();
      let live = true;
      const manager = createPeerLinkManager({
        selfId: () => "a",
        signaling: () => {
          if (!live) throw new Error("signalling socket is gone");
          return sig.signaling;
        },
        rtcConfig: () => ({ iceServers: [] }),
        supportsLink: () => true,
        connect: transport.connect,
      });
      manager.listen();
      const link = await manager.ensure("b");
      live = false;

      manager.close({ announce: true });

      expect(manager.current).toBeNull();
      expect(manager.status).toBe("idle");
      expect(link.conn.close).toHaveBeenCalledOnce();
      errors.mockRestore();
    });

    it.each<[string, (m: ReturnType<typeof createPeerLinkManager>) => void]>([
      ["an ordinary close", (m) => m.close()],
      ["an explicit non-announcing close", (m) => m.close({ announce: false })],
      ["stop", (m) => m.stop()],
    ])("stays silent on %s", async (_name, act) => {
      const { manager, sig } = await linked();
      const before = sig.sent.length;
      act(manager);
      await settle();
      expect(sig.sent.slice(before)).toEqual([]);
      manager.stop();
    });
  });

  describe("honouring", () => {
    it("tears the link down on an authenticated leave and echoes nothing", async () => {
      const { manager, link, sig, events } = await linked();
      const before = sig.sent.length;

      sig.inject("b", await leaveFrom(link));
      await settle();

      expect(manager.current).toBeNull();
      expect(manager.status).toBe("idle");
      expect(link.conn.close).toHaveBeenCalledOnce();
      expect(events).toEqual([
        { status: "open", peerId: "b" },
        { status: "idle", peerId: null },
      ]);
      // Silence is the point: a reply would tell a relay which peer holds a link.
      expect(sig.sent.slice(before)).toEqual([]);
      manager.stop();
    });

    it("cancels a held link, its recovery driver and the rebuild in flight", async () => {
      const seam = rebuild({ gate: new Promise<void>(() => {}) });
      const { manager, link, sig, events, drop } = await linked({ resume: seam.resume });
      drop("failed");
      expect(manager.status).toBe("interrupted");
      // An intent raised mid-gap is waiting on the recovery promise.
      const joined = manager.ensure("b");
      const rejects = expect(joined).rejects.toThrow();

      sig.inject("b", await leaveFrom(link));
      await settle();

      expect(manager.current).toBeNull();
      expect(manager.status).toBe("idle");
      expect(seam.calls[0].signal?.aborted).toBe(true);
      await rejects;
      expect(events).toEqual([
        { status: "open", peerId: "b" },
        { status: "idle", peerId: null },
      ]);
      manager.stop();
    });

    it("leaves no timer or retry behind after an honoured leave", async () => {
      vi.useFakeTimers();
      const resume = vi.fn(async (): Promise<Conn> => { throw new Error("no route"); });
      const { manager, link, sig, events, drop } = await linked({ resume });
      drop("failed");
      // Wait on the observable boundary instead of advancing an arbitrary ten
      // fake milliseconds. The recovery call and the leave MAC both cross Web
      // Crypto, whose completion is scheduled outside the fake-timer queue;
      // a busy hosted worker can therefore need more real task turns even
      // though no product timer is late. `waitFor` advances fake timers while
      // yielding those turns and fails with the state that never arrived.
      await vi.waitFor(() => expect(resume).toHaveBeenCalled());
      const attempts = resume.mock.calls.length;

      sig.inject("b", await leaveFrom(link));
      await vi.waitFor(() => expect(manager.current).toBeNull());

      // Neither the 90 s window timer nor the 1.5 s retry driver survives, so
      // there is no second teardown and no rebuild toward a peer that has gone.
      await vi.advanceTimersByTimeAsync(LINK_RECOVERY_WINDOW_MS * 2);
      expect(events).toEqual([
        { status: "open", peerId: "b" },
        { status: "idle", peerId: null },
      ]);
      expect(resume.mock.calls.length).toBe(attempts);
      manager.stop();
      vi.useRealTimers();
    });

    // The correction that matters: a transport replacement publishes a DIFFERENT
    // link object carrying the SAME keys, SAS and codecs. That is one
    // authentication step, so a leave verified against those keys is still about
    // this link. Comparing the captured object would silently drop it.
    it("honours a leave for a link that has since moved to a replacement transport", async () => {
      const seam = rebuild();
      const { manager, link, sig, drop } = await linked({ resume: seam.resume });
      drop("failed");
      await vi.waitFor(() => expect(manager.status).toBe("open"));
      const replaced = manager.current!;
      expect(replaced).not.toBe(link);
      expect(replaced.keys).toBe(link.keys);

      sig.inject("b", await leaveFrom(link));
      await settle();

      expect(manager.current).toBeNull();
      expect(manager.status).toBe("idle");
      manager.stop();
    });

    // Same property, with the replacement landing while the MAC is in flight.
    // Deliberately asserted without pinning which side wins: both interleavings
    // must end in exactly one teardown and one closed transport.
    it("survives a replacement published while the leave is being verified", async () => {
      let release!: () => void;
      const seam = rebuild({ gate: new Promise<void>((resolve) => { release = resolve; }) });
      const { manager, link, sig, events, drop } = await linked({ resume: seam.resume });
      drop("failed");
      await settle();
      expect(seam.resume).toHaveBeenCalledTimes(1);

      sig.inject("b", await leaveFrom(link));
      release();
      await settle();

      expect(manager.current).toBeNull();
      expect(manager.status).toBe("idle");
      expect(events.filter((e) => e.status === "idle")).toHaveLength(1);
      expect(seam.conns[0].close).toHaveBeenCalled();
      manager.stop();
    });

    it("honours a duplicate leave exactly once", async () => {
      const { manager, link, sig, events } = await linked();
      const leave = await leaveFrom(link);

      sig.inject("b", leave);
      sig.inject("b", leave);
      await settle();
      sig.inject("b", leave);
      await settle();

      expect(manager.current).toBeNull();
      expect(events.filter((e) => e.status === "idle")).toHaveLength(1);
      expect(link.conn.close).toHaveBeenCalledOnce();
      manager.stop();
    });
  });

  describe("refusing", () => {
    /** Every rejection has the same visible outcome: nothing at all. */
    async function survives(
      make: (link: MixedPeerLink) => Promise<InboundSignal>,
      from = "b",
    ) {
      const { manager, link, sig, events } = await linked();
      const before = sig.sent.length;
      sig.inject(from, await make(link));
      await settle();
      expect(manager.current).toBe(link);
      expect(manager.status).toBe("open");
      expect(events).toEqual([{ status: "open", peerId: "b" }]);
      expect(sig.sent.slice(before)).toEqual([]);
      manager.stop();
    }

    it("drops a leave with no tag", async () => {
      await survives(async () => ({ link: true, leave: true }));
    });

    it("drops a leave with a non-string tag", async () => {
      await survives(async () => ({ link: true, leave: true, auth: 7 } as unknown as InboundSignal));
    });

    it("drops a malformed tag", async () => {
      await survives(async () => ({ link: true, leave: true, auth: "!!! not base64 !!!" }));
    });

    it("drops a tag from another session's keys", async () => {
      const attacker = generateKeyPair();
      const victim = generateKeyPair();
      const foreign = await deriveSession("initiator", attacker, victim.publicKey);
      await survives((link) => leaveFrom(link, "b", "a", foreign.resumeAuth));
    });

    // The reason linkLeavePayload exists: a tag over the resume payload — the
    // one every rebuild signal already carries — must not end a link.
    it("drops a tag computed over the resume payload instead of the leave payload", async () => {
      await survives(async (link) => ({
        link: true,
        leave: true,
        auth: await signResume(link.keys.resumeAuth, authPayload({ link: true, leave: true })),
      }));
    });

    // Both sides hold the same resumeAuth, so direction is the only thing that
    // stops a relay from reflecting our own departure back at us.
    it("drops our own leave reflected back at us", async () => {
      await survives((link) => leaveFrom(link, "a", "b"));
    });

    it("drops a leave from a peer that is not the link's", async () => {
      await survives((link) => leaveFrom(link, "z", "a"), "z");
    });

    it("drops a leave replayed onto a fresh link to the same peer", async () => {
      const { manager, link, sig } = await linked();
      const stale = await leaveFrom(link);

      manager.close();
      const fresh = await manager.ensure("b");
      expect(fresh.keys).not.toBe(link.keys);

      sig.inject("b", stale);
      await settle();

      expect(manager.current).toBe(fresh);
      expect(manager.status).toBe("open");
      manager.stop();
    });

    it("does not apply an old link's in-flight verification to a fresh link", async () => {
      const { manager, link, sig } = await linked();
      const stale = await leaveFrom(link);
      let release!: (ok: boolean) => void;
      const held = new Promise<boolean>((resolve) => { release = resolve; });
      const verify = vi.spyOn(crypto.subtle, "verify").mockReturnValue(held);

      try {
        // handleLeave reaches the held Web Crypto operation synchronously. The
        // old link then ends and a new authenticated link to the same peer is
        // fully published before that old result is allowed to continue.
        sig.inject("b", stale);
        expect(verify).toHaveBeenCalledOnce();
        manager.close();
        const fresh = await manager.ensure("b");
        expect(fresh.keys).not.toBe(link.keys);

        release(true);
        await settle();

        expect(manager.current).toBe(fresh);
        expect(manager.status).toBe("open");
      } finally {
        verify.mockRestore();
        manager.stop();
      }
    });

    it("drops a leave once the link is already gone", async () => {
      const { manager, link, sig, events } = await linked();
      const leave = await leaveFrom(link);
      manager.close();

      sig.inject("b", leave);
      await settle();

      expect(manager.current).toBeNull();
      expect(events.filter((e) => e.status === "idle")).toHaveLength(1);
      manager.stop();
    });

    it("spends one HMAC on a whole burst, not one per message", async () => {
      const { manager, link, sig } = await linked();
      const bad: InboundSignal = {
        link: true, leave: true, auth: "A".repeat(LINK_LEAVE_AUTH_LENGTH),
      };

      for (let i = 0; i < 200; i++) sig.inject("b", bad);
      await settle();
      expect(manager.current).toBe(link);

      // Only the first message of the burst held the verification slot, so the
      // budget still has room for the genuine departure behind it.
      sig.inject("b", await leaveFrom(link));
      await settle();
      expect(manager.current).toBeNull();
      manager.stop();
    });

    it("stops verifying after a bounded number of attempts", async () => {
      const { manager, link, sig } = await linked();
      const bad: InboundSignal = {
        link: true, leave: true, auth: "A".repeat(LINK_LEAVE_AUTH_LENGTH),
      };

      for (let i = 0; i < LINK_LEAVE_MAX_ATTEMPTS; i++) {
        sig.inject("b", bad);
        await settle();
      }
      expect(manager.current).toBe(link);

      // The budget is spent for this link's lifetime. A genuine departure is now
      // ignored too — and degrades to exactly the recovery window that existed
      // before this signal, which is the whole reason the budget is safe.
      sig.inject("b", await leaveFrom(link));
      await settle();
      expect(manager.current).toBe(link);
      manager.stop();
    });

    it("gives a new link to the same peer a fresh attempt budget", async () => {
      const { manager, link, sig } = await linked();
      const bad: InboundSignal = {
        link: true, leave: true, auth: "A".repeat(LINK_LEAVE_AUTH_LENGTH),
      };
      for (let i = 0; i < LINK_LEAVE_MAX_ATTEMPTS; i++) {
        sig.inject("b", bad);
        await settle();
      }
      manager.close();

      const fresh = await manager.ensure("b");
      sig.inject("b", await leaveFrom(fresh));
      await settle();

      expect(manager.current).toBeNull();
      manager.stop();
    });

    // A transport replacement is the same authentication step, so it must NOT
    // hand a flooding peer a fresh budget.
    it("does not refresh the budget on a transport replacement", async () => {
      const seam = rebuild();
      const { manager, link, sig, drop } = await linked({ resume: seam.resume });
      const bad: InboundSignal = {
        link: true, leave: true, auth: "A".repeat(LINK_LEAVE_AUTH_LENGTH),
      };
      for (let i = 0; i < LINK_LEAVE_MAX_ATTEMPTS; i++) {
        sig.inject("b", bad);
        await settle();
      }

      drop("failed");
      await vi.waitFor(() => expect(manager.status).toBe("open"));
      expect(manager.current).not.toBe(link);

      sig.inject("b", await leaveFrom(link));
      await settle();
      expect(manager.current).not.toBeNull();
      manager.stop();
    });
  });
});

describe("the relay gate", () => {
  /** A gate a test opens by hand. Mirrors what `createRelaySelection` exposes,
   *  including `notePeer` never opening it — the real one only ever arms a
   *  bounded grace there. */
  function manualGate() {
    let open = false;
    let waiters: Array<() => void> = [];
    const noted: string[] = [];
    return {
      noted,
      gate: {
        ready: () => open,
        notePeer(peerId: string) { noted.push(peerId); },
        whenReady(cb: () => void) { if (open) cb(); else waiters.push(cb); },
      },
      /** How many callbacks are parked behind the gate right now. */
      get parked() { return waiters.length; },
      release() {
        open = true;
        const parked = waiters;
        waiters = [];
        for (const cb of parked) cb();
      },
    };
  }

  /**
   * A transport seam that behaves like the real one in the ONE way this feature
   * depends on: it registers its inbound handler on the signaling client it was
   * handed, synchronously, and then chains its initial signal behind it.
   */
  function recordingTransport() {
    const seen: { from: string; data: unknown }[] = [];
    const configs: unknown[] = [];
    const conns: Conn[] = [];
    const connect = vi.fn(async (opts: Parameters<typeof connectLink>[0]): Promise<Conn> => {
      configs.push(opts.config);
      opts.signaling.onSignal((from, data) => { seen.push({ from, data }); });
      if (opts.initialSignal) seen.push({ from: opts.peerId, data: opts.initialSignal });
      const peer = generateKeyPair();
      opts.onPeerKey(peer.publicKey);
      const file = { label: "relayium", readyState: "open" } as RTCDataChannel;
      const text = { label: "relayium-text", readyState: "open" } as RTCDataChannel;
      const conn: Conn = {
        channel: file,
        getChannel: (l) => l === "relayium" ? file : l === "relayium-text" ? text : undefined,
        close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "relay",
        stats: async () => new Map() as unknown as RTCStatsReport,
      };
      conns.push(conn);
      return conn;
    });
    return { connect, seen, configs, conns };
  }

  const offer: InboundSignal = { link: true, sdp: { type: "offer", sdp: "v=0" } } as InboundSignal;
  const candidate = (n: number): InboundSignal =>
    ({ link: true, ice: { candidate: `candidate:${n}` } }) as unknown as InboundSignal;

  /**
   * **The outbound half.** A request or an offer is the first thing that
   * commits this page to a relay, and its own thirty-second timeout starts with
   * it. Neither may go out before the room has agreed which relay to use.
   */
  it("holds the outbound request behind the gate, and sends it on release", async () => {
    vi.useFakeTimers();
    const sig = signalingHarness();
    const transport = transportHarness();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);

    const pending = manager.ensure("a"); // "z" > "a" → this side requests
    void pending.catch(() => {});
    await tick();
    expect(sig.sent).toEqual([]);
    expect(manager.status).toBe("requesting");
    expect(manager.boundPeerId).toBe("a");

    // The request timeout must not have been running while the gate was shut.
    await vi.advanceTimersByTimeAsync(LINK_REQUEST_TIMEOUT_MS + 1_000);
    expect(sig.sent).toEqual([]);

    g.release();
    await tick();
    expect(sig.sent).toEqual([{ to: "a", data: { linkRequest: true, link: true } }]);
    manager.stop();
    vi.useRealTimers();
  });

  it("joins a second intent for the same peer and refuses a different one while gated", async () => {
    const sig = signalingHarness();
    const transport = transportHarness();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);

    const first = manager.ensure("a");
    const same = manager.ensure("a");
    expect(same).toBe(first);
    await expect(manager.ensure("b")).rejects.toBeInstanceOf(LinkBusyError);
    void first.catch(() => {});
    manager.stop();
    await expect(first).rejects.toThrow();
  });

  /**
   * **The inbound half, and the one that could lose something.**
   *
   * `connectLink` installs this peer's signal handler synchronously; an `await`
   * in front of it would put a window exactly where the peer is trickling the
   * relay candidates a cross-network link cannot connect without. So the offer
   * and everything chasing it are HELD, and replayed into the transport's own
   * handler in arrival order once the gate opens.
   */
  it("holds an inbound offer and replays the frames that chased it, in order", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [{ urls: ["turn:chosen.example:3478"] }] }),
      supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    sig.inject("a", offer);
    for (let i = 0; i < 3; i++) sig.inject("a", candidate(i));
    await tick();
    expect(transport.connect).not.toHaveBeenCalled();

    g.release();
    await tick();
    await tick();

    expect(transport.connect).toHaveBeenCalledTimes(1);
    // The configuration was snapshotted AFTER the gate opened — the whole point.
    expect(transport.configs).toEqual([{ iceServers: [{ urls: ["turn:chosen.example:3478"] }] }]);
    expect(transport.seen.map((f) => f.data)).toEqual([
      offer, candidate(0), candidate(1), candidate(2),
    ]);
    manager.stop();
  });

  /** Fail closed, never truncate: a link built from a prefix of its own
   *  candidates is not the establishment the peer is making, and a silent
   *  truncation is indistinguishable from a connection that simply hangs. */
  it("abandons a held offer that is flooded, and says so", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    sig.inject("a", offer);
    for (let i = 0; i <= LINK_HELD_SIGNAL_MAX; i++) sig.inject("a", candidate(i));
    await tick();
    expect(sig.sent).toEqual([{ to: "a", data: { busy: true, link: true } }]);

    g.release();
    await tick();
    expect(transport.connect).not.toHaveBeenCalled();
    manager.stop();
  });

  /** A held offer binds this manager as firmly as an in-flight establishment,
   *  and the checks that answer `busy` cannot see it. Silence here would leave
   *  the second peer waiting out its own request timeout. */
  it("tells a second peer the room is taken while an offer is held", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    sig.inject("a", offer);
    expect(manager.boundPeerId).toBe("a");
    expect(manager.status).toBe("connecting");

    sig.inject("b", offer);
    expect(sig.sent).toEqual([{ to: "b", data: { busy: true, link: true } }]);
    // The SAME peer sending twice is a duplicate, not a second claim: the
    // establishment is built from the first offer.
    sig.inject("a", offer);
    expect(sig.sent).toHaveLength(1);

    g.release();
    await tick();
    expect(transport.connect).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  /** A departure while the offer waits must cancel it, or the gate would open
   *  onto an establishment with somebody who has left the room. */
  it("lets a departure cancel a held offer through boundPeerId", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    sig.inject("a", offer);
    expect(manager.boundPeerId).toBe("a");
    // What the workspace does when the server confirms this peer left.
    manager.close();
    expect(manager.boundPeerId).toBe("");
    expect(manager.status).toBe("idle");

    g.release();
    await tick();
    expect(transport.connect).not.toHaveBeenCalled();
    manager.stop();
  });

  it("changes nothing at all when no gate is installed", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.listen();

    sig.inject("a", offer);
    await tick();
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.seen.map((f) => f.data)).toEqual([offer]);
    manager.stop();
  });

  it("drops a held offer when the manager is closed under it", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "z", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    sig.inject("a", offer);
    await tick();
    manager.close();
    g.release();
    await tick();
    expect(transport.connect).not.toHaveBeenCalled();
    manager.stop();
  });

  /**
   * **The retry that turned one gated request into several waiters.**
   *
   * The peer re-sends `linkRequest` every `LINK_REQUEST_RETRY_MS` until it gets
   * an offer, so a gate held for a few seconds sees the SAME request two or
   * three times. Registering a waiter per arrival meant that on release the
   * first one started `establish` and every later one then observed `opening`
   * and answered `busy` — to the peer it had just begun building a link with.
   * That `busy` reaches the peer before the offer does and fails its request.
   */
  it("coalesces a peer's gated request retries into one waiter and one establishment", async () => {
    vi.useFakeTimers();
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    // "a" < "z", so this side is the INITIATOR and the peer is the one that asks.
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [{ urls: ["turn:chosen.example:3478"] }] }),
      supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    const request: InboundSignal = { link: true, linkRequest: true } as InboundSignal;
    sig.inject("z", request);
    expect(g.parked).toBe(1);
    expect(manager.boundPeerId).toBe("z");
    // Two more retries land while the room is still agreeing on a relay.
    await vi.advanceTimersByTimeAsync(LINK_REQUEST_RETRY_MS + 1);
    sig.inject("z", request);
    await vi.advanceTimersByTimeAsync(LINK_REQUEST_RETRY_MS + 1);
    sig.inject("z", request);

    // One waiter, and — the part that broke the peer's request — not one word
    // back to it while it waits.
    expect(g.parked).toBe(1);
    expect(sig.sent).toEqual([]);
    expect(transport.connect).not.toHaveBeenCalled();
    expect(g.noted).toEqual(["z", "z", "z"]);

    g.release();
    await vi.advanceTimersByTimeAsync(0);

    // Exactly one settlement: one establishment, built after the gate opened and
    // therefore on the agreed configuration, and no `busy` to the peer it is
    // being built with.
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.configs).toEqual([{ iceServers: [{ urls: ["turn:chosen.example:3478"] }] }]);
    expect(sig.sent.filter((s) => s.to === "z" && s.data.busy === true)).toEqual([]);
    expect(manager.status).not.toBe("idle");

    // A retry that arrives AFTER the establishment is the ordinary duplicate the
    // pre-gate code already answered, and it is still answered.
    sig.inject("z", request);
    expect(sig.sent.filter((s) => s.data.busy === true))
      .toEqual([{ to: "z", data: { busy: true, link: true } }]);

    manager.stop();
    vi.useRealTimers();
  });

  it("still tells a genuinely different peer the room is taken while a request is gated", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    const request: InboundSignal = { link: true, linkRequest: true } as InboundSignal;
    sig.inject("z", request);
    sig.inject("y", request);
    // The second peer, unlike the first peer's retry, is told at once rather
    // than left to wait out its own thirty-second timeout.
    expect(sig.sent).toEqual([{ to: "y", data: { busy: true, link: true } }]);
    expect(g.parked).toBe(1);

    // And an offer from a third peer, which binds this manager the same way.
    // "B" < "a", so this side is that peer's RESPONDER and its offer is legal.
    sig.inject("B", offer);
    expect(sig.sent).toEqual([
      { to: "y", data: { busy: true, link: true } },
      { to: "B", data: { busy: true, link: true } },
    ]);

    g.release();
    await tick();
    expect(transport.connect).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("retires a gated request when its peer leaves and the manager is closed", async () => {
    const sig = signalingHarness();
    const transport = recordingTransport();
    const g = manualGate();
    const manager = createPeerLinkManager({
      selfId: () => "a", signaling: () => sig.signaling,
      rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
      connect: transport.connect,
    });
    manager.setRelayGate(g.gate);
    manager.listen();

    sig.inject("z", { link: true, linkRequest: true } as InboundSignal);
    expect(manager.boundPeerId).toBe("z");
    // What the workspace does when the server confirms this peer left.
    manager.close();
    expect(manager.boundPeerId).toBe("");

    g.release();
    await tick();
    expect(transport.connect).not.toHaveBeenCalled();
    expect(sig.sent).toEqual([]);
    manager.stop();
  });

  /**
   * **A roster that no longer names a peer.**
   *
   * Weaker evidence than the `left` frame above — it is not a confirmed physical
   * departure — so it reaches strictly less: only the phases a gate is holding,
   * which have no transport under them and exist solely because that peer was
   * expected to answer. Releasing one later would put this side's first legal
   * `link/1` frame on the wire addressed to somebody who has gone.
   */
  describe("and a roster that stops naming the peer it is holding for", () => {
    it("settles a gated ensure rather than leaving its caller on a promise nothing will keep", async () => {
      const sig = signalingHarness();
      const transport = transportHarness();
      const g = manualGate();
      const manager = createPeerLinkManager({
        selfId: () => "z", signaling: () => sig.signaling,
        rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
        connect: transport.connect,
      });
      manager.setRelayGate(g.gate);

      const pending = manager.ensure("a");
      await tick();
      expect(manager.status).toBe("requesting");
      expect(manager.boundPeerId).toBe("a");

      manager.rosterPeerGone("a");
      await expect(pending).rejects.toThrow(/link closed/);
      expect(manager.boundPeerId).toBe("");
      // `requesting` was published on behalf of the intent just retired. Left
      // standing it is a status the user can neither act on nor get out of.
      expect(manager.status).toBe("idle");

      // And the release, when it comes, belongs to nothing.
      g.release();
      await tick();
      expect(sig.sent).toEqual([]);
      expect(transport.connect).not.toHaveBeenCalled();
      manager.stop();
    });

    it("retires a parked inbound request, so the release cannot answer a peer that has gone", async () => {
      const sig = signalingHarness();
      const transport = recordingTransport();
      const g = manualGate();
      const manager = createPeerLinkManager({
        selfId: () => "a", signaling: () => sig.signaling,
        rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
        connect: transport.connect,
      });
      manager.setRelayGate(g.gate);
      manager.listen();

      sig.inject("z", { link: true, linkRequest: true } as InboundSignal);
      expect(manager.boundPeerId).toBe("z");
      expect(g.parked).toBe(1);

      manager.rosterPeerGone("z");
      expect(manager.boundPeerId).toBe("");

      // The waiter is still parked — nothing cancels a gate callback — and that
      // is fine precisely because it re-reads the phase it belongs to.
      g.release();
      await tick();
      expect(transport.connect).not.toHaveBeenCalled();
      expect(sig.sent).toEqual([]);
      manager.stop();
    });

    it("drops a held offer and stops claiming to be connecting on its behalf", async () => {
      const sig = signalingHarness();
      const transport = recordingTransport();
      const g = manualGate();
      const manager = createPeerLinkManager({
        selfId: () => "z", signaling: () => sig.signaling,
        rtcConfig: () => ({ iceServers: [{ urls: ["turn:chosen.example:3478"] }] }),
        supportsLink: () => true,
        connect: transport.connect,
      });
      manager.setRelayGate(g.gate);
      manager.listen();

      sig.inject("a", offer);
      sig.inject("a", candidate(0));
      expect(manager.status).toBe("connecting");
      expect(manager.boundPeerId).toBe("a");

      manager.rosterPeerGone("a");
      expect(manager.status).toBe("idle");
      expect(manager.boundPeerId).toBe("");

      g.release();
      await tick();
      await tick();
      expect(transport.connect).not.toHaveBeenCalled();
      manager.stop();
    });

    it("touches a peer it is not holding anything for, and repeats, and neither does anything", async () => {
      const sig = signalingHarness();
      const transport = transportHarness();
      const g = manualGate();
      const manager = createPeerLinkManager({
        selfId: () => "z", signaling: () => sig.signaling,
        rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
        connect: transport.connect,
      });
      manager.setRelayGate(g.gate);

      const pending = manager.ensure("a");
      await tick();
      manager.rosterPeerGone("b"); // somebody else entirely
      expect(manager.status).toBe("requesting");
      expect(manager.boundPeerId).toBe("a");

      // A `left` frame and the roster that drops the same peer both arrive for
      // an ordinary disconnect, in either order, so this has to be idempotent.
      manager.rosterPeerGone("a");
      manager.rosterPeerGone("a");
      await expect(pending).rejects.toThrow(/link closed/);
      expect(manager.status).toBe("idle");
      manager.stop();
    });

    /**
     * The line this must not cross. `PeerWorkspace.peerLeft` is the confirmed
     * physical departure and owns everything with a transport under it; a roster
     * is not that frame, and an established link's DataChannel is a separate
     * transport that a roster change says nothing about.
     */
    it("leaves an established link exactly as it is", async () => {
      const sig = signalingHarness();
      const transport = transportHarness();
      const g = manualGate();
      const manager = createPeerLinkManager({
        selfId: () => "z", signaling: () => sig.signaling,
        rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
        connect: transport.connect,
      });
      manager.setRelayGate(g.gate);
      manager.listen();
      g.release(); // the room agreed its relay; nothing is gated any more

      sig.inject("a", offer); // "a" < "z" → this side responds
      await tick();
      const link = await manager.ensure("a");
      expect(manager.status).toBe("open");

      manager.rosterPeerGone("a");
      expect(manager.status).toBe("open");
      expect(manager.current).toBe(link);
      expect(manager.boundPeerId).toBe("a");
      expect(link.conn.close).not.toHaveBeenCalled();
      manager.stop();
    });

    it("leaves an outstanding request alone, because that one is already on the wire", async () => {
      vi.useFakeTimers();
      const sig = signalingHarness();
      const transport = transportHarness();
      const g = manualGate();
      const manager = createPeerLinkManager({
        selfId: () => "z", signaling: () => sig.signaling,
        rtcConfig: () => ({ iceServers: [] }), supportsLink: () => true,
        connect: transport.connect,
      });
      manager.setRelayGate(g.gate);
      g.release();

      const pending = manager.ensure("a"); // "z" > "a" → this side requests
      void pending.catch(() => {});
      await tick();
      expect(sig.sent).toEqual([{ to: "a", data: { linkRequest: true, link: true } }]);

      // Past the gate, and therefore not this call's to cancel: the ask has been
      // sent, it carries its own thirty-second timeout, and a confirmed
      // departure (`PeerWorkspace.peerLeft`) or a roster the workspace itself
      // diffs (`syncPeers`) is what ends it.
      manager.rosterPeerGone("a");
      expect(manager.status).toBe("requesting");
      expect(manager.boundPeerId).toBe("a");
      expect(manager.requestedPeerId).toBe("a");

      await vi.advanceTimersByTimeAsync(LINK_REQUEST_TIMEOUT_MS + 1_000);
      await expect(pending).rejects.toBeInstanceOf(LinkRequestTimeoutError);
      manager.stop();
      vi.useRealTimers();
    });
  });
});
