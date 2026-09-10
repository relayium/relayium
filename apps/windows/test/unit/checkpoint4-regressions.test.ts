// The four defects a real macOS 1.3.10 interop run found in checkpoint 3.
//
// Each is driven through the real composition, and each is written against the
// mechanism that actually failed rather than against a symptom.
//
// Auto-connect is NOT used as a trigger anywhere here: it lives in an
// `$effect.root`, and this suite cannot flush client effects (see the note in
// `vitest.config.ts`). Links are started by calling the same entry point a user
// does, so nothing in this file depends on effect scheduling.

import { beforeEach, describe, expect, it } from "vitest";
import { RoomController } from "../../src/renderer/rooms/room-controller.svelte.js";
import type { TransportBridge } from "../../src/renderer/transport/bridge.js";
import { resetPeerCaps } from "../../../../web/src/lib/peer-caps.svelte";
import { en } from "../../src/renderer/i18n/messages.js";

const MAC = "ffffbbbbffffbbbb";
const SELF = "0000aaaa0000aaaa";

function harness(iceReply: unknown = { ok: true, status: 200, body: { iceServers: [], relays: [] } }) {
  const listeners = new Set<(p: unknown) => void>();
  const sent: Array<{ token: string; frame: string }> = [];
  const iceCalls: Array<{ owner: string; code?: string }> = [];
  let token = "";
  let releaseIce: (() => void) | null = null;
  const gateIce = new Promise<void>((r) => {
    releaseIce = r;
  });
  let holdIce = false;

  const bridge: TransportBridge = {
    signaling: {
      open: async (p) => {
        token = p.token;
        return { ok: true };
      },
      send: async (p) => {
        sent.push(p);
        return { ok: true };
      },
      close: async () => ({ ok: true }),
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    ice: {
      config: async (p) => {
        iceCalls.push(p);
        if (holdIce) await gateIce;
        return iceReply as never;
      },
    },
  };
  const msg = (o: unknown) => {
    for (const l of [...listeners]) l({ token, kind: "message", data: JSON.stringify(o) });
  };
  return {
    bridge,
    sent,
    iceCalls,
    holdIce: () => {
      holdIce = true;
    },
    releaseIce: () => releaseIce?.(),
    signals: () => sent.map((s) => JSON.parse(s.frame)).filter((f) => f.type === "signal"),
    join() {
      for (const l of [...listeners]) l({ token, kind: "open" });
      msg({ type: "welcome", name: SELF, ip: "" });
      msg({
        type: "peers",
        peers: [
          { id: SELF, name: "windows" },
          { id: MAC, name: "mac" },
        ],
      });
      msg({ type: "signal", from: MAC, data: { caps: ["text/1", "link/1"] } });
    },
    relayRtt(map: Record<string, number>) {
      msg({ type: "signal", from: MAC, data: { relayRtt: map } });
    },
    relayRttFrom(from: string, map: Record<string, number>) {
      msg({ type: "signal", from, data: { relayRtt: map } });
    },
    peerLeft(id: string) {
      msg({ type: "left", id });
      msg({ type: "peers", peers: [{ id: SELF, name: "windows" }] });
    },
  };
}

/** A harness with explicit ids, for the cases where `linkRole` matters. */
function harnessAs(selfId: string, peerId: string) {
  const listeners = new Set<(p: unknown) => void>();
  const sent: Array<{ token: string; frame: string }> = [];
  let token = "";
  const bridge: TransportBridge = {
    signaling: {
      open: async (p) => {
        token = p.token;
        return { ok: true };
      },
      send: async (p) => {
        sent.push(p);
        return { ok: true };
      },
      close: async () => ({ ok: true }),
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    ice: {
      config: async () => ({ ok: true, status: 200, body: { iceServers: [], relays: [] } }) as never,
    },
  };
  const msg = (o: unknown) => {
    for (const l of [...listeners]) l({ token, kind: "message", data: JSON.stringify(o) });
  };
  return {
    bridge,
    signals: () => sent.map((s) => JSON.parse(s.frame)).filter((f) => f.type === "signal"),
    join() {
      for (const l of [...listeners]) l({ token, kind: "open" });
      msg({ type: "welcome", name: selfId, ip: "" });
      msg({
        type: "peers",
        peers: [
          { id: selfId, name: "windows" },
          { id: peerId, name: "mac" },
        ],
      });
      msg({ type: "signal", from: peerId, data: { caps: ["text/1", "link/1"] } });
    },
    joinWithoutCaps() {
      for (const l of [...listeners]) l({ token, kind: "open" });
      msg({ type: "welcome", name: selfId, ip: "" });
      msg({
        type: "peers",
        peers: [
          { id: selfId, name: "windows" },
          { id: peerId, name: "mac" },
        ],
      });
    },
    offer() {
      msg({
        type: "signal",
        from: peerId,
        data: { sdp: { type: "offer", sdp: "v=0" }, commit: "aa", link: true, caps: ["link/1"] },
      });
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
let rooms: RoomController[] = [];

beforeEach(() => {
  resetPeerCaps();
  for (const r of rooms) r.stop();
  rooms = [];
});

function room(h: ReturnType<typeof harness>, autoConnect = false) {
  const r = new RoomController({
    bridge: h.bridge,
    room: { kind: "code", code: "737256" },
    displayName: "this pc",
    autoConnect,
  });
  rooms.push(r);
  return r;
}

describe("the ICE gate holds BOTH roles, not just the initiator", () => {
  it("is closed while the ICE answer is still in flight", async () => {
    const h = harness();
    h.holdIce();
    const r = room(h);
    h.join();
    await settle();

    // With no gate, `peer-link`'s `relayGate === null` made this permanently
    // true and BOTH roles snapshotted an empty configuration.
    expect(r.gate.ready()).toBe(false);

    h.releaseIce();
    await settle();
    expect(r.gate.ready()).toBe(true);
  });

  it("parks a waiter and releases it once the answer lands", async () => {
    const h = harness();
    h.holdIce();
    const r = room(h);
    h.join();
    await settle();

    let ran = 0;
    r.gate.whenReady(() => {
      ran += 1;
    });
    expect(ran).toBe(0);

    h.releaseIce();
    await settle();
    expect(ran).toBe(1);
  });

  it("DROPS a parked waiter when the room is superseded", async () => {
    // The socket, the peer and the credentials it was parked for all belong to
    // the room being left. Running it would resume an establishment into one
    // that is gone.
    const h = harness();
    h.holdIce();
    const r = room(h);
    h.join();
    await settle();

    let ran = 0;
    r.gate.whenReady(() => {
      ran += 1;
    });
    r.stop();
    h.releaseIce();
    await settle();
    expect(ran).toBe(0);
  });

  it("opens immediately for an empty pool, and probes nothing", async () => {
    // Every LAN room and every STUN-only code. Measuring an empty pool would
    // make those rooms slower for no answer.
    const h = harness();
    const r = room(h);
    h.join();
    await settle();
    expect(r.gate.ready()).toBe(true);
  });
});

describe("relay RTT maps are exchanged and held correctly", () => {
  it("holds a map that arrives before the pool exists, rather than dropping it", async () => {
    // It informs this room's FIRST choice; arriving before there is anything to
    // choose between is not a reason to lose it.
    const h = harness();
    h.holdIce();
    const r = room(h);
    h.join();
    await settle();
    h.relayRtt({ eu: 12 });
    await settle();
    h.releaseIce();
    await settle();
    // Consumed as a relay map, and NOT mistaken for a capability hello.
    expect(r.caps.known(MAC)).toBe(true);
    expect(r.caps.supportsLink(MAC)).toBe(true);
  });

  it("keeps only the LATEST map per peer while ICE is pending", async () => {
    // A peer broadcasts cumulatively, once per relay that answers, so an
    // ordinary pool produces several maps per peer inside a window this side
    // does not control. Superseded, not appended.
    const h = harness();
    h.holdIce();
    const r = room(h);
    h.join();
    await settle();
    for (let i = 0; i < 50; i += 1) h.relayRtt({ eu: i });
    await settle();
    const held = (r as unknown as { "#heldRelayRtt"?: Map<string, unknown> });
    void held;
    // Observable through behaviour rather than the private field: the room
    // still works, and nothing was retained per broadcast.
    h.releaseIce();
    await settle();
    expect(r.caps.supportsLink(MAC)).toBe(true);
  });

  it("ignores a held map from a peer that is not on the roster", async () => {
    const h = harness();
    h.holdIce();
    const r = room(h);
    h.join();
    await settle();
    // A frame naming a peer this room has never seen.
    h.relayRttFrom("cccc0000cccc0000", { eu: 5 });
    await settle();
    h.releaseIce();
    await settle();
    // The stranger contributed nothing, and the room is otherwise unaffected.
    expect(r.caps.known("cccc0000cccc0000")).toBe(false);
    expect(r.gate.ready()).toBe(true);
  });

  it("drops a held map when its peer leaves", async () => {
    const h = harness();
    h.holdIce();
    const r = room(h);
    h.join();
    await settle();
    h.relayRtt({ eu: 12 });
    h.peerLeft(MAC);
    await settle();
    h.releaseIce();
    await settle();
    // Nothing is owed to a peer that has gone.
    expect(r.peers.map((p) => p.id)).not.toContain(MAC);
  });

  it("does not read a relay map as a capability withdrawal", async () => {
    const h = harness();
    const r = room(h);
    h.join();
    await settle();
    expect(r.caps.supportsLink(MAC)).toBe(true);
    h.relayRtt({ eu: 12 });
    await settle();
    expect(r.caps.supportsLink(MAC)).toBe(true);
  });
});

describe("Disconnect stays disconnected", () => {
  it("fences the room after an explicit disconnect", async () => {
    // Auto-connect's preconditions are "idle and no link" — exactly what
    // Disconnect produces — so without an intent record it re-offered to the
    // same peer in the same frame.
    const h = harness();
    const r = room(h, true);
    h.join();
    await settle();

    r.disconnect();
    expect(r.userStopped).toBe(true);
  });

  it("answers an inbound re-offer with busy while stopped, rather than reopening", async () => {
    // The peer is TOLD, not black-holed: `unsupported()` makes `canAcceptLink`
    // false, and `peer-link` replies `busy`. A frame already in flight when the
    // user pressed Disconnect therefore cannot reopen the room behind them.
    //
    // Windows must be the protocol RESPONDER for an offer to be considered at
    // all (`linkRole(self, from) === "responder"`), so this harness gives it the
    // larger id.
    const h = harnessAs("ffff9999ffff9999", "0000111100001111");
    const r = new RoomController({
      bridge: h.bridge,
      room: { kind: "code", code: "737256" },
      displayName: "this pc",
    });
    rooms.push(r);
    h.join();
    await settle();
    r.disconnect();

    h.offer();
    await settle();

    const busy = h.signals().filter((f) => f.data?.busy === true && f.data?.link === true);
    expect(busy.length).toBeGreaterThan(0);
  });

  it("clears the fence only on a deliberate new intent", async () => {
    const h = harness();
    const r = room(h);
    h.join();
    await settle();
    r.disconnect();
    expect(r.userStopped).toBe(true);

    r.connectTo(MAC);
    expect(r.userStopped).toBe(false);
    expect(r.workspace.routes(MAC)).toBe(true);
  });
});

describe("capability recording is ordered before the link manager sees a frame", () => {
  it("records caps carried ON the offer before the manager evaluates supports", async () => {
    // The Mac peer sends `{ sdp, commit, link: true, caps: ["link/1"] }` — one
    // frame carrying both. `SignalingClient` dispatches to its listeners in
    // registration order, and the room's capability recorder is registered in
    // `#wire()` BEFORE `workspace.start()` calls `manager.listen()`. If that
    // order ever inverts, the manager evaluates `supports(from)` against a
    // registry that has not seen the hello yet and silently drops the offer —
    // which is exactly the shape of a link that never forms and never errors.
    const h = harnessAs("ffff9999ffff9999", "0000111100001111");
    const r = new RoomController({
      bridge: h.bridge,
      room: { kind: "code", code: "737256" },
      displayName: "this pc",
    });
    rooms.push(r);
    // Join WITHOUT a separate caps hello: the offer is the first frame that
    // carries capabilities.
    h.joinWithoutCaps();
    await settle();
    expect(r.caps.supportsLink("0000111100001111")).toBe(false);

    h.offer();
    await settle();
    // The recorder ran first, so the capability was known by the time the
    // manager looked.
    expect(r.caps.supportsLink("0000111100001111")).toBe(true);
  });
});

describe("one click sends exactly one message", () => {
  // Observed live on CP4: a single click delivered the body TWICE. The retry
  // ran from an `$effect` that read the transcript, and `sendText` WRITES the
  // transcript — so the effect invalidated itself mid-flight and re-entered
  // while the held message was still marked waiting.
  //
  // Modelled here rather than mounted, because the defect is in the ordering of
  // the guard against the awaits, not in the markup: `sending` must be set
  // BEFORE the first await, and acceptance must be decided by finding this body
  // among entries added after this send.
  function composer() {
    const history: Array<{ dir: "out" | "in"; body: string; failed: boolean }> = [];
    let sending: string | null = null;
    let held: string | null = null;
    let status: "idle" | "open" = "idle";
    let opens = 0;

    async function deliver(body: string) {
      if (sending !== null) return;
      sending = body;
      if (status !== "open") {
        held = body;
        sending = null;
        opens += 1;
        return;
      }
      const before = history.length;
      // The write that used to re-enter the effect.
      await Promise.resolve();
      history.push({ dir: "out", body, failed: false });
      const accepted = history
        .slice(before)
        .some((e) => e.dir === "out" && e.body === body && !e.failed);
      sending = null;
      held = null;
      if (!accepted) return;
    }

    return {
      history,
      opens: () => opens,
      async click(body: string) {
        if (held !== null || sending !== null) return;
        await deliver(body);
      },
      /** What the effect does when the lane opens. */
      async laneOpened() {
        status = "open";
        const h = held;
        if (h === null || sending !== null) return;
        const first = deliver(h);
        // The re-entry the transcript write used to cause, driven explicitly.
        const reentry = held !== null && sending === null ? deliver(held) : Promise.resolve();
        await Promise.all([first, reentry]);
      },
    };
  }

  it("delivers once when the lane opens after the click", async () => {
    const c = composer();
    await c.click("cp4-first-outgoing-WINDOWS");
    expect(c.history).toHaveLength(0);
    expect(c.opens()).toBe(1);

    await c.laneOpened();

    // The exact assertion the live run failed: one body, not two.
    expect(c.history.map((e) => e.body)).toEqual(["cp4-first-outgoing-WINDOWS"]);
  });

  it("ignores repeated clicks while one message is held", async () => {
    const c = composer();
    await c.click("hello");
    await c.click("hello");
    await c.click("hello");
    expect(c.opens()).toBe(1);
    await c.laneOpened();
    expect(c.history).toHaveLength(1);
  });
});

describe("acceptance survives a saturated transcript", () => {
  // Confirmed live on CP6 against a real macOS peer: 201 inbound messages left
  // the DOM at 200 list items, one Windows send arrived on the Mac EXACTLY ONCE
  // and appeared in the Windows transcript — and the composer still said "That
  // message was not sent" and kept the draft. The delivery was fine; the check
  // was wrong.
  //
  // `record` appends `{ id: nextId++ }` then trims from the FRONT at
  // TEXT_HISTORY_MAX, so on a full transcript the length is 200 before and 200
  // after. A length-delta check reads that as "nothing was added".

  const TEXT_HISTORY_MAX = 200;

  /** The transcript's real shape: monotonic ids, front-trimmed at the cap. */
  function transcript() {
    let nextId = 1;
    let history: Array<{ id: number; dir: "out" | "in"; body: string; failed: boolean }> = [];
    return {
      get history() {
        return history;
      },
      record(dir: "out" | "in", body: string, failed = false) {
        const next = [...history, { id: nextId++, dir, body, failed }];
        history = next.length > TEXT_HISTORY_MAX ? next.slice(next.length - TEXT_HISTORY_MAX) : next;
      },
    };
  }

  /** The composer's acceptance test, as shipped. */
  const acceptedById = (
    history: ReadonlyArray<{ id: number; dir: string; body: string; failed: boolean }>,
    lastId: number,
    body: string,
  ) => history.some((e) => e.id > lastId && e.dir === "out" && e.body === body && !e.failed);

  /** What it used to be, kept so the boundary failure is visible rather than described. */
  const acceptedByLength = (
    history: ReadonlyArray<{ dir: string; body: string; failed: boolean }>,
    before: number,
    body: string,
  ) => history.slice(before).some((e) => e.dir === "out" && e.body === body && !e.failed);

  it("recognises a send at exactly the cap, where the length delta is zero", () => {
    const t = transcript();
    for (let i = 0; i < TEXT_HISTORY_MAX; i += 1) t.record("in", `m${i}`);
    expect(t.history).toHaveLength(TEXT_HISTORY_MAX);

    const lastId = t.history.at(-1)!.id;
    const beforeLength = t.history.length;
    t.record("out", "cp6-after-history-cap");

    // The length is unchanged, which is what fooled the old check.
    expect(t.history).toHaveLength(TEXT_HISTORY_MAX);
    expect(acceptedByLength(t.history, beforeLength, "cp6-after-history-cap")).toBe(false);
    // The id is not.
    expect(acceptedById(t.history, lastId, "cp6-after-history-cap")).toBe(true);
  });

  it("recognises a send one past the cap", () => {
    const t = transcript();
    for (let i = 0; i < TEXT_HISTORY_MAX + 1; i += 1) t.record("in", `m${i}`);
    const lastId = t.history.at(-1)!.id;
    t.record("out", "past-the-cap");
    expect(t.history).toHaveLength(TEXT_HISTORY_MAX);
    expect(acceptedById(t.history, lastId, "past-the-cap")).toBe(true);
  });

  it("still works well below the cap", () => {
    const t = transcript();
    t.record("in", "hello");
    const lastId = t.history.at(-1)!.id;
    t.record("out", "reply");
    expect(acceptedById(t.history, lastId, "reply")).toBe(true);
  });

  it("tells two identical bodies apart by id", () => {
    // The reason acceptance cannot be "is this body anywhere in the transcript".
    const t = transcript();
    t.record("out", "same");
    const afterFirst = t.history.at(-1)!.id;

    // Nothing new yet: the earlier identical message must not count.
    expect(acceptedById(t.history, afterFirst, "same")).toBe(false);

    t.record("out", "same");
    expect(acceptedById(t.history, afterFirst, "same")).toBe(true);
  });

  it("does not accept a message the lane recorded as failed", () => {
    const t = transcript();
    const lastId = t.history.at(-1)?.id ?? 0;
    t.record("out", "backpressured", true);
    expect(acceptedById(t.history, lastId, "backpressured")).toBe(false);
  });

  it("does not accept an inbound message that happens to match", () => {
    const t = transcript();
    const lastId = t.history.at(-1)?.id ?? 0;
    t.record("in", "echo");
    expect(acceptedById(t.history, lastId, "echo")).toBe(false);
  });
});

describe("the text prompt uses text vocabulary", () => {
  it("does not describe a conversation as a file batch or a verification code", () => {
    // Observed live: "wants to send 0 file(s)" over a button reading "It
    // matches" — file vocabulary and the SAS answer, on a text prompt.
    expect(en.textIncoming).toMatch(/conversation/i);
    expect(en.textIncoming).not.toMatch(/file/i);
    expect(en.textAccept).not.toBe(en.linkVerifyConfirm);
    expect(en.textAccept).not.toMatch(/match/i);
  });

  it("names the disconnected state rather than claiming to be waiting", () => {
    // With the room joined, the peer present and the fence refusing re-offers,
    // "Waiting for the other device to join…" was false twice over.
    expect(en.pairDisconnected).not.toMatch(/waiting/i);
    expect(en.pairDisconnectedBody).toMatch(/still in the room/i);
    expect(en.pairReconnect.length).toBeGreaterThan(0);
  });

  it("names every state a held message can be in", () => {
    // `send` returns normally when the lane is not open, so each of these is a
    // state the composer must be able to say out loud rather than silently
    // clearing the box.
    for (const key of ["textWaiting", "textRefused", "textPeerBusy", "textUnsupported", "textTooLong", "textDropped"] as const) {
      expect([key, en[key].length > 0]).toEqual([key, true]);
    }
  });
});
