// Sealing through `relayium-secret-helper`.
//
// The helper protects the plaintext with user-scope DPAPI and wraps it in its
// own integrity record. That record is native-private: nothing here builds or
// validates it. What this file owns is the application envelope — the
// discriminator — which never crosses the wire, because the helper does not
// parse it.

import { RELAYIUM_ENVELOPE_V1, classify, unwrap, wrap } from "./envelope.js";
import { MAX_BLOB_BYTES, MAX_PLAINTEXT_BYTES, OP_OPEN, OP_SEAL } from "./protocol.js";
import type { HelperTransport } from "./helper-transport.js";

export type DpapiFailure = "helper-unavailable" | "undecryptable" | "too-large";

export class DpapiCipherError extends Error {
  constructor(readonly code: DpapiFailure) {
    // No detail, ever: this value crosses process and IPC boundaries, and a
    // message that quoted what failed would carry the secret with it.
    super(code);
    this.name = "DpapiCipherError";
  }
}

export class DpapiCipher {
  constructor(private readonly transport: HelperTransport) {}

  async seal(plaintext: string): Promise<Buffer> {
    // Measured BEFORE allocating. Copying an over-long secret into a buffer
    // only to reject it leaves that copy in the heap for no purpose.
    if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES) {
      throw new DpapiCipherError("too-large");
    }
    const payload = Buffer.from(plaintext, "utf8");

    let result;
    try {
      result = await this.transport.invoke(OP_SEAL, payload);
    } finally {
      // The plaintext copy is done with either way. Best effort: the original
      // string cannot be wiped, but this copy can.
      payload.fill(0);
    }
    if (!result.ok) {
      // A seal cannot be "undecryptable" — there is nothing to decrypt yet — so
      // a refusal here is the helper declining, not bad data.
      throw new DpapiCipherError("helper-unavailable");
    }
    if (result.payload.byteLength > MAX_BLOB_BYTES) throw new DpapiCipherError("helper-unavailable");
    return wrap(result.payload);
  }

  async open(sealed: Buffer): Promise<string> {
    // Enforced HERE, not only in the caller. This method is exported, and
    // `unwrap` blindly strips five bytes — so without this check a `v10` blob or
    // any five-byte prefix would be forwarded to the helper as if it were ours,
    // asking the native side to interpret a format it does not define.
    if (classify(sealed) !== "relayium-v1") throw new DpapiCipherError("undecryptable");
    const blob = unwrap(sealed);
    if (blob.byteLength > MAX_BLOB_BYTES) throw new DpapiCipherError("undecryptable");

    const result = await this.transport.invoke(OP_OPEN, blob);
    if (!result.ok) {
      // `refused` covers both a wrong key and the helper's integrity check
      // rejecting a blob that `CryptUnprotectData` returned success for. Both
      // are facts about the DATA, so both are `undecryptable` — recoverable by
      // the user, never by us re-minting over it.
      throw new DpapiCipherError(result.failure === "refused" ? "undecryptable" : "helper-unavailable");
    }
    // Bounded before decoding: a helper returning more than this store would
    // ever have sealed is not returning our plaintext.
    if (result.payload.byteLength > MAX_PLAINTEXT_BYTES) {
      result.payload.fill(0);
      throw new DpapiCipherError("undecryptable");
    }
    try {
      // Strict: a payload that is not valid UTF-8 is not our plaintext, and
      // lossy decoding would return replacement characters as if they were the
      // secret.
      return new TextDecoder("utf-8", { fatal: true }).decode(result.payload);
    } catch {
      throw new DpapiCipherError("undecryptable");
    } finally {
      // The decoded string is now the only copy; the buffer is not needed.
      result.payload.fill(0);
    }
  }

  /** Exposed so the store can size its bound from the envelope, not a literal. */
  static readonly envelopeBytes = RELAYIUM_ENVELOPE_V1.byteLength;
}
