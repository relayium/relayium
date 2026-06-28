import sodium from "libsodium-wrappers";

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

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
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
  return {
    send: await importAesKey(keys.sharedTx),
    recv: await importAesKey(keys.sharedRx),
  };
}

function nonceFromSeq(seq: number): Uint8Array {
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
  plaintext: Uint8Array,
): Promise<Uint8Array> {
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
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonceFromSeq(seq) },
    key,
    ciphertext,
  );
  return new Uint8Array(pt);
}

export function sas(self: Uint8Array, peer: Uint8Array): string {
  // Order-independent: sort the two public keys before hashing.
  const [a, b] = compare(self, peer) <= 0 ? [self, peer] : [peer, self];
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  const digest = sodium.crypto_generichash(8, combined);
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
