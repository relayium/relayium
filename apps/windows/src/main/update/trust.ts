// What this build will trust about an update, and nothing else.
//
// ## Two anchors, deliberately separate
//
// A **signed feed** answers "are these the exact bytes Relayium published?" It
// is this module's business: one Ed25519 public key compiled into the build,
// and a detached signature over the exact bytes of the metadata.
//
// **Authenticode** answers "does Windows recognise who published this
// executable?" It is NOT this module's business and cannot be substituted for
// by anything here — see `contracts.ts`. A verified feed makes an installer
// IDENTIFIED, not safe to run unattended, and the two results are carried
// separately all the way to the user.
//
// ## The key is pinned, never learned
//
// A trust root that can arrive in the thing it is meant to verify is not a
// trust root. Nothing in this module reads a key, a key id, an algorithm or a
// host from the feed: the config is supplied by the host at construction and is
// read-only from then on. A build with no pin refuses to check for updates at
// all rather than checking without verifying.

import { createPublicKey, verify as verifyDetached, type KeyObject } from "node:crypto";

/** The one metadata URL a production build reads. Fixed, not derived. */
export const FEED_URL = "https://relayium.com/apps/windows/updates.json";
/** Its detached signature, alongside it. */
export const FEED_SIGNATURE_URL = "https://relayium.com/apps/windows/updates.json.sig";

/**
 * The hosts an artifact download may touch, EXACTLY.
 *
 * GitHub serves a release asset with a 302 from `github.com` to a separate
 * download host, so a client that refused every redirect could not fetch the
 * artifact at all. These are exact hostnames, not suffixes: `*.githubusercontent.com`
 * would admit any subdomain anyone can be given, which is not an identity.
 *
 * ## What is deliberately absent, and why it is a REFUSAL rather than a gap
 *
 * GitHub has at times served release assets from S3 bucket hostnames. A bucket
 * name is not a pinnable publisher identity, so it is not here. If a redirect
 * lands on one, this build refuses and REPORTS the host it refused
 * (`artifact.ts`), so the pin can be extended from observed evidence instead of
 * from a guess. That is the honest failure: a download that does not happen and
 * says where it stopped.
 *
 * ## Not the fleet list
 *
 * `src/main/stored/transport.ts` has its own allowlist for stored-ciphertext
 * downloads (`*.relayium.com`). It is NOT reused here and must not be: that one
 * admits a whole suffix because a fleet node is any host under it, and it
 * governs opaque ciphertext that fails an AEAD check if it is wrong. This one
 * governs an EXECUTABLE.
 */
export const DEFAULT_ARTIFACT_HOSTS: readonly string[] = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

/** Where a build is allowed to look, and what it will believe. */
export interface UpdateTrust {
  /** Ed25519 public keys, base64url-encoded raw 32 bytes. More than one only
   *  during a rotation, so a feed signed by either half verifies. */
  readonly publicKeys: readonly string[];
  readonly feedUrl: string;
  readonly signatureUrl: string;
  readonly artifactHosts: readonly string[];
  /** The product this feed is for. A manifest naming anything else is refused
   *  rather than treated as a newer product. */
  readonly product: string;
  /** `stable`. One public channel; an engineering build disables updates
   *  entirely rather than pointing at a second feed. */
  readonly channel: string;
  readonly platform: "windows";
  readonly arch: "x64";
  /**
   * The Authenticode publisher identity an installer must carry.
   *
   * Null while no certificate is provisioned — and then NO install is possible:
   * `PlatformInstaller` refuses `no-expected-publisher` rather than running an
   * unverified executable, and the preview verifier can never report the
   * expected publisher either. That is the honest state for a product with no
   * code-signing certificate, not a degradation of one that has it.
   */
  readonly expectedPublisher: string | null;
}

