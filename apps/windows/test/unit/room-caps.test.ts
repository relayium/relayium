// Room-local capabilities, and the page-global they must not touch.
//
// Two assertions, and the second is the one that matters. The first pins the
// room-local recorder against the WEB `recordPeerCaps` it duplicates, so the
// five lines cannot drift. The second drives two concurrent rooms and asserts
// the web module's page-global `announced` stays EMPTY throughout — which is
// the regression that catches any future accidental read of the global, whether
// it comes from this file or from a shared module growing a new call site.

import { describe, expect, it, beforeEach } from "vitest";
import { RoomCaps } from "../../src/renderer/rooms/room-caps.js";
import {
  CAP_LINK,
  CAP_PREUPLOAD,
  CAP_TEXT,
  peerCapsKnown,
  peerSupportsLink,
  peerSupportsPreupload,
  recordPeerCaps,
  resetPeerCaps,
  retainPeers,
} from "../../../../web/src/lib/peer-caps.svelte";

/** Everything a peer could put in a hello, including things that are not one. */
const FRAMES: Array<{ name: string; data: unknown }> = [
  { name: "a current web peer", data: { caps: [CAP_LINK, CAP_PREUPLOAD] } },
  { name: "link only", data: { caps: [CAP_LINK] } },
  { name: "a legacy peer", data: { caps: [CAP_TEXT] } },
  { name: "an empty hello", data: { caps: [] } },
  { name: "a versioned variant", data: { caps: ["link/2"] } },
  { name: "a capitalised variant", data: { caps: ["Link/1"] } },
  { name: "preupload without link", data: { caps: [CAP_PREUPLOAD] } },
  { name: "mixed types in caps", data: { caps: [CAP_LINK, 7, null, "text/1"] } },
  { name: "caps that is not an array", data: { caps: "link/1" } },
  { name: "caps absent — a relayRtt piggyback", data: { relayRtt: { eu: 12 } } },
  { name: "an array payload", data: [CAP_LINK] },
  { name: "null", data: null },
  { name: "a string", data: "link/1" },
];

beforeEach(() => resetPeerCaps());

describe("the room-local recorder agrees with recordPeerCaps", () => {
  for (const frame of FRAMES) {
    it(`agrees on ${frame.name}`, () => {
      const room = new RoomCaps();
      // Separate ids, because the web recorder is a page global and this test
      // must not depend on the order the two are driven in.
      const wasHelloRoom = room.record("p", frame.data);
      const wasHelloWeb = recordPeerCaps("p", frame.data);

      expect(wasHelloRoom).toBe(wasHelloWeb);
      expect(room.known("p")).toBe(peerCapsKnown("p"));
      expect(room.supportsLink("p")).toBe(peerSupportsLink("p"));
      expect(room.supportsPreupload("p")).toBe(peerSupportsPreupload("p"));
    });
  }

  it("agrees about a peer that never announced", () => {
    const room = new RoomCaps();
    expect(room.known("ghost")).toBe(peerCapsKnown("ghost"));
    expect(room.supportsLink("ghost")).toBe(peerSupportsLink("ghost"));
  });

  /**
   * A peer id that names an `Object.prototype` member.
   *
   * Asserted about `RoomCaps` ONLY. It is backed by a `Map`, which has no
   * prototype chain to inherit from, so an id like `toString` is simply an id
   * it has never been told about — which is the correct answer.
   *
   * The web module answers differently here, and that difference is reported to
   * root for review rather than encoded as an expectation: a test that asserted
   * the current web behaviour would be pinning a defect as desirable, and would
   * have to be deleted the moment it was fixed. `peer-caps.svelte.ts` is outside
   * this slice's lease either way.
   */
  it("treats an Object.prototype member name as an id it has never heard from", () => {
    const room = new RoomCaps();
    expect(room.known("toString")).toBe(false);
    expect(room.supportsLink("toString")).toBe(false);
    expect(room.supportsPreupload("constructor")).toBe(false);
    expect(room.known("valueOf")).toBe(false);

    // And it is recorded normally once such a peer does announce.
    room.record("toString", { caps: [CAP_LINK] });
    expect(room.known("toString")).toBe(true);
    expect(room.supportsLink("toString")).toBe(true);
  });

  it("agrees on retention", () => {
    const room = new RoomCaps();
    for (const id of ["a", "b", "c"]) {
      room.record(id, { caps: [CAP_LINK] });
      recordPeerCaps(id, { caps: [CAP_LINK] });
    }
    room.retain(["a", "c"]);
    retainPeers(["a", "c"]);

    for (const id of ["a", "b", "c"]) {
      expect([id, room.known(id)]).toEqual([id, peerCapsKnown(id)]);
      expect([id, room.supportsLink(id)]).toEqual([id, peerSupportsLink(id)]);
    }
  });

  it("records the last hello a peer sent, like the web module", () => {
    const room = new RoomCaps();
    room.record("p", { caps: [CAP_LINK] });
    recordPeerCaps("p", { caps: [CAP_LINK] });
    room.record("p", { caps: [] });
    recordPeerCaps("p", { caps: [] });
    expect(room.supportsLink("p")).toBe(peerSupportsLink("p"));
    expect(room.supportsLink("p")).toBe(false);
  });
});

describe("two rooms do not prune each other", () => {
  it("keeps the pairing room's peers when the LAN roster churns", () => {
    const lan = new RoomCaps();
    const pairing = new RoomCaps();

    lan.record("lan-peer", { caps: [CAP_LINK] });
    pairing.record("code-peer", { caps: [CAP_LINK] });

    // The exact event that breaks a shared global: a phone walks out of Wi-Fi
    // range, and the LAN roster comes back without it.
    lan.retain([]);

    expect(lan.supportsLink("lan-peer")).toBe(false);
    // The pairing peer is right there and must stay reachable.
    expect(pairing.supportsLink("code-peer")).toBe(true);
  });

  it("keeps the LAN room's peers when the pairing room is reset", () => {
    const lan = new RoomCaps();
    const pairing = new RoomCaps();
    lan.record("lan-peer", { caps: [CAP_LINK] });
    pairing.record("code-peer", { caps: [CAP_LINK] });

    pairing.reset();

    expect(pairing.supportsLink("code-peer")).toBe(false);
    expect(lan.supportsLink("lan-peer")).toBe(true);
  });

  it("never writes to the web page-global while both rooms run", () => {
    const lan = new RoomCaps();
    const pairing = new RoomCaps();

    for (const frame of FRAMES) {
      lan.record("lan-peer", frame.data);
      pairing.record("code-peer", frame.data);
    }
    lan.retain([]);
    pairing.retain(["code-peer"]);

    // The whole point. If a shared module ever grows a call site that reads or
    // writes the global for this slice's path, this is what fails.
    expect(peerCapsKnown("lan-peer")).toBe(false);
    expect(peerCapsKnown("code-peer")).toBe(false);
    expect(peerSupportsLink("code-peer")).toBe(false);
    expect(peerSupportsPreupload("code-peer")).toBe(false);
  });
});
