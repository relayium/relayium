// The `relayium-secret-helper` wire format.
//
//   request   RLSQ | version 1 | op    | u32BE len | payload
//   response  RLSR | version 1 | status| u32BE len | payload
//
// The helper wraps the plaintext in its own DPAPI-encrypted integrity record
// (domain, version, length, SHA-256). That format is NATIVE-PRIVATE: nothing
// here parses or reproduces it. `CryptUnprotectData` can return success on
// corrupted output, so the helper validates structure on open — and a second
// implementation of a private format would only be a second thing to drift.

export const REQUEST_MAGIC = Buffer.from("RLSQ", "ascii");
export const RESPONSE_MAGIC = Buffer.from("RLSR", "ascii");
export const PROTOCOL_VERSION = 1;

export const OP_SEAL = 1;
export const OP_OPEN = 2;

export type HelperStatus = "ok" | "protocol" | "refused" | "internal";
const STATUS_BY_CODE: Readonly<Record<number, HelperStatus>> = {
  0: "ok",
  1: "protocol",
  2: "refused",
  3: "internal",
};

/**
 * Exit codes, and why `1` is not among them.
 *
 * status 0 -> exit 0, 1 -> 2, 2 -> 3, 3 -> 4. Exit 1 is deliberately unused, so
 * a process that died for a reason of its own — a runtime abort, a loader
 * failure — is distinguishable from any real status rather than being decoded
 * as one.
 */
export const EXIT_BY_STATUS: Readonly<Record<HelperStatus, number>> = {
  ok: 0,
  protocol: 2,
  refused: 3,
  internal: 4,
};

export const MAX_PLAINTEXT_BYTES = 65536;
export const MAX_BLOB_BYTES = 69632;
export const FRAME_HEADER_BYTES = 10;
/** The larger of the two payloads a frame can carry. */
export const MAX_FRAME_PAYLOAD_BYTES = MAX_BLOB_BYTES;
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES;

export function encodeRequest(op: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  REQUEST_MAGIC.copy(header, 0);
  header.writeUInt8(PROTOCOL_VERSION, 4);
  header.writeUInt8(op, 5);
  header.writeUInt32BE(payload.byteLength, 6);
  return Buffer.concat([header, payload]);
}

export type DecodedResponse =
  | { readonly ok: true; readonly status: HelperStatus; readonly payload: Buffer }
  | { readonly ok: false; readonly reason: "short" | "bad-magic" | "bad-version" | "bad-status" | "over-bound" | "truncated" | "trailing" };

/**
 * Decode one complete response.
 *
 * Total and bounded. `short` means "not yet complete" so a reader can wait;
 * every other reason is terminal, because a frame that is wrong is not a frame
 * that will become right with more bytes.
 */
export function decodeResponse(buffer: Buffer): DecodedResponse {
  if (buffer.byteLength < FRAME_HEADER_BYTES) return { ok: false, reason: "short" };
  if (!buffer.subarray(0, 4).equals(RESPONSE_MAGIC)) return { ok: false, reason: "bad-magic" };
  if (buffer.readUInt8(4) !== PROTOCOL_VERSION) return { ok: false, reason: "bad-version" };

  const status = STATUS_BY_CODE[buffer.readUInt8(5)];
  if (status === undefined) return { ok: false, reason: "bad-status" };

  const length = buffer.readUInt32BE(6);
  // Checked before any allocation or slice sized by it.
  if (length > MAX_FRAME_PAYLOAD_BYTES) return { ok: false, reason: "over-bound" };

  const end = FRAME_HEADER_BYTES + length;
  if (buffer.byteLength < end) return { ok: false, reason: "short" };
  if (buffer.byteLength > end) return { ok: false, reason: "trailing" };

  // A failure carries no payload; one that does is not a frame this helper
  // produces, and reading it as success would be reading an unspecified value.
  if (status !== "ok" && length !== 0) return { ok: false, reason: "truncated" };

  return { ok: true, status, payload: buffer.subarray(FRAME_HEADER_BYTES, end) };
}
