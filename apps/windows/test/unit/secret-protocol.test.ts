import { describe, expect, it } from "vitest";
import {
  EXIT_BY_STATUS, FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, OP_SEAL,
  RESPONSE_MAGIC, decodeResponse, encodeRequest,
} from "../../src/main/secret/protocol.js";

const response = (status: number, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  RESPONSE_MAGIC.copy(header, 0);
  header.writeUInt8(1, 4);
  header.writeUInt8(status, 5);
  header.writeUInt32BE(payload.byteLength, 6);
  return Buffer.concat([header, payload]);
};

describe("request encoding", () => {
  it("is magic, version, op, big-endian length, payload", () => {
    const frame = encodeRequest(OP_SEAL, Buffer.from("hi"));
    expect(frame.subarray(0, 4).toString("ascii")).toBe("RLSQ");
    expect(frame.readUInt8(4)).toBe(1);
    expect(frame.readUInt8(5)).toBe(OP_SEAL);
    expect(frame.readUInt32BE(6)).toBe(2);
  });
});

describe("exit mapping", () => {
  it("is 0/2/3/4, leaving 1 unused", () => {
    expect(EXIT_BY_STATUS).toEqual({ ok: 0, protocol: 2, refused: 3, internal: 4 });
    // Exit 1 belongs to no status, so a process that died on its own terms
    // cannot be decoded as one.
    expect(Object.values(EXIT_BY_STATUS)).not.toContain(1);
  });
});

describe("response decoding is total and bounded", () => {
  it("accepts a well-formed ok frame", () => {
    const decoded = decodeResponse(response(0, Buffer.from("blob")));
    expect(decoded.ok && decoded.status).toBe("ok");
    expect(decoded.ok && decoded.payload.toString()).toBe("blob");
  });

  it("maps each status code", () => {
    for (const [code, status] of [[1, "protocol"], [2, "refused"], [3, "internal"]] as const) {
      const decoded = decodeResponse(response(code));
      expect(decoded.ok && decoded.status).toBe(status);
    }
  });

  it("rejects a bad magic, version or status", () => {
    const bad = response(0);
    bad.write("XXXX", 0, "ascii");
    expect(decodeResponse(bad)).toEqual({ ok: false, reason: "bad-magic" });
    const v = response(0); v.writeUInt8(2, 4);
    expect(decodeResponse(v)).toEqual({ ok: false, reason: "bad-version" });
    const s = response(0); s.writeUInt8(9, 5);
    expect(decodeResponse(s)).toEqual({ ok: false, reason: "bad-status" });
  });

  it("refuses an over-bound length BEFORE sizing anything by it", () => {
    const frame = response(0);
    frame.writeUInt32BE(MAX_FRAME_PAYLOAD_BYTES + 1, 6);
    expect(decodeResponse(frame)).toEqual({ ok: false, reason: "over-bound" });
  });

  it("distinguishes incomplete from wrong", () => {
    expect(decodeResponse(Buffer.alloc(3))).toEqual({ ok: false, reason: "short" });
    expect(decodeResponse(response(0, Buffer.from("abc")).subarray(0, 11))).toEqual({ ok: false, reason: "short" });
    expect(decodeResponse(Buffer.concat([response(0), Buffer.from("x")]))).toEqual({ ok: false, reason: "trailing" });
  });

  it("refuses a failure frame that carries a payload", () => {
    // A failure payload is specified empty; one that is not is not a frame this
    // helper produces, and reading it would be reading an unspecified value.
    expect(decodeResponse(response(2, Buffer.from("why")))).toEqual({ ok: false, reason: "truncated" });
  });
});
