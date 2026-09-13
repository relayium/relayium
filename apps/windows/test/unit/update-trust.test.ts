// The trust root: exact-bytes Ed25519, a pin that is never learned, and the
// refusals that must stay refusals.
//
// The key here is EPHEMERAL and generated per run. No release key material is
// in this repository, and a test that needed some would be a test that leaked
// it.
import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ARTIFACT_HOSTS,
  FEED_SIGNATURE_URL,
  FEED_URL,
  PRODUCTION_TRUST_BASE,
  TrustError,
  assertSignedByPin,
  decodeSignature,
  signatureFailureIsTerminal,
  updatesEnabled,
  type UpdateTrust,
} from "../../src/main/update/trust.js";

function ephemeralKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { encoded: jwk.x ?? "", privateKey };
}

const trustWith = (keys: readonly string[]): UpdateTrust => ({
  ...PRODUCTION_TRUST_BASE,
  publicKeys: keys,
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the pinned feed key", () => {
  it("accepts a signature over the exact bytes", () => {
    const key = ephemeralKey();
    const document = bytes('{"schema":1}');
    const signature = new Uint8Array(sign(null, document, key.privateKey));
    expect(() => assertSignedByPin(document, signature, trustWith([key.encoded]))).not.toThrow();
  });

  it("refuses a signature over DIFFERENT bytes, including a re-serialisation", () => {
    const key = ephemeralKey();
    const signed = bytes('{"schema":1,"build":2}');
    const signature = new Uint8Array(sign(null, signed, key.privateKey));
    // The same document, re-serialised with different whitespace. A verifier
    // that checked a parse rather than the bytes would accept this.
    const reserialised = bytes('{"schema": 1, "build": 2}');
    expect(() => assertSignedByPin(reserialised, signature, trustWith([key.encoded]))).toThrow(
      TrustError,
    );
    // And a single flipped byte.
    const tampered = signed.slice();
    tampered[3] = (tampered[3] ?? 0) ^ 0x01;
    expect(() => assertSignedByPin(tampered, signature, trustWith([key.encoded]))).toThrow(TrustError);
  });

  it("refuses another key's signature", () => {
    const mine = ephemeralKey();
    const theirs = ephemeralKey();
    const document = bytes("x");
    const signature = new Uint8Array(sign(null, document, theirs.privateKey));
    const error = (() => {
      try {
        assertSignedByPin(document, signature, trustWith([mine.encoded]));
        return null;
      } catch (reason) {
        return reason as TrustError;
      }
    })();
    expect(error?.code).toBe("not-signed-by-pin");
  });

  it("accepts either half of a rotation", () => {
    const outgoing = ephemeralKey();
    const incoming = ephemeralKey();
    const document = bytes("rotating");
    const trust = trustWith([outgoing.encoded, incoming.encoded]);
    for (const key of [outgoing, incoming]) {
      const signature = new Uint8Array(sign(null, document, key.privateKey));
      expect(() => assertSignedByPin(document, signature, trust)).not.toThrow();
    }
  });

  it("refuses everything when nothing is pinned", () => {
    const key = ephemeralKey();
    const document = bytes("x");
    const signature = new Uint8Array(sign(null, document, key.privateKey));
    const error = (() => {
      try {
        assertSignedByPin(document, signature, trustWith([]));
        return null;
      } catch (reason) {
        return reason as TrustError;
      }
    })();
    // Not "verified because there was nothing to check against".
    expect(error?.code).toBe("no-pin");
  });

  it("refuses a malformed pin loudly rather than skipping it", () => {
    const key = ephemeralKey();
    const document = bytes("x");
    const signature = new Uint8Array(sign(null, document, key.privateKey));
    // A build whose key does not parse must fail, not fall through to the next
    // pin and appear to work.
    expect(() => assertSignedByPin(document, signature, trustWith(["not-a-key"]))).toThrow(
      /malformed-pin/,
    );
  });

  it("refuses a signature of the wrong length", () => {
    const key = ephemeralKey();
    expect(() =>
      assertSignedByPin(bytes("x"), new Uint8Array(32), trustWith([key.encoded])),
    ).toThrow(/malformed-signature/);
  });
});

describe("the signature encoding", () => {
  it("decodes exactly 64 base64url bytes and nothing else", () => {
    const key = ephemeralKey();
    const signature = sign(null, bytes("x"), key.privateKey);
    const encoded = signature.toString("base64url");
    expect(decodeSignature(encoded)).toEqual(new Uint8Array(signature));
    // A trailing newline is what a file would carry.
    expect(decodeSignature(`${encoded}\n`)).toEqual(new Uint8Array(signature));
    for (const bad of ["", "abc", `${encoded}A`, signature.toString("base64"), `${encoded.slice(1)}+`]) {
      expect(() => decodeSignature(bad), JSON.stringify(bad.slice(0, 12))).toThrow(TrustError);
    }
  });
});

describe("what the build will look at", () => {
  it("pins one fixed feed URL and its detached signature", () => {
    expect(FEED_URL).toBe("https://relayium.com/apps/windows/updates.json");
    expect(FEED_SIGNATURE_URL).toBe("https://relayium.com/apps/windows/updates.json.sig");
    expect(PRODUCTION_TRUST_BASE.channel).toBe("stable");
    expect(PRODUCTION_TRUST_BASE.platform).toBe("windows");
    expect(PRODUCTION_TRUST_BASE.arch).toBe("x64");
  });

  it("lists artifact hosts EXACTLY, never as a suffix", () => {
    expect(DEFAULT_ARTIFACT_HOSTS).toEqual([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
    // No entry is a pattern, and none of them is the fleet suffix the stored
    // download path uses — that one admits a whole domain, and this governs an
    // executable.
    for (const host of DEFAULT_ARTIFACT_HOSTS) {
      expect(host.startsWith("*")).toBe(false);
      expect(host.startsWith(".")).toBe(false);
      expect(host.endsWith("relayium.com")).toBe(false);
    }
  });

  it("disables updates for an engineering build and for a build with no pin", () => {
    const key = ephemeralKey();
    expect(updatesEnabled(trustWith([key.encoded]), false)).toBe(true);
    // An engineering build points at a loopback origin; it has no business
    // installing a public artifact.
    expect(updatesEnabled(trustWith([key.encoded]), true)).toBe(false);
    expect(updatesEnabled(trustWith([]), false)).toBe(false);
    expect(updatesEnabled(null, false)).toBe(false);
  });

  it("states that a rejected signature is never cured by retrying", () => {
    // A value a caller has to read, rather than a rule to remember.
    expect(signatureFailureIsTerminal).toBe(true);
  });
});
