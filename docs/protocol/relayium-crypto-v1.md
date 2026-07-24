# Relayium crypto layer v1 (authoritative)

Source of truth for the Swift port. Any change requires regenerating
`apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json` and updating web + Swift together.

## Key agreement
- Primitive: libsodium `crypto_kx` (X25519 + BLAKE2b KDF).
- `generateKeyPair()` → `crypto_kx_keypair()` (32-byte public, 32-byte secret).
- `deriveSession(role, self, peerPublic)`:
  - role "initiator" → `crypto_kx_client_session_keys(selfPub, selfSec, peerPub)` → (rx, tx)
  - role "responder" → `crypto_kx_server_session_keys(selfPub, selfSec, peerPub)` → (rx, tx)
  - `send` key = tx (sharedTx), `recv` key = rx (sharedRx). Each 32 bytes, used as AES-256-GCM keys.

## AEAD (per-frame)
- AES-256-GCM. Key = the 32-byte send/recv session key.
- Nonce (12 bytes) = nonceFromSeq(seq): bytes[0..4)=0; bytes[4..8)=BE(uint32(floor(seq/2^32))); bytes[8..12)=BE(uint32(seq mod 2^32)).
- `seal(key,seq,pt)` → AES-GCM ciphertext with 16-byte tag appended (combined mode).
- `open(key,seq,ct)` → inverse; auth failure is a hard error.

## Commitment (commit-then-reveal, anti-MITM on the 6-digit SAS)
- COMMIT_BYTES=32, NONCE_BYTES=32.
- `randomNonce()` = 32 random bytes.
- `commitKey(pub,nonce)` = BLAKE2b-256(pub || nonce) via `crypto_generichash(32, pub||nonce)`.
- `verifyCommit(commit,pub,nonce)` = constant-time equal to commitKey; false on length mismatch.

## SAS (6-digit)
- Inputs: the two raw public keys. Sort ascending (bytewise) → (a,b).
- digest = `crypto_generichash(8, a||b)` (unkeyed BLAKE2b, 8-byte output).
- num = (BE uint32 at offset 0) XOR (BE uint32 at offset 4), unsigned.
- SAS = (num mod 1_000_000) as zero-padded 6-digit decimal string.

## Resume-auth key (HMAC key both sides derive identically)
- Domain = ASCII "relayium-resume-auth-v1\0" (24 bytes incl. trailing NUL).
- Sort session (tx,rx) bytewise ascending → (a,b).
- raw = `crypto_generichash(32, domain || a || b)`.
- Used as HMAC-SHA-256 key.
- `signResume(key,payload)` = base64(HMAC-SHA256(key, utf8(payload))).
- `verifyResume(key,payload,mac)` = constant-time verify; absent/malformed mac = false.
