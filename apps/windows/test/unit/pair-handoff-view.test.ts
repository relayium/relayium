// The handoff's copy, and what the QR actually encodes.

import { describe, expect, it } from "vitest";
import { pairEn, pairZh, type PairMessageKey } from "../../src/renderer/pair/messages.js";
import { renderJoinQr, QR_SIDE } from "../../src/renderer/pair/qr.js";
import { joinLinkFor } from "../../src/main/features/pair-handoff.js";
import {
  PAIR_HANDOFF_CODE_LENGTH,
  PAIR_HANDOFF_FRAGMENT,
  PAIR_HANDOFF_PATH,
  isPairHandoffAction,
} from "../../src/shared/pair-handoff.js";
// The canonical helper the mac's QR comment points at. Imported rather than
// restated so the fragment rule has one definition.
import { parseCodeParam, CROSS_PATH } from "../../../../web/src/lib/transfer-link";

const ORIGIN = "https://relayium.test";
const CODE = "483920";

describe("the contract matches the canonical web helper", () => {
  it("uses the same path and fragment the web client builds and parses", () => {
    expect(PAIR_HANDOFF_PATH).toBe(CROSS_PATH);
    expect(PAIR_HANDOFF_FRAGMENT).toBe("#c=");
    expect(PAIR_HANDOFF_CODE_LENGTH).toBe(6);
  });

  it("produces a link the web client's own parser accepts", () => {
    const link = joinLinkFor(ORIGIN, CODE);
    expect(link).not.toBeNull();
    const hash = new URL(link!).hash;
    // The round trip that matters: what main builds is what the joining page
    // reads. A disagreement here is a link that opens to nothing.
    expect(parseCodeParam(hash)).toBe(CODE);
  });

  it("admits exactly one action token", () => {
    expect(isPairHandoffAction("copy-join-link")).toBe(true);
    for (const bad of ["copy", "", "paste", null, undefined, 1]) {
      expect(isPairHandoffAction(bad)).toBe(false);
    }
  });
});

describe("what the encoder is given", () => {
  it("parses the join link into segments that reproduce it exactly", async () => {
    // SCOPE: this inspects the encoder's INPUT REPRESENTATION — the segments it
    // parsed the link into and will rasterise. It is NOT a decode of a rendered
    // image and must not be described as one: nothing here reads pixels, and a
    // scanner result is a different claim entirely. Actual image decoding is
    // done independently by root against the captured PNGs.
    const link = joinLinkFor(ORIGIN, CODE)!;
    const qrcode = await import("qrcode");
    const encoded = qrcode.create(link, { errorCorrectionLevel: "M" });
    // Byte-mode segments carry UTF-8 BYTES, not a string — decoding them is the
    // point, since these are the bytes that get rasterised.
    const decoder = new TextDecoder();
    const payload = encoded.segments
      .map((segment) => {
        const data = segment.data as unknown;
        return typeof data === "string" ? data : decoder.decode(Uint8Array.from(data as number[]));
      })
      .join("");
    expect(payload).toBe(link);
    // The code is recoverable from what the encoder was given, by the web
    // client's own parser — again, from the segments, not from an image.
    expect(parseCodeParam(new URL(payload).hash)).toBe(CODE);
  });

  it("renders a PNG data URL at the handoff size", async () => {
    const link = joinLinkFor(ORIGIN, CODE)!;
    const result = await renderJoinQr({ link, generation: 4 });
    expect(result.generation).toBe(4);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(QR_SIDE).toBe(160);
  });

  it("never rejects, and answers null for input it cannot encode", async () => {
    for (const link of ["", null as unknown as string, undefined as unknown as string]) {
      await expect(renderJoinQr({ link, generation: 1 })).resolves.toEqual({
        generation: 1,
        dataUrl: null,
      });
    }
  });
});

describe("the catalogue covers both maintained languages", () => {
  const enKeys = Object.keys(pairEn).sort();

  it("has the same key set in both", () => {
    expect(Object.keys(pairZh).sort()).toEqual(enKeys);
  });

  it("has no empty string in either", () => {
    for (const key of enKeys as PairMessageKey[]) {
      expect(pairEn[key].length).toBeGreaterThan(0);
      expect(pairZh[key].length).toBeGreaterThan(0);
    }
  });

  it("uses the same placeholders in both", () => {
    const holders = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of enKeys as PairMessageKey[]) {
      expect({ key, h: holders(pairZh[key]) }).toEqual({ key, h: holders(pairEn[key]) });
    }
  });

  it("is really translated where it matters", () => {
    for (const key of ["qrUnavailable", "copyExpired", "linkNote", "idle"] as const) {
      expect(pairZh[key]).not.toBe(pairEn[key]);
      expect(pairZh[key]).toMatch(/[一-鿿]/);
    }
  });

  it("says why the link has a fragment, without claiming more", () => {
    expect(pairEn.linkNote).toMatch(/after #/);
    expect(pairZh.linkNote).toContain("#");
    // It explains our servers, and does not promise anything about the
    // recipient's network or their browser history.
    expect(pairEn.linkNote).not.toMatch(/private|secure|encrypted|anonymous/i);
  });

  it("treats a missing QR as an accelerator, not a breakage", () => {
    expect(pairEn.qrUnavailable).toMatch(/still work/i);
    expect(pairZh.qrUnavailable).toContain("仍然可用");
  });
});
