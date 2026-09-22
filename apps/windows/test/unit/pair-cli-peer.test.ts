// A relayium CLI in a pairing room, seen from the Windows client.
//
// The recogniser itself is the WEB module, imported unmodified — the first
// assertion pins that import path and the discriminator's behaviour together,
// so a move or a rename on the web side fails here rather than silently
// leaving this client with no recogniser at all.
//
// The rest is a source guard, in the shape this suite already uses elsewhere:
// the controller has to LATCH the verdict (the CLI leaves ~0.2 s after it
// arrives, so a roster-derived answer would be "nobody is here"), and the page
// has to render it at ROOM level, because either card may have been the one
// that minted the code.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isCliHandshakeSignal } from "../../../../web/src/lib/cli-peer.svelte";
import { en, zh } from "../../src/renderer/i18n/messages.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the CLI recogniser this client imports from web", () => {
  it("recognises the CLI's handshake frames", () => {
    expect(isCliHandshakeSignal({ kind: "commit", commit: "Y29tbWl0" })).toBe(true);
    expect(isCliHandshakeSignal({ kind: "reveal", fp: "ab", nonce: "bm8=" })).toBe(true);
  });

  // The safety argument in one assertion: no app or web peer emits a top-level
  // `kind`. `commit` is included deliberately — it is a real field on an app's
  // offer, so a recogniser keyed on it would refuse every real pairing.
  it.each([
    ["capability hello", { caps: ["link/1"] }],
    ["relay-RTT map", { relayRtt: { r1: 42 } }],
    ["rename", { rename: "Lily's PC" }],
    ["link request", { linkRequest: true, link: true }],
    ["busy", { busy: true, link: true }],
    ["link leave", { link: true, leave: true, auth: "c2ln" }],
    ["offer", { sdp: { type: "offer", sdp: "v=0" }, commit: "Y29tbWl0", caps: ["link/1"] }],
    ["ice", { ice: { candidate: "candidate:1 1 udp" } }],
    ["a bare commit", { commit: "Y29tbWl0" }],
  ])("does not recognise an app peer's %s", (_name, payload) => {
    expect(isCliHandshakeSignal(payload)).toBe(false);
  });
});

describe("the room controller and the pair page", () => {
  const controller = read("../../src/renderer/rooms/room-controller.svelte.ts");
  const page = read("../../src/renderer/pages/PairPage.svelte");

  it("latches the verdict rather than deriving it from the roster", () => {
    expect(controller).toContain("#cliPeer = $state(false)");
    expect(controller).toContain("isCliHandshakeSignal(data)");
    expect(controller).toContain("get cliPeer(): boolean");
    // Cleared when this client joins a room, so a verdict cannot outlive the
    // room it was about.
    expect(controller).toContain("this.#cliPeer = false;");
  });

  it("states it at room level, not inside one of the two cards", () => {
    expect(page).toContain('data-test="pair-cli-peer"');
    expect(page).toContain('t("pairCliPeer")');
    // Between the cards: after the first closes and before the second opens.
    const afterFirstCard = page.split("</Card>")[1] ?? "";
    expect(afterFirstCard).toContain("room.cliPeer");
  });

  it("has the sentence in both maintained catalogues, naming the two commands", () => {
    for (const catalogue of [en, zh]) {
      expect(catalogue.pairCliPeer).toContain("relayium up");
      expect(catalogue.pairCliPeer).toContain("relayium down");
    }
    expect(en.pairCliPeer).not.toBe(zh.pairCliPeer);
  });
});
