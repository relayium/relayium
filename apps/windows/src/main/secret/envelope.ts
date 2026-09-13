// Which cipher wrote a stored blob.
//
// Determined by an explicit leading discriminator, never by attempting a
// decrypt and catching the failure. Trial decryption would make an oracle of a
// decrypt error and would blur `undecryptable` — "this data is bad" — into
// "wrong cipher", which is the distinction the whole secret-durability
// investigation existed to preserve.

/** `RLYM` + version 1. Written by the DPAPI helper path. */
export const RELAYIUM_ENVELOPE_V1 = Buffer.from([0x52, 0x4c, 0x59, 0x4d, 0x01]);

/**
 * Chromium's `OSCrypt` prefixes, read-only.
 *
 * These identify data sealed by `safeStorage.encryptString` before the helper
 * existed. Byte 0 is `0x76` where ours is `0x52`, so the two can never be
 * confused whatever follows.
 */
const LEGACY_PREFIXES = [Buffer.from("v10", "ascii"), Buffer.from("v11", "ascii")];

export type EnvelopeKind = "relayium-v1" | "legacy-oscrypt" | "unknown";

export function classify(sealed: Buffer): EnvelopeKind {
  if (sealed.byteLength >= RELAYIUM_ENVELOPE_V1.byteLength &&
      sealed.subarray(0, RELAYIUM_ENVELOPE_V1.byteLength).equals(RELAYIUM_ENVELOPE_V1)) {
    return "relayium-v1";
  }
  for (const prefix of LEGACY_PREFIXES) {
    if (sealed.byteLength >= prefix.byteLength && sealed.subarray(0, prefix.byteLength).equals(prefix)) {
      return "legacy-oscrypt";
    }
  }
  return "unknown";
}

/** Add the discriminator. The helper never sees it — it does not parse this. */
export function wrap(raw: Buffer): Buffer {
  return Buffer.concat([RELAYIUM_ENVELOPE_V1, raw]);
}

/** Strip the discriminator before handing the blob to the helper. */
export function unwrap(sealed: Buffer): Buffer {
  return sealed.subarray(RELAYIUM_ENVELOPE_V1.byteLength);
}
