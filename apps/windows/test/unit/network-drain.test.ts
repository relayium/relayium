// Asking a socket to close is not the same as it closing.
//
// The hub retires a socket and nulls its handlers before calling `close()` —
// correct, because nothing further may be delivered under a token the renderer
// has given up — but it means the hub cannot see the close happen. A quit that
// treated `closeAll()` as a join reported a stopped network while a WebSocket
// was still tearing down. Same shape for an aborted ICE read: `abort()` stops
// this side WAITING; the request settles afterwards.

import { describe, expect, it } from "vitest";
import { SignalingHub, type SignalingSocketLike } from "../../src/main/net/signaling-socket.js";
import { IceRequestRegistry } from "../../src/main/net/ice-control.js";

function fakeSocket() {
  const socket: SignalingSocketLike & { closeCalls: number } = {
    closeCalls: 0,
    send() {},
    close() {
      socket.closeCalls += 1;
    },
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return socket;
}

function hubWith(sockets: Array<SignalingSocketLike>) {
  let index = 0;
  const hub = new SignalingHub({
    origin: "https://relayium.com",
    emit: () => undefined,
    factory: () => sockets[index++]!,
  });
  return hub;
}

describe("the signalling hub drains what it asked to close", () => {
  it("does not report a socket closed until it says so", async () => {
    const socket = fakeSocket();
    const hub = hubWith([socket]);
    hub.open("token-1", "room-1", { kind: "lan" }, 0);

    hub.closeAll();
    expect(socket.closeCalls).toBe(1);
    // Asked. Not yet observed — and this is exactly what a join must not skip.
    expect(hub.closingCount).toBe(1);

    const stillOpen = await hub.drainClosing(20);
    expect(stillOpen).toBe(1);

    // Now the socket actually closes.
    socket.onclose?.();
    expect(hub.closingCount).toBe(0);
    expect(await hub.drainClosing(20)).toBe(0);
  });

  it("returns as soon as the close arrives, rather than waiting out the deadline", async () => {
    const socket = fakeSocket();
    const hub = hubWith([socket]);
    hub.open("token-1", "room-1", { kind: "lan" }, 0);
    hub.closeAll();

    setTimeout(() => socket.onclose?.(), 5);
    const started = Date.now();
    expect(await hub.drainClosing(5_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("counts a socket whose close never arrives, and keeps the handle", async () => {
    const socket = fakeSocket();
    const hub = hubWith([socket]);
    hub.open("token-1", "room-1", { kind: "lan" }, 0);
    hub.closeAll();

    expect(await hub.drainClosing(10)).toBe(1);
    // Not dropped to make the number look better: it is still watched, so a
    // later close is still observed.
    expect(hub.closingCount).toBe(1);
    socket.onclose?.();
    expect(hub.closingCount).toBe(0);
  });

  it("does not treat a throwing close() as a closed socket", async () => {
    // The throw says the CALL failed. It may be gone; it may be wedged holding
    // a connection open, which is exactly the case worth reporting.
    const socket = fakeSocket();
    socket.close = () => {
      throw new Error("already gone");
    };
    const hub = hubWith([socket]);
    hub.open("token-1", "room-1", { kind: "lan" }, 0);
    hub.closeAll();

    expect(await hub.drainClosing(10)).toBe(1);
    // Unless the socket can answer for itself.
    (socket as unknown as { readyState: number }).readyState = 3;
    expect(await hub.drainClosing(10)).toBe(0);
  });

  it("does not treat an error as a close", async () => {
    // A WebSocket reports an error and THEN closes. The sockets that matter
    // here are the ones where the second event never comes; settling on the
    // first would report precisely those as finished.
    const socket = fakeSocket();
    const hub = hubWith([socket]);
    hub.open("token-1", "room-1", { kind: "lan" }, 0);
    hub.closeAll();

    socket.onerror?.();
    expect(await hub.drainClosing(10)).toBe(1);

    socket.onclose?.();
    expect(await hub.drainClosing(10)).toBe(0);
  });

  it("settles a socket that reports itself CLOSED without an event", async () => {
    const socket = fakeSocket();
    const hub = hubWith([socket]);
    hub.open("token-1", "room-1", { kind: "lan" }, 0);
    hub.closeAll();
    (socket as unknown as { readyState: number }).readyState = 3;
    expect(await hub.drainClosing(10)).toBe(0);
  });

  it("counts sockets that will not close against the ceiling", async () => {
    // Otherwise a peer that never closes lets the room be reopened again and
    // again, each attempt retaining one more connection while the ceiling
    // counts only the well-behaved ones.
    const sockets = Array.from({ length: 8 }, () => fakeSocket());
    const hub = hubWith(sockets);

    hub.open("token-1", "room-1", { kind: "lan" }, 0);
    hub.close("token-1");
    expect(hub.closingCount).toBe(1);

    hub.open("token-2", "room-2", { kind: "code", code: "004291" }, 0);
    hub.close("token-2");
    expect(hub.closingCount).toBe(2);

    // Two retained plus the ceiling of two means the next open is refused
    // rather than adding a third live connection.
    expect(() => hub.open("token-3", "room-3", { kind: "lan" }, 0)).toThrow(/ceiling/);

    for (const socket of sockets) socket.onclose?.();
    expect(hub.closingCount).toBe(0);
    expect(() => hub.open("token-4", "room-4", { kind: "lan" }, 0)).not.toThrow();
  });
});

describe("the ICE registry drains what it aborted", () => {
  it("does not report done while an aborted read is still settling", async () => {
    const registry = new IceRequestRegistry();
    const lease = registry.admit(0, "room-1");

    registry.abortAll();
    // The controller is aborted; the request has not released its lease yet,
    // which is what actually happens while a fetch unwinds.
    expect(lease.signal.aborted).toBe(true);
    expect(registry.inFlight).toBe(1);
    expect(await registry.drain(10)).toBe(1);

    lease.release();
    expect(await registry.drain(10)).toBe(0);
  });

  it("returns as soon as the last read settles", async () => {
    const registry = new IceRequestRegistry();
    const lease = registry.admit(0, "room-1");
    registry.abortAll();

    setTimeout(() => lease.release(), 5);
    const started = Date.now();
    expect(await registry.drain(5_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("is a no-op when nothing is outstanding", async () => {
    expect(await new IceRequestRegistry().drain(1_000)).toBe(0);
  });
});
