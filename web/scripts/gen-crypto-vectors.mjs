import _sodium from "libsodium-wrappers";
import { writeFileSync } from "node:fs";

await _sodium.ready;
const s = _sodium;
const hex = (u) => s.to_hex(u);
const fromHex = (h) => s.from_hex(h);

// Fixed 32-byte secrets → deterministic crypto_kx keypairs via seed.
const aliceSeed = fromHex("11".repeat(32));
const bobSeed = fromHex("22".repeat(32));
const alice = s.crypto_kx_seed_keypair(aliceSeed);
const bob = s.crypto_kx_seed_keypair(bobSeed);

// Byte-wise comparator matching web/src/lib/crypto.ts exactly (memcmp/lexicographic
// semantics, byte 0 first). NOTE: do NOT use libsodium's s.compare here — that is
// sodium_compare, which treats the bytes as a LITTLE-endian number (last byte most
// significant) and does not match crypto.ts's ordering.
function compareBytes(x, y) {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

// role initiator = client; responder = server. Alice initiates.
const aliceK = s.crypto_kx_client_session_keys(alice.publicKey, alice.privateKey, bob.publicKey);
const bobK = s.crypto_kx_server_session_keys(bob.publicKey, bob.privateKey, alice.publicKey);

// SAS (sort raw pubs, generichash 8)
const sasOf = (x, y) => {
  const [a, b] = compareBytes(x, y) <= 0 ? [x, y] : [y, x];
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0); combined.set(b, a.length);
  const d = s.crypto_generichash(8, combined, null);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const num = (dv.getUint32(0) ^ dv.getUint32(4)) >>> 0;
  return (num % 1_000_000).toString().padStart(6, "0");
};

// commitment
const nonce = fromHex("33".repeat(32));
const commitInput = new Uint8Array(alice.publicKey.length + nonce.length);
commitInput.set(alice.publicKey, 0); commitInput.set(nonce, alice.publicKey.length);
const commit = s.crypto_generichash(32, commitInput, null);

// AEAD via Web Crypto AES-GCM with seq nonce (matches crypto.ts seal)
const keyRaw = fromHex("44".repeat(32));
const seq = 5;
const nonceFromSeq = (n) => {
  const b = new Uint8Array(12);
  const dv = new DataView(b.buffer);
  dv.setUint32(4, Math.floor(n / 2 ** 32)); dv.setUint32(8, n >>> 0);
  return b;
};
const pt = new TextEncoder().encode("relayium frame payload");
const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceFromSeq(seq) }, key, pt));

// resume-auth key + mac
const DOMAIN = new TextEncoder().encode("relayium-resume-auth-v1\0");
const [ra, rb] = compareBytes(aliceK.sharedTx, aliceK.sharedRx) <= 0
  ? [aliceK.sharedTx, aliceK.sharedRx] : [aliceK.sharedRx, aliceK.sharedTx];
const raInput = new Uint8Array(DOMAIN.length + ra.length + rb.length);
raInput.set(DOMAIN, 0); raInput.set(ra, DOMAIN.length); raInput.set(rb, DOMAIN.length + ra.length);
const raRaw = s.crypto_generichash(32, raInput, null);
const payload = "resume:offset=1024";
const hkey = await crypto.subtle.importKey("raw", raRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const macBuf = new Uint8Array(await crypto.subtle.sign("HMAC", hkey, new TextEncoder().encode(payload)));
const mac = btoa(String.fromCharCode(...macBuf));

const out = {
  alice: { pub: hex(alice.publicKey), sec: hex(alice.privateKey) },
  bob: { pub: hex(bob.publicKey), sec: hex(bob.privateKey) },
  session: { aliceSend: hex(aliceK.sharedTx), aliceRecv: hex(aliceK.sharedRx), bobSend: hex(bobK.sharedTx), bobRecv: hex(bobK.sharedRx) },
  sas: sasOf(alice.publicKey, bob.publicKey),
  commit: { nonce: hex(nonce), value: hex(commit) },
  aead: { keyHex: hex(keyRaw), seq, ptHex: hex(pt), ctHex: hex(ct) },
  resumeAuth: { keyHex: hex(raRaw), payload, mac },
};
writeFileSync("../apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote crypto-vectors.json");
