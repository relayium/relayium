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
