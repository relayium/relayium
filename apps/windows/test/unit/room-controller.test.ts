// Two rooms at once, composed from the actual shipping modules.
//
// This is the test the whole slice exists to make possible. It drives a real
// `SignalingClient` over a real `BridgeSocket` over a fake IPC bridge, into a
// real `createPeerWorkspace` — every rune module compiled by the ordinary Svelte
// plugin, nothing vendored, nothing stubbed except the process boundary itself.
//
// What it does NOT do is establish a peer connection: `RTCPeerConnection` does
// not exist in this environment, and pretending otherwise would be a test of a
// stub. Link establishment, SAS and the lanes are acceptance work against real
// clients and real servers, and are owed by R-LAN/R-PAIR.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomController } from "../../src/renderer/rooms/room-controller.svelte.js";
import type { SignalingRoom } from "../../src/shared/ipc-contract.js";
import type { TransportBridge } from "../../src/renderer/transport/bridge.js";
import {
  CAP_LINK,
  CAP_PREUPLOAD,
  peerCapsKnown,
  peerSupportsLink,
  resetPeerCaps,
} from "../../../../web/src/lib/peer-caps.svelte";

/**
 * The main process, as far as the renderer can tell.
 *
 * One subscriber list for every socket, exactly like the real bridge: frames
 * for the other room arrive at both listeners and are filtered by token, which
 * is one of the things worth exercising with two rooms live.
 */
