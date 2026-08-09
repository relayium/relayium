// Wrapping a Device Inbox content key to a target device (protocol §2).
//
// Exactly one thing is sealed: the task's 32-byte one-time AES-256-GCM content
// key — the same key `store-crypto.ts` already produces for a stored upload.
// The manifest and every file frame are encrypted with it exactly as today;
// Device Inbox changes only how that key reaches the target.
//
// The primitive is libsodium `crypto_box_seal` (`x25519-sealedbox-v1`): X25519 +
// XSalsa20-Poly1305 under an EPHEMERAL sender key, so no sender long-term key
// has to exist. Central holds no device private key, so it cannot open the
// result — that is what keeps "Relayium cannot read your files" true for this
// path. The Go receiver opens it with `box.OpenAnonymous`
// (`server/internal/inboxclient/keys.go`), and that interoperability is proven
// by execution, not by inspection: see `device-seal.interop.test.ts`.
//
// This module holds the ONLY code in the browser that touches a target device's
// key material. Nothing here logs, stores or returns a private value, and the
// content key never leaves as anything but ciphertext.
import type Sodium from "libsodium-wrappers";
import { decodeKey, encodeKey } from "./store-crypto";
import { INBOX_KEY_ALGORITHM, X25519_PUBLIC_KEY_BYTES, isCanonicalB64Url } from "./device-inbox";

/** Sealed-box length for this algorithm: 32-byte ephemeral public key + the
 *  32-byte content key + the 16-byte Poly1305 tag. Central checks the same
 *  number (`inbox.SealedBoxBytes`) and refuses `malformed_wrapped_key`
 *  otherwise, so a client sealing something OTHER than the content key fails at
 *  create rather than on the target device hours later. */
export const SEALED_BOX_BYTES = 80;

/** The AES-256-GCM content key length. Asserted before sealing so a short or
 *  long key cannot be wrapped: everything downstream on the device is keyed by
 *  it, and the failure would surface there as "corrupt data". */
export const CONTENT_KEY_BYTES = 32;

/** A target key this client refuses to wrap to.
 *
 *  Deliberately carries no field for the offending key and never puts it in the
 *  message: this reaches UI copy and could reach a log, and key material is
 *  exactly the string that must not be echoed into either. */
export class UnusableDeviceKeyError extends Error {
  constructor() {
    super("unusable device public key");
    this.name = "UnusableDeviceKeyError";
  }
}

// libsodium is ~450KB of wasm/asm; the same lazy-load-once shape as crypto.ts so
// it stays out of the entry chunk and a My Devices page that never sends never
// pays for it.
let lib: typeof Sodium | undefined;
let loading: Promise<typeof Sodium> | undefined;

async function sodium(): Promise<typeof Sodium> {
  if (lib) return lib;
  loading ??= import("libsodium-wrappers").then(async (m) => {
    const s = m.default;
    await s.ready;
    lib = s;
    return s;
  });
  try {
    return await loading;
  } catch (e) {
    loading = undefined; // a failed fetch must not poison every retry
    throw e;
  }
}

// The fixed low-order probe scalar, byte-for-byte the one central validates
// with (`inbox.lowOrderProbe` = SHA-256 of this domain string). Any clamped
// scalar detects a low-order point — a fixed one is used so the check is
// deterministic and independent of the random source, and deriving it from the
// same domain string means the browser and the server refuse exactly the same
// set of keys rather than two sets that happen to overlap today.
const LOW_ORDER_PROBE_DOMAIN = "relayium-device-inbox-loworder-probe-v1";
let probeScalar: Uint8Array | undefined;

async function lowOrderProbe(): Promise<Uint8Array> {
  if (!probeScalar) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(LOW_ORDER_PROBE_DOMAIN));
    probeScalar = new Uint8Array(d);
  }
  return probeScalar;
}

/** Decode and validate a device's announced public key, returning its raw bytes.
 *
 *  Mirrors `inbox.ValidatePublicKey` check for check, in the same order: unknown
 *  algorithm, non-canonical base64url, wrong length, low-order point. The last
 *  one is the one that matters — such a key parses, is the right length, and
 *  every "wrap" to it is recoverable by anybody. Central rejects it at
 *  REGISTRATION, so this is defence in depth against a substituted or
 *  downgraded device-list response, not a second authority. */
export async function decodeDevicePublicKey(algorithm: string, encoded: string): Promise<Uint8Array> {
  if (algorithm !== INBOX_KEY_ALGORITHM) throw new UnusableDeviceKeyError();
  if (!isCanonicalB64Url(encoded, X25519_PUBLIC_KEY_BYTES)) throw new UnusableDeviceKeyError();
  let raw: Uint8Array;
  try {
    raw = decodeKey(encoded);
  } catch {
    throw new UnusableDeviceKeyError();
  }
  if (raw.length !== X25519_PUBLIC_KEY_BYTES) throw new UnusableDeviceKeyError();
  const s = await sodium();
  let shared: Uint8Array;
  try {
    shared = s.crypto_scalarmult(await lowOrderProbe(), raw);
  } catch {
    // libsodium reports the all-zero shared secret as an error. Treated as the
    // refusal it is rather than propagated, so no caller has to know which
    // libsodium build signals it by throwing.
    throw new UnusableDeviceKeyError();
  }
  // Belt and braces: a build that returned the zero secret instead of throwing
  // would otherwise slip a world-readable "wrap" past this function. Not a
  // constant-time comparison on purpose — the value being compared is derived
  // from a PUBLIC key with a PUBLIC fixed scalar, so there is no secret here to
  // leak through timing, and a loud, obvious check is worth more than a subtle
  // one guarding nothing.
  if (shared.every((b) => b === 0)) throw new UnusableDeviceKeyError();
  return raw;
}

/** Seal a 32-byte content key to a validated raw X25519 public key.
 *
 *  Returns canonical unpadded base64url, the one spelling this protocol uses for
 *  key material everywhere (`#k=`, device public keys, this box). */
export async function sealContentKeyToRaw(contentKey: Uint8Array, publicKey: Uint8Array): Promise<string> {
  if (contentKey.length !== CONTENT_KEY_BYTES) throw new UnusableDeviceKeyError();
  if (publicKey.length !== X25519_PUBLIC_KEY_BYTES) throw new UnusableDeviceKeyError();
  const s = await sodium();
  const sealed = s.crypto_box_seal(contentKey, publicKey);
  // A wrong length here means libsodium produced something this protocol
  // version does not define. Refused rather than sent: central would reject it
  // as `malformed_wrapped_key` anyway, and failing here keeps the ciphertext
  // upload from being spent on a delivery that cannot be created.
  if (sealed.length !== SEALED_BOX_BYTES) throw new UnusableDeviceKeyError();
  return encodeKey(sealed);
}

/** Validate a device's announced key and seal `contentKey` to it.
 *
 *  The two halves are exposed separately as well, because the card decides
 *  whether a device is sendable long before a file exists — but this is the only
 *  path a send uses, so validation can never be skipped by forgetting to call
 *  it. */
export async function sealContentKey(
  contentKey: Uint8Array,
  algorithm: string,
  encodedPublicKey: string,
): Promise<string> {
  return sealContentKeyToRaw(contentKey, await decodeDevicePublicKey(algorithm, encodedPublicKey));
}
