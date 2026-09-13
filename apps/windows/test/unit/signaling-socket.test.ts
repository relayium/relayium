// The main-owned signalling hub.
//
// Two kinds of assertion live here, and they are worth telling apart. The first
// pins this file's re-statements against the WEB module they mirror — the room
// URL and the code predicate — by importing the real web functions and
// comparing verdicts, so the duplication cannot drift silently. The second
// drives the hub's own refusals, which are the ones a renderer fault or a
// hostile server would reach.

import { describe, expect, it } from "vitest";
import {
  MAX_SIGNALING_FRAME_BYTES,
  MAX_SIGNALING_INBOUND_PER_SECOND,
  MAX_SIGNALING_SENDS_PER_SECOND,
  type SignalingEvent,
} from "../../src/shared/ipc-contract.js";
import {
  SignalingHub,
  SignalingRefusal,
  frameByteLength,
  isPermittedFrame,
  isWellFormedCode,
  signalingURL,
  type SignalingSocketLike,
} from "../../src/main/net/signaling-socket.js";
import { wsURL } from "../../../../web/src/lib/transfer-link";
import { isValidCode } from "../../../../web/src/lib/pair-code";

const ORIGIN = "https://relayium.example";

/** A socket a test drives directly. `bufferedAmount` is settable because
 *  backpressure is one of the bounds under test. */
class FakeSocket implements SignalingSocketLike {
  sent: string[] = [];
  closed = 0;
  bufferedAmount = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed += 1;
  }
}

function makeHub(now: () => number = () => 0) {
  const events: SignalingEvent[] = [];
  const created: FakeSocket[] = [];
  const hub = new SignalingHub({
    origin: ORIGIN,
    emit: (event) => events.push(event),
    factory: () => {
      const socket = new FakeSocket();
      created.push(socket);
      return socket;
    },
    now,
  });
  return { hub, events, created };
}

const frame = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, ...extra });

describe("the room address mirrors the web client", () => {
  it("agrees with wsURL for a LAN room", () => {
    expect(signalingURL(ORIGIN, { kind: "lan" })).toBe(
      wsURL({ protocol: "https:", host: "relayium.example" }, ""),
    );
  });

  it("agrees with wsURL for a code room", () => {
    expect(signalingURL(ORIGIN, { kind: "code", code: "424242" })).toBe(
      wsURL({ protocol: "https:", host: "relayium.example" }, "424242"),
    );
  });

  it("uses ws for a plain-http origin, like the web client does", () => {
    expect(signalingURL("http://127.0.0.1:8080", { kind: "lan" })).toBe(
      wsURL({ protocol: "http:", host: "127.0.0.1:8080" }, ""),
    );
  });

  it("refuses a malformed code before it constructs anything", () => {
    expect(() => signalingURL(ORIGIN, { kind: "code", code: "42424" })).toThrow(SignalingRefusal);
    expect(() => signalingURL(ORIGIN, { kind: "code", code: "4242a2" })).toThrow(SignalingRefusal);
  });
});

describe("the code predicate mirrors the web client", () => {
  // The alphabet and its neighbours, so a drift in either direction fails
  // rather than a happy-path sample that both happen to agree on.
  const candidates = [
    "424242", "000000", "999999",
    "42424", "4242422", "", " 424242", "424242 ",
    "4242a2", "42424٢", "4２4242", "-42424", "42.242",
  ];

  it("agrees with isValidCode on every candidate", () => {
    for (const candidate of candidates) {
      expect([candidate, isWellFormedCode(candidate)]).toEqual([candidate, isValidCode(candidate)]);
    }
  });
});

describe("frame bounds are measured in bytes", () => {
  it("counts UTF-8 octets, not UTF-16 code units", () => {
    // The exact discrepancy the ceiling's name promises is not there.
    expect("你".length).toBe(1);
    expect(frameByteLength("你")).toBe(3);
    expect("𝄞".length).toBe(2);
    expect(frameByteLength("𝄞")).toBe(4);
  });

  it("refuses an outbound frame that is oversized in bytes but not in length", () => {
    // Under the ceiling by `String.length`, three times over it in bytes. A
    // UTF-16 length check would have let this through.
    const filler = "你".repeat(MAX_SIGNALING_FRAME_BYTES / 2);
    const oversized = frame("signal", { to: "p", data: filler });
    expect(oversized.length).toBeLessThan(MAX_SIGNALING_FRAME_BYTES);
    expect(frameByteLength(oversized)).toBeGreaterThan(MAX_SIGNALING_FRAME_BYTES);
    expect(isPermittedFrame(oversized)).toBe(false);
  });

  it("still accepts an ordinary non-ASCII frame", () => {
    expect(isPermittedFrame(frame("signal", { to: "p", data: { name: "报告.pdf" } }))).toBe(true);
  });

  it("refuses a frame type outside the allowlist, and a non-JSON frame", () => {
    expect(isPermittedFrame(frame("subscribe"))).toBe(false);
    expect(isPermittedFrame("not json")).toBe(false);
    expect(isPermittedFrame("[]")).toBe(false);
    expect(isPermittedFrame("")).toBe(false);
  });

  it("ends the socket on an oversized INBOUND frame, measured the same way", () => {
    const { hub, events, created } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    const socket = created[0]!;

    socket.onmessage?.({ data: "你".repeat(MAX_SIGNALING_FRAME_BYTES / 2) });

    expect(events.at(-1)).toEqual({ token: "t", kind: "close", reason: "oversize" });
    expect(socket.closed).toBe(1);
    // Named as this app's own refusal, never as the peer having gone away.
    expect(events.filter((e) => e.kind === "close" && e.reason === "remote")).toHaveLength(0);
  });
});

