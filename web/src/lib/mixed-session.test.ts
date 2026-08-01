import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, ready } from "./crypto";
import { createMixedSession, type MixedSessionDeps } from "./mixed-session.svelte";
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

  // The coordinator side of an authenticated transport rebuild. Nothing triggers
  // one yet; what is pinned here is that when the manager publishes a
  // replacement, both lanes own it before a single captured frame is replayed.
  it("re-attaches both lanes to a replaced transport before replaying its capture", async () => {
    const h = harness();
    const file = channel("relayium");
    const text = channel("relayium-text");
    const captured: Record<string, ArrayBuffer[]> = {
      relayium: [],
      "relayium-text": [TEXT_REQUEST.buffer.slice(0)],
    };
    const rebuilt: Conn = {
      channel: file,
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      takeCaptured: (label) => ({ frames: captured[label].splice(0), overflow: false }),
      close: vi.fn(),
      path: async () => "p2p",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    const resume = vi.fn(async () => rebuilt);
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
      resume,
    });

    const link = await mixed.ensure("b");
    const generation = mixed.linkGeneration;
    const next = await mixed.manager.replaceTransport("b");

    expect(mixed.link).toBe(next);
    expect(mixed.file.link).toBe(next);
    expect(mixed.text.link).toBe(next);
    // One link, one SAS, one set of codecs — across the transport gap.
    expect(next.keys).toBe(link.keys);
    expect(next.sas).toBe(link.sas);
    expect(mixed.sasCode).toBe(link.sas);
    expect(next.fileSender).toBe(link.fileSender);
    expect(next.fileReceiver).toBe(link.fileReceiver);
    expect(next.textSender).toBe(link.textSender);
    expect(next.textReceiver).toBe(link.textReceiver);
    // The new lanes are owned and the retired ones are silent.
    expect(next.fileChannel.onmessage).toBeTypeOf("function");
    expect(next.textChannel.onmessage).toBeTypeOf("function");
    expect(link.fileChannel.onmessage).toBeNull();
    expect(link.textChannel.onmessage).toBeNull();
    // The frame the peer sent on the rebuilt text lane before this side could
    // attach was not lost, and it reached the lane, not the capture sink.
    expect(mixed.text.status).toBe("incomingRequest");
    expect(mixed.linkGeneration).toBeGreaterThan(generation);
    expect(h.conns[0].close).toHaveBeenCalledOnce();
    await flush();
    expect(mixed.path).toBe("p2p");
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

// The coordinator owns exactly one recovery decision: is this dropped transport
// worth holding a link for? Everything here is about making that decision
// independent of the order in which the browser reports the drop.
describe("mixed session transport recovery", () => {
  /** A replacement transport with fresh channels, shaped like connectResumeLink's. */
  function rebuiltTransport() {
    const file = channel("relayium");
    const text = channel("relayium-text");
    const conn: Conn = {
      channel: file,
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      close: vi.fn(),
      path: async () => "p2p",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
    return { conn, file, text };
  }

  function session(opts: { resume?: MixedSessionDeps["resume"] } = {}) {
    const h = harness();
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
      resume: opts.resume,
    });
    return {
      h, mixed,
      drop: (state: "failed" | "closed" = "failed") =>
        h.connect.mock.calls[0][0].onStateChange?.(state),
    };
  }

  /** A rebuild seam that never resolves, so the held state can be observed. */
  const stalledResume = () =>
    vi.fn((_opts: { signal?: AbortSignal }) => new Promise<Conn>(() => {}));

  const picked = (name: string, body: string) => [{ file: new File([body], name) }];

  async function inFlightBatch(mixed: ReturnType<typeof createMixedSession>) {
    mixed.file.enqueue("b", picked("held.txt", "payload"));
    await vi.waitFor(() => expect(mixed.file.send?.status).toBe("waitingAccept"));
  }

  it.each([
    ["the data channels close first", "channel" as const],
    ["the peer connection goes terminal first", "pc" as const],
  ])("holds a link with lane work in flight when %s", async (_name, order) => {
    const { h, mixed, drop } = session({ resume: stalledResume() });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    const generation = mixed.linkGeneration;

    // RTCDataChannel.onclose may run a lane's own suspend before the
    // RTCPeerConnection reaches a terminal state. After that suspend the lane's
    // public active() already reads terminal, so a coordinator that sampled it
    // there would tear down a link that was mid-transfer.
    if (order === "channel") {
      link.fileChannel.onclose?.(new Event("close"));
      link.textChannel.onclose?.(new Event("close"));
    }
    drop("failed");
    if (order === "pc") {
      link.fileChannel.onclose?.(new Event("close"));
      link.textChannel.onclose?.(new Event("close"));
    }

    expect(mixed.status).toBe("interrupted");
    expect(mixed.link).toBe(link);
    expect(mixed.sasCode).toBe(link.sas);
    // Same authentication step: nothing re-announces the SAS while held.
    expect(mixed.linkGeneration).toBe(generation);
    // The interrupted batch fails visibly rather than hanging.
    expect(mixed.file.send?.status).toBe("sendFail");
    expect(mixed.file.send?.done).toBe(true);
    expect(h.conns[0].close).toHaveBeenCalled();
    mixed.stop();
  });

  it.each([
    ["the data channels close first", "channel" as const],
    ["the peer connection goes terminal first", "pc" as const],
  ])("still tears an idle link down when %s", async (_name, order) => {
    const { h, mixed, drop } = session({ resume: stalledResume() });
    const link = await mixed.ensure("b");

    if (order === "channel") {
      link.fileChannel.onclose?.(new Event("close"));
      link.textChannel.onclose?.(new Event("close"));
    }
    drop("failed");
    if (order === "pc") {
      link.fileChannel.onclose?.(new Event("close"));
      link.textChannel.onclose?.(new Event("close"));
    }

    expect(mixed.status).toBe("failed");
    expect(mixed.link).toBeNull();
    expect(mixed.file.link).toBeNull();
    expect(mixed.text.link).toBeNull();
    expect(mixed.path).toBeNull();
    expect(h.conns[0].close).toHaveBeenCalledOnce();
    mixed.stop();
  });

  it("holds a link whose only work is a queued file batch", async () => {
    const { mixed, drop } = session({ resume: stalledResume() });
    await mixed.ensure("b");
    await inFlightBatch(mixed);
    mixed.file.enqueue("b", picked("queued.txt", "later"));
    expect(mixed.file.queued).toHaveLength(1);

    drop("failed");

    expect(mixed.status).toBe("interrupted");
    expect(mixed.file.queued).toHaveLength(1);
    mixed.stop();
  });

  it("holds a link whose only work is an open text conversation", async () => {
    const { mixed, drop } = session({ resume: stalledResume() });
    const link = await mixed.ensure("b");
    link.textChannel.onmessage?.({ data: TEXT_REQUEST.buffer.slice(0) } as MessageEvent);
    expect(mixed.text.status).toBe("incomingRequest");
    mixed.text.accept();
    await flush();

    drop("failed");

    expect(mixed.status).toBe("interrupted");
    // A gap ends the conversation visibly and keeps the transcript.
    expect(mixed.text.status).toBe("ended");
    mixed.stop();
  });

  it("re-owns both lanes on the rebuilt transport and leaves the old ones silent", async () => {
    const rebuilt = rebuiltTransport();
    const { h, mixed, drop } = session({ resume: vi.fn(async () => rebuilt.conn) });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    const generation = mixed.linkGeneration;

    drop("failed");
    await vi.waitFor(() => expect(mixed.status).toBe("open"));

    const next = mixed.link!;
    expect(next).not.toBe(link);
    expect(mixed.file.link).toBe(next);
    expect(mixed.text.link).toBe(next);
    expect(next.sas).toBe(link.sas);
    expect(mixed.sasCode).toBe(link.sas);
    expect(next.keys).toBe(link.keys);
    expect(next.fileSender).toBe(link.fileSender);
    expect(next.fileReceiver).toBe(link.fileReceiver);
    expect(next.textSender).toBe(link.textSender);
    expect(next.textReceiver).toBe(link.textReceiver);
    expect(next.fileChannel.onmessage).toBeTypeOf("function");
    expect(next.textChannel.onmessage).toBeTypeOf("function");
    expect(link.fileChannel.onmessage).toBeNull();
    expect(link.textChannel.onmessage).toBeNull();
    // A completed replacement IS a publish, so the identity counter moves.
    expect(mixed.linkGeneration).toBeGreaterThan(generation);
    await flush();
    expect(mixed.path).toBe("p2p");
    expect(h.conns[0].close).toHaveBeenCalled();
    mixed.stop();
  });

  it("launches a batch enqueued during the gap only after recovery", async () => {
    let release!: (conn: Conn) => void;
    const gate = new Promise<Conn>((resolve) => { release = resolve; });
    const rebuilt = rebuiltTransport();
    const { mixed, drop } = session({ resume: vi.fn(() => gate) });
    await mixed.ensure("b");
    await inFlightBatch(mixed);

    drop("failed");
    expect(mixed.status).toBe("interrupted");
    mixed.file.enqueue("b", picked("after-gap.txt", "queued mid gap"));
    await flush();
    // Nothing may enter a transport that does not exist.
    expect(mixed.file.queued).toHaveLength(1);
    expect((rebuilt.file as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();

    release(rebuilt.conn);
    await vi.waitFor(() => expect(mixed.file.queued).toHaveLength(0));
    await vi.waitFor(() =>
      expect((rebuilt.file as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalled());
    mixed.stop();
  });

  it("cancels recovery on explicit disconnect and closes everything once", async () => {
    const resume = stalledResume();
    const { h, mixed, drop } = session({ resume });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);

    drop("failed");
    expect(mixed.status).toBe("interrupted");
    mixed.disconnect();

    expect(mixed.status).toBe("idle");
    expect(mixed.link).toBeNull();
    expect(mixed.file.link).toBeNull();
    expect(mixed.text.link).toBeNull();
    expect(link.fileChannel.onmessage).toBeNull();
    expect(link.textChannel.onmessage).toBeNull();
    expect(h.conns[0].close).toHaveBeenCalled();
    expect(resume.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  it("never lets the idle timer close an interrupted link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness();
    const mixed = createMixedSession({
      selfId: () => "a",
      signaling: () => h.signaling,
      rtcConfig: () => ({ iceServers: [] }),
      supportsLink: () => true,
      connect: h.connect,
      resume: stalledResume(),
      idleMs: 1_000,
    });
    const link = await mixed.ensure("b");
    await inFlightBatch(mixed);
    h.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(mixed.status).toBe("interrupted");

    // The link is current but has no transport; an idle close here would win a
    // race against the bounded recovery window, silently.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mixed.link).toBe(link);
    expect(mixed.status).toBe("interrupted");
    mixed.stop();
  });
});
