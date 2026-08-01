import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, ready } from "./crypto";
import { createPeerWorkspace } from "./peer-workspace.svelte";
import type { TextSession } from "./text-session.svelte";
import type { TransferSession } from "./transfer-session.svelte";
import type { SignalingClient } from "./signaling";
import type { Conn, InboundSignal } from "./webrtc";
import type { ConnectOpts } from "./webrtc";
import { ACCEPT } from "./transfer";

beforeAll(async () => { await ready(); });

function dataChannel(label: string) {
  return {
    label, readyState: "open", bufferedAmount: 0,
    onmessage: null, onclose: null, send: vi.fn(), close: vi.fn(),
  } as unknown as RTCDataChannel;
}

function setup() {
  const listeners: ((from: string, data: unknown) => void)[] = [];
  const sent: { to: string; data: InboundSignal }[] = [];
  const signaling = {
    onSignal(cb: (from: string, data: unknown) => void) {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    sendSignal(to: string, data: unknown) { sent.push({ to, data: data as InboundSignal }); },
  } as unknown as SignalingClient;
  const connect = vi.fn(async (opts: ConnectOpts): Promise<Conn> => {
    opts.onPeerKey(generateKeyPair().publicKey);
    const file = dataChannel("relayium");
    const text = dataChannel("relayium-text");
    return {
      channel: file,
      getChannel: (label) => label === "relayium" ? file : label === "relayium-text" ? text : undefined,
      close: vi.fn(), path: async () => "lan",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
  });
  const legacyFiles = {
    incoming: null, recv: null, send: null, sasCode: "legacy-file",
    sendPath: undefined, recvPath: undefined, busy: false, transferActive: false,
    sendFiles: vi.fn(), accept: vi.fn(), reject: vi.fn(), abort: vi.fn(),
    abortAll: vi.fn(), dismissSend: vi.fn(), dismissRecv: vi.fn(), reset: vi.fn(),
    conn: vi.fn(),
  } as unknown as TransferSession;
  let legacyTextStatus = "idle";
  let legacyTextActive = false;
  const legacyText = {
    get status() { return legacyTextStatus; }, peerId: "", sasCode: "legacy-text", path: undefined,
    history: [], errorKey: "", openWith: vi.fn(), accept: vi.fn(), reject: vi.fn(),
    send: vi.fn(), end: vi.fn(), clearHistory: vi.fn(), active: vi.fn(() => legacyTextActive),
  } as unknown as TextSession;
  let selfId = "a";
  let joined = true;
  let unsupported = false;
  let peers = ["a", "z", "old"];
  const workspace = createPeerWorkspace({
    selfId: () => selfId,
    joined: () => joined,
    peerIds: () => peers,
    unsupported: () => unsupported,
    signaling: () => signaling,
    rtcConfig: () => ({ iceServers: [] }),
    legacyFiles,
    legacyText,
    supportsLink: (peerId) => peerId !== "old",
    connect,
  });
  return {
    workspace, legacyFiles, legacyText, sent, connect,
    inject(from: string, data: InboundSignal) {
      for (const listener of [...listeners]) listener(from, data);
    },
    setSelfId(value: string) { selfId = value; },
    setJoined(value: boolean) { joined = value; },
    setUnsupported(value: boolean) { unsupported = value; },
    setPeers(value: string[]) { peers = value; },
    setLegacyText(status: string, active: boolean) {
      legacyTextStatus = status;
      legacyTextActive = active;
    },
  };
}

describe("peer workspace capability routing", () => {
  it("routes file and text intent only for an exact link-capable peer", async () => {
    const h = setup();
    const mixedFiles = vi.spyOn(h.workspace.mixed.file, "enqueue").mockImplementation(() => {});
    const mixedText = vi.spyOn(h.workspace.mixed.text, "openWith").mockResolvedValue();
    const picked = [{ file: new File(["x"], "x.txt") }];

    h.workspace.sendFiles("z", picked);
    await h.workspace.openText("z");
    expect(mixedFiles).toHaveBeenCalledWith("z", picked);
    expect(mixedText).toHaveBeenCalledWith("z");
    expect(h.legacyFiles.sendFiles).not.toHaveBeenCalled();
    expect(h.legacyText.openWith).not.toHaveBeenCalled();

    h.workspace.sendFiles("old", picked);
    await h.workspace.openText("old");
    expect(h.legacyFiles.sendFiles).toHaveBeenCalledWith("old", picked);
    expect(h.legacyText.openWith).toHaveBeenCalledWith("old");
  });

  it("blocks both legacy inbound generations while one mixed link exists", async () => {
    const h = setup();
    await h.workspace.mixed.ensure("z");
    expect(h.workspace.blocksLegacyInbound).toBe(true);
    expect(h.workspace.warnsOnLeave).toBe(true);
    expect(h.workspace.blocksNewIntent("z")).toBe(false);
    expect(h.workspace.blocksNewIntent("old")).toBe(true);
    h.workspace.stop();
  });

  it("does not let canAcceptLink reject the offer for its own pending request", async () => {
    const h = setup();
    h.setSelfId("z");
    h.workspace.start();
    const waiting = h.workspace.mixed.ensure("a");
    expect(h.sent).toContainEqual({ to: "a", data: { linkRequest: true, link: true } });
    h.inject("a", { link: true, sdp: { type: "offer", sdp: "v=0" } });
    await expect(waiting).resolves.toMatchObject({ peerId: "a" });
    expect(h.connect).toHaveBeenCalledOnce();
    h.workspace.stop();
  });

  it("rejects inbound link allocation when legacy work is active", () => {
    const h = setup();
    Object.defineProperty(h.legacyFiles, "transferActive", { get: () => true });
    h.workspace.start();
    h.inject("z", { link: true, linkRequest: true });
    expect(h.sent).toContainEqual({ to: "z", data: { busy: true, link: true } });
    expect(h.connect).not.toHaveBeenCalled();
    h.workspace.stop();
  });

  it("also blocks outbound mixed intent while legacy work is active", async () => {
    const h = setup();
    Object.defineProperty(h.legacyFiles, "transferActive", { get: () => true });
    const mixedFiles = vi.spyOn(h.workspace.mixed.file, "enqueue");
    const mixedText = vi.spyOn(h.workspace.mixed.text, "openWith");
    const picked = [{ file: new File(["x"], "x.txt") }];
    h.workspace.sendFiles("z", picked);
    await h.workspace.openText("z");
    expect(mixedFiles).not.toHaveBeenCalled();
    expect(mixedText).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("rejects unknown-roster and unsupported-environment inbound links", () => {
    const h = setup();
    h.workspace.start();
    h.setPeers(["a"]);
    h.inject("z", { link: true, linkRequest: true });
    h.setPeers(["a", "z"]);
    h.setUnsupported(true);
    h.inject("z", { link: true, linkRequest: true });
    expect(h.sent.filter((frame) => frame.data.busy)).toHaveLength(2);
    expect(h.connect).not.toHaveBeenCalled();
    h.workspace.stop();
  });

  it("closes a departed peer and suppresses immediate inbound reopen after explicit disconnect", async () => {
    const h = setup();
    h.workspace.start();
    await h.workspace.mixed.ensure("z");
    h.workspace.disconnect();
    h.inject("z", { link: true, linkRequest: true });
    expect(h.sent).toContainEqual({ to: "z", data: { busy: true, link: true } });
    expect(h.connect).toHaveBeenCalledOnce();

    // A later local reconnect is not trapped by the inbound suppression policy.
    await h.workspace.mixed.ensure("z");
    expect(h.connect).toHaveBeenCalledTimes(2);
    h.setPeers(["a"]);
    h.workspace.syncPeers();
    expect(h.workspace.mixed.link).toBeNull();
    h.workspace.stop();
  });

  it("does not let a mixed file-only link steal an ended legacy transcript", async () => {
    const h = setup();
    h.setLegacyText("ended", false);
    await h.workspace.mixed.ensure("z");
    expect(h.workspace.text).toBe(h.legacyText);
    expect(h.workspace.textPath).toBe(h.legacyText.path);
    h.workspace.stop();
  });

  it("returns ownership to a later active legacy request after mixed text ends", async () => {
    const h = setup();
    await h.workspace.openText("z");
    expect(h.workspace.text).toBe(h.workspace.mixed.text);
    h.workspace.mixed.disconnect();

    h.setLegacyText("incomingRequest", true);
    expect(h.workspace.text).toBe(h.legacyText);
    h.workspace.acceptText();
    expect(h.legacyText.accept).toHaveBeenCalledOnce();

    h.setLegacyText("ended", false);
    expect(h.workspace.text).toBe(h.legacyText);
    h.workspace.stop();
  });

  it("keeps mixed text history selected when a file-only link is rebuilt", async () => {
    const h = setup();
    await h.workspace.openText("z");
    const first = h.workspace.mixed.link!;
    first.textChannel.onmessage?.({ data: ACCEPT.buffer.slice(0) } as MessageEvent);
    expect(h.workspace.mixed.text.status).toBe("open");
    await h.workspace.sendText("kept mixed history");
    expect(h.workspace.mixed.text.history).toHaveLength(1);
    h.workspace.endText();
    h.workspace.mixed.disconnect();

    await h.workspace.mixed.ensure("z");
    expect(h.workspace.mixed.text.status).toBe("idle");
    expect(h.workspace.text).toBe(h.workspace.mixed.text);
    expect(h.workspace.text.history[0]?.body).toBe("kept mixed history");
    h.workspace.stop();
  });
});
