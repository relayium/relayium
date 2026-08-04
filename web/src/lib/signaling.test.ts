import { describe, it, expect } from "vitest";
import { SignalingClient, type WebSocketLike } from "./signaling";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url = "") {}
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  raw(data: string) { this.onmessage?.({ data }); }
}

describe("SignalingClient", () => {
  it("sends join on open and routes welcome/peers/signal", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    let selfId = "";
    let peers = 0;
    let signalFrom = "";
    c.onSelfId((id) => (selfId = id));
    c.onPeers((p) => (peers = p.length));
    c.onSignal((from) => (signalFrom = from));

    sock.onopen?.();
    expect(JSON.parse(sock.sent[0])).toMatchObject({ type: "join", name: "Alice" });

    sock.emit({ type: "welcome", name: "abc123" });
    sock.emit({ type: "peers", peers: [{ id: "abc123", name: "Alice" }, { id: "def", name: "Bob" }] });
    sock.emit({ type: "signal", from: "def", data: { sdp: "x" } });

    expect(selfId).toBe("abc123");
    expect(peers).toBe(2);
    expect(signalFrom).toBe("def");
  });

  it("ignores malformed frames without throwing or firing callbacks", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    let selfId = "", peers = -1, signalFrom = "";
    c.onSelfId((id) => (selfId = id));
    c.onPeers((p) => (peers = p.length));
    c.onSignal((from) => (signalFrom = from));
    sock.onopen?.();

    // Non-JSON, JSON null, non-object, missing/typeless discriminant, and
    // wrong-typed payload fields must all be dropped silently.
    expect(() => {
      sock.raw("}{ not json");
      sock.raw("null");
      sock.raw("42");
      sock.emit({ no: "type" });
      sock.emit({ type: 123 });
      sock.emit({ type: "welcome" }); // name missing
      sock.emit({ type: "peers", peers: "not-an-array" });
      sock.emit({ type: "signal" }); // from missing
    }).not.toThrow();
    expect(selfId).toBe("");
    expect(peers).toBe(-1);
    expect(signalFrom).toBe("");

    // A well-formed frame after the bad ones still routes.
    sock.emit({ type: "welcome", name: "ok1" });
    expect(selfId).toBe("ok1");
  });

  it("treats a roster frame with no peers as an empty roster", () => {
    // Current servers send an explicit empty array, but an older server can
    // omit it. Since grouping, a client CAN legitimately be told "you can see
    // nobody"; dropping that frame leaves the departed peer on screen forever.
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    let peers: unknown[] | null = null;
    c.onPeers((p) => (peers = p));
    sock.onopen?.();
    sock.emit({ type: "peers", peers: [{ id: "b", name: "B" }] });
    expect(peers).toHaveLength(1);
    sock.emit({ type: "peers" });
    expect(peers).toEqual([]);
  });

  it("reports an explicit physical peer departure separately from a roster handoff", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    const left: string[] = [];
    c.onPeerLeft((peerId) => left.push(peerId));
    sock.onopen?.();

    // A representative changing in a roster is not a departure event.
    sock.emit({ type: "peers", peers: [{ id: "new-page", name: "Phone" }] });
    expect(left).toEqual([]);
    sock.emit({ type: "left", peer: "old-page" });
    expect(left).toEqual(["old-page"]);

    // Missing/empty/wrong-typed peer ids are malformed and ignored.
    sock.emit({ type: "left" });
    sock.emit({ type: "left", peer: "" });
    sock.emit({ type: "left", peer: 42 });
    expect(left).toEqual(["old-page"]);
  });

  it("surfaces the server-observed public IP from the welcome", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    let selfIP = "";
    c.onSelfId((_id, ip) => (selfIP = ip));
    sock.onopen?.();
    sock.emit({ type: "welcome", name: "abc123", ip: "198.51.100.9" });
    expect(selfIP).toBe("198.51.100.9");
  });

  it("reports an empty IP when the welcome omits it", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    let selfIP = "unset";
    c.onSelfId((_id, ip) => (selfIP = ip));
    sock.onopen?.();
    sock.emit({ type: "welcome", name: "abc123" });
    expect(selfIP).toBe("");
  });

  it("delivers a signal to all registered onSignal listeners", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    const got: string[] = [];
    c.onSignal((from) => got.push("a:" + from));
    c.onSignal((from) => got.push("b:" + from));
    sock.onopen?.();
    sock.emit({ type: "signal", from: "peer9", data: { sdp: "x" } });
    expect(got).toEqual(["a:peer9", "b:peer9"]);
  });

  it("stamps the target on sendSignal", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    sock.onopen?.();
    c.sendSignal("def", { ice: "candidate" });
    const last = JSON.parse(sock.sent[sock.sent.length - 1]);
    expect(last).toMatchObject({ type: "signal", to: "def", data: { ice: "candidate" } });
  });

  it("invokes onClose when the socket closes", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    let closed = false;
    c.onClose(() => (closed = true));
    sock.onclose?.();
    expect(closed).toBe(true);
  });

  it("reconnect opens a fresh socket at the new url, closes the old, keeps callbacks", () => {
    const made: FakeSocket[] = [];
    const c = new SignalingClient("ws://room-a", "Alice", (u) => {
      const s = new FakeSocket(u);
      made.push(s);
      return s;
    });
    let peers = 0;
    c.onPeers((p) => (peers = p.length));

    c.reconnect("ws://room-b");
    expect(made).toHaveLength(2);
    expect(made[0].closed).toBe(true);
    expect(made[1].url).toBe("ws://room-b");

    // join is sent on the new socket's open, and callbacks still route.
    made[1].onopen?.();
    expect(JSON.parse(made[1].sent[0])).toMatchObject({ type: "join", name: "Alice" });
    made[1].emit({ type: "peers", peers: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    expect(peers).toBe(2);
  });

  it("reconnect does not fire onClose (intentional room swap, not a drop)", () => {
    const made: FakeSocket[] = [];
    const c = new SignalingClient("ws://room-a", "Alice", (u) => {
      const s = new FakeSocket(u);
      made.push(s);
      return s;
    });
    let closes = 0;
    c.onClose(() => closes++);
    c.reconnect("ws://room-b");
    // The old socket was closed by us, but its onclose was detached first.
    made[0].onclose?.(); // even if the platform later fires it, it must be a no-op
    expect(closes).toBe(0);
    // A genuine close on the live socket still surfaces.
    made[1].onclose?.();
    expect(closes).toBe(1);
  });
});

