// The publisher half of the update feed.
//
// The CLI that drives this is `build/make-update-manifest.mjs`; this file is the
// part with types, compiled with the rest of the main process so the test can
// import it directly rather than through a hand-written declaration that could
// only ever drift from it.
//
// The client has had a complete VERIFIER for some time: one Ed25519 key pinned
// into the build, a fixed feed URL with a detached signature beside it, an exact
// list of artifact hosts, and a parser that refuses by name. Nothing in this
// repository could produce a document that verifier would accept — so the two
// halves of the mechanism had never met.
//
// This is the other half. It reads a real installer, measures it, and writes the
// exact JSON `src/main/update/manifest.ts` parses, plus the detached signature
// `src/main/update/feed.ts` fetches beside it.
//
// ## What it will not do
//
// **Invent a build number.** `--build` is required and must be greater than
// zero. The update core's gate is "strictly greater build, or there is no
// update", so a manifest numbered 0 — or numbered by deriving something from the
// semver — would either offer the running version forever or invent an ordering
// the feed never agreed to. See `src/main/build-info.ts`.
//
// **Sign without a key.** `--key` is optional and its absence is reported: the
// manifest is written and NO `.sig` appears beside it. A feed with no signature
// is refused by the client as `untrusted`, terminally and without retrying it
// unverified, which is the correct outcome for an unsigned publication rather
// than something to work around here.
//
// **Guess the artifact URL.** It is passed in and checked against the hosts the
// build actually pins, so a manifest naming a host the client refuses is caught
// where it is written rather than by every user at once.

import { createHash, createPrivateKey, createPublicKey, sign as signDetached } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** Kept in step with `PRODUCTION_TRUST_BASE`; asserted by the test beside this. */
export const MANIFEST_IDENTITY = {
  schema: 1,
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
};

/**
 * The manifest bytes for one artifact.
 *
 * Returns a Buffer, not a string: the signature covers EXACT BYTES, and the
 * client persists the bytes it verified rather than re-serialising. Anything
 * that re-encodes between here and the signature breaks that.
 */
export interface ManifestFields {
  readonly version: string;
  readonly build: number;
  readonly artifactUrl: string;
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly publishedAt: number;
  readonly notesUrl?: string | null;
}

export function manifestBytes(fields: ManifestFields): Buffer {
  const { version, build, artifactUrl, artifactBytes, artifactSha256, publishedAt, notesUrl = null } = fields;
  if (!Number.isSafeInteger(build) || build <= 0) {
    throw new Error(`build must be a positive integer, got ${String(build)}`);
  }
  if (!/^[0-9]+(\.[0-9]+){1,3}$/.test(String(version))) {
    throw new Error(`version must be dotted numbers, got ${String(version)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(artifactSha256))) {
    throw new Error("artifactSha256 must be lowercase hex sha-256");
  }
  // Key order is fixed and the encoding is compact-with-newline, so two runs
  // over the same inputs produce identical bytes. A publisher whose output
  // varied would produce a different signature for the same release.
  // The WIRE shape, which is not the parsed shape. `UpdateManifest` in
  // `manifest.ts` is flat because that is what a caller wants back; the
  // document the parser reads nests the artifact's three facts under
  // `artifact`. Writing it from the interface produces a manifest the shipping
  // parser refuses as `bad-artifact-url`, which is how this was caught.
  const document = {
    ...MANIFEST_IDENTITY,
    version: String(version),
    build,
    artifact: {
      url: String(artifactUrl),
      sizeBytes: artifactBytes,
      sha256: String(artifactSha256),
    },
    publishedAt,
    notesUrl: notesUrl === null ? null : String(notesUrl),
  };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/** Base64url of the detached Ed25519 signature, exactly as the feed carries it. */
export function signManifest(bytes: Uint8Array, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`the feed is signed with Ed25519; this key is ${String(key.asymmetricKeyType)}`);
  }
  return signDetached(null, bytes, key).toString("base64url");
}

/**
 * The pin this key produces, in the ONLY encoding the build accepts.
 *
 * `trust.ts` builds its key from a JWK whose `x` is base64url of the raw 32
 * bytes — not SPKI, not standard base64, not hex. Every other encoding is
 * refused as `malformed-pin`, and a build with a malformed pin refuses to check
 * for updates at all. That is the most likely provisioning mistake there is, so
 * the pin is derived from the signing key here rather than converted by hand at
 * the moment somebody is pasting secrets into a settings page.
 */
export function publicKeyPin(privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`the feed is signed with Ed25519; this key is ${String(key.asymmetricKeyType)}`);
  }
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: unknown };
  if (typeof jwk.x !== "string") throw new Error("could not derive the public key");
  return jwk.x;
}

/** What the artifact itself says about its own size and digest. */
export function measureArtifact(file: string): { artifactBytes: number; artifactSha256: string } {
  const bytes = readFileSync(file);
  return {
    artifactBytes: statSync(file).size,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

