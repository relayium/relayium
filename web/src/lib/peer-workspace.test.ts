import { beforeAll, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
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
      close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "lan",
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
  // Never let a triggered transport rebuild reach a real RTCPeerConnection.
  const resume = vi.fn((_opts: { signal?: AbortSignal }) => new Promise<Conn>(() => {}));
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
    resume,
  });
  return {
    workspace, legacyFiles, legacyText, sent, connect, resume,
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

  // The workspace is the only place that knows which teardown was a user
  // decision. `syncPeers` (the peer already left the room), `resetRoom` and
  // `stop` must not claim to be one.
  it("announces only the user's own disconnect", async () => {
    const h = setup();
    const leaves = () => h.sent.filter((frame) => frame.data.leave === true);

    await h.workspace.mixed.ensure("z");
    h.workspace.disconnect();
    await vi.waitFor(() => expect(leaves()).toHaveLength(1));
    expect(leaves()[0].to).toBe("z");

    await h.workspace.mixed.ensure("z");
    h.workspace.resetRoom();
    await h.workspace.mixed.ensure("z");
    h.setPeers(["a"]);
    h.workspace.syncPeers();
    await h.workspace.mixed.ensure("z");
    h.workspace.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(leaves()).toHaveLength(1);
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

// What the unified workspace header and queue render is derived entirely from
// these getters, so the "one link, one SAS, one path, one disconnect" rule and the
// "legacy is untouched" rule are both testable without a DOM.
describe("peer workspace unified presentation surface", () => {
  it("exposes no link header source at all on the legacy path", () => {
    const h = setup();
    expect(h.workspace.usingMixed).toBe(false);
    expect(h.workspace.linkPeerId).toBe("");
    expect(h.workspace.linkPath).toBeUndefined();
    expect(h.workspace.queuedBatches).toHaveLength(0);
    // The legacy surfaces keep their own SAS and per-direction paths.
    expect(h.workspace.sasCode).toBe("legacy-file");
    expect(h.workspace.text).toBe(h.legacyText);
    h.workspace.stop();
  });

  it("names one peer, one link state, one SAS and one path for a mixed link", async () => {
    const h = setup();
    const link = await h.workspace.mixed.ensure("z");
    expect(h.workspace.usingMixed).toBe(true);
    expect(h.workspace.linkPeerId).toBe("z");
    expect(h.workspace.linkStatus).toBe("open");
    expect(h.workspace.sasCode).toBe(link.sas);
    expect(h.workspace.sasCode).not.toBe("legacy-file");
    // The path is sampled asynchronously; one macrotask is enough for the mock.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.workspace.linkPath).toBe("lan");
    h.workspace.stop();
  });

  it("gives each link its own identity so a repeated SAS is still a new step", async () => {
    const h = setup();
    const seen = [h.workspace.linkGeneration];
    const first = await h.workspace.mixed.ensure("z");
    seen.push(h.workspace.linkGeneration);
    h.workspace.disconnect();
    seen.push(h.workspace.linkGeneration);
    const second = await h.workspace.mixed.ensure("z");
    seen.push(h.workspace.linkGeneration);

    expect(second).not.toBe(first);
    // Four distinct values for idle → open → torn down → open again. A surface
    // that says something once per link keys off this, so two links can never be
    // confused with each other even if their six digits collide.
    expect(new Set(seen).size).toBe(seen.length);
    h.workspace.stop();
  });

  it("publishes queued file batches and cancels one by id", async () => {
    const h = setup();
    await h.workspace.mixed.ensure("z");
    const pick = (name: string) => [{ file: new File(["x"], name) }];
    // The first selection takes the lane; the second must queue rather than
    // disable the file control, and that queue has to be visible.
    h.workspace.sendFiles("z", pick("first.txt"));
    h.workspace.sendFiles("z", pick("second.txt"));
    expect(h.workspace.queuedBatches.map((b) => b.files[0].name)).toEqual(["second.txt"]);

    h.workspace.cancelQueuedBatch(h.workspace.queuedBatches[0].id);
    expect(h.workspace.queuedBatches).toHaveLength(0);
    h.workspace.stop();
  });

  it("keeps file and text intent independent for the linked peer and blocks others", async () => {
    const h = setup();
    await h.workspace.openText("z");
    const link = h.workspace.mixed.link!;
    link.textChannel.onmessage?.({ data: ACCEPT.buffer.slice(0) } as MessageEvent);
    expect(h.workspace.mixed.text.status).toBe("open");

    // An open conversation must not disable picking more files for the same peer…
    expect(h.workspace.blocksNewIntent("z")).toBe(false);
    h.workspace.sendFiles("z", [{ file: new File(["x"], "x.txt") }]);
    expect(h.workspace.mixed.file.active()).toBe(true);
    // …and a file batch must not close the conversation.
    expect(h.workspace.mixed.text.status).toBe("open");
    // Every other peer stays blocked while the one global link slot is taken.
    expect(h.workspace.blocksNewIntent("old")).toBe(true);
    h.workspace.stop();
  });
});

// An interrupted link is still a link. The exclusion that keeps a mixed link and
// a legacy transfer from ever coexisting has to hold across the gap too —
// otherwise the window in which the link is defenceless is exactly the window in
// which a legacy inbound offer could claim the same peer.
describe("peer workspace during a mixed transport gap", () => {
  async function interrupted() {
    const h = setup();
    await h.workspace.mixed.ensure("z");
    h.workspace.mixed.file.enqueue("z", [{ file: new File(["held"], "held.txt") }]);
    await vi.waitFor(() => expect(h.workspace.mixed.file.send?.status).toBe("waitingAccept"));
    h.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(h.workspace.linkStatus).toBe("interrupted");
    return h;
  }

  it("keeps blocking every legacy inbound generation while interrupted", async () => {
    const h = await interrupted();

    expect(h.workspace.usingMixed).toBe(true);
    expect(h.workspace.blocksLegacyInbound).toBe(true);
    expect(h.workspace.warnsOnLeave).toBe(true);
    expect(h.workspace.linkPeerId).toBe("z");
    // The workspace still owns this peer, so no legacy path can start for it.
    expect(h.workspace.blocksNewIntent("old")).toBe(true);
    h.workspace.stop();
  });

  it("disconnects and cancels recovery when the peer leaves during the gap", async () => {
    const h = await interrupted();

    h.setPeers(["a", "old"]);
    h.workspace.syncPeers();

    expect(h.workspace.mixed.link).toBeNull();
    expect(h.workspace.linkStatus).toBe("idle");
    expect(h.workspace.blocksLegacyInbound).toBe(false);
    expect(h.resume.mock.calls[0][0].signal?.aborted).toBe(true);
    h.workspace.stop();
  });
});
