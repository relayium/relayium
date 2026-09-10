// This installation's lookup hint.
//
// 32 random bytes, RawURL base64, 43 characters — the same value the Go CLI and
// the macOS app mint, governed by `server/account/installid.go`.
//
// ## It is not a credential
//
// Presenting it authenticates nothing. Central consults it only AFTER a human
// has approved a device-code login, and only inside the approving account, to
// decide which device row that approval lands on. That is why it rides `start`
// and never `poll`: `poll` is the call that returns a bearer, and a value that
// travels alongside a credential eventually gets treated as one.
//
// ## It outlives sign-out
//
// Deliberate, and the reason this lives apart from the bearer. If signing out
// erased it, signing back in would mint a *third* device row for one machine and
// the user's device list would fill with ghosts of itself. The macOS
// `InstallationIdentityStoring` protocol has no `clear()` for exactly this
// reason; here the same guarantee is structural — sign-out deletes the bearer
// key and this module is never asked.

import { randomBytes } from "node:crypto";
import { SecretStoreError, type SecretStore } from "../secrets.js";

export const INSTALL_ID_LENGTH = 43;
export const INSTALL_ID_BYTES = 32;
/** Its own key, never cleared by sign-out. */
export const INSTALL_ID_KEY = "installation-identity";

/**
 * Accept exactly the canonical spelling and nothing else.
 *
 * A 32-byte value leaves two unused bits in its final base64 character, so a
 * permissive decoder accepts four spellings of one value. Since this string is
 * compared and indexed AS TEXT, more than one spelling would let a single
 * installation present two identities. The round trip is the strictness check —
 * a character-class regex cannot see a non-canonical final character.
 */
export function isValidInstallID(value: string): boolean {
  if (typeof value !== "string" || value.length !== INSTALL_ID_LENGTH) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return false;
  }
  if (decoded.length !== INSTALL_ID_BYTES) return false;
  return decoded.toString("base64url") === value;
}

export function mintInstallID(): string {
  return randomBytes(INSTALL_ID_BYTES).toString("base64url");
}

/**
 * Read the stored identity, minting one only on genuine first run.
 *
 * ## Why this does not catch broadly
 *
 * An earlier shape caught every error and minted a replacement. That turns a
 * momentarily unreadable file — a permission blip, a profile being restored, a
 * cipher that cannot open bytes written under a different OS account — into a
 * SECOND identity for one machine, which is precisely what this value exists to
 * prevent. Only `not-found` may mint. Everything else propagates, so the caller
 * can show a recoverable failure instead of quietly acquiring a new identity.
 *
 * ## Why `putIfAbsent` rather than get-then-put
 *
 * Two concurrent callers on one installation must not end up with two different
 * identities. `putIfAbsent` is serialised inside the store and is create-once:
 * exactly one caller writes, and the other is handed back the value that won.
 */
export async function loadOrMintInstallID(store: SecretStore): Promise<string> {
  try {
    const existing = await store.get(INSTALL_ID_KEY);
    if (isValidInstallID(existing)) return existing;
    // Present, decryptable, and not a canonical identity. Central would refuse
    // it as a hint, and keeping it would leave a string no rule governs — so
    // this is the one case where replacing a readable value is correct.
    await store.put(INSTALL_ID_KEY, mintInstallID());
    return await store.get(INSTALL_ID_KEY);
  } catch (err) {
    if (!(err instanceof SecretStoreError) || err.code !== "not-found") throw err;
  }
  const { value } = await store.putIfAbsent(INSTALL_ID_KEY, mintInstallID());
  return value;
}