describe("one socket per room kind", () => {
  it("allows one LAN room and one code room at once", () => {
    const { hub } = makeHub();
    hub.open("lan", "owner-lan", { kind: "lan" }, 0);
    hub.open("code", "owner-code", { kind: "code", code: "424242" }, 0);
    expect(hub.openCount).toBe(2);
  });

  it("refuses a SECOND room of the same kind", () => {
    const { hub } = makeHub();
    hub.open("lan", "owner-lan", { kind: "lan" }, 0);
    // The ceiling alone would permit this: two memberships of one room under
    // two peer ids, each showing the app to itself.
    expect(() => hub.open("lan2", "owner-lan2", { kind: "lan" }, 0)).toThrow(SignalingRefusal);
    expect(hub.openCount).toBe(1);
  });

  it("refuses a second code room even for a different code", () => {
    const { hub } = makeHub();
    hub.open("a", "owner-a", { kind: "code", code: "424242" }, 0);
    expect(() => hub.open("b", "owner-b", { kind: "code", code: "123456" }, 0)).toThrow(SignalingRefusal);
  });

  it("frees the kind once its socket is closed", () => {
    const { hub } = makeHub();
    hub.open("lan", "owner-lan", { kind: "lan" }, 0);
    hub.close("lan");
    expect(() => hub.open("lan2", "owner-lan2", { kind: "lan" }, 0)).not.toThrow();
  });

  it("refuses a reused token", () => {
    const { hub } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    expect(() => hub.open("t", "owner-t", { kind: "code", code: "424242" }, 0)).toThrow(SignalingRefusal);
  });
});

describe("a retired socket never speaks again", () => {
  it("drops an onopen that arrives after close", () => {
    const { hub, events, created } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    const socket = created[0]!;
    const opened = socket.onopen;

    hub.close("t");
    const afterClose = events.length;
    // The handler reference a caller might still hold. Retirement nulls the
    // socket's handlers, so calling the OLD reference reaches nothing.
    opened?.();

    expect(events).toHaveLength(afterClose);
    expect(socket.onopen).toBeNull();
  });

  it("emits exactly one terminal event however many ways it ends", () => {
    const { hub, events, created } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    const socket = created[0]!;

    hub.close("t");
    hub.close("t");
    socket.onclose?.();
    hub.revoke(0);

    expect(events.filter((e) => e.kind === "close")).toHaveLength(1);
  });

  it("does not let a reused token resurrect the old socket's events", () => {
    const { hub, events, created } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    const first = created[0]!;
    const staleMessage = first.onmessage;
    hub.close("t");

    // The same token, a NEW socket. The old handler must reach nothing: a frame
    // from a socket the renderer already closed, delivered under a token it has
    // since reused, is one room's traffic appearing in another.
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    const before = events.length;
    staleMessage?.({ data: frame("signal", { to: "p" }) });

    expect(events).toHaveLength(before);
    expect(hub.openCount).toBe(1);
  });

  it("refuses a send on a closed socket rather than reopening one", () => {
    const { hub } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    hub.close("t");
    expect(() => hub.send("t", frame("join", { name: "a" }))).toThrow(SignalingRefusal);
  });
});

describe("revocation is per generation", () => {
  it("drops the retiring document's sockets and leaves a later one's alone", () => {
    const { hub } = makeHub();
    hub.open("old", "owner-old", { kind: "lan" }, 0);
    hub.open("new", "owner-new", { kind: "code", code: "424242" }, 1);

    hub.revoke(0);

    expect(hub.openCount).toBe(1);
    expect(() => hub.send("old", frame("join", { name: "a" }))).toThrow(SignalingRefusal);
    expect(() => hub.send("new", frame("join", { name: "a" }))).not.toThrow();
  });
});

describe("the outbound bounds", () => {
  it("refuses above the send rate", () => {
    const { hub } = makeHub(() => 0);
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    for (let i = 0; i < MAX_SIGNALING_SENDS_PER_SECOND; i += 1) {
      hub.send("t", frame("signal", { to: "p" }));
    }
    expect(() => hub.send("t", frame("signal", { to: "p" }))).toThrow(SignalingRefusal);
  });

  it("refuses rather than queues when the socket is backed up", () => {
    const { hub, created } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    created[0]!.bufferedAmount = 2 * 1024 * 1024;
    // Loudly: a silently dropped signalling frame is a session that stalls with
    // nothing on screen explaining it.
    expect(() => hub.send("t", frame("signal", { to: "p" }))).toThrow(SignalingRefusal);
  });

  it("ends a socket that floods this client inbound", () => {
    const { hub, events, created } = makeHub(() => 0);
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    const socket = created[0]!;
    for (let i = 0; i <= MAX_SIGNALING_INBOUND_PER_SECOND; i += 1) {
      socket.onmessage?.({ data: frame("signal", { to: "p" }) });
    }
    expect(events.at(-1)).toEqual({ token: "t", kind: "close", reason: "flooded" });
  });

  it("drops a binary frame without forwarding it as text", () => {
    const { hub, events, created } = makeHub();
    hub.open("t", "owner-t", { kind: "lan" }, 0);
    created[0]!.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
    expect(events.filter((e) => e.kind === "message")).toHaveLength(0);
  });
});

describe("closeAll", () => {
  it("retires every socket, whatever generation it belongs to", () => {
    const { hub, events } = makeHub();
    hub.open("a", "owner-a", { kind: "lan" }, 0);
    hub.open("b", "owner-b", { kind: "code", code: "424242" }, 3);
    hub.closeAll();
    expect(hub.openCount).toBe(0);
    expect(events.filter((e) => e.kind === "close")).toHaveLength(2);
  });
});