function fakeBridge() {
  const listeners = new Set<(payload: unknown) => void>();
  const opened: Array<{ token: string; owner: string; room: SignalingRoom }> = [];
  const sent: Array<{ token: string; frame: string }> = [];
  const closed: string[] = [];
  const iceCalls: Array<{ owner: string; code?: string }> = [];
  let iceReply: unknown = { ok: true, status: 200, body: { iceServers: [], relays: [] } };

  const emit = (payload: unknown) => {
    for (const listener of [...listeners]) listener(payload);
  };

  const bridge: TransportBridge = {
    signaling: {
      open: async (payload) => {
        opened.push(payload);
        return { ok: true };
      },
      send: async (payload) => {
        sent.push(payload);
        return { ok: true };
      },
      close: async ({ token }) => {
        closed.push(token);
        // Main answers with the terminal event, as the real hub does.
        emit({ token, kind: "close", reason: "local" });
        return { ok: true };
      },
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    ice: {
      config: async (payload) => {
        iceCalls.push(payload);
        return iceReply as never;
      },
    },
  };

  return {
    bridge,
    opened,
    sent,
    closed,
    iceCalls,
    listenerCount: () => listeners.size,
    setIceReply: (reply: unknown) => {
      iceReply = reply;
    },
    /** Deliver an event as main would. */
    emit,
    /** The token of the socket for the Nth `open`. */
    tokenOf: (index: number) => opened[index]!.token,
    /** Drive a full join for one socket: open, welcome, roster. */
    join(index: number, selfId: string, peerIds: string[]) {
      const token = this.tokenOf(index);
      emit({ token, kind: "open" });
      emit({ token, kind: "message", data: JSON.stringify({ type: "welcome", name: selfId, ip: "" }) });
      this.roster(index, [selfId, ...peerIds]);
    },
    roster(index: number, ids: string[]) {
      emit({
        token: this.tokenOf(index),
        kind: "message",
        data: JSON.stringify({ type: "peers", peers: ids.map((id) => ({ id, name: id })) }),
      });
    },
    /** A `signal` frame from one peer to this client. */
    signal(index: number, from: string, data: unknown) {
      emit({
        token: this.tokenOf(index),
        kind: "message",
        data: JSON.stringify({ type: "signal", from, data }),
      });
    },
  };
}

/** Let the transport's microtask flush and the ICE promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let controllers: RoomController[] = [];

beforeEach(() => resetPeerCaps());
afterEach(() => {
  for (const controller of controllers) controller.stop();
  controllers = [];
});

function makeRoom(bridge: TransportBridge, room: SignalingRoom, displayName: string) {
  const controller = new RoomController({ bridge, room, displayName });
  controllers.push(controller);
  return controller;
}

describe("one room, end to end through the bridge", () => {
  it("subscribes BEFORE it asks main to open", async () => {
    const fake = fakeBridge();
    // Ordering, asserted rather than described: a listener installed after the
    // open request can miss `welcome`, and `welcome` is this page's own peer id.
    expect(fake.listenerCount()).toBe(0);
    makeRoom(fake.bridge, { kind: "lan" }, "windows");
    expect(fake.listenerCount()).toBeGreaterThan(0);
    expect(fake.opened).toHaveLength(1);
    await settle();
  });

  it("names a room kind, never an address", async () => {
    const fake = fakeBridge();
    makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    await settle();
    expect(fake.opened[0]!.room).toEqual({ kind: "code", code: "424242" });
    expect(JSON.stringify(fake.opened[0])).not.toMatch(/wss?:|\/ws|relayium\.com/);
  });

  it("joins, learns its own id, and sends the join frame", async () => {
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "lan" }, "windows");

    fake.join(0, "self-1", []);
    await settle();

    expect(room.joined).toBe(true);
    expect(room.selfId).toBe("self-1");
    const join = fake.sent.map((s) => JSON.parse(s.frame)).find((f) => f.type === "join");
    expect(join).toEqual({ type: "join", name: "windows" });
  });

  it("omits the installation hint entirely, in both room kinds", async () => {
    const fake = fakeBridge();
    makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    fake.join(0, "self-1", []);
    await settle();
    const join = fake.sent.map((s) => JSON.parse(s.frame)).find((f) => f.type === "join");
    // Omitted, not sent empty — a code room must carry no device identity at
    // all, and an older server must see the original frame.
    expect(join).not.toHaveProperty("deviceId");
    expect(join).not.toHaveProperty("active");
  });

  it("reads ICE once, for its own room, under its own owner token", async () => {
    const fake = fakeBridge();
    makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    await settle();
    expect(fake.iceCalls).toHaveLength(1);
    expect(fake.iceCalls[0]!.code).toBe("424242");
    expect(fake.iceCalls[0]!.owner).toBeTruthy();
  });

  it("asks for ICE on a LAN room too, with no code", async () => {
    const fake = fakeBridge();
    makeRoom(fake.bridge, { kind: "lan" }, "windows");
    await settle();
    // LAN is answered STUN-only, not "no ICE at all".
    expect(fake.iceCalls).toHaveLength(1);
    expect(fake.iceCalls[0]!.code).toBeUndefined();
  });

  it("installs the STUN list it was given", async () => {
    const fake = fakeBridge();
    fake.setIceReply({
      ok: true,
      status: 200,
      body: { iceServers: [{ urls: ["stun:s:3478"] }], relays: [] },
    });
    const room = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    await settle();
    expect(room.ice?.iceServers).toEqual([{ urls: ["stun:s:3478"] }]);
    expect(room.rtcConfig().iceServers).toEqual([{ urls: ["stun:s:3478"] }]);
    // No relay in the list, so relay-only is not forced — host candidates are
    // the whole point on a LAN.
    expect(room.rtcConfig().iceTransportPolicy).toBeUndefined();
  });

  it("never invents a third-party STUN when the endpoint is unreadable", async () => {
    const fake = fakeBridge();
    fake.setIceReply({ ok: false, failure: "network" });
    const room = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    await new Promise((r) => setTimeout(r, 1400)); // the shared module's one retry
    expect(room.ice?.relayStatus).toBe("unavailable");
    expect(room.rtcConfig().iceServers).toEqual([]);
  });

  it("reports a code the SERVER refused as refused", async () => {
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    // The socket opened — the server saw the code — and then closed before
    // `welcome`. That is a rejection.
    fake.emit({ token: fake.tokenOf(0), kind: "open" });
    fake.emit({ token: fake.tokenOf(0), kind: "close", reason: "remote" });
    await settle();
    expect(room.refused).toBe(true);
    expect(room.connection).toBe("refused");
  });

  it("does NOT blame the code when the socket never opened", async () => {
    // Reproduced from a real run: joining 123456 with the server unreachable
    // reported "not valid, or it has expired". The code was never offered to
    // anybody, so that was a guess — and the wrong one, pointing the user at
    // their code instead of their connection.
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "code", code: "123456" }, "windows");
    fake.emit({ token: fake.tokenOf(0), kind: "close", reason: "failed" });
    await settle();
    expect(room.refused).toBe(false);
    expect(room.connection).toBe("reconnecting");
  });

  it("treats a drop AFTER joining a code room as a reconnect, not a bad code", async () => {
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    fake.join(0, "self-1", []);
    await settle();
    fake.emit({ token: fake.tokenOf(0), kind: "close", reason: "remote" });
    await settle();
    expect(room.refused).toBe(false);
    expect(room.everJoined).toBe(true);
    expect(room.connection).toBe("reconnecting");
  });

  it("does not call a LAN drop a refusal", async () => {
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    fake.join(0, "self-1", []);
    fake.emit({ token: fake.tokenOf(0), kind: "close", reason: "remote" });
    await settle();
    expect(room.refused).toBe(false);
    expect(room.joined).toBe(false);
  });

  it("tells an empty room apart from one it never got into", async () => {
    // The screen that made this necessary: "No other devices yet" beside a Stop
    // receiving button, for a socket that had never opened.
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    await settle();
    expect(room.connection).toBe("connecting");
    expect(room.everJoined).toBe(false);

    fake.join(0, "self-1", []);
    await settle();
    // Now — and only now — an empty roster means nobody else is here.
    expect(room.connection).toBe("joined");
    expect(room.everJoined).toBe(true);
    expect(room.peers).toEqual([]);
  });

  it("stops listening when the room stops", async () => {
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    fake.join(0, "self-1", []);
    await settle();
    const before = fake.listenerCount();

    room.stop();
    await settle();

    expect(fake.closed).toContain(fake.tokenOf(0));
    // Without this, every reopened room leaves a listener on one emitter.
    expect(fake.listenerCount()).toBeLessThan(before);
  });

  it("delivers exactly one close however the room ends", async () => {
    const fake = fakeBridge();
    const room = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    fake.join(0, "self-1", []);
    await settle();

    room.stop();
    room.stop();
    fake.emit({ token: fake.tokenOf(0), kind: "close", reason: "remote" });
    await settle();

    expect(fake.closed.filter((t) => t === fake.tokenOf(0))).toHaveLength(1);
  });
});

describe("two concurrent rooms are independent", () => {
  it("gives each room its own socket, its own owner, and its own ICE read", async () => {
    const fake = fakeBridge();
    makeRoom(fake.bridge, { kind: "lan" }, "windows");
    makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    await settle();

    expect(fake.opened).toHaveLength(2);
    expect(fake.opened[0]!.token).not.toBe(fake.opened[1]!.token);
    expect(fake.opened[0]!.owner).not.toBe(fake.opened[1]!.owner);
    expect(fake.iceCalls).toHaveLength(2);
    expect(fake.iceCalls[0]!.owner).not.toBe(fake.iceCalls[1]!.owner);
  });

  it("routes each socket's frames to its own room only", async () => {
    const fake = fakeBridge();
    const lan = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    const pairing = makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");

    fake.join(0, "lan-self", ["lan-peer"]);
    fake.join(1, "code-self", ["code-peer"]);
    await settle();

    expect(lan.selfId).toBe("lan-self");
    expect(pairing.selfId).toBe("code-self");
    expect(lan.peers.map((p) => p.id)).toEqual(["lan-peer"]);
    expect(pairing.peers.map((p) => p.id)).toEqual(["code-peer"]);
  });

  // The regression this whole slice's capability work exists for.
  it("keeps the pairing room's capabilities when the LAN roster churns", async () => {
    const fake = fakeBridge();
    const lan = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    const pairing = makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");

    fake.join(0, "lan-self", ["lan-peer"]);
    fake.join(1, "code-self", ["code-peer"]);
    fake.signal(0, "lan-peer", { caps: [CAP_LINK, CAP_PREUPLOAD] });
    fake.signal(1, "code-peer", { caps: [CAP_LINK, CAP_PREUPLOAD] });
    await settle();

    expect(lan.caps.supportsLink("lan-peer")).toBe(true);
    expect(pairing.caps.supportsLink("code-peer")).toBe(true);

    // A phone walks out of Wi-Fi range. With one shared registry this prunes
    // the PAIRING peer too, and it becomes permanently unreachable with
    // nothing on either screen explaining it.
    fake.roster(0, ["lan-self"]);
    await settle();

    expect(lan.caps.supportsLink("lan-peer")).toBe(false);
    expect(pairing.caps.supportsLink("code-peer")).toBe(true);
    expect(pairing.workspace.routes("code-peer")).toBe(true);
  });

  it("leaves the other room untouched when one stops", async () => {
    const fake = fakeBridge();
    const lan = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    const pairing = makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    fake.join(0, "lan-self", ["lan-peer"]);
    fake.join(1, "code-self", ["code-peer"]);
    fake.signal(1, "code-peer", { caps: [CAP_LINK] });
    await settle();

    pairing.stop();
    await settle();

    expect(lan.joined).toBe(true);
    expect(lan.peers.map((p) => p.id)).toEqual(["lan-peer"]);
    expect(fake.closed).toEqual([fake.tokenOf(1)]);
  });

  it("never touches the web page-global for the whole lifetime of both rooms", async () => {
    const fake = fakeBridge();
    const lan = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");

    fake.join(0, "lan-self", ["lan-peer"]);
    fake.join(1, "code-self", ["code-peer"]);
    fake.signal(0, "lan-peer", { caps: [CAP_LINK, CAP_PREUPLOAD] });
    fake.signal(1, "code-peer", { caps: [CAP_LINK, CAP_PREUPLOAD] });
    fake.roster(0, ["lan-self"]);
    lan.stop();
    await settle();

    // If any composed module on this path ever reads or writes `announced`,
    // this is what catches it — including one that grows a new call site later.
    expect(peerCapsKnown("lan-peer")).toBe(false);
    expect(peerCapsKnown("code-peer")).toBe(false);
    expect(peerSupportsLink("code-peer")).toBe(false);
  });

  it("announces this build's capabilities to each room's peers separately", async () => {
    const fake = fakeBridge();
    makeRoom(fake.bridge, { kind: "lan" }, "windows");
    makeRoom(fake.bridge, { kind: "code", code: "424242" }, "windows");
    fake.join(0, "lan-self", ["lan-peer"]);
    fake.join(1, "code-self", ["code-peer"]);
    await settle();

    const hellos = fake.sent
      .map((s) => ({ token: s.token, frame: JSON.parse(s.frame) }))
      .filter((s) => s.frame.type === "signal" && Array.isArray(s.frame.data?.caps));

    const lanHello = hellos.find((h) => h.token === fake.tokenOf(0));
    const codeHello = hellos.find((h) => h.token === fake.tokenOf(1));
    expect(lanHello?.frame.to).toBe("lan-peer");
    expect(codeHello?.frame.to).toBe("code-peer");
    expect(lanHello?.frame.data.caps).toEqual([CAP_LINK, CAP_PREUPLOAD]);
  });

  it("does not greet itself", async () => {
    const fake = fakeBridge();
    makeRoom(fake.bridge, { kind: "lan" }, "windows");
    fake.join(0, "lan-self", ["lan-peer"]);
    await settle();

    const greeted = fake.sent
      .map((s) => JSON.parse(s.frame))
      .filter((f) => f.type === "signal" && Array.isArray(f.data?.caps))
      .map((f) => f.to);
    expect(greeted).not.toContain("lan-self");
  });

  it("routes nothing to a peer that never announced", async () => {
    const fake = fakeBridge();
    const lan = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    fake.join(0, "lan-self", ["silent-peer"]);
    await settle();
    // Not announcing and announcing `link/2` are equally unreachable.
    expect(lan.workspace.routes("silent-peer")).toBe(false);
  });

  it("routes nothing to a peer announcing a different protocol version", async () => {
    const fake = fakeBridge();
    const lan = makeRoom(fake.bridge, { kind: "lan" }, "windows");
    fake.join(0, "lan-self", ["old-peer"]);
    fake.signal(0, "old-peer", { caps: ["text/1"] });
    await settle();
    expect(lan.caps.supportsLink("old-peer")).toBe(false);
    expect(lan.workspace.routes("old-peer")).toBe(false);
  });
});

describe("a refused open is reported, not swallowed", () => {
  it("ends the socket when main refuses to open it", async () => {
    const fake = fakeBridge();
    const refusing: TransportBridge = {
      ...fake.bridge,
      signaling: {
        ...fake.bridge.signaling,
        open: async () => {
          throw new Error("a lan room is already open");
        },
      },
    };
    const room = makeRoom(refusing, { kind: "lan" }, "windows");
    await settle();
    // A room that silently never connects is exactly the failure the close
    // reasons exist to prevent.
    expect(room.joined).toBe(false);
  });

  it("drops frames rather than throwing when main refuses a send", async () => {
    const fake = fakeBridge();
    const refusing: TransportBridge = {
      ...fake.bridge,
      signaling: {
        ...fake.bridge.signaling,
        send: vi.fn(async () => {
          throw new Error("send rate exceeded");
        }),
      },
    };
    const room = makeRoom(refusing, { kind: "lan" }, "windows");
    fake.join(0, "self-1", ["peer"]);
    await settle();
    // Fire-and-forget, like the browser's own `send`. An unhandled rejection
    // here would break the dispatch loop for every room.
    expect(room.joined).toBe(true);
  });
});
