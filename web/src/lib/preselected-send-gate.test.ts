import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
import { generateKeyPair, ready } from "./crypto";
import { canReleaseConfirmedSend } from "./confirm-send";
import { clearOutbox, outbox, setOutbox, takeOutbox } from "./outbox.svelte";
import { createPeerWorkspace, type PeerWorkspace } from "./peer-workspace.svelte";
import { needsSendConfirmation, shownSasCode } from "./verify-gates";
import type { Peer } from "./protocol";
import type { SignalingClient } from "./signaling";
import type { TextSession } from "./text-session.svelte";
import type { TransferSession } from "./transfer-session.svelte";
import type { Conn, ConnectOpts, InboundSignal } from "./webrtc";

// The preselected-batch journey, end to end through the REAL objects: the shared
// outbox module, a real peer workspace over a stubbed transport, and the real
// release gate. What it proves is a SEQUENCE, which no single rendered state and
// no source grep can show — a queued batch exists before the link does, so the
// bar's Send is offered while the code it tells you to compare has not been
// computed yet.
//
// App.svelte's own wiring (that its handler and its button both read this gate,
// and that opening the workspace never drains) is pinned separately in
// workspace-orchestration.test.ts; App is not mountable here because it owns the
// signalling socket, the ICE fetch and the service-worker registration.

beforeAll(async () => { await ready(); });
beforeEach(() => { clearOutbox(); });

function channel(label: string) {
  return {
    label, readyState: "open", binaryType: "blob", bufferedAmount: 0,
    onmessage: null, onclose: null, send: vi.fn(), close: vi.fn(),
  } as unknown as RTCDataChannel;
}

/** A code room with advanced verification ON — the only mode in which the send
 *  confirmation exists at all. */
const ROOM_CODE = "483920";
const VERIFY_ON = true;

function setup() {
  const signaling = {
    onSignal: () => () => {},
    sendSignal: vi.fn(),
  } as unknown as SignalingClient;
  const connect = vi.fn(async (opts: ConnectOpts): Promise<Conn> => {
    const file = channel("relayium");
    const text = channel("relayium-text");
    opts.onPeerKey(generateKeyPair().publicKey);
    return {
      channel: file,
      getChannel: (l) => l === "relayium" ? file : l === "relayium-text" ? text : undefined,
      close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES, path: async () => "relay",
      stats: async () => new Map() as unknown as RTCStatsReport,
    };
  });
  const legacyFiles = {
    incoming: null, recv: null, send: null, sasCode: "", sendPath: undefined,
    recvPath: undefined, busy: false, transferActive: false,
    sendFiles: vi.fn(), accept: vi.fn(), reject: vi.fn(), abort: vi.fn(),
    abortAll: vi.fn(), dismissSend: vi.fn(), dismissRecv: vi.fn(), reset: vi.fn(),
    conn: vi.fn(),
  } as unknown as TransferSession;
  const legacyText = {
    status: "idle", peerId: "", sasCode: "", path: undefined, history: [], errorKey: "",
    openWith: vi.fn(), accept: vi.fn(), reject: vi.fn(), send: vi.fn(), end: vi.fn(),
    clearHistory: vi.fn(), active: () => false,
  } as unknown as TextSession;
  const workspace = createPeerWorkspace({
    selfId: () => "a",
    joined: () => true,
    peerIds: () => ["a", "z"],
    unsupported: () => false,
    signaling: () => signaling,
    rtcConfig: () => ({ iceServers: [] }),
    legacyFiles,
    legacyText,
    supportsLink: () => true,
    connect,
  });
  return { workspace, legacyFiles, connect, ...app(workspace) };
}

/**
 * The four pieces of App.svelte this journey runs through, written the way App
 * writes them. Each line here has a matching source assertion in
 * workspace-orchestration.test.ts, so a divergence fails there rather than
 * passing quietly in both places.
 */
