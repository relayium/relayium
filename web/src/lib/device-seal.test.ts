import { describe, it, expect, beforeAll } from "vitest";
import sodium from "libsodium-wrappers";
import { encodeKey } from "./store-crypto";
import { INBOX_KEY_ALGORITHM } from "./device-inbox";
import {
  CONTENT_KEY_BYTES,
  SEALED_BOX_BYTES,
  UnusableDeviceKeyError,
  decodeDevicePublicKey,
  sealContentKey,
  sealContentKeyToRaw,
} from "./device-seal";

beforeAll(async () => {
  await sodium.ready; // this suite opens boxes with an INDEPENDENT libsodium call
});

function contentKey(fill = 7): Uint8Array {
  return new Uint8Array(CONTENT_KEY_BYTES).fill(fill);
}

describe("wrapping a content key to a device", () => {
  it("produces a box the device's private key opens, and nothing else does", async () => {
    const target = sodium.crypto_box_keypair();
    const other = sodium.crypto_box_keypair();
    const key = contentKey();

    const wrapped = await sealContentKey(key, INBOX_KEY_ALGORITHM, encodeKey(target.publicKey));
    const raw = sodium.from_base64(wrapped, sodium.base64_variants.URLSAFE_NO_PADDING);
    expect(raw.length).toBe(SEALED_BOX_BYTES);

    const opened = sodium.crypto_box_seal_open(raw, target.publicKey, target.privateKey);
    expect(Array.from(opened)).toEqual(Array.from(key));

    // The wrong device holds the wrong half. libsodium signals this by throwing;
    // either way the content key must not come back out.
    expect(() => sodium.crypto_box_seal_open(raw, other.publicKey, other.privateKey)).toThrow();
  });

  it("a tampered box does not open — the Poly1305 tag is the whole point", async () => {
    const target = sodium.crypto_box_keypair();
    const wrapped = await sealContentKey(contentKey(), INBOX_KEY_ALGORITHM, encodeKey(target.publicKey));
    const raw = sodium.from_base64(wrapped, sodium.base64_variants.URLSAFE_NO_PADDING);
    for (const at of [0, 40, raw.length - 1]) {
      const bad = raw.slice();
      bad[at] ^= 0x01;
      expect(() => sodium.crypto_box_seal_open(bad, target.publicKey, target.privateKey)).toThrow();
    }
  });

  it("is canonical unpadded base64url — one key, one spelling", async () => {
    const target = sodium.crypto_box_keypair();
    const wrapped = await sealContentKey(contentKey(), INBOX_KEY_ALGORITHM, encodeKey(target.publicKey));
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(wrapped).not.toContain("=");
    // Exactly what central checks before it will store the box.
    expect(wrapped.length).toBe(Math.ceil((SEALED_BOX_BYTES * 8) / 6));
  });

  it("never produces the same box twice — the sender key is ephemeral", async () => {
    const target = sodium.crypto_box_keypair();
    const a = await sealContentKey(contentKey(), INBOX_KEY_ALGORITHM, encodeKey(target.publicKey));
    const b = await sealContentKey(contentKey(), INBOX_KEY_ALGORITHM, encodeKey(target.publicKey));
    expect(a).not.toBe(b);
  });
});

describe("refusing a key that must not be wrapped to", () => {
  it("refuses the all-zero public key — every wrap to it is world-readable", async () => {
    // The adversarial case this validation exists for: a low-order point parses,
    // is the right length, and the shared secret is all zeros, so ANY holder of
    // the box could open it. Central refuses it at registration; the browser
    // must refuse it again, because a substituted device-list response is
    // exactly how it would arrive here.
    const zero = encodeKey(new Uint8Array(32));
    await expect(decodeDevicePublicKey(INBOX_KEY_ALGORITHM, zero)).rejects.toBeInstanceOf(UnusableDeviceKeyError);
    await expect(sealContentKey(contentKey(), INBOX_KEY_ALGORITHM, zero)).rejects.toBeInstanceOf(
      UnusableDeviceKeyError,
    );
  });

  it("refuses the rest of the canonical low-order set", async () => {
    // The published Curve25519 small-order points. Each one is a key a hostile
    // or broken server could hand out to make "encrypted for your device" mean
    // "encrypted for everybody".
    const lowOrder = [
      new Uint8Array(32), // 0
      Uint8Array.from([1, ...new Array(31).fill(0)]), // 1
      sodium.from_hex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
      sodium.from_hex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f11d7"),
      sodium.from_hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
      sodium.from_hex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
      sodium.from_hex("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    ];
    for (const point of lowOrder) {
      await expect(
        decodeDevicePublicKey(INBOX_KEY_ALGORITHM, encodeKey(point)),
        `accepted low-order point ${sodium.to_hex(point)}`,
      ).rejects.toBeInstanceOf(UnusableDeviceKeyError);
    }
  });

  it("refuses an algorithm this protocol version does not define", async () => {
    const target = sodium.crypto_box_keypair();
    for (const alg of ["", "rsa-oaep-v1", "x25519-sealedbox-v2", "X25519-SealedBox-v1"]) {
      await expect(
        sealContentKey(contentKey(), alg, encodeKey(target.publicKey)),
      ).rejects.toBeInstanceOf(UnusableDeviceKeyError);
    }
  });

  it("refuses a non-canonical or wrong-length spelling", async () => {
    const target = sodium.crypto_box_keypair();
    const good = encodeKey(target.publicKey);
    for (const bad of [
      good + "=", // padded
      good.slice(0, 42), // short
      good + "A", // long
      good.replace(/-/g, "+").replace(/_/g, "/") + "", // standard alphabet (no-op when absent, still 43 chars)
      "A".repeat(42) + "B", // non-zero trailing bits
      "",
      " " + good,
    ]) {
      if (bad === good) continue; // the alphabet swap is a no-op for this key
      await expect(
        decodeDevicePublicKey(INBOX_KEY_ALGORITHM, bad),
        `accepted ${JSON.stringify(bad)}`,
      ).rejects.toBeInstanceOf(UnusableDeviceKeyError);
    }
  });

  it("refuses to wrap anything that is not exactly the 32-byte content key", async () => {
    const target = sodium.crypto_box_keypair();
    const pub = await decodeDevicePublicKey(INBOX_KEY_ALGORITHM, encodeKey(target.publicKey));
    for (const n of [0, 16, 31, 33, 64]) {
      await expect(sealContentKeyToRaw(new Uint8Array(n), pub)).rejects.toBeInstanceOf(UnusableDeviceKeyError);
    }
  });

  it("carries no key material in the error it throws", async () => {
    const secret = encodeKey(new Uint8Array(32).fill(0xab));
    const err = await sealContentKey(contentKey(), "bogus-alg", secret).catch((e) => e);
    expect(err).toBeInstanceOf(UnusableDeviceKeyError);
    expect(JSON.stringify({ m: err.message, s: err.stack ?? "" })).not.toContain(secret);
  });
});
