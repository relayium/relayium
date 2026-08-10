import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
import { canReleaseConfirmedSend } from "./confirm-send";
import { generateKeyPair, ready } from "./crypto";
import { CAP_LINK, CAP_TEXT, peerSupportsLink, recordPeerCaps, resetPeerCaps, retainPeers } from "./peer-caps.svelte";
import { clearRoom, enterRoom } from "./room.svelte";
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

/** `realLinkCaps` drops the injected capability stub so the workspace uses the
 *  shipped `peerSupportsLink` — the only way to test what a DEFAULT build does
 *  with a peer's roster claim, room policy included. */
function setup(opts: { realLinkCaps?: boolean } = {}) {
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
  let legacyTextPeer = "";
  const legacyText = {
    get status() { return legacyTextStatus; },
    get peerId() { return legacyTextPeer; },
    sasCode: "legacy-text", path: undefined,
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
    supportsLink: opts.realLinkCaps ? undefined : (peerId) => peerId !== "old",
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
    setLegacyText(status: string, active: boolean, peerId = "") {
      legacyTextStatus = status;
      legacyTextActive = active;
      legacyTextPeer = peerId;
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

  it("preserves an established link across a roster handoff and suppresses immediate inbound reopen after explicit disconnect", async () => {
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
    expect(h.workspace.mixed.link?.peerId).toBe("z");
    h.workspace.stop();
  });

  // A device's representative page can be replaced while we are still waiting
  // for it to accept — the user switched tabs, or that page was closed. The new
  // roster is the notification, and it must land as "this target is gone", not
  // as an indefinite "Waiting for the other device to accept…".
  it("cancels a pending request when its target leaves the roster", async () => {
    const h = setup();
    h.setSelfId("zz"); // greater id → this side asks and waits for the accept
    h.workspace.start();
    const pending = h.workspace.mixed.ensure("z");
    pending.catch(() => {}); // the assertion below is that it settles at all
    expect(h.workspace.linkStatus).toBe("requesting");

    h.setPeers(["zz"]); // the roster now names a different page for that device
    h.workspace.syncPeers();

    expect(h.workspace.linkStatus).toBe("idle");
    await expect(pending).rejects.toBeInstanceOf(Error);
    h.workspace.stop();
  });

  // A peer that does not speak link/1 — an older Web tab, a native client, or
  // any peer in a pairing-code room — negotiates text over the legacy session,
  // so this is the path the reported "Waiting for the other device to
  // accept…" actually came from. Without it, that panel stays on
  // screen for a page that is no longer in anybody's roster — and the sender
  // cannot even start a new session, because the dead one still counts as busy.
  it.each([
    ["waitingAccept"], ["connecting"],
  ])("ends an outgoing legacy text session in %s once its target leaves the roster", (status) => {
    const h = setup();
    h.setLegacyText(status, true, "gone");
    h.setPeers(["a", "z", "old"]);
    h.workspace.syncPeers();
    expect(h.legacyText.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["incomingRequest"], ["open"],
  ])("keeps an established/incoming legacy text session in %s across a representative handoff", (status) => {
    const h = setup();
    h.setLegacyText(status, true, "old-representative");
    h.setPeers(["new-representative"]);
    h.workspace.syncPeers();
    expect(h.legacyText.end).not.toHaveBeenCalled();
  });

  it.each([
    ["connecting"], ["waitingAccept"], ["incomingRequest"], ["open"],
  ])("ends a legacy text session in %s when its physical peer actually leaves", (status) => {
    const h = setup();
    h.setLegacyText(status, true, "old-page");
    h.workspace.peerLeft("old-page");
    expect(h.legacyText.end).toHaveBeenCalledOnce();
  });

  it("does not end a session for an unrelated physical departure", () => {
    const h = setup();
    h.setLegacyText("open", true, "still-here");
    h.workspace.peerLeft("different-page");
    expect(h.legacyText.end).not.toHaveBeenCalled();
  });

  it("keeps an established healthy mixed link when the remote SIGNALLING peer leaves", async () => {
    // The correlated-loss invariant, arrived at from the other side. Side A
    // losing only its WebSocket is exactly what makes the server tell us "A
    // left" — and A's DataChannel to us is a different transport that is still
    // carrying whatever it was carrying. Tearing it down here would abort a live
    // transfer because the rendezvous socket blinked, which is the one thing
    // link-recovery.ts says must never happen.
    const h = setup();
    const link = await h.workspace.mixed.ensure("z");
    const conn = link.conn;
    h.workspace.peerLeft("unrelated");
    expect(h.workspace.mixed.link?.peerId).toBe("z");

    h.workspace.peerLeft("z");
    expect(h.workspace.mixed.link).toBe(link);
    expect(h.workspace.linkStatus).toBe("open");
    expect(conn.close).not.toHaveBeenCalled();
    // Both lanes are still attached to it, so work in flight keeps running.
    expect(link.fileChannel.onmessage).not.toBeNull();
    expect(link.textChannel.onmessage).not.toBeNull();
    // …and the header says up front that this one can no longer be rebuilt: the
    // peer id it would have to address is not in the room any more.
    expect(h.workspace.recoveryAvailable).toBe(false);
    expect(h.workspace.linkEndReason).toBe("");
    h.workspace.stop();
  });

  it("terminates that preserved link with signalingLost, and no resume attempt, if its transport dies later", async () => {
    const h = setup();
    await h.workspace.mixed.ensure("z");
    h.workspace.mixed.file.enqueue("z", [{ file: new File(["payload"], "held.txt") }]);
    await vi.waitFor(() => expect(h.workspace.mixed.file.send?.status).toBe("waitingAccept"));

    h.workspace.peerLeft("z");
    h.connect.mock.calls[0][0].onStateChange?.("failed");

    expect(h.workspace.linkStatus).toBe("failed");
    expect(h.workspace.mixed.link).toBeNull();
    expect(h.workspace.linkEndReason).toBe("signalingLost");
    // Not one rebuild offer into a room the peer is no longer in.
    expect(h.resume).not.toHaveBeenCalled();
    h.workspace.stop();
  });

  it("ends an already-interrupted link at once instead of waiting out a window that cannot succeed", async () => {
    const h = setup();
    await h.workspace.mixed.ensure("z");
    h.workspace.mixed.file.enqueue("z", [{ file: new File(["payload"], "held.txt") }]);
    await vi.waitFor(() => expect(h.workspace.mixed.file.send?.status).toBe("waitingAccept"));
    h.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(h.workspace.linkStatus).toBe("interrupted");

    // This one HAS no transport left to preserve, and the rebuild it is waiting
    // for is addressed to a peer that has gone. Say so now rather than 90
    // seconds from now under a generic "connection failed".
    h.workspace.peerLeft("z");
    expect(h.workspace.mixed.link).toBeNull();
    // The same shape as the credential's terminal teardown: the REASON is the
    // state (WorkspaceHeader renders it over the status line), and it holds the
    // workspace on screen with the queued batch still next to it.
    expect(h.workspace.linkEndReason).toBe("signalingLost");
    expect(h.workspace.usingMixed).toBe(true);
    h.workspace.stop();
  });

  it("forgets a departure when the room is reset, so the next room's link is recoverable", async () => {
    const h = setup();
    await h.workspace.mixed.ensure("z");
    h.workspace.peerLeft("z");
    expect(h.workspace.recoveryAvailable).toBe(false);

    h.workspace.resetRoom();
    await h.workspace.mixed.ensure("z");
    expect(h.workspace.recoveryAvailable).toBe(true);
    h.workspace.stop();
  });

  it("scopes the departure to the peer that left, not to the next link", async () => {
    const h = setup();
    h.setPeers(["a", "z", "y"]);
    await h.workspace.mixed.ensure("z");
    h.workspace.peerLeft("y");
    expect(h.workspace.recoveryAvailable).toBe(true);
    h.workspace.stop();
  });

  it("cancels an in-flight mixed request when that physical peer leaves", async () => {
    const h = setup();
    h.setSelfId("zz");
    h.workspace.start();
    const pending = h.workspace.mixed.ensure("z");
    pending.catch(() => {});
    expect(h.workspace.mixed.manager.boundPeerId).toBe("z");

    h.workspace.peerLeft("z");
    expect(h.workspace.linkStatus).toBe("idle");
    await expect(pending).rejects.toBeInstanceOf(Error);
    h.workspace.stop();
  });

  it("leaves a legacy text session alone while its peer is still listed", () => {
    const h = setup();
    h.setLegacyText("open", true, "old");
    h.setPeers(["a", "old"]);
    h.workspace.syncPeers();
    expect(h.legacyText.end).not.toHaveBeenCalled();
  });

  it("does not re-end a legacy session that already finished", () => {
    const h = setup();
    h.setLegacyText("ended", false, "gone");
    h.setPeers(["a"]);
    h.workspace.syncPeers();
    expect(h.legacyText.end).not.toHaveBeenCalled();
  });

  it("keeps waiting while the request target is still in the roster", async () => {
    const h = setup();
    h.setSelfId("zz");
    h.workspace.start();
    const pending = h.workspace.mixed.ensure("z");
    pending.catch(() => {});
    h.setPeers(["zz", "z", "old"]);
    h.workspace.syncPeers();
    expect(h.workspace.linkStatus).toBe("requesting");
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

  it("reports whether an authenticated link object genuinely exists", async () => {
    // `usingMixed` is deliberately broader — it is true while a request is still
    // in flight, so the workspace can own the screen before there is anything to
    // trust. A launcher that opens a lane must key off the narrower fact.
    const h = setup();
    expect(h.workspace.hasLink).toBe(false);
    const pending = h.workspace.openText("z");
    expect(h.workspace.usingMixed).toBe(true);
    expect(h.workspace.hasLink).toBe(false);
    await pending;
    expect(h.workspace.hasLink).toBe(true);
    h.workspace.disconnect();
    expect(h.workspace.hasLink).toBe(false);
    h.workspace.stop();
  });

  it("makes a text open that resolves after Disconnect inert", async () => {
    // The auto-open orchestration in App is fire-and-forget on purpose: the
    // lane's own attempt/generation guards are what must absorb a resolution
    // that lands after the user already tore the workspace down. If they ever
    // stopped doing so, this is where a "connecting…" panel would reappear on a
    // link that no longer exists.
    const h = setup();
    const pending = h.workspace.openText("z");
    h.workspace.disconnect();
    await pending;
    expect(h.workspace.mixed.text.status).not.toBe("waitingAccept");
    expect(h.workspace.mixed.text.status).not.toBe("connecting");
    expect(h.workspace.hasLink).toBe(false);
    expect(h.workspace.usingMixed).toBe(false);
    h.workspace.stop();
  });

  it("makes a text open that resolves after a room switch inert", async () => {
    const h = setup();
    const pending = h.workspace.openText("z");
    h.workspace.resetRoom();
    await pending;
    expect(h.workspace.mixed.text.status).not.toBe("waitingAccept");
    expect(h.workspace.mixed.text.status).not.toBe("connecting");
    expect(h.workspace.usingMixed).toBe(false);
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

  it("keeps recovery alive when the roster hands the device to another page", async () => {
    const h = await interrupted();

    h.setPeers(["a", "old"]);
    h.workspace.syncPeers();

    expect(h.workspace.mixed.link?.peerId).toBe("z");
    expect(h.workspace.linkStatus).toBe("interrupted");
    expect(h.workspace.blocksLegacyInbound).toBe(true);
    expect(h.resume.mock.calls[0][0].signal?.aborted).toBe(false);
    h.workspace.stop();
  });
});

// A link that ended of something the user must act on. The state machine is
// covered in mixed-link-lifecycle.test.ts; what this pins is the SURFACE rule —
// the workspace holds the screen to say so, and holds nothing else.
describe("peer workspace after a link ends terminally", () => {
  async function ended() {
    const h = setup();
    // The signalling identity disappears under a live link with lane work: the
    // socket dropped. Nothing happens to the transport until it, too, dies.
    await h.workspace.mixed.ensure("z");
    h.workspace.mixed.file.enqueue("z", [{ file: new File(["held"], "held.txt") }]);
    await vi.waitFor(() => expect(h.workspace.mixed.file.send?.status).toBe("waitingAccept"));
    h.setJoined(false);
    h.setSelfId("");
    h.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(h.workspace.linkEndReason).toBe("signalingLost");
    return h;
  }

  it("keeps the workspace on screen so the reason can be read", async () => {
    const h = await ended();
    // Without this the surface silently reverts to the device chooser, and the
    // only evidence that a transfer stopped mid-flight is that it is gone.
    expect(h.workspace.usingMixed).toBe(true);
    expect(h.workspace.hasLink).toBe(false);
    h.workspace.stop();
  });

  it("holds the screen without holding the peer", async () => {
    const h = await ended();
    // A terminal explanation is not an exclusion: starting again is the way out,
    // so it may not be what blocks starting again.
    expect(h.workspace.blocksLegacyInbound).toBe(false);
    expect(h.workspace.blocksNewIntent("z")).toBe(false);
    expect(h.workspace.blocksNewIntent("old")).toBe(false);
    h.workspace.stop();
  });

  it("clears the reason when it is dismissed, and only then", async () => {
    const h = await ended();
    h.workspace.syncPeers(); // roster churn is not an answer to it
    expect(h.workspace.linkEndReason).toBe("signalingLost");
    h.workspace.dismissLinkEnd();
    expect(h.workspace.linkEndReason).toBe("");
    expect(h.workspace.usingMixed).toBe(false);
    h.workspace.stop();
  });

  it("clears it on a room switch, whose peers and credentials are all different", async () => {
    const h = await ended();
    h.workspace.resetRoom();
    expect(h.workspace.linkEndReason).toBe("");
    expect(h.workspace.usingMixed).toBe(false);
    h.workspace.stop();
  });
});

// ── the release scope of link/1 ────────────────────────────────────────────────
//
// A default build implements the unified link and now advertises and routes it
// in EVERY room — the LAN room and a pairing-code room alike (DECISION-LOG
// 2026-08-10). Everything below runs the SHIPPED `peerSupportsLink` (no injected
// stub), because the point is what a real build does with a real roster claim.
//
// What the room no longer decides, the capability still does, and that is the
// whole downgrade boundary now: an exact `link/1` announcement or nothing. These
// cases are deterministic here rather than in a real browser because `/api/pair`
// mints a cross-network code only for a logged-in account and the ws route
// rejects a code that was never minted; the browser-side proof runs against a
// controlled pairing fixture instead (e2e/code-room.mjs) — see web/e2e/README.md.
describe("peer workspace link/1 routing scope", () => {
  beforeEach(() => { clearRoom(); resetPeerCaps(); });

  it.each([
    ["the code-less LAN room", undefined],
    ["a pairing-code room", "123456"],
  ])("routes a link-capable peer in %s", async (_label, code) => {
    const h = setup({ realLinkCaps: true });
    recordPeerCaps("z", { caps: [CAP_TEXT, CAP_LINK] });
    if (code) enterRoom({ code });

    expect(h.workspace.routes("z")).toBe(true);

    const mixedFiles = vi.spyOn(h.workspace.mixed.file, "enqueue").mockImplementation(() => {});
    const mixedText = vi.spyOn(h.workspace.mixed.text, "openWith").mockResolvedValue();
    const picked = [{ file: new File(["x"], "x.txt") }];
    h.workspace.sendFiles("z", picked);
    await h.workspace.openText("z");
    expect(mixedFiles).toHaveBeenCalledWith("z", picked);
    expect(mixedText).toHaveBeenCalledWith("z");
    expect(h.legacyFiles.sendFiles).not.toHaveBeenCalled();
    expect(h.legacyText.openWith).not.toHaveBeenCalled();
    h.workspace.stop();
  });

  // The negative half of the rollout, against the SHIPPED predicate rather than
  // a stub, and now in BOTH rooms: a peer that never announced, or announced a
  // different version, is a legacy peer — and must never be probed with a link
  // request or a two-channel offer it cannot answer. An old build reads such an
  // offer as a file transfer whose manifest never arrives, and waits out its
  // stall watchdog. A pairing room is where this matters most: the peer on the
  // other end of a code is routinely a phone on an older bundle.
  it.each([
    ["a peer that never announced", null, undefined],
    ["a peer that announced only text/1", [CAP_TEXT], undefined],
    ["a peer announcing a different link version", [CAP_TEXT, "link/2"], undefined],
    ["a peer that never announced", null, "123456"],
    ["a peer that announced only text/1", [CAP_TEXT], "123456"],
    ["a peer announcing a different link version", [CAP_TEXT, "link/2"], "123456"],
    ["a peer announcing a near-miss claim", [CAP_TEXT, "link/1x"], "123456"],
  ])("leaves %s on the legacy path (room %s)", async (_label, caps, code) => {
    const h = setup({ realLinkCaps: true });
    if (caps) recordPeerCaps("z", { caps });
    if (code) enterRoom({ code });
    h.workspace.start();

    expect(h.workspace.routes("z")).toBe(false);

    const mixedFiles = vi.spyOn(h.workspace.mixed.file, "enqueue").mockImplementation(() => {});
    const picked = [{ file: new File(["x"], "x.txt") }];
    h.workspace.sendFiles("z", picked);
    await h.workspace.openText("z");

    expect(mixedFiles).not.toHaveBeenCalled();
    expect(h.legacyFiles.sendFiles).toHaveBeenCalledWith("z", picked);
    expect(h.legacyText.openWith).toHaveBeenCalledWith("z");
    // Nothing link-shaped went out: no request, no offer, not even a busy reply.
    expect(h.sent.filter((s) => (s.data as { link?: boolean }).link === true)).toEqual([]);
    expect(h.connect).not.toHaveBeenCalled();
    h.workspace.stop();
  });

  // A signalling relay sees every frame and can inject one. It cannot forge its
  // way past an EXACT capability check, so the surviving attack is a
  // well-formed-looking announcement that is not this protocol — in either room.
  it.each([
    ["a caps frame that is not an array", { caps: "link/1" }],
    ["a caps list of non-strings", { caps: [1, { link: "1" }] }],
    ["a frame with no caps at all", { rename: "link/1" }],
    ["a bare array instead of an envelope", ["link/1"]],
  ])("cannot be made to route by %s", async (_label, frame) => {
    const h = setup({ realLinkCaps: true });
    enterRoom({ code: "123456" });
    recordPeerCaps("z", frame);
    h.workspace.start();

    expect(h.workspace.routes("z")).toBe(false);
    h.inject("z", { link: true, linkRequest: true } as unknown as InboundSignal);
    expect(h.sent).toEqual([]);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.workspace.linkStatus).toBe("idle");
    h.workspace.stop();
  });

  it("never answers an inbound link request or offer from a peer that did not announce", async () => {
    const h = setup({ realLinkCaps: true });
    enterRoom({ code: "123456" });
    h.workspace.start();

    // "a" < "z", so an inbound request would make us the initiator and an
    // inbound offer would make us the responder. Both must be dropped, and
    // dropped SILENTLY: a busy reply would still tell the peer we speak link/1.
    h.inject("z", { link: true, linkRequest: true } as unknown as InboundSignal);
    h.setSelfId("zz");
    h.inject("z", { link: true, sdp: { type: "offer", sdp: "v=0" } } as unknown as InboundSignal);

    expect(h.sent).toEqual([]);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.workspace.linkStatus).toBe("idle");
    expect(h.workspace.usingMixed).toBe(false);
    h.workspace.stop();
  });

  it("clears mixed state and capabilities on a room switch before the new room acts", async () => {
    const h = setup({ realLinkCaps: true });
    recordPeerCaps("z", { caps: [CAP_TEXT, CAP_LINK] });
    await h.workspace.mixed.ensure("z");
    expect(h.workspace.usingMixed).toBe(true);

    // Exactly what App.switchRoom does, in that order.
    h.workspace.resetRoom();
    resetPeerCaps();
    enterRoom({ code: "123456" });

    expect(h.workspace.usingMixed).toBe(false);
    expect(h.workspace.linkStatus).toBe("idle");
    // The new room's peers announce for themselves. The capability table is what
    // carries a peer id, and the server hands the same ids out again in the next
    // room — so a claim that survived the switch would route a link to a stranger.
    expect(peerSupportsLink("z")).toBe(false);
    // And leaving the room again does not resurrect the old claim.
    clearRoom();
    expect(peerSupportsLink("z")).toBe(false);
    h.workspace.stop();
  });
});

// ── an established link is authoritative for the peer it is bound to ──────────
//
// The correlated-loss invariant, read from the ROUTER rather than from the link
// lifecycle. A `left` frame — or this page's own socket dropping — is a
// statement about the rendezvous service and about nothing else: the DataChannel
// between the two pages is a separate transport, still carrying whatever it was
// carrying. But every input `routes()` used to read is a signalling fact: room
// membership, this page's own id, and a capability announcement that ARRIVES
// over signalling and is pruned with the roster (`retainPeers`). So a healthy,
// authenticated, mutually verified link would silently stop being routable, and
// the whole workspace with it — new files fell through to the legacy transfer
// path or were refused outright, on a connection that was working perfectly.
//
// Deliberately run against the SHIPPED `peerSupportsLink` and the shipped
// `retainPeers`: a stubbed capability cannot show that the announcement is
// really gone, which is the entire point.
describe("peer workspace routing across signalling-only loss", () => {
  beforeEach(() => { clearRoom(); resetPeerCaps(); });

  /** A live link to "z", then the signalling layer disappears underneath it —
   *  either the peer's socket (a `left` frame plus the roster that follows it,
   *  exactly as App sequences them) or this page's own. */
  async function linked(cut: "peer" | "self") {
    const h = setup({ realLinkCaps: true });
    recordPeerCaps("z", { caps: [CAP_TEXT, CAP_LINK] });
    h.workspace.start();
    await h.workspace.mixed.ensure("z");
    expect(h.workspace.hasLink).toBe(true);
    expect(h.workspace.linkStatus).toBe("open");
    if (cut === "peer") {
      h.setPeers(["a", "old"]);
      retainPeers(["a", "old"]);
      h.workspace.syncPeers();
      h.workspace.peerLeft("z");
      // The pruning really happened: this is the state the router now has to
      // route through, not a hypothetical one.
      expect(peerSupportsLink("z")).toBe(false);
    } else {
      h.setJoined(false);
      h.setSelfId("");
    }
    return h;
  }

  it.each([["the peer's", "peer"], ["this page's own", "self"]] as const)(
    "keeps the link, and keeps routing to it, when %s signalling goes away",
    async (_label, cut) => {
      const h = await linked(cut);
      expect(h.workspace.hasLink).toBe(true);
      expect(h.workspace.linkStatus).toBe("open");
      // The router's answer for the bound peer comes from the link, not from the
      // signalling facts that just went away.
      expect(h.workspace.routes("z")).toBe(true);
      expect(h.workspace.blocksNewIntent("z")).toBe(false);
      // …and it is honest about the future: this link could not be rebuilt.
      expect(h.workspace.recoveryAvailable).toBe(false);
      h.workspace.stop();
    },
  );

  it.each([["the peer's", "peer"], ["this page's own", "self"]] as const)(
    "sends a NEW file batch over that link instead of downgrading to legacy, after %s signalling loss",
    async (_label, cut) => {
      const h = await linked(cut);
      const enqueue = vi.spyOn(h.workspace.mixed.file, "enqueue").mockImplementation(() => {});
      const picked = [{ file: new File(["after the cut"], "after.txt") }];

      h.workspace.sendFiles("z", picked);

      expect(enqueue).toHaveBeenCalledWith("z", picked);
      // The two failure modes this closes, named: a silent drop, and a legacy
      // downgrade that would negotiate a SECOND connection and a second SAS.
      expect(h.legacyFiles.sendFiles).not.toHaveBeenCalled();
      h.workspace.stop();
    },
  );

  it.each([["the peer's", "peer"], ["this page's own", "self"]] as const)(
    "opens a NEW text conversation on that same link after %s signalling loss",
    async (_label, cut) => {
      const h = await linked(cut);
      const openWith = vi.spyOn(h.workspace.mixed.text, "openWith").mockResolvedValue();

      await h.workspace.openText("z");

      expect(openWith).toHaveBeenCalledWith("z");
      expect(h.legacyText.openWith).not.toHaveBeenCalled();
      h.workspace.stop();
    },
  );

  // The authority is scoped to ONE peer and one live link. Everything else keeps
  // the exact gates it had: this is not "signalling loss turns the gates off".
  // The routing answer is also an input to the sender-side verification stop:
  // `canReleaseConfirmedSend` reads it as `unified`, and `unified === false`
  // means "a legacy peer, whose code appears on its own transfer card" and
  // releases immediately. So a healthy unified link reporting itself as
  // un-routable did not merely downgrade the transport — it turned the code
  // comparison in a code room into a click-through, for the exact peer the stop
  // exists to guard against.
  it.each([["the peer's", "peer"], ["this page's own", "self"]] as const)(
    "keeps the unified send confirmation engaged after %s signalling loss",
    async (_label, cut) => {
      const h = await linked(cut);
      const unified = h.workspace.routes("z");
      expect(unified).toBe(true);
      // Still fails closed with no code on screen…
      expect(canReleaseConfirmedSend({
        confirmed: true, unified, targetPeerId: "z",
        linkPeerId: h.workspace.hasLink ? h.workspace.linkPeerId : "",
        shownSas: "",
      })).toBe(false);
      // …and releases only against this link's own displayed code.
      expect(canReleaseConfirmedSend({
        confirmed: true, unified, targetPeerId: "z",
        linkPeerId: h.workspace.hasLink ? h.workspace.linkPeerId : "",
        shownSas: h.workspace.sasCode,
      })).toBe(true);
      // A code belonging to some other link is not a code for this batch.
      expect(canReleaseConfirmedSend({
        confirmed: true, unified, targetPeerId: "someone-else",
        linkPeerId: h.workspace.linkPeerId,
        shownSas: h.workspace.sasCode,
      })).toBe(false);
      h.workspace.stop();
    },
  );

  it("grants that authority to the bound peer only", async () => {
    // This page's own membership is gone, so a link that does not exist yet
    // cannot be built — no matter how completely the other peer announced.
    const h = await linked("self");
    recordPeerCaps("old", { caps: [CAP_TEXT, CAP_LINK] });

    expect(h.workspace.routes("old")).toBe(false);
    expect(h.workspace.blocksNewIntent("old")).toBe(true);
    // And the same page still routes the peer it is actually linked to.
    expect(h.workspace.routes("z")).toBe(true);
    h.workspace.stop();
  });

  it("withdraws it the moment the link is actually gone", async () => {
    const h = await linked("peer");
    // The transport dies for real. With the peer out of the room there is
    // nothing to rebuild toward — and a link that has ended is authoritative
    // for nothing.
    h.connect.mock.calls[0][0].onStateChange?.("failed");

    expect(h.workspace.hasLink).toBe(false);
    expect(h.workspace.routes("z")).toBe(false);
    const picked = [{ file: new File(["late"], "late.txt") }];
    h.workspace.sendFiles("z", picked);
    // Legacy is where a peer with no link belongs — including this one, now.
    expect(h.legacyFiles.sendFiles).toHaveBeenCalledWith("z", picked);
    h.workspace.stop();
  });

  // A gap is not an established link. Holding one open is a bet on a rebuild,
  // and the rebuild is addressed through signalling — so while the transport is
  // down the ordinary gates are the honest answer.
  it("does not extend that authority to a link with no transport under it", async () => {
    const h = setup({ realLinkCaps: true });
    recordPeerCaps("z", { caps: [CAP_TEXT, CAP_LINK] });
    h.workspace.start();
    await h.workspace.mixed.ensure("z");
    h.workspace.mixed.file.enqueue("z", [{ file: new File(["held"], "held.txt") }]);
    await vi.waitFor(() => expect(h.workspace.mixed.file.send?.status).toBe("waitingAccept"));
    h.connect.mock.calls[0][0].onStateChange?.("failed");
    expect(h.workspace.linkStatus).toBe("interrupted");

    // Signalling is fine here, so the ordinary answer is still "yes" — the point
    // is that it comes from the capability, which can therefore still say no.
    expect(h.workspace.routes("z")).toBe(true);
    retainPeers(["a", "old"]);
    expect(h.workspace.routes("z")).toBe(false);
    h.workspace.stop();
  });
});