function app(workspace: PeerWorkspace) {
  let pendingPeer: Peer | null = null;
  let dismissedPeerId: string | null = null;
  const shownSas = () => shownSasCode(VERIFY_ON, workspace.sasCode);
  const canRelease = () => {
    const target = pendingPeer;
    if (!target) return false;
    return canReleaseConfirmedSend({
      confirmed: needsSendConfirmation(VERIFY_ON, ROOM_CODE),
      unified: workspace.routes(target.id),
      targetPeerId: target.id,
      linkPeerId: workspace.hasLink ? workspace.linkPeerId : "",
      shownSas: shownSas(),
    });
  };
  return {
    shownSas, canRelease,
    peer: () => pendingPeer,
    /** App's auto-send effect, for the one shape this file is about: a queue, a
     *  single reachable peer, and a code room with verification on. */
    armBar(peer: Peer) {
      if (!outbox().length || workspace.blocksNewIntent(peer.id)) { pendingPeer = null; return; }
      if (!needsSendConfirmation(VERIFY_ON, ROOM_CODE)) {
        workspace.sendFiles(peer.id, takeOutbox());
        return;
      }
      if (!pendingPeer && peer.id !== dismissedPeerId) pendingPeer = peer;
    },
    confirmSend() {
      if (!pendingPeer || !canRelease()) return;
      const id = pendingPeer.id;
      pendingPeer = null;
      workspace.sendFiles(id, takeOutbox());
    },
    cancelSend() {
      if (!pendingPeer) return;
      dismissedPeerId = pendingPeer.id;
      pendingPeer = null;
    },
    releaseQueued() {
      const peerId = workspace.hasLink ? workspace.linkPeerId : "";
      if (!peerId || !outbox().length) return;
      dismissedPeerId = null;
      pendingPeer = { id: peerId, name: peerId } as Peer;
    },
    async openWorkspace(peerId: string) {
      if (workspace.blocksNewIntent(peerId)) return;
      if (outbox().length && !needsSendConfirmation(VERIFY_ON, ROOM_CODE)) {
        workspace.sendFiles(peerId, takeOutbox());
        return;
      }
      await workspace.openText(peerId);
    },
  };
}

const target = { id: "z", name: "Tab Z" } as Peer;
const queued = () => [{ file: new File(["payload"], "shared.bin") }];

describe("a preselected batch meeting a unified peer", () => {
  it("cannot be released until the workspace is showing that link's code", async () => {
    const h = setup();
    setOutbox(queued());

    // 1. The bar arms the instant the peer is reachable — with no link, so no
    //    verification code has been computed and none is on screen.
    h.armBar(target);
    expect(h.peer()).toEqual(target);
    expect(h.workspace.hasLink).toBe(false);
    expect(h.shownSas()).toBe("");
    expect(h.canRelease()).toBe(false);

    // 2. Confirming here does nothing at all: the files stay queued, no link is
    //    built, and the bar is still up rather than silently dismissed.
    h.confirmSend();
    expect(outbox()).toHaveLength(1);
    expect(h.workspace.hasLink).toBe(false);
    expect(h.workspace.mixed.file.send).toBeNull();
    expect(h.workspace.mixed.file.queued).toHaveLength(0);
    expect(h.legacyFiles.sendFiles).not.toHaveBeenCalled();
    expect(h.peer()).toEqual(target);

    // 3. Opening the workspace builds the link and drains NOTHING — the whole
    //    point: looking at the code must not be the thing that sends.
    await h.openWorkspace(target.id);
    expect(outbox()).toHaveLength(1);
    expect(h.workspace.hasLink).toBe(true);
    expect(h.workspace.linkPeerId).toBe("z");
    expect(h.workspace.mixed.file.send).toBeNull();

    // 4. Now there is a code on screen, for this peer, and only now may Send go.
    expect(h.shownSas()).not.toBe("");
    expect(h.canRelease()).toBe(true);
    h.confirmSend();
    expect(outbox()).toHaveLength(0);
    await vi.waitFor(() => expect(h.workspace.mixed.file.send?.peer).toBe("z"));
    h.workspace.stop();
  });

  it("keeps the persistent re-arm after Cancel, and that path is gated too", async () => {
    const h = setup();
    setOutbox(queued());
    h.armBar(target);

    // Cancel before any link: the files are still queued and the bar is spent
    // for this peer, exactly as before.
    h.cancelSend();
    expect(h.peer()).toBeNull();
    expect(outbox()).toHaveLength(1);
    h.armBar(target);
    expect(h.peer()).toBeNull();

    // The way back is the workspace's own release control, which re-arms the
    // SAME bar rather than sending…
    await h.openWorkspace(target.id);
    expect(outbox()).toHaveLength(1);
    h.releaseQueued();
    expect(h.peer()?.id).toBe("z");
    expect(outbox()).toHaveLength(1);

    // …and by now the link is live, so the comparison is available and the
    // release is allowed.
    expect(h.canRelease()).toBe(true);
    h.confirmSend();
    expect(outbox()).toHaveLength(0);
    await vi.waitFor(() => expect(h.workspace.mixed.file.send?.peer).toBe("z"));
    h.workspace.stop();
  });

  it("closes again if the link ends before the user answers the bar", async () => {
    const h = setup();
    setOutbox(queued());
    h.armBar(target);
    await h.openWorkspace(target.id);
    expect(h.canRelease()).toBe(true);

    // An ended link still NAMES its peer (the workspace stays on screen to say
    // so), but its code is gone. Releasing against it would build a second link
    // and send over a SAS nobody ever saw.
    h.workspace.disconnect();
    expect(h.workspace.hasLink).toBe(false);
    expect(h.canRelease()).toBe(false);
    h.confirmSend();
    expect(outbox()).toHaveLength(1);
    h.workspace.stop();
  });
});
