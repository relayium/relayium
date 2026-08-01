import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, ready } from "./crypto";
import {
  LINK_AUTH_TIMEOUT_MS, LINK_REQUEST_RETRY_MS, LINK_REQUEST_TIMEOUT_MS,
  LinkAuthenticationTimeoutError, LinkBusyError, LinkRequestTimeoutError,
  UnsupportedLinkError, createPeerLinkManager,
  isLinkOffer, isLinkRequest, linkRole,
} from "./peer-link.svelte";
import { connectLink, type Conn, type InboundSignal } from "./webrtc";
import type { SignalingClient } from "./signaling";

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
      path: async () => "lan",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    conns.push(conn);
    return conn;
  });
  return { connect, conns };
}

const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("mixed peer link ownership", () => {
  it("assigns the smaller peer id as the only offerer", () => {
    expect(linkRole("a", "b")).toBe("initiator");
    expect(linkRole("b", "a")).toBe("responder");
  });

  it("recognises only exact content-free link requests and fresh link offers", () => {
    expect(isLinkRequest({ linkRequest: true })).toBe(true);
    expect(isLinkRequest({ linkRequest: true, sdp: { type: "offer" } })).toBe(false);
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
    expect(sig.sent).toEqual([{ to: "a", data: { linkRequest: true } }]);
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
    sig.inject("z", { linkRequest: true });
    sig.inject("z", { linkRequest: true });
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
    sig.inject("z", { linkRequest: true });
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
    sig.inject("z", { linkRequest: true });
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
      close: vi.fn(), path: async () => "lan",
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
        close: vi.fn(), path: async () => "lan",
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
        close: vi.fn(), path: async () => "lan",
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
    sig.inject("z", { linkRequest: true });
    await tick();
    expect(transport.connect).toHaveBeenCalledTimes(1);
    manager.stop();
  });
});
