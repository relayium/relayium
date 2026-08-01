import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, ready } from "./crypto";
import { createMixedSession } from "./mixed-session.svelte";
import { TEXT_REQUEST } from "./text-wire";
import type { SignalingClient } from "./signaling";
import type { Conn, InboundSignal } from "./webrtc";
import type { ConnectOpts } from "./webrtc";

beforeAll(async () => { await ready(); });
afterEach(() => { vi.useRealTimers(); });

function channel(label: string) {
  return {
    label,
    readyState: "open",
    binaryType: "blob",
    bufferedAmount: 0,
    onmessage: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as RTCDataChannel;
}

function harness(
  path: "lan" | "p2p" | "relay" | "unknown" | (() => "lan" | "p2p" | "relay" | "unknown") = "lan",
  beforePeerKey?: (file: RTCDataChannel, text: RTCDataChannel) => void,
) {
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
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      close: vi.fn(),
      path: async () => typeof path === "function" ? path() : path,
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    conns.push(conn);
    if (beforePeerKey) {
      setTimeout(() => {
        beforePeerKey(file, text);
        opts.onPeerKey(generateKeyPair().publicKey);
      }, 0);
    } else opts.onPeerKey(generateKeyPair().publicKey);
    return conn;
  });
  return {
    signaling, sent, conns, connect,
    inject(from: string, data: InboundSignal) {
      for (const listener of [...listeners]) listener(from, data);
    },
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("mixed session coordinator", () => {
  it("attaches both lanes to the exact link before establishment resolves", async () => {
    const h = harness("relay");
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
    });

    const link = await mixed.ensure("b");
    expect(mixed.link).toBe(link);
    expect(mixed.file.link).toBe(link);
    expect(mixed.text.link).toBe(link);
    expect(link.fileChannel.onmessage).toBeTypeOf("function");
    expect(link.textChannel.onmessage).toBeTypeOf("function");
    await flush();
    expect(mixed.path).toBe("relay");
    mixed.stop();
  });

  it("attaches lanes for a remotely requested link without a local ensure call", async () => {
    const h = harness();
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      canAcceptLink: () => true,
      connect: h.connect,
    });
    mixed.start();

    h.inject("z", { link: true, linkRequest: true });
    await vi.waitFor(() => expect(mixed.link?.peerId).toBe("z"));
    expect(mixed.file.link).toBe(mixed.link);
    expect(mixed.text.link).toBe(mixed.link);
    expect(mixed.link?.fileChannel.onmessage).toBeTypeOf("function");
    expect(mixed.link?.textChannel.onmessage).toBeTypeOf("function");
    mixed.stop();
  });

  it("replays a text request captured before lane attachment", async () => {
    const h = harness("lan", (_file, text) => {
      text.onmessage?.({ data: TEXT_REQUEST.buffer.slice(0) } as MessageEvent);
    });
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
    });

    await mixed.ensure("b");
    expect(mixed.text.status).toBe("incomingRequest");
    expect(mixed.text.link).toBe(mixed.link);
    mixed.stop();
  });

  it("fails quickly instead of replaying into a declined lane capture sink", async () => {
    const h = harness("lan", (_file, text) => {
      text.onmessage?.({ data: TEXT_REQUEST.buffer.slice(0) } as MessageEvent);
      Object.defineProperty(text, "readyState", { value: "closed", configurable: true });
    });
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
    });

    const started = performance.now();
    await expect(mixed.ensure("b")).rejects.toThrow("mixed lane attachment failed");
    expect(performance.now() - started).toBeLessThan(250);
    expect(mixed.link).toBeNull();
    expect(mixed.text.status).toBe("failed");
  });

  it("polls an initially unknown ICE path and stops once it settles", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = harness(() => ++calls < 3 ? "unknown" : "p2p");
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
    });
    await mixed.ensure("b");
    expect(mixed.path).toBeNull();
    await vi.advanceTimersByTimeAsync(800);
    expect(mixed.path).toBe("p2p");
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(3);
    mixed.stop();
  });

  it("keeps pending consent alive, then closes only after a full idle lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness();
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
      idleMs: 1_000,
    });
    const link = await mixed.ensure("b");
    link.textChannel.onmessage?.({ data: TEXT_REQUEST.buffer.slice(0) } as MessageEvent);
    expect(mixed.text.status).toBe("incomingRequest");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(mixed.link).toBe(link);
    expect(h.conns[0].close).not.toHaveBeenCalled();

    mixed.text.reject();
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(mixed.link).toBe(link);
    await vi.advanceTimersByTimeAsync(1);
    expect(mixed.link).toBeNull();
    expect(h.conns[0].close).toHaveBeenCalledOnce();
    mixed.stop();
  });

  it("explicit disconnect detaches both lanes before closing their shared transport", async () => {
    const h = harness();
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
    });
    const link = await mixed.ensure("b");
    mixed.disconnect();
    expect(mixed.link).toBeNull();
    expect(mixed.file.link).toBeNull();
    expect(mixed.text.link).toBeNull();
    expect(link.fileChannel.onmessage).toBeNull();
    expect(link.textChannel.onmessage).toBeNull();
    expect(h.conns[0].close).toHaveBeenCalledOnce();
  });
});
