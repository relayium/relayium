// The stored-link protocol surface, declared as types only.
//
// ## Why this file exists
//
// The stored-transfer crypto lives in `web/src/lib/store-crypto.ts`, which the
// Web client runs. Importing it from `src/main/**` is impossible:
// `tsconfig.main.json` sets `rootDir: "src"`, and TypeScript refuses a source
// file outside it (TS6059) under both `--noEmit` and emit. Vendoring a copy
// would be silent divergence with a green board on both sides — and this is
// AEAD framing, where divergence means a receiver that accepts bytes the sender
// never sealed.
//
// So the shared module is a SOURCE INPUT to a Node-targeted bundle
// (`build/stored-runtime.entry.ts` -> `dist/main/stored-runtime.js`), and this
// file declares the shape that bundle provides. Types only: no import of the
// shared code, so it compiles inside `rootDir` like any other main file. Same
// arrangement `src/main/inbox/runtime-contract.ts` uses for the Device Inbox.
//
// ## How it is kept honest
//
// Two independent checks, because either alone is weak:
//
//  1. The entry declares `satisfies StoredRuntime`, so a drift is a COMPILE
//     error in the bundle build (`tsconfig.stored.json` typechecks it — Vite
//     only transpiles and would happily emit a mismatch).
//  2. `test/unit/stored-runtime.test.ts` loads the BUILT artifact and decrypts
//     ciphertext produced by the shared encoder, so a bundle that typechecks but
//     does not run — or runs with the wrong nonce schedule — still fails.
//
// ## The send half is additive
//
// S2 adds `generateKey`, `sealManifest` and `downloadPrefix`. They are new
// members on the same contract and the same bundle, not a second runtime: the
// AEAD, the nonce schedule and the base64url alphabet a send uses are the ones
// a receive already opens, and two bundles over one source is how those start
// to drift in the build rather than in the source.
//
// ## What is deliberately NOT here
//
// `storedSaveSpecs` from `web/src/lib/stored-download.ts`. It routes names
// through `zip.ts`'s `safeSegments`, which DROPS unsafe segments and keeps
// going — correct for a browser ZIP, where a mangled member is still a
// download. A Windows destination answers a different question ("may I create
// this exact file inside the folder the user chose?") and the only safe answer
// to a name it cannot honour is *no*: see the header of `src/main/io/winpath.ts`,
// which refuses the rewrite in as many words. Manifest names therefore reach
// `src/main/io/plan.ts` unchanged and a refusal stays a refusal.
//
// Upload, `completionProof`/`completionVerifier` and the pair-room completion
// capability are absent too. S1 receives; an ordinary share never completes.

/** The stored manifest, exactly as AEAD frame 0 carries it. */
export interface RuntimeStoredManifest {
  readonly files: readonly { readonly name: string; readonly size: number }[];
}

/**
 * A streaming decryptor over the length-prefixed ciphertext frames.
 *
 * `push` reassembles across ARBITRARY network chunk boundaries — a frame split
 * over ten reads, ten frames in one read — and yields plaintext in order.
 * `end` is not a formality: a stream truncated on a frame boundary is otherwise
 * indistinguishable from a clean end, so the expected plaintext total is the
 * only thing that can tell them apart.
 */
export interface RuntimeStoreDecryptor {
  /** Total decrypted plaintext bytes emitted so far. */
  readonly decryptedBytes: number;
  push(data: Uint8Array): AsyncIterable<Uint8Array>;
  /** Throws on trailing bytes or a plaintext-length shortfall. */
  end(expectedBytes: number): AsyncIterable<Uint8Array>;
}

/**
 * The protocol surface `src/main/stored/**` needs at runtime.
 *
 * Deliberately narrow: every member is something the receive path actually
 * calls, so the cost of a new dependency on shared code is visible here.
 */
export interface StoredRuntime {
  /** Wire constants, so no caller re-derives one. */
  readonly constants: {
    /** Plaintext bytes per sealed frame. */
    readonly storeChunkSize: number;
    /** 4-byte length prefix + 16-byte GCM tag. */
    readonly frameOverhead: number;
    /** Upper bound on one ciphertext frame, prefix excluded. */
    readonly maxFrameCiphertext: number;
  };

  /**
   * Import the link fragment's key.
   *
   * Takes the ENCODED string, not raw bytes, on purpose — but NOT because of
   * any process boundary. The bundle is loaded by and executes inside this same
   * main process; an earlier version of this comment claimed the raw bytes
   * "never exist in the main process at all", which was simply false and is the
   * kind of fictitious isolation that makes a reader trust the wrong thing.
   *
   * What is actually true, and is what this shape buys: the decode is a
   * temporary inside one call, the raw array is never bound to anything this
   * module keeps, never returned, never journalled, never logged and never put
   * on the wire. What comes back is a non-extractable WebCrypto handle, so the
   * raw material cannot be recovered from the value callers do hold.
   *
   * Throws on anything `from_base64`'s URLSAFE_NO_PADDING variant would refuse.
   * The rejection never quotes the input.
   */
  importKeyFromFragment(encoded: string): Promise<CryptoKey>;

  /**
   * Decrypt and validate frame 0.
   *
   * Rejects a manifest that does not open under this key (tamper, wrong key),
   * and — separately — one whose contents are not a manifest: the shared
   * validator bounds the file count, name length and size arithmetic, and
   * strips bidi/control characters from names, before any caller sees them.
   */
  decryptManifest(key: CryptoKey, ciphertext: Uint8Array): Promise<RuntimeStoredManifest>;

  /** Total plaintext bytes the manifest describes. */
  totalBytes(manifest: RuntimeStoredManifest): number;

  /** A fresh decryptor for this object's blob. Frame sequence starts at 1. */
  createDecryptor(key: CryptoKey): RuntimeStoreDecryptor;

  // -------------------------------------------------------------------------
  // Send (S2)
  // -------------------------------------------------------------------------

  /**
   * A fresh random content key for ONE upload.
   *
   * Returns the WebCrypto handle and the base64url encoding, because the two
   * have different destinations: the handle seals the manifest here in main,
   * and the encoded form is what custody stores, what the owning renderer
   * document needs to encrypt content with, and what the `#k=` fragment
   * eventually carries. The raw bytes are a temporary inside this call — again,
   * a no-network/no-log/no-journal scope, not a process boundary.
   *
   * One key per upload, generated once. Reusing a key across attempts is how
   * AES-GCM nonce reuse happens — see `upload/engine.ts`, which never
   * re-encrypts under a retained key.
   */
  generateKey(): Promise<{ key: CryptoKey; encoded: string }>;

  /**
   * Seal the manifest at frame 0, validating it first.
   *
   * The shared validator's bounds (file count, name length, size arithmetic)
   * apply on the way out exactly as they do on the way in, so an upload cannot
   * mint a manifest a receive would refuse.
   */
  sealManifest(key: CryptoKey, manifest: RuntimeStoredManifest): Promise<Uint8Array>;

  /** The link path prefix, from the shared link builder rather than retyped. */
  readonly downloadPrefix: string;
}
