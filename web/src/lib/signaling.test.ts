import { describe, it, expect } from "vitest";
import { SignalingClient, type WebSocketLike } from "./signaling";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close() {}
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
});
