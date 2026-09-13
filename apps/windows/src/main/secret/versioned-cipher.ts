// Read by discriminator; write only through DPAPI.
//
// ## Why migration is a REPORT, not an action taken here
//
// `SecretStore` serializes every operation on a key through one chain. A cipher
// that reacted to a legacy read by calling `store.put(key, …)` would enqueue
// behind the very `get` it is running inside, and the chain would await itself:
// a deadlock, on the sign-in path, that no test of this file alone would catch.
//
// So this layer never writes. It reports `needsMigration` with the plaintext it
// already recovered, and the store — already inside that key's serialized
// section — performs the atomic replace itself.

import { classify } from "./envelope.js";
import { DpapiCipher, DpapiCipherError } from "./dpapi-cipher.js";
import type { LegacyReader } from "./legacy-cipher.js";

export type OpenOutcome =
  | { readonly kind: "ok"; readonly value: string; readonly needsMigration: boolean }
  | { readonly kind: "undecryptable" }
  | { readonly kind: "helper-unavailable" };

export class VersionedCipher {
  constructor(
    private readonly dpapi: DpapiCipher,
    private readonly legacy: LegacyReader,
  ) {}

  /** Always the current envelope. The legacy format is never written again. */
  seal(plaintext: string): Promise<Buffer> {
    return this.dpapi.seal(plaintext);
  }

  async open(sealed: Buffer): Promise<OpenOutcome> {
    switch (classify(sealed)) {
      case "relayium-v1": {
        try {
          return { kind: "ok", value: await this.dpapi.open(sealed), needsMigration: false };
        } catch (err) {
          return err instanceof DpapiCipherError && err.code === "helper-unavailable"
            ? { kind: "helper-unavailable" }
            : { kind: "undecryptable" };
        }
      }
      case "legacy-oscrypt": {
        if (!this.legacy.isAvailable()) return { kind: "helper-unavailable" };
        try {
          // Readable today, and worth re-sealing — but the decision to write is
          // the store's, above.
          return { kind: "ok", value: this.legacy.decrypt(sealed), needsMigration: true };
        } catch {
          // The exact state the field builds are in: bytes intact, key gone.
          // Recoverable by the user, never by re-minting over it.
          return { kind: "undecryptable" };
        }
      }
      case "unknown":
        // Refused before anything is spawned. The helper is never asked to
        // interpret a blob it does not define.
        return { kind: "undecryptable" };
    }
  }
}
