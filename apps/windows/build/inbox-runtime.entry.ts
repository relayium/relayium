// Bundle entry for the Inbox runtime. NOT compiled by tsconfig.main.json.
//
// ## What this is
//
// The single place that names the shared protocol modules. Vite bundles this
// entry — with `web/src/lib/*` as SOURCE INPUT, not a vendored copy and not a
// published package — into the fixed artifact `dist/main/inbox-runtime.js`,
// which `src/main/inbox/runtime.ts` loads.
//
// `satisfies InboxRuntime` is the load-bearing line: it makes a drift between
// this object and the contract a COMPILE error. Vite only transpiles, so
// `tsconfig.inbox.json` is what actually typechecks this file; without that
// step a mismatch would emit happily and fail at runtime.
//
// ## The two primitives that are not in the shared modules
//
// `web/src/lib/device-seal.ts` is SENDER-ONLY: a browser seals a content key to
// a device, it never opens one, so the shared code exposes `crypto_box_seal` and
// no inverse, and no inbox keypair generation. The receive half needs both.
//
// They are added here as direct libsodium calls — `crypto_box_seal_open` and
// `crypto_box_keypair`, the same primitives `server/internal/inboxclient`
// uses — rather than as a reimplementation of anything. Everything the shared
// modules DO expose is taken from them unchanged.
import type Sodium from "libsodium-wrappers";

import {
  DEVICE_NAME_MAX,
  normalizeDeviceName,
} from "../../../web/src/lib/device-identity";
import {
  CAP_RECEIVE_V3,
  CAP_TEXT_V1,
  INBOX_KEY_ALGORITHM,
  INBOX_PROTOCOL_VERSION,
  X25519_PUBLIC_KEY_BYTES,
} from "../../../web/src/lib/device-inbox";
import {
  CONTENT_KEY_BYTES,
  SEALED_BOX_BYTES,
  sealContentKey,
} from "../../../web/src/lib/device-seal";
import {
  INBOX_MANIFEST_MAX_ITEMS,
  INBOX_MANIFEST_MAX_TEXT_BYTES,
  INBOX_MANIFEST_MIN_TEXT_BYTES,
  INBOX_MANIFEST_VERSION,
  decodeInboxManifest,
  encodeInboxManifestBytes,
  fileManifest,
  textManifest,
} from "../../../web/src/lib/inbox-manifest";
import {
  FRAME_OVERHEAD,
  MAX_FRAME_CT,
  STORE_CHUNK_SIZE,
  cipherSizeFor,
  encryptFiles,
  StoreDecryptor,
  decodeKey,
  decryptManifest,
  encodeKey,
  importStoreKey,
  sealManifestBytes,
} from "../../../web/src/lib/store-crypto";

import type { InboxRuntime } from "../src/main/inbox/runtime-contract";

/**
 * Frame 0, opened to raw bytes.
 *
 * The THIRD receive-side primitive the shared modules do not expose, for the
 * same reason as the two sodium calls above: `web/src/lib` has only ever had a
 * sender. `store-crypto` exposes `sealManifestBytes` (write frame 0 from
 * caller-canonical bytes) and `decryptManifest` (read frame 0 AS the Stored-Wire
 * manifest), and a Device Inbox delivery seals the dedicated v3
 * `inbox-manifest` document there instead — which the Stored-Wire parser
 * refuses. Go carries the identical split for the identical reason:
 * `storecrypto.OpenManifest` sits beside `DecryptManifest` and its comment says
 * parsing there "would reintroduce exactly the coupling a separate codec exists
 * to avoid".
 *
 * ## This is not a new wire format
 *
 * Same AEAD unit, same sequence number, same key. `nonce(0)` is twelve zero
 * bytes in `store-crypto.ts` (`setUint32(4, 0); setUint32(8, 0)`) and in Go
 * (`binary.BigEndian.PutUint64(n[4:], 0)`). It is spelled out here rather than
 * imported because `nonce` is module-private and `web/src/lib` is frozen.
 *
 * The duplication is pinned, not trusted: `inbox-runtime-contract.test.ts`
 * round-trips this against the shared `sealManifestBytes`, so if the shared
 * nonce derivation ever changed, that test fails rather than the two silently
 * diverging.
 */
const FRAME_ZERO_IV = new Uint8Array(12);

async function openManifestBytes(key: CryptoKey, ciphertext: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(ciphertext.byteLength);
  copy.set(ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: FRAME_ZERO_IV }, key, copy);
  return new Uint8Array(plaintext);
}

// Lazy-loaded once, matching how `device-seal.ts` treats libsodium: it is
// ~450KB of wasm and nothing on the send-only path should pay for it eagerly.
let loading: Promise<typeof Sodium> | null = null;
async function sodium(): Promise<typeof Sodium> {
  loading ??= import("libsodium-wrappers").then(async (m) => {
    const s = m.default;
    await s.ready;
    return s;
  });
  return loading;
}