describe("SignalingClient LAN presence", () => {
  // The presence hook is what makes a join say "these tabs are one device".
  // It is deliberately a pair of getters: the room can change under a live
  // client (reconnect), and a page's focus changes constantly.
  const presenceOf = (deviceId: string, active = false) => ({
    deviceId: () => deviceId,
    active: () => active,
  });

  it("carries the installation id and the current-page state on join", () => {
    const sock = new FakeSocket();
    new SignalingClient("ws://x", "Alice", () => sock, presenceOf("f".repeat(32), true));
    sock.onopen?.();
    expect(JSON.parse(sock.sent[0])).toEqual({
      type: "join", name: "Alice", deviceId: "f".repeat(32), active: true,
    });
  });

  it("omits active on a join from a page that is not the current one", () => {
    const sock = new FakeSocket();
    new SignalingClient("ws://x", "Alice", () => sock, presenceOf("f".repeat(32), false));
    sock.onopen?.();
    const join = JSON.parse(sock.sent[0]);
    expect(join.deviceId).toBe("f".repeat(32));
    expect(join.active).toBeUndefined();
  });

  it("omits presence entirely when there is no installation id", () => {
    // A pairing-code room: two tabs of one browser pairing with each other are
    // two participants, and sending the id there would merge them into one.
    const sock = new FakeSocket();
    new SignalingClient("ws://x", "Alice", () => sock, presenceOf("", true));
    sock.onopen?.();
    const join = JSON.parse(sock.sent[0]);
    expect(join).toEqual({ type: "join", name: "Alice" });
    expect(join).not.toHaveProperty("deviceId");
    expect(join).not.toHaveProperty("active");
  });

  it("re-evaluates presence on reconnect, so a room switch drops it", () => {
    const made: FakeSocket[] = [];
    let deviceId = "f".repeat(32);
    const c = new SignalingClient("ws://lan", "Alice", (u) => {
      const s = new FakeSocket(u);
      made.push(s);
      return s;
    }, { deviceId: () => deviceId, active: () => true });
    made[0].onopen?.();
    expect(JSON.parse(made[0].sent[0]).deviceId).toBe("f".repeat(32));

    deviceId = ""; // switched into a pairing-code room
    c.reconnect("ws://code");
    made[1].onopen?.();
    expect(JSON.parse(made[1].sent[0])).toEqual({ type: "join", name: "Alice" });
  });

  it("sends an activation frame only when this connection has an identity", () => {
    const withId = new FakeSocket();
    const c1 = new SignalingClient("ws://x", "Alice", () => withId, presenceOf("f".repeat(32)));
    withId.onopen?.();
    c1.sendActivate();
    expect(JSON.parse(withId.sent[1])).toEqual({ type: "activate" });

    const without = new FakeSocket();
    const c2 = new SignalingClient("ws://x", "Alice", () => without, presenceOf(""));
    without.onopen?.();
    c2.sendActivate();
    expect(without.sent).toHaveLength(1); // the join, and nothing else
  });

  it("joins exactly as before when no presence hook is supplied", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    sock.onopen?.();
    expect(JSON.parse(sock.sent[0])).toEqual({ type: "join", name: "Alice" });
    c.sendActivate();
    expect(sock.sent).toHaveLength(1);
  });
});

describe("SignalingClient.send 在重连窗口里", () => {
  it("socket 已关时既不发也不抛（即发即忘的调用点不该产生 unhandled rejection）", () => {
    class ClosedSocket extends FakeSocket {
      readonly readyState = 3; // CLOSED
    }
    const sock = new ClosedSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    expect(() => c.sendSignal("peer", { hi: true })).not.toThrow();
    expect(sock.sent).toEqual([]);
  });

  it("send 本身抛 InvalidStateError 也被吞掉", () => {
    class ThrowingSocket extends FakeSocket {
      readonly readyState = 1; // OPEN，但底层仍可能抛
      send() { throw new DOMException("still in CONNECTING state", "InvalidStateError"); }
    }
    const c = new SignalingClient("ws://x", "Alice", () => new ThrowingSocket());
    expect(() => c.sendSignal("peer", { hi: true })).not.toThrow();
  });
});
