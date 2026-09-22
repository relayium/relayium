import { describe, it, expect, beforeEach } from "vitest";
import { isCliHandshakeSignal, noteCliPeer, cliPeerInRoom, resetCliPeer } from "./cli-peer.svelte";

beforeEach(() => { resetCliPeer(); });

/** The CLI's two handshake frames, verbatim from `hsMsg` in
 *  `server/internal/rzvous/handshake.go`. `mode` is omitted for the file mode,
 *  which is what a plain `relayium send` emits. */
const CLI_COMMIT = { kind: "commit", commit: "Y29tbWl0", mode: "text" };
const CLI_COMMIT_FILE = { kind: "commit", commit: "Y29tbWl0" };
const CLI_REVEAL = { kind: "reveal", fp: "ab".repeat(32), nonce: "bm9uY2U=", candidates: ["192.0.2.1:5000"] };

/** Every payload an app or web peer actually puts on the signalling socket.
 *  If one of these ever latches the verdict, a real pairing is being refused. */
const APP_SIGNALS: Array<[string, unknown]> = [
  ["capability hello", { caps: ["link/1", "preupload/1"] }],
  ["relay-RTT map", { relayRtt: { r1: 42, r2: 71 } }],
  ["rename", { rename: "Lily's Mac" }],
  ["link request", { linkRequest: true, link: true }],
  ["busy", { busy: true, link: true }],
  ["link leave", { link: true, leave: true, auth: "c2ln" }],
  ["renew envelope", { link: true, renew: { round: 1 }, auth: "c2ln" }],
  ["reveal (app)", { link: true, reveal: { key: "a2V5", nonce: "bm9uY2U=" } }],
  ["offer", { sdp: { type: "offer", sdp: "v=0…" }, commit: "Y29tbWl0", caps: ["link/1"] }],
  ["answer", { sdp: { type: "answer", sdp: "v=0…" } }],
  ["ice candidate", { ice: { candidate: "candidate:1 1 udp …", sdpMid: "0" } }],
  ["resume offer", { sdp: { type: "offer", sdp: "v=0…" }, resume: true, auth: "c2ln" }],
];

describe("isCliHandshakeSignal", () => {
  it("recognises the CLI's commit and reveal", () => {
    expect(isCliHandshakeSignal(CLI_COMMIT)).toBe(true);
    expect(isCliHandshakeSignal(CLI_COMMIT_FILE)).toBe(true);
    expect(isCliHandshakeSignal(CLI_REVEAL)).toBe(true);
  });

  // The whole safety argument for this feature: a top-level `kind` is something
  // no app or web peer emits. Each case here is a shape taken from a real
  // emitter, so a future signal that adds `kind` fails this test rather than
  // silently breaking pairing in production.
  it.each(APP_SIGNALS)("does not recognise an app peer's %s", (_name, payload) => {
    expect(isCliHandshakeSignal(payload)).toBe(false);
  });

  // `commit` is a REAL field on InboundSignal — it rides the offer/answer — so a
  // recogniser keyed on it would refuse every app pairing. This is the mistake
  // RelayiumKit's shape-permissive `peerCommit(from:)` actually made.
  it("does not key on `commit`, which apps legitimately send", () => {
    expect(isCliHandshakeSignal({ commit: "Y29tbWl0" })).toBe(false);
  });

  it("rejects non-objects and a non-string kind", () => {
    for (const bad of [null, undefined, "kind", 7, [], [{ kind: "commit" }], { kind: 1 }, { kind: null }, {}]) {
      expect(isCliHandshakeSignal(bad)).toBe(false);
    }
  });
});

describe("the latch", () => {
  it("latches for the room the frame arrived in", () => {
    expect(cliPeerInRoom("483920")).toBe(false);
    expect(noteCliPeer(CLI_COMMIT, "483920")).toBe(true);
    expect(cliPeerInRoom("483920")).toBe(true);
  });

  // The CLI exits on our capability hello about 0.2 s after joining, so the
  // roster is empty by the time anything renders. A verdict derived from the
  // live roster would read "nobody is here"; this one must not.
  it("survives the peer leaving, because it is not read from the roster", () => {
    noteCliPeer(CLI_REVEAL, "483920");
    // nothing here re-announces or re-joins; the room simply has no peers now
    expect(cliPeerInRoom("483920")).toBe(true);
  });

  it("does not leak into another room", () => {
    noteCliPeer(CLI_COMMIT, "483920");
    expect(cliPeerInRoom("670675")).toBe(false);
  });

  it("never latches without a room, and never on an app signal", () => {
    expect(noteCliPeer(CLI_COMMIT, "")).toBe(false);
    expect(cliPeerInRoom("")).toBe(false);
    for (const [, payload] of APP_SIGNALS) {
      expect(noteCliPeer(payload, "483920")).toBe(false);
    }
    expect(cliPeerInRoom("483920")).toBe(false);
  });

  // N4: the verdict selects a fixed localized string; the peer's own `kind` is
  // never carried out of the recogniser, so peer-controlled text cannot reach
  // the DOM through this path.
  it("returns only a boolean, never the peer's text", () => {
    expect(noteCliPeer({ kind: "<img src=x onerror=alert(1)>" }, "483920")).toBe(true);
    expect(cliPeerInRoom("483920")).toBe(true);
  });
});
