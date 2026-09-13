// Bundle entry for the stored-link runtime. NOT compiled by tsconfig.main.json.
//
// ## What this is
//
// The single place that names the shared stored-transfer crypto. Vite bundles
// this entry — with `web/src/lib/store-crypto.ts` and `stored-download.ts` as
// SOURCE INPUT, not a vendored copy and not a published package — into the
// fixed artifact `dist/main/stored-runtime.js`, which
// `src/main/stored/runtime.ts` loads.
//
// `satisfies StoredRuntime` is the load-bearing line: it makes a drift between
// this object and the contract a COMPILE error. Vite only transpiles, so
// `tsconfig.stored.json` is what actually typechecks this file; without that
// step a mismatch would emit happily and fail at runtime.
//
// ## Nothing is reimplemented here
//
// Not the nonce schedule, not the frame layout, not the base64url alphabet, not
// the manifest validator. Every member below forwards to the shared module. The
// AEAD in a stored object is the same AEAD the Web client wrote, and the only
// way that stays true is for there to be exactly one implementation of it.
//
// The one thing this file does add is the SHAPE of the key boundary:
// `importKeyFromFragment` composes `decodeKey` and `importStoreKey` so the raw
// bytes are a local inside one call. This bundle is loaded by the MAIN PROCESS
// and runs there, so that is not a process boundary and must not be described
// as one — the honest scope is that the raw material is never bound, returned,
// journalled, logged or sent, and `importStoreKey` imports non-extractable so
// the handle callers hold cannot yield it back.
import {
  FRAME_OVERHEAD,
  MAX_FRAME_CT,
  STORE_CHUNK_SIZE,
  StoreDecryptor,
  decodeKey,
  decryptManifest,
  encodeKey,
  encryptManifest,
  generateStoreKey,
  importStoreKey,
} from "../../../web/src/lib/store-crypto";
import { storedTotalBytes } from "../../../web/src/lib/stored-download";
import { DOWNLOAD_PREFIX } from "../../../web/src/lib/transfer-link";

import type { RuntimeStoredManifest, StoredRuntime } from "../src/main/stored/runtime-contract";

const runtime = {
  constants: {
    storeChunkSize: STORE_CHUNK_SIZE,
    frameOverhead: FRAME_OVERHEAD,
    maxFrameCiphertext: MAX_FRAME_CT,
  },

  // `async`, not an expression-bodied arrow. `decodeKey` throws SYNCHRONOUSLY
  // on a fragment outside the alphabet, and a function the contract types as
  // returning a promise must not throw past its caller's `await`: the caller
  // then has to guard the call site AND the await to catch one failure, which
  // is the kind of asymmetry that gets one of the two wrong. Caught by the
  // frozen-vector suite, which asserted on a rejection and received a throw.
  //
  // The decoded bytes stay a temporary inside this call: never bound, never
  // returned, and `importStoreKey` imports non-extractable.
  importKeyFromFragment: async (encoded: string): Promise<CryptoKey> =>
    importStoreKey(decodeKey(encoded)),

  decryptManifest: (key: CryptoKey, ciphertext: Uint8Array) => decryptManifest(key, ciphertext),

  // `storedTotalBytes` takes the shared `StoredManifest`, whose `files` is
  // mutable; the contract's is readonly, which is the stricter direction, so the
  // entries are copied into the shape it wants rather than cast.
  totalBytes: (manifest: RuntimeStoredManifest): number =>
    storedTotalBytes({ files: manifest.files.map((file) => ({ name: file.name, size: file.size })) }),

  createDecryptor: (key: CryptoKey) => new StoreDecryptor(key),

  // --- send ---

  // The raw bytes are a local here and are never returned: what leaves is the
  // WebCrypto handle (non-extractable) and the base64url text the fragment
  // needs — which DOES cross to the owning renderer for a send, because the
  // renderer is what encrypts (see `upload/service.ts`). `generateStoreKey` is
  // the shared generator, so a Windows upload's key is drawn exactly as the Web
  // client's is.
  generateKey: async (): Promise<{ key: CryptoKey; encoded: string }> => {
    const generated = await generateStoreKey();
    return { key: generated.key, encoded: encodeKey(generated.raw) };
  },

  // `encryptManifest`, not `sealManifestBytes`: the validating entry point, so
  // the file count, name length and size arithmetic are checked on the send
  // side by the same code that checks them on the receive side.
  sealManifest: (key: CryptoKey, manifest: RuntimeStoredManifest) =>
    encryptManifest(key, { files: manifest.files.map((file) => ({ name: file.name, size: file.size })) }),

  downloadPrefix: DOWNLOAD_PREFIX,
} satisfies StoredRuntime;

// One default export carrying the whole surface, so the loader has a single
// thing to type and a single thing to check.
export default runtime;
