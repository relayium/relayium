import sodium from "libsodium-wrappers";

// Buffers that cross the Web Crypto / DOM boundary must be explicitly
// ArrayBuffer-backed: TS's generic `Uint8Array<ArrayBufferLike>` is rejected by
// `importKey`/`encrypt`/`decrypt`, which demand `Uint8Array<ArrayBuffer>`. Every
// buffer here is ArrayBuffer-backed at runtime (never SharedArrayBuffer).
type Bytes = Uint8Array<ArrayBuffer>;

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SessionKeys {
  send: CryptoKey;
  recv: CryptoKey;
}

export async function ready(): Promise<void> {
  await sodium.ready;
}

export function generateKeyPair(): KeyPair {
  const kp = sodium.crypto_kx_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

async function importAesKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function deriveSession(
  role: "initiator" | "responder",
  self: KeyPair,
  peerPublic: Uint8Array,
): Promise<SessionKeys> {
  // crypto_kx gives a (rx, tx) pair; client/server roles produce mirror-image
  // keys so that one side's tx equals the other side's rx.
  const keys =
    role === "initiator"
      ? sodium.crypto_kx_client_session_keys(
          self.publicKey,
          self.privateKey,
          peerPublic,
        )
      : sodium.crypto_kx_server_session_keys(
          self.publicKey,
          self.privateKey,
          peerPublic,
        );
  // libsodium-wrappers types its outputs as the bare generic `Uint8Array`, but
  // its session keys are always ArrayBuffer-backed at runtime.
  return {
    send: await importAesKey(keys.sharedTx as Bytes),
    recv: await importAesKey(keys.sharedRx as Bytes),
  };
}

function nonceFromSeq(seq: number): Bytes {
  const n = new Uint8Array(12);
  const view = new DataView(n.buffer);
  // high 4 bytes zero; low 8 bytes hold the counter (supports >2^53 frames anyway).
  view.setUint32(4, Math.floor(seq / 2 ** 32));
  view.setUint32(8, seq >>> 0);
  return n;
}

export async function seal(
  key: CryptoKey,
  seq: number,
  plaintext: Bytes,
): Promise<Bytes> {
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonceFromSeq(seq) },
    key,
    plaintext,
  );
  return new Uint8Array(ct);
}

export async function open(
  key: CryptoKey,
  seq: number,
  ciphertext: Bytes,
): Promise<Bytes> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonceFromSeq(seq) },
    key,
    ciphertext,
  );
  return new Uint8Array(pt);
}

// ── SAS commitment (commit-then-reveal handshake) ────────────────────────────
// A 6-digit SAS is only ~20 bits, so a malicious signaling relay that sees both
// real public keys before choosing its own could brute-force a colliding code
// and MITM the session. To stop that we bind each side's public key with a
// commitment `C = BLAKE2b(pub || nonce)` that is exchanged *before* either side
// reveals its real public key. An attacker must therefore commit to its keys
// without having seen the peer's key, removing the post-hoc collision freedom.
export const COMMIT_BYTES = 32;
export const NONCE_BYTES = 32;

/** Fresh 32-byte commitment nonce. Requires ready(). */
export function randomNonce(): Uint8Array {
  return sodium.randombytes_buf(NONCE_BYTES);
}

/** Commitment to a public key: 32-byte BLAKE2b(pub || nonce). */
export function commitKey(pub: Uint8Array, nonce: Uint8Array): Uint8Array {
  const combined = new Uint8Array(pub.length + nonce.length);
  combined.set(pub, 0);
  combined.set(nonce, pub.length);
  return sodium.crypto_generichash(COMMIT_BYTES, combined, null);
}

/** Constant-time check that `commit` opens to (pub, nonce). False on any
 *  mismatch, including a malformed/short commitment. */
export function verifyCommit(
  commit: Uint8Array,
  pub: Uint8Array,
  nonce: Uint8Array,
): boolean {
  const expected = commitKey(pub, nonce);
  if (commit.length !== expected.length) return false;
  return sodium.memcmp(commit as Bytes, expected as Bytes);
}

export function sas(self: Uint8Array, peer: Uint8Array): string {
  // Order-independent: sort the two public keys before hashing.
  const [a, b] = compare(self, peer) <= 0 ? [self, peer] : [peer, self];
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  // `null` key = unkeyed BLAKE2b (byte-identical to omitting it); the resolved
  // libsodium-wrappers types mark the key parameter as required, so pass it.
  const digest = sodium.crypto_generichash(8, combined, null);
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const num = (view.getUint32(0) ^ view.getUint32(4)) >>> 0;
  return (num % 1_000_000).toString().padStart(6, "0");
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