const runtime = {
  constants: {
    manifestVersion: INBOX_MANIFEST_VERSION,
    protocolVersion: INBOX_PROTOCOL_VERSION,
    capReceiveV3: CAP_RECEIVE_V3,
    capTextV1: CAP_TEXT_V1,
    keyAlgorithm: INBOX_KEY_ALGORITHM,
    storeChunkSize: STORE_CHUNK_SIZE,
    frameOverhead: FRAME_OVERHEAD,
    sealedBoxBytes: SEALED_BOX_BYTES,
    contentKeyBytes: CONTENT_KEY_BYTES,
    publicKeyBytes: X25519_PUBLIC_KEY_BYTES,
    maxTextBytes: INBOX_MANIFEST_MAX_TEXT_BYTES,
    minTextBytes: INBOX_MANIFEST_MIN_TEXT_BYTES,
    maxItems: INBOX_MANIFEST_MAX_ITEMS,
    deviceNameMax: DEVICE_NAME_MAX,
    maxFrameCt: MAX_FRAME_CT,
  },

  fileManifest: (items: readonly { name: string; size: number }[]) => fileManifest([...items]),
  textManifest: (size: number) => textManifest(size),

  async openSealedContentKey(sealed: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
    if (sealed.length !== SEALED_BOX_BYTES) {
      throw new Error("inbox runtime: sealed content key is the wrong length");
    }
    if (privateKey.length !== X25519_PUBLIC_KEY_BYTES) {
      throw new Error("inbox runtime: device private key is the wrong length");
    }
    const s = await sodium();
    // The public key is derived rather than stored alongside: libsodium's seal
    // format needs both halves to open, and deriving keeps the caller from
    // having to keep them paired correctly.
    const publicKey = s.crypto_scalarmult_base(privateKey);
    const opened = s.crypto_box_seal_open(sealed, publicKey, privateKey);
    if (opened.length !== CONTENT_KEY_BYTES) {
      throw new Error("inbox runtime: opened content key is the wrong length");
    }
    return opened;
  },

  sealContentKey: (contentKey: Uint8Array, algorithm: string, encodedPublicKey: string) =>
    sealContentKey(contentKey, algorithm, encodedPublicKey),

  async generateKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
    const s = await sodium();
    const pair = s.crypto_box_keypair();
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
  },

  encodeKey: (raw: Uint8Array) => encodeKey(raw),
  decodeKey: (encoded: string) => decodeKey(encoded),

  importStoreKey: (raw: Uint8Array) => importStoreKey(raw),
  // The shared producer itself, passed straight through. `readonly File[]` is
  // widened to the shared signature's `File[]` at this one boundary rather than
  // by changing shared code; nothing here copies, wraps or re-derives a frame.
  encryptFiles: (files: readonly File[], key: CryptoKey) => encryptFiles([...files], key),
  cipherSizeFor: (files: readonly File[]) => cipherSizeFor([...files]),
  decryptManifest: (key: CryptoKey, ciphertext: Uint8Array) => decryptManifest(key, ciphertext),
  sealManifestBytes: (key: CryptoKey, plaintext: Uint8Array) => sealManifestBytes(key, plaintext),

  openManifestBytes: (key: CryptoKey, ciphertext: Uint8Array) => openManifestBytes(key, ciphertext),
  decodeInboxManifest: (raw: Uint8Array) => decodeInboxManifest(raw),
  encodeInboxManifest: (manifest: { v: number; items: readonly { kind: "file" | "text"; name?: string; size: number }[] }) => {
    // The contract's manifest carries `v: number`; the shared encoder takes the
    // literal v3 type. This is a CHECK rather than a cast: a manifest at any
    // other version is not one this encoder may canonicalise, and asserting it
    // through would produce bytes the receiver's strict decoder refuses.
    if (manifest.v !== INBOX_MANIFEST_VERSION) {
      throw new Error(`inbox runtime: manifest version ${String(manifest.v)} is not v${String(INBOX_MANIFEST_VERSION)}`);
    }
    return encodeInboxManifestBytes({ ...manifest, v: INBOX_MANIFEST_VERSION, items: [...manifest.items] });
  },
  createStoreDecryptor: (key: CryptoKey) => new StoreDecryptor(key),

  normalizeDeviceName: (name: string) => normalizeDeviceName(name),
} satisfies InboxRuntime;

export const constants = runtime.constants;
export const fileManifestOf = runtime.fileManifest;

// One default export carrying the whole surface, so the loader has a single
// thing to type and a single thing to check.
export default runtime;
