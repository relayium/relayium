// The publisher, checked against the verifier that actually ships.
//
// The client has had a complete update verifier for some time and this
// repository had no publisher, so the two halves of the mechanism had never
// met. A generator tested against its own idea of the format proves nothing —
// the only question worth asking is whether `parseManifest` and the pinned-key
// signature check, exactly as they are compiled into the app, accept what the
// publisher writes and refuse what it must not.
//
// No credential is involved. An ephemeral Ed25519 keypair stands in for the
// release key, which is the only part of this that is still owed (OA-030).

import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as signDetached } from "node:crypto";
import {
  MANIFEST_IDENTITY,
  manifestBytes,
  publicKeyPin,
  signManifest,
} from "../../src/main/update/manifest-publisher.js";
import { ManifestError, parseManifest } from "../../src/main/update/manifest.js";
import { PRODUCTION_TRUST_BASE, assertSignedByPin, decodeSignature } from "../../src/main/update/trust.js";

const keys = generateKeyPairSync("ed25519");
// The encoding `trust.ts` actually accepts: base64url of the raw 32 bytes, as
// a JWK `x`. SPKI base64 — the obvious guess, and the one this test made first
// — is refused as `malformed-pin`, which is why the publisher derives it.
const publicKeyBase64 = publicKeyPin(keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const EXPECTED = {
  product: PRODUCTION_TRUST_BASE.product,
  channel: PRODUCTION_TRUST_BASE.channel,
  platform: "windows",
  arch: "x64",
} as const;

/** The shipping check, in the shape the app calls it: decode, then assert. */
const acceptedByPin = (bytes: Buffer, signature: string, keys: string[]): boolean => {
  try {
    assertSignedByPin(bytes, decodeSignature(signature), { ...PRODUCTION_TRUST_BASE, publicKeys: keys });
    return true;
  } catch {
    return false;
  }
};

const FIELDS = {
  version: "0.2.0",
  build: 7,
  artifactUrl: "https://github.com/relayium/relayium/releases/download/win-v0.2.0/Relayium.Setup.0.2.0.exe",
  artifactBytes: 118_127_472,
  artifactSha256: "ba312c88b080947bae2fb4fd1abc43a2b29eb4bc6fe386af9e37fd0e8a584de8",
  publishedAt: 1_757_600_000,
  notesUrl: "https://relayium.com/apps/windows/notes/0.2.0",
};

describe("what the publisher writes, read by the verifier that ships", () => {
  it("produces a manifest the shipping parser accepts", () => {
    const bytes = manifestBytes(FIELDS);
    const signature = signManifest(bytes, privatePem);
    const parsed = parseManifest(bytes, EXPECTED, signature);
    expect(parsed.version).toBe("0.2.0");
    expect(parsed.build).toBe(7);
    expect(parsed.artifactSha256).toBe(FIELDS.artifactSha256);
    // The bytes travel with the parse because the signature covers THEM, not a
    // re-serialisation of the object.
    expect(Buffer.from(parsed.signedBytes).equals(bytes)).toBe(true);
  });

  it("produces a signature the pinned-key check accepts", () => {
    const bytes = manifestBytes(FIELDS);
    const signature = signManifest(bytes, privatePem);
    expect(acceptedByPin(bytes, signature, [publicKeyBase64])).toBe(true);
  });

  // The property the whole mechanism rests on.
  it("is refused when a single byte of the document changes", () => {
    const bytes = manifestBytes(FIELDS);
    const signature = signManifest(bytes, privatePem);
    const tampered = Buffer.from(bytes);
    // Move the build number 7 -> 8: the smallest change that would matter, and
    // the one an attacker wants, since build is the update gate.
    const at = tampered.indexOf(Buffer.from('"build": 7'));
    expect(at).toBeGreaterThan(0);
    tampered[at + '"build": '.length] = "8".charCodeAt(0);
    expect(acceptedByPin(tampered, signature, [publicKeyBase64])).toBe(false);
  });

  it("is refused when another key signed it", () => {
    const other = generateKeyPairSync("ed25519");
    const bytes = manifestBytes(FIELDS);
    const foreign = signDetached(null, bytes, other.privateKey).toString("base64url");
    expect(acceptedByPin(bytes, foreign, [publicKeyBase64])).toBe(false);
  });

  it("derives a pin the build accepts, from the key that signs", () => {
    // The likeliest provisioning mistake in the whole feature: a pin in the
    // wrong encoding makes every client refuse to check for updates at all,
    // with `malformed-pin`, and looks like a working release until nobody
    // updates. Deriving it from the signing key removes the hand conversion.
    const pin = publicKeyPin(privatePem);
    expect(pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bytes = manifestBytes(FIELDS);
    expect(acceptedByPin(bytes, signManifest(bytes, privatePem), [pin])).toBe(true);
    // And an SPKI-encoded copy of the same key is NOT accepted, so the
    // distinction is asserted rather than assumed.
    const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(acceptedByPin(bytes, signManifest(bytes, privatePem), [spki])).toBe(false);
  });

  it("names the same product, channel, platform and arch the build pins", () => {
    // Two constants that must agree and live in different files. If the trust
    // base is ever re-channelled, this fails rather than every client refusing
    // a `wrong-channel` feed at once.
    expect(MANIFEST_IDENTITY.product).toBe(PRODUCTION_TRUST_BASE.product);
    expect(MANIFEST_IDENTITY.channel).toBe(PRODUCTION_TRUST_BASE.channel);
    expect(MANIFEST_IDENTITY.platform).toBe(PRODUCTION_TRUST_BASE.platform);
    expect(MANIFEST_IDENTITY.arch).toBe(PRODUCTION_TRUST_BASE.arch);
  });

  it("writes the same bytes twice for the same release", () => {
    // A publisher whose output varied would produce a different signature for
    // one release, and no way to tell a re-run from a substitution.
    expect(manifestBytes(FIELDS).equals(manifestBytes({ ...FIELDS }))).toBe(true);
  });
});

describe("what the publisher refuses to write", () => {
  // The update core's gate is "strictly greater build, or no update". A zero
  // ships a feed that either offers the running version forever or never
  // updates anyone.
  it("refuses a build number that is not a positive integer", () => {
    for (const build of [0, -1, 1.5, Number.NaN]) {
      expect(() => manifestBytes({ ...FIELDS, build }), String(build)).toThrow(/build must be/);
    }
  });

  it("refuses a version that is not dotted numbers", () => {
    for (const version of ["", "v1.2.3", "1", "1.2.3-beta", "latest"]) {
      expect(() => manifestBytes({ ...FIELDS, version }), version).toThrow(/version must be/);
    }
  });

  it("refuses a digest that is not lowercase hex sha-256", () => {
    for (const artifactSha256 of ["", "abc", FIELDS.artifactSha256.toUpperCase(), `${FIELDS.artifactSha256}00`]) {
      expect(() => manifestBytes({ ...FIELDS, artifactSha256 }), artifactSha256.slice(0, 12)).toThrow(/sha-256/);
    }
  });

  it("refuses to sign with a key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => signManifest(manifestBytes(FIELDS), rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString()))
      .toThrow(/Ed25519/);
  });
});

describe("a manifest for the wrong build entirely", () => {
  // Each of these is a real publication mistake, and the client names them
  // separately so a failure says which one happened.
  it("is refused by name when the channel does not match", () => {
    const bytes = Buffer.from(
      `${JSON.stringify({ ...MANIFEST_IDENTITY, channel: "beta", version: "0.2.0", build: 7,
        artifact: { url: FIELDS.artifactUrl, sizeBytes: FIELDS.artifactBytes, sha256: FIELDS.artifactSha256 },
        publishedAt: FIELDS.publishedAt, notesUrl: null }, null, 2)}\n`,
    );
    expect(() => parseManifest(bytes, EXPECTED, signManifest(bytes, privatePem)))
      .toThrow(ManifestError);
    try {
      parseManifest(bytes, EXPECTED, signManifest(bytes, privatePem));
    } catch (err) {
      expect((err as ManifestError).code).toBe("wrong-channel");
    }
  });
});
