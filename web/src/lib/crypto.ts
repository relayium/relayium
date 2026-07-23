import type Sodium from "libsodium-wrappers";

// libsodium is ~450KB of wasm/asm and is the single biggest thing the app can
// download. It's loaded lazily (and cached as one promise) instead of statically
// imported so it lands in its own chunk: the entry bundle no longer carries it,
// and a business-logic release doesn't invalidate it in the browser cache.
//
// Every synchronous export below reaches for `lib` — all of them are already
// documented as "requires ready()", and every call site awaits `ready()` during
// startup, so the throw is a contract violation, not a reachable state.
let lib: typeof Sodium | undefined;
let loading: Promise<typeof Sodium> | undefined;

export async function ready(): Promise<void> {
  loading ??= import("libsodium-wrappers").then(async (m) => {
    const s = m.default;
    await s.ready;
    lib = s;
    return s;
  });
  try {
    await loading;
  } catch (e) {
    loading = undefined; // a failed fetch (flaky network) must not poison every retry
    throw e;
  }
}

function sodiumSync(): typeof Sodium {
  if (!lib) throw new Error("libsodium not initialised — await ready() first");
  return lib;
}

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
  /** HMAC key both sides derive to the SAME value, used to authenticate resume
   *  signalling (see signResume). Separate from send/recv on purpose: it signs
   *  attacker-visible plaintext, so it must not be the key protecting content. */
  resumeAuth: CryptoKey;
}

export function generateKeyPair(): KeyPair {
  const kp = sodiumSync().crypto_kx_keypair();
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
      ? sodiumSync().crypto_kx_client_session_keys(
          self.publicKey,
          self.privateKey,
          peerPublic,
        )
      : sodiumSync().crypto_kx_server_session_keys(
          self.publicKey,
          self.privateKey,
          peerPublic,
        );
  // libsodium-wrappers types its outputs as the bare generic `Uint8Array`, but
  // its session keys are always ArrayBuffer-backed at runtime.
  return {
    send: await importAesKey(keys.sharedTx as Bytes),
    recv: await importAesKey(keys.sharedRx as Bytes),
    resumeAuth: await deriveResumeAuth(keys.sharedTx as Bytes, keys.sharedRx as Bytes),
  };
}

/** Domain separation: this key must never produce a tag that could be replayed
 *  into any other context that might later hash the same session secrets. */
const RESUME_AUTH_DOMAIN = "relayium-resume-auth-v1\0";

/** Derive the shared resume-authentication key from the session secrets.
 *
 *  crypto_kx hands the two sides MIRRORED secrets (one's tx is the other's rx),
 *  so hashing them in local order would give the peers two different keys. They
 *  are sorted first — the pair as a SET is identical on both sides, so the sort
 *  is what makes this derivation symmetric without any extra round trip. */
async function deriveResumeAuth(tx: Bytes, rx: Bytes): Promise<CryptoKey> {
  const [a, b] = compareBytes(tx, rx) <= 0 ? [tx, rx] : [rx, tx];
  const domain = new TextEncoder().encode(RESUME_AUTH_DOMAIN);
  const input = new Uint8Array(domain.length + a.length + b.length);
  input.set(domain, 0);
  input.set(a, domain.length);
  input.set(b, domain.length + a.length);
  const raw = sodiumSync().crypto_generichash(32, input) as Bytes;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function compareBytes(x: Uint8Array, y: Uint8Array): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/** Tag for a resume signalling message, base64. */
export async function signResume(key: CryptoKey, payload: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/** Check a resume tag. A malformed/absent tag is a failure, never a pass —
 *  falling back to "unauthenticated is fine" would make the whole binding
 *  optional at the attacker's choosing. */
export async function verifyResume(
  key: CryptoKey,
  payload: string,
  mac: string | undefined,
): Promise<boolean> {
  if (!mac) return false;
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(atob(mac), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
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
  return sodiumSync().randombytes_buf(NONCE_BYTES);
}

/** Commitment to a public key: 32-byte BLAKE2b(pub || nonce). */
export function commitKey(pub: Uint8Array, nonce: Uint8Array): Uint8Array {
  const combined = new Uint8Array(pub.length + nonce.length);
  combined.set(pub, 0);
  combined.set(nonce, pub.length);
  return sodiumSync().crypto_generichash(COMMIT_BYTES, combined, null);
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
  return sodiumSync().memcmp(commit as Bytes, expected as Bytes);
}

export function sas(self: Uint8Array, peer: Uint8Array): string {
  // Order-independent: sort the two public keys before hashing.
  const [a, b] = compare(self, peer) <= 0 ? [self, peer] : [peer, self];
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  // `null` key = unkeyed BLAKE2b (byte-identical to omitting it); the resolved
  // libsodium-wrappers types mark the key parameter as required, so pass it.
  const digest = sodiumSync().crypto_generichash(8, combined, null);
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
