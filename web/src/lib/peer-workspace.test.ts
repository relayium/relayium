import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
import { generateKeyPair, ready } from "./crypto";
import { CAP_LINK, CAP_TEXT, peerSupportsLink, recordPeerCaps, resetPeerCaps } from "./peer-caps.svelte";
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

  it("ends an established mixed link only when that physical peer leaves", async () => {
    const h = setup();
    await h.workspace.mixed.ensure("z");
    const conn = h.workspace.mixed.link!.conn;
    h.workspace.peerLeft("unrelated");
    expect(h.workspace.mixed.link?.peerId).toBe("z");

    h.workspace.peerLeft("z");
    expect(h.workspace.mixed.link).toBeNull();
    expect(conn.close).toHaveBeenCalledOnce();
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

// ── the release scope of link/1 ────────────────────────────────────────────────
//
// A default build implements the unified link, so it advertises and routes it —
// but only in the code-less LAN room. Everything below runs the SHIPPED
// `peerSupportsLink` (no injected stub), because the point is what a real build
// does with a real roster claim.
//
// The pairing-code half is a policy test, not a preference: a signalling relay
// sees every frame and can inject one, so refusing to *say* `link/1` there is
// worth nothing unless we also refuse to *believe* it.
//
// It is deterministic here rather than in a real browser on purpose, and that is
// a limitation worth naming: `/api/pair` mints a cross-network code only for a
// logged-in account and the ws route rejects any code that was never minted, so
// the CDP harness cannot join a real pairing room at all. These cases are the
// whole proof of that policy — see web/e2e/README.md.
describe("peer workspace link/1 room scope", () => {
  beforeEach(() => { clearRoom(); resetPeerCaps(); });

  it("routes a link-capable peer in the code-less LAN room", async () => {
    const h = setup({ realLinkCaps: true });
    recordPeerCaps("z", { caps: [CAP_TEXT, CAP_LINK] });

    expect(h.workspace.routes("z")).toBe(true);

    const mixedFiles = vi.spyOn(h.workspace.mixed.file, "enqueue").mockImplementation(() => {});
    const picked = [{ file: new File(["x"], "x.txt") }];
    h.workspace.sendFiles("z", picked);
    expect(mixedFiles).toHaveBeenCalledWith("z", picked);
    expect(h.legacyFiles.sendFiles).not.toHaveBeenCalled();
    h.workspace.stop();
  });

  // Requirement 3 of the rollout, against the SHIPPED predicate rather than a
  // stub: a peer that never announced, or announced a different version, is a
  // legacy peer even on LAN — and must never be probed with a link request or a
  // two-channel offer it cannot answer. An old build reads such an offer as a
  // file transfer whose manifest never arrives, and waits out its stall watchdog.
  it.each([
    ["a peer that never announced", null],
    ["a peer that announced only text/1", [CAP_TEXT]],
    ["a peer announcing a different link version", [CAP_TEXT, "link/2"]],
  ])("leaves %s on the legacy path in the LAN room", async (_label, caps) => {
    const h = setup({ realLinkCaps: true });
    if (caps) recordPeerCaps("z", { caps });
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

  it("refuses to route a forged link/1 claim inside a pairing-code room", async () => {
    const h = setup({ realLinkCaps: true });
    recordPeerCaps("z", { caps: [CAP_TEXT, CAP_LINK] });
    enterRoom({ code: "123456" });

    expect(h.workspace.routes("z")).toBe(false);

    const mixedFiles = vi.spyOn(h.workspace.mixed.file, "enqueue").mockImplementation(() => {});
    const mixedText = vi.spyOn(h.workspace.mixed.text, "openWith").mockResolvedValue();
    const picked = [{ file: new File(["x"], "x.txt") }];
    h.workspace.sendFiles("z", picked);
    await h.workspace.openText("z");

    // The pairing room keeps exactly its existing one-mode-at-a-time behaviour.
    expect(mixedFiles).not.toHaveBeenCalled();
    expect(mixedText).not.toHaveBeenCalled();
    expect(h.legacyFiles.sendFiles).toHaveBeenCalledWith("z", picked);
    expect(h.legacyText.openWith).toHaveBeenCalledWith("z");
    h.workspace.stop();
  });

  it("never answers an inbound link request or offer from a pairing-code room", async () => {
    const h = setup({ realLinkCaps: true });
    recordPeerCaps("z", { caps: [CAP_TEXT, CAP_LINK] });
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
    expect(peerSupportsLink("z")).toBe(false);
    // And leaving the room again does not resurrect the old claim.
    clearRoom();
    expect(peerSupportsLink("z")).toBe(false);
    h.workspace.stop();
  });
});