export type TrustFailure =
  /** No pinned key. A build in this state does not check for updates. */
  | "no-pin"
  | "malformed-pin"
  | "malformed-signature"
  /** The bytes are not signed by any pinned key. Terminal: see the note on
   *  `signatureFailureIsTerminal`. */
  | "not-signed-by-pin";

export class TrustError extends Error {
  constructor(readonly code: TrustFailure) {
    super(`update trust: ${code}`);
    this.name = "TrustError";
  }
}

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature is 64 bytes; base64url of 64 bytes is 86 characters. */
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;

/**
 * A raw 32-byte Ed25519 public key as a `KeyObject`.
 *
 * Through JWK, which is the only format Node accepts for a RAW Ed25519 key —
 * SPKI would mean hand-assembling DER here, and a hand-assembled trust root is
 * a worse idea than a JWK.
 */
function keyFrom(encoded: string): KeyObject {
  if (!BASE64URL_32.test(encoded)) throw new TrustError("malformed-pin");
  try {
    return createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: encoded },
      format: "jwk",
    });
  } catch {
    throw new TrustError("malformed-pin");
  }
}

/**
 * Verify a detached Ed25519 signature over EXACT BYTES.
 *
 * The bytes, not a parse of them. This is called before the metadata is decoded
 * — before its schema is read, before its version is compared, before its URL
 * is looked at — because every one of those is an action taken on the
 * attacker's behalf if the bytes are not the publisher's. A re-serialised
 * document would also verify against a different signature than the one the
 * publisher made, which is how canonicalisation bugs become signature bypasses.
 *
 * Returns void or throws. There is no "verified with warnings".
 */
export function assertSignedByPin(
  bytes: Uint8Array,
  signature: Uint8Array,
  trust: UpdateTrust,
): void {
  if (trust.publicKeys.length === 0) throw new TrustError("no-pin");
  if (signature.byteLength !== 64) throw new TrustError("malformed-signature");
  for (const encoded of trust.publicKeys) {
    // A malformed pin is a build defect and is not skipped over: a build whose
    // key does not parse must fail loudly rather than fall through to the next
    // one and appear to work.
    const key = keyFrom(encoded);
    if (verifyDetached(null, bytes, key, signature)) return;
  }
  throw new TrustError("not-signed-by-pin");
}

/** Decode a base64url signature strictly. Refuses anything the encoder could
 *  not have produced, rather than accepting a truncation that would then fail
 *  verification and look like tampering. */
export function decodeSignature(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!BASE64URL_64.test(trimmed)) throw new TrustError("malformed-signature");
  return new Uint8Array(Buffer.from(trimmed, "base64url"));
}

/**
 * Whether a signature failure may ever be retried as unverified.
 *
 * It may not, and this exists so the answer is a value some future caller has
 * to read rather than a rule someone has to remember. A rejected signature is
 * not cured by fetching again, by fetching over a different route, or by asking
 * the user. The only cure is a correctly signed feed.
 */
export const signatureFailureIsTerminal = true;

/**
 * Whether this build may check for updates at all.
 *
 * False for an engineering build, and false when no key is pinned. Both are
 * refusals of the whole feature, not degradations of it: an engineering build
 * points at a loopback origin and has no business installing a public artifact,
 * and a build with no pin cannot verify anything it would download.
 */
export function updatesEnabled(trust: UpdateTrust | null, engineering: boolean): boolean {
  if (engineering) return false;
  return trust !== null && trust.publicKeys.length > 0;
}

/** The production trust root, minus the key material root supplies. Exported so
 *  a host can build the real config without restating the fixed parts. */
export const PRODUCTION_TRUST_BASE = {
  feedUrl: FEED_URL,
  signatureUrl: FEED_SIGNATURE_URL,
  artifactHosts: DEFAULT_ARTIFACT_HOSTS,
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
  // Not provisioned. Root coordinates the certificate; until then this stays
  // null and the signed install path is unreachable by construction.
  expectedPublisher: null,
} as const satisfies Omit<UpdateTrust, "publicKeys">;
