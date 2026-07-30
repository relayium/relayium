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
  /** AEAD keys for the message stream, domain-separated from send/recv.
   *
   *  送文件那条流的 nonce 安全性建立在"只有一个生产者推进 seq"之上（见 transfer.ts
   *  的 Sender.seq），而消息是**第二个**生产者：它由 UI 事件触发，和一个在 yield 处
   *  挂起、可能永远不恢复的异步生成器交错。两个生产者共用一个密钥正是 AES-GCM 复用
   *  nonce 的那个形状。派生出独立子密钥之后，消息流有自己从 0 开始的计数器，交错这个
   *  问题就消失了，而不是被回答了。 */
  textSend: CryptoKey;
  textRecv: CryptoKey;
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
    textSend: await importAesKey(textKeyBytes(keys.sharedTx as Bytes) as Bytes),
    textRecv: await importAesKey(textKeyBytes(keys.sharedRx as Bytes) as Bytes),
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
  // `null` key = unkeyed BLAKE2b, byte-identical to omitting the argument; the
  // resolved libsodium-wrappers types mark it required, so pass it explicitly the
  // way commitKey/sas/textKeyBytes already do. Pinned by a vector test: the derived
  // key still reproduces crypto-vectors.json's resumeAuth.mac, which the Swift port
  // pins independently.
  const raw = sodiumSync().crypto_generichash(32, input, null) as Bytes;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Domain separation for the message stream's keys. Changing this string is a
 *  wire break: regenerate apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json and
 *  move web + Swift together (docs/protocol/relayium-crypto-v1.md). */
export const TEXT_KEY_DOMAIN = "relayium-text-v1\0";

/**
 * The 32-byte AEAD key for ONE direction of the message stream.
 *
 * Unlike deriveResumeAuth this deliberately does **not** sort its inputs, and
 * must not. That key is shared, so it has to be symmetric; these are per
 * direction. crypto_kx already hands the peers mirrored secrets — one side's tx
 * is the other's rx — so hashing each one locally lines the directions up with
 * no extra round trip. Sorting would collapse both directions onto a single key
 * and put two producers back on one nonce counter, which is the exact hazard the
 * separate key exists to remove.
 *
 * The domain prefix is what stops this being a bare hash of a session secret,
 * replayable into any other context that might later hash the same secret.
 */
export function textKeyBytes(sessionKey: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(TEXT_KEY_DOMAIN);
  const input = new Uint8Array(domain.length + sessionKey.length);
  input.set(domain, 0);
  input.set(sessionKey, domain.length);
  // `null` key = unkeyed BLAKE2b, byte-identical to omitting the argument; the
  // resolved libsodium-wrappers types mark it required, so pass it (same as
  // commitKey/sas/deriveResumeAuth).
  return sodiumSync().crypto_generichash(32, input, null) as Bytes;
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
  // Explicitly ArrayBuffer-backed: Web Crypto's BufferSource rejects the generic
  // `Uint8Array<ArrayBufferLike>` that Uint8Array.from infers, and every buffer in
  // this file is ArrayBuffer-backed at runtime (never SharedArrayBuffer).
  let sig: Bytes;
  try {
    sig = Uint8Array.from(atob(mac), (c) => c.charCodeAt(0)) as Bytes;
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
