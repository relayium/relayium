import { describe, it, expect } from "vitest";
import { isTextOffer } from "./text-link";

describe("isTextOffer", () => {
  it("accepts a text-generation offer", () => {
    expect(isTextOffer({ text: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(true);
  });

  // Untagged is the file generation, which listenForIncoming owns. Claiming one
  // here would start a message session on someone else's file transfer.
  it("rejects an untagged offer", () => {
    expect(isTextOffer({ sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
  });

  // A resume never runs a handshake, so it can never open a message session.
  it("rejects a resume, tagged or not", () => {
    expect(isTextOffer({ resume: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
    expect(isTextOffer({ text: true, resume: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
  });

  // An answer or a candidate belongs to a connection that already exists.
  it("rejects anything that is not an offer", () => {
    expect(isTextOffer({ text: true, sdp: { type: "answer", sdp: "v=0" } })).toBe(false);
    expect(isTextOffer({ text: true, ice: { candidate: "c" } })).toBe(false);
    expect(isTextOffer({ text: true })).toBe(false);
  });

  it("rejects the other piggybacks that share this envelope", () => {
    expect(isTextOffer({ caps: ["text/1"] })).toBe(false);
    expect(isTextOffer({ rename: "Bob" })).toBe(false);
    expect(isTextOffer({ relayRtt: { r1: 9 } })).toBe(false);
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, 0, "", "text", [], { text: "yes" }, { text: 1 }]) {
      expect(isTextOffer(junk), JSON.stringify(junk) ?? "undefined").toBe(false);
    }
  });
});
