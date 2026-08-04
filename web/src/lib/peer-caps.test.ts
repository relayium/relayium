import { describe, it, expect, beforeEach } from "vitest";
import {
  CAP_LINK, CAP_TEXT, LINK_BUILD_SUPPORT, advertisedCaps, capsSignal, linkRoomActive,
  recordPeerCaps, peerSupportsLink, peerSupportsText, retainPeers, resetPeerCaps,
} from "./peer-caps.svelte";
import { clearRoom, enterRoom } from "./room.svelte";
import { localCaps } from "./webrtc";

/** The code-less LAN room is the only one `link/1` is scoped to. Every test
 *  starts there explicitly rather than inheriting whichever room a previous
 *  file left behind. */
beforeEach(() => { clearRoom(); resetPeerCaps(); });

describe("peer caps", () => {
  it("treats an unheard-from peer as not supporting text", () => {
    expect(peerSupportsText("p1")).toBe(false);
  });

  it("records an announcement and reports support", () => {
    expect(recordPeerCaps("p1", { caps: [CAP_TEXT] })).toBe(true);
    expect(peerSupportsText("p1")).toBe(true);
  });

  it("announces exactly text/1 and link/1 in the code-less LAN room", () => {
    expect(CAP_TEXT).toBe("text/1");
    expect(CAP_LINK).toBe("link/1");
    // The release switch for the unified workspace. A default build implements
    // both lanes, so it says so — in the LAN room, and only there.
    expect(capsSignal()).toEqual({ caps: [CAP_TEXT, CAP_LINK] });
    expect(advertisedCaps()).toEqual([CAP_TEXT, CAP_LINK]);
    expect(LINK_BUILD_SUPPORT).toBe(true);
    expect(linkRoomActive()).toBe(true);
    // Both announcements come from this one source, so the roster hello and the
    // per-connection SDP confirmation cannot disagree about what we support.
    expect([...localCaps()]).toEqual([...advertisedCaps()]);
  });

  it("never announces link/1 from a pairing-code room", () => {
    enterRoom({ code: "123456" });
    expect(linkRoomActive()).toBe(false);
    expect(capsSignal()).toEqual({ caps: [CAP_TEXT] });
    expect(advertisedCaps()).toEqual([CAP_TEXT]);
    // The per-connection confirmation is read at call time, not frozen at
    // import time — a module constant would keep announcing the LAN answer
    // after the page switched rooms without reloading.
    expect([...localCaps()]).toEqual([CAP_TEXT]);
    clearRoom();
    expect([...localCaps()]).toEqual([CAP_TEXT, CAP_LINK]);
  });

  // The room policy is not only about what we say. A signalling relay sees every
  // frame and can inject one, so a code room must also refuse to BELIEVE a
  // link/1 claim: routing is what actually activates the mixed manager.
  it("refuses a forged link/1 claim inside a pairing-code room", () => {
    recordPeerCaps("forger", { caps: [CAP_TEXT, CAP_LINK] });
    expect(peerSupportsLink("forger")).toBe(true);
    enterRoom({ code: "654321" });
    expect(peerSupportsLink("forger")).toBe(false);
    // text/1 is unaffected: the pairing room keeps its existing message path.
    expect(peerSupportsText("forger")).toBe(true);
    clearRoom();
    expect(peerSupportsLink("forger")).toBe(true);
  });

  it("tracks exact link support independently from text", () => {
    recordPeerCaps("link-only", { caps: [CAP_LINK] });
    recordPeerCaps("text-only", { caps: [CAP_TEXT] });
    recordPeerCaps("future", { caps: ["link/2"] });
    expect(peerSupportsLink("link-only")).toBe(true);
    expect(peerSupportsText("link-only")).toBe(false);
    expect(peerSupportsLink("text-only")).toBe(false);
    expect(peerSupportsLink("future")).toBe(false);
  });

  it("records text and link support together", () => {
    recordPeerCaps("both", { caps: [CAP_TEXT, CAP_LINK] });
    expect(peerSupportsText("both")).toBe(true);
    expect(peerSupportsLink("both")).toBe(true);
  });

  it("hands out a fresh array, so a caller cannot mutate what we announce", () => {
    const first = capsSignal();
    first.caps.push("forged/1");
    expect(capsSignal()).toEqual({ caps: [CAP_TEXT, CAP_LINK] });
  });

  // The other piggybacks (relayRtt, rename) share this envelope and are handled
  // by other listeners, so misclaiming one would silently break them.
  it("ignores frames that are not a caps hello", () => {
    expect(recordPeerCaps("p1", { sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
    expect(recordPeerCaps("p1", { rename: "Bob" })).toBe(false);
    expect(recordPeerCaps("p1", { relayRtt: { r1: 12 } })).toBe(false);
    expect(recordPeerCaps("p1", {})).toBe(false);
    expect(recordPeerCaps("p1", null)).toBe(false);
    expect(recordPeerCaps("p1", undefined)).toBe(false);
    expect(recordPeerCaps("p1", "caps")).toBe(false);
    expect(recordPeerCaps("p1", 7)).toBe(false);
    expect(recordPeerCaps("p1", [CAP_TEXT])).toBe(false);
    expect(peerSupportsText("p1")).toBe(false);
  });

  // Peer-authored input arriving on an untrusted channel. Nothing here may throw
  // out of the signal dispatch, and nothing malformed may read as support.
  it("survives a malformed caps field without granting support", () => {
    expect(recordPeerCaps("p1", { caps: "text/1" })).toBe(false);   // not an array
    expect(recordPeerCaps("p2", { caps: [1, 2, 3] })).toBe(true);   // array, no strings
    expect(recordPeerCaps("p3", { caps: [] })).toBe(true);
    expect(recordPeerCaps("p4", { caps: [null, { a: 1 }] })).toBe(true);
    expect(recordPeerCaps("p5", { caps: ["TEXT/1"] })).toBe(true);  // case-sensitive
    expect(recordPeerCaps("p6", { caps: ["text/2"] })).toBe(true);  // a later version
    for (const id of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
      expect(peerSupportsText(id), id).toBe(false);
    }
  });

  it("accepts our capability alongside ones we do not know", () => {
    expect(recordPeerCaps("p1", { caps: ["future/9", CAP_TEXT, "other/2"] })).toBe(true);
    expect(peerSupportsText("p1")).toBe(true);
  });

  it("keeps peers independent", () => {
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    recordPeerCaps("p2", { caps: [] });
    expect(peerSupportsText("p1")).toBe(true);
    expect(peerSupportsText("p2")).toBe(false);
  });

  it("lets a later announcement supersede an earlier one", () => {
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    expect(peerSupportsText("p1")).toBe(true);
    recordPeerCaps("p1", { caps: [] });
    expect(peerSupportsText("p1")).toBe(false);
  });

  it("forgets a peer that left the roster", () => {
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    recordPeerCaps("p2", { caps: [CAP_TEXT] });
    retainPeers(["p2"]);
    expect(peerSupportsText("p1")).toBe(false);
    expect(peerSupportsText("p2")).toBe(true);
  });

  it("retainPeers with an empty roster forgets everyone", () => {
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    retainPeers([]);
    expect(peerSupportsText("p1")).toBe(false);
  });

  // A reconnecting peer gets a brand-new id from the server (main.go:44-48), so
  // a stale announcement can never be inherited by the new connection.
  it("does not carry an announcement onto a different peer id", () => {
    recordPeerCaps("old-id", { caps: [CAP_TEXT] });
    expect(peerSupportsText("new-id")).toBe(false);
  });

  it("resetPeerCaps clears everything, for a room switch", () => {
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    resetPeerCaps();
    expect(peerSupportsText("p1")).toBe(false);
  });
});
