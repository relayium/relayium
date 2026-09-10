// The shared-protocol surface, declared as types only.
//
// ## Why this file exists
//
// The protocol logic lives in `web/src/lib/*`, which the Web client also runs.
// Importing it directly from `src/main/**` is impossible: `tsconfig.main.json`
// sets `rootDir: "src"`, and TypeScript refuses a source file outside it
// (TS6059) under both `--noEmit` and emit. Vendoring a copy would be silent
// divergence with a green board on both sides.
//
// So the shared modules are a SOURCE INPUT to a Node-targeted bundle
// (`build/inbox-runtime.entry.ts` → `dist/main/inbox-runtime.js`), and this file
// declares the shape that bundle provides. It is types only: no import of the
// shared code, so it compiles inside `rootDir` like any other main-process file.
//
// ## How it is kept honest
//
// Two independent checks, because either alone is weak:
//
//  1. The entry declares `satisfies InboxRuntime`, so a drift is a COMPILE error
//     in the bundle build (`tsconfig.inbox.json` typechecks it — Vite only
//     transpiles and would happily emit a mismatch).
//  2. `test/unit/inbox-runtime-contract.test.ts` loads the BUILT artifact and
//     exercises it, so a bundle that typechecks but does not run still fails.
//
// A runtime arity check is not type proof and a compile-time `satisfies` is not
// proof the artifact loads. Both are required.

/** A v3 inbox manifest item. Mirrors `web/src/lib/inbox-manifest`. */
export interface RuntimeManifestItem {
  readonly kind: "file" | "text";
  readonly name?: string;
  readonly size: number;
}

export interface RuntimeManifest {
  readonly v: number;
  readonly items: readonly RuntimeManifestItem[];
}

/** The stored-manifest shape the AEAD frame 0 carries. */
export interface RuntimeStoredManifest {
  readonly files: readonly { readonly name: string; readonly size: number }[];
}

/**
 * The frame decryptor for a delivery's ciphertext body.
 *
 * Sequence 1..n, one AEAD frame per chunk, length-prefixed. `end` is not
 * optional politeness: a stream truncated ON a frame boundary is otherwise
 * indistinguishable from a clean finish, so the expected plaintext total is
 * what actually detects it.
 */
export interface RuntimeStoreDecryptor {
  /** Plaintext bytes emitted so far. */
  readonly decryptedBytes: number;
  push(data: Uint8Array): AsyncGenerator<Uint8Array>;
  end(expectedBytes?: number): AsyncGenerator<Uint8Array>;
}

/**
 * The protocol surface the Inbox needs at runtime.
 *
 * Deliberately narrow: every member is something `src/main/inbox/**` actually
 * calls. Widening it means widening the bundle, so the cost of a new dependency
 * on shared code is visible here.
 */
export interface InboxRuntime {
  /** Wire constants, so no caller re-derives one. */
  readonly constants: {
    readonly manifestVersion: number;
    readonly protocolVersion: number;
    readonly capReceiveV3: string;
    readonly capTextV1: string;
    readonly keyAlgorithm: string;
    readonly storeChunkSize: number;
    readonly frameOverhead: number;
    readonly sealedBoxBytes: number;
    readonly contentKeyBytes: number;
    readonly publicKeyBytes: number;
    readonly maxTextBytes: number;
    readonly minTextBytes: number;
    readonly maxItems: number;
    readonly deviceNameMax: number;
    /** Ceiling on one ciphertext frame. A length prefix is attacker-controlled. */
    readonly maxFrameCt: number;
  };

  /** Build a v3 file manifest. Throws the shared validator's error on refusal. */
  fileManifest(items: readonly { name: string; size: number }[]): RuntimeManifest;
  /** Build a v3 text manifest for a plaintext byte length. */
  textManifest(size: number): RuntimeManifest;

  /** Open a sealed content key with this device's private key. */
  openSealedContentKey(sealed: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
  /** Seal a content key to a recipient's advertised public key. */
  sealContentKey(contentKey: Uint8Array, algorithm: string, encodedPublicKey: string): Promise<string>;
  /** Generate an X25519 keypair for this device. */
  generateKeyPair(): Promise<{ readonly publicKey: Uint8Array; readonly privateKey: Uint8Array }>;

  /** base64url without padding, the encoding the wire uses for keys. */
  encodeKey(raw: Uint8Array): string;
  decodeKey(encoded: string): Uint8Array;

  /** Import a raw 32-byte AEAD key for the framed store format. */
  importStoreKey(raw: Uint8Array): Promise<CryptoKey>;

  /**
   * The PRODUCTION ciphertext frame producer, exposed, not reimplemented.
   *
   * This is `web/src/lib/store-crypto.ts`'s own `encryptFiles` — the single
   * function the Web sender runs and the one whose frames the Mac
   * (`StoreFrame.encryptChunks`) and Web receivers already decrypt. It is
   * declared here so main-side code can drive it directly; a second
   * implementation of the nonce schedule would be a fork of the one thing in
   * this product that must never fork, because AES-GCM under a repeated nonce
   * with different plaintext is a break rather than a bug.
   *
   * `File` is a Node global; the function touches only `.size` and
   * `.slice(a, b).arrayBuffer()`, so it is `File`-typed and `Blob`-generic and
   * needs no change to run outside a renderer.
   *
   * **The renderer remains the producer in the product.** Main receives
   * ciphertext frames over IPC precisely so no arbitrary-path read channel
   * exists here. This member is what lets a main-side harness produce REAL
   * frames without a renderer, and what a future main-side producer would use
   * rather than writing its own.
   */
  encryptFiles(files: readonly File[], key: CryptoKey): AsyncGenerator<Uint8Array>;

  /**
   * The exact ciphertext total those frames will come to.
   *
   * The value `?size=` declares. Shared rather than re-derived: `plan.ts`
   * computes the same number from sizes alone, and having both lets a caller
   * cross-check its schedule against the encryptor that will actually run.
   */
  cipherSizeFor(files: readonly File[]): number;
  /** Decrypt frame 0 into the STORED-WIRE manifest. Not the Inbox document. */
  decryptManifest(key: CryptoKey, ciphertext: Uint8Array): Promise<RuntimeStoredManifest>;
  /** Seal an already-canonical manifest document at frame 0. */
  sealManifestBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array>;

  /**
   * Open frame 0 to RAW BYTES, interpreting nothing.
   *
   * The receive half needs this and `decryptManifest` cannot serve it: a Device
   * Inbox delivery seals the dedicated v3 `inbox-manifest` document at frame 0,
   * not the Stored-Wire one, and the Stored-Wire parser would refuse it.
   * Go has the identical split for the identical reason
   * (`storecrypto.OpenManifest` beside `DecryptManifest`).
   */
  openManifestBytes(key: CryptoKey, ciphertext: Uint8Array): Promise<Uint8Array>;
  /** The strict canonical v3 decoder. Re-encodes and requires equality. */
  decodeInboxManifest(raw: Uint8Array): RuntimeManifest;
  /**
   * The canonical v3 encoder — the bytes frame 0 carries.
   *
   * The send half needs it for the same reason the receive half needs the
   * decoder: there is exactly ONE byte sequence per manifest, and re-deriving
   * it here would be a second encoder to disagree with the frozen vectors.
   */
  encodeInboxManifest(manifest: RuntimeManifest): Uint8Array;
  /** A decryptor for the data frames that follow frame 0. */
  createStoreDecryptor(key: CryptoKey): RuntimeStoreDecryptor;

  /** Normalise a user-supplied device name. */
  normalizeDeviceName(name: string): string;
}
