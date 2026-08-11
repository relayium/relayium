import { describe, it, expect, beforeEach } from "vitest";
import {
  CAP_LINK, CAP_PREUPLOAD, CAP_TEXT, LINK_BUILD_SUPPORT, advertisedCaps, capsSignal, linkRoomActive,
  recordPeerCaps, peerSupportsLink, peerSupportsPreupload, peerSupportsText, retainPeers, resetPeerCaps,
} from "./peer-caps.svelte";
import { clearRoom, enterRoom } from "./room.svelte";
import { localCaps } from "./webrtc";

/** `link/1` is no longer scoped to a room, so these run in both. Each test still
 *  starts from a known room rather than inheriting whichever one a previous file
 *  left behind — the room store is module state. */
beforeEach(() => { clearRoom(); resetPeerCaps(); });

describe("peer caps", () => {
  it("treats an unheard-from peer as not supporting text", () => {
    expect(peerSupportsText("p1")).toBe(false);
  });

  it("records an announcement and reports support", () => {
    expect(recordPeerCaps("p1", { caps: [CAP_TEXT] })).toBe(true);
    expect(peerSupportsText("p1")).toBe(true);
  });

  it("announces exactly text/1, link/1 and preupload/1", () => {
    expect(CAP_TEXT).toBe("text/1");
    expect(CAP_LINK).toBe("link/1");
    // The release switch for the unified workspace. A default build implements
    // both lanes, so it says so.
    // preupload/1 joined the list in the checkpoint that implemented BOTH
    // halves of the key handoff. It rides with link/1 and can never be
    // announced without it: frame kind 12 travels on the link's file channel.
    expect(CAP_PREUPLOAD).toBe("preupload/1");
    expect(capsSignal()).toEqual({ caps: [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD] });
    expect(advertisedCaps()).toEqual([CAP_TEXT, CAP_LINK, CAP_PREUPLOAD]);
    expect(LINK_BUILD_SUPPORT).toBe(true);
    expect(linkRoomActive()).toBe(true);
    // Both announcements come from this one source, so the roster hello and the
    // per-connection SDP confirmation cannot disagree about what we support.
    expect([...localCaps()]).toEqual([...advertisedCaps()]);
  });

  // Supersedes "never announces link/1 from a pairing-code room". The room scope
  // is gone (DECISION-LOG 2026-08-10); what replaced it is a bounded relay
  // lifetime, not a refusal to speak the protocol. The announcement must be the
  // SAME in both rooms — an asymmetry here is what strands a peer that believed
  // one half of it.
  it("announces the same capabilities in a pairing-code room", () => {
    enterRoom({ code: "123456" });
    expect(linkRoomActive()).toBe(true);
    expect(capsSignal()).toEqual({ caps: [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD] });
    expect(advertisedCaps()).toEqual([CAP_TEXT, CAP_LINK, CAP_PREUPLOAD]);
    // Still read at call time, not frozen at import time: entering and leaving a
    // room rewrites the URL fragment without a reload.
    expect([...localCaps()]).toEqual([CAP_TEXT, CAP_LINK, CAP_PREUPLOAD]);
    clearRoom();
    expect([...localCaps()]).toEqual([CAP_TEXT, CAP_LINK, CAP_PREUPLOAD]);
  });

  // The downgrade boundary that did NOT move. It is what keeps a speculative
  // two-channel offer away from an older Web peer, a native client or the CLI —
  // all of which read any inbound offer as a file transfer and then wait out a
  // stall watchdog for a manifest that never comes.
  it.each([
    ["a peer that never announced", null],
    ["a peer announcing only text/1", [CAP_TEXT]],
    ["a later link version", [CAP_TEXT, "link/2"]],
    ["a differently-cased claim", [CAP_TEXT, "LINK/1"]],
    ["a near-miss claim", [CAP_TEXT, "link/1 "]],
    ["an empty announcement", []],
  ])("refuses to route %s, in either room", (_label, caps) => {
    for (const room of [undefined, "123456"] as const) {
      resetPeerCaps();
      room ? enterRoom({ code: room }) : clearRoom();
      if (caps) recordPeerCaps("p", { caps });
      expect(peerSupportsLink("p"), `${_label} in ${room ?? "LAN"}`).toBe(false);
    }
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

  it("believes an exact claim in a pairing-code room too", () => {
    recordPeerCaps("peer", { caps: [CAP_TEXT, CAP_LINK] });
    enterRoom({ code: "654321" });
    expect(peerSupportsLink("peer")).toBe(true);
    expect(peerSupportsText("peer")).toBe(true);
  });

  // The gate on frame kind 12, with the same exactness rule and the same reason:
  // an unknown kind is a hard error, so a speculative handoff does not degrade
  // to the live link — it fails the whole transfer.
  it.each([
    ["a peer that never announced", null],
    ["a peer announcing only text/1", [CAP_TEXT]],
    ["a current link peer that does not speak it", [CAP_TEXT, CAP_LINK]],
    ["a later handoff version", [CAP_TEXT, CAP_LINK, "preupload/2"]],
    ["a differently-cased claim", [CAP_TEXT, CAP_LINK, "PREUPLOAD/1"]],
    ["a near-miss claim", [CAP_TEXT, CAP_LINK, "preupload/1 "]],
  ])("never hands a key handoff to %s", (_label, caps) => {
    if (caps) recordPeerCaps("peer", { caps });
    expect(peerSupportsPreupload("peer")).toBe(false);
    enterRoom({ code: "123456" });
    expect(peerSupportsPreupload("peer")).toBe(false);
  });

  it("believes an exact preupload/1 claim", () => {
    recordPeerCaps("peer", { caps: [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD] });
    expect(peerSupportsPreupload("peer")).toBe(true);
    enterRoom({ code: "654321" });
    expect(peerSupportsPreupload("peer")).toBe(true);
  });

  it("forgets a departed peer's handoff claim with the rest of its announcement", () => {
    recordPeerCaps("gone", { caps: [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD] });
    retainPeers([]);
    expect(peerSupportsPreupload("gone")).toBe(false);
  });

  it("records text and link support together", () => {
    recordPeerCaps("both", { caps: [CAP_TEXT, CAP_LINK] });
    expect(peerSupportsText("both")).toBe(true);
    expect(peerSupportsLink("both")).toBe(true);
  });

  it("hands out a fresh array, so a caller cannot mutate what we announce", () => {
    const first = capsSignal();
    first.caps.push("forged/1");
    expect(capsSignal()).toEqual({ caps: [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD] });
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
