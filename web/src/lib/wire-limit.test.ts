import { describe, expect, it } from "vitest";
import {
  CHROME_MAX_MESSAGE_BYTES,
  CONSERVATIVE_MAX_MESSAGE_BYTES,
  negotiatedMaxMessageBytes,
} from "./wire-limit";
import { CHUNK_SIZE, CHUNK_OVERHEAD, MIN_PIECE_BYTES, piecePlainBytes } from "./transfer";

// A DataChannel's maximum message size is negotiated with the PEER, so a sender
// that assumes its own browser's capability is assuming something about a device
// it has never seen. Every branch here is one way the browser can answer.
describe("negotiatedMaxMessageBytes", () => {
  it("uses the negotiated number when the transport reports one", () => {
    expect(negotiatedMaxMessageBytes({ maxMessageSize: CHROME_MAX_MESSAGE_BYTES }))
      .toBe(CHROME_MAX_MESSAGE_BYTES);
    expect(negotiatedMaxMessageBytes({ maxMessageSize: 65_536 })).toBe(65_536);
  });

  it("honours Infinity — the spec returns it only when BOTH ends declared no limit", () => {
    expect(negotiatedMaxMessageBytes({ maxMessageSize: Infinity })).toBe(Infinity);
  });

  it("falls back conservatively when SCTP is not up yet", () => {
    expect(negotiatedMaxMessageBytes(null)).toBe(CONSERVATIVE_MAX_MESSAGE_BYTES);
    expect(negotiatedMaxMessageBytes(undefined)).toBe(CONSERVATIVE_MAX_MESSAGE_BYTES);
  });

  it("falls back conservatively on every ambiguous answer", () => {
    // 0 is a value the spec says is never returned. Reading it as "unlimited"
    // would be exactly the wrong guess on the devices this bug is about.
    for (const maxMessageSize of [0, -1, NaN, undefined]) {
      expect(negotiatedMaxMessageBytes({ maxMessageSize })).toBe(CONSERVATIVE_MAX_MESSAGE_BYTES);
    }
    expect(negotiatedMaxMessageBytes({} as { maxMessageSize?: number })).toBe(CONSERVATIVE_MAX_MESSAGE_BYTES);
  });

  it("does not round a fractional report upward past what the peer accepts", () => {
    expect(negotiatedMaxMessageBytes({ maxMessageSize: 65_536.9 })).toBe(65_536);
  });
});

describe("piecePlainBytes", () => {
  it("carries a whole logical chunk when the connection can take one", () => {
    expect(piecePlainBytes(CHUNK_SIZE + CHUNK_OVERHEAD)).toBe(CHUNK_SIZE);
    expect(piecePlainBytes(CHROME_MAX_MESSAGE_BYTES)).toBe(CHUNK_SIZE);
    expect(piecePlainBytes(Infinity)).toBe(CHUNK_SIZE);
  });

  it("leaves room for the header and the AES-GCM tag", () => {
    // The exact boundary that made a 64 KiB peer fail: the wire frame is the
    // plaintext plus CHUNK_OVERHEAD, so the plaintext must be strictly smaller.
    expect(piecePlainBytes(65_536)).toBe(65_536 - CHUNK_OVERHEAD);
    expect(piecePlainBytes(65_536) + CHUNK_OVERHEAD).toBeLessThanOrEqual(65_536);
  });

  it("is one byte short of a whole chunk at one byte under the chunk frame size", () => {
    const limit = CHUNK_SIZE + CHUNK_OVERHEAD - 1;
    expect(piecePlainBytes(limit)).toBe(CHUNK_SIZE - 1);
    expect(piecePlainBytes(limit) + CHUNK_OVERHEAD).toBeLessThanOrEqual(limit);
  });

  it("refuses a limit too small to be worth transferring over, by name", () => {
    expect(() => piecePlainBytes(MIN_PIECE_BYTES + CHUNK_OVERHEAD - 1))
      .toThrow(/maximum message size .* too small/);
    expect(() => piecePlainBytes(0)).toThrow(/too small/);
    expect(piecePlainBytes(MIN_PIECE_BYTES + CHUNK_OVERHEAD)).toBe(MIN_PIECE_BYTES);
  });
});
