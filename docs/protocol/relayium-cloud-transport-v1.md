# Relayium stored-transfer HTTP transport v1 (authoritative)

Layers on top of the stored-wire codec (relayium-stored-wire-v1.md). The wire
bytes (encrypted manifest, framed ciphertext) are defined there; this doc defines
how they move over HTTP.

## Upload (authenticated)
- `POST /api/files?burnAfterRead=<0|1>&ttl=<seconds>`
- Auth: `Authorization: Bearer <rlm_cli_ token>` (RequireAuth).
- Body: `uint32BE(len(encManifest)) || encManifest || frameStream`
  - `encManifest` = encryptManifest(key, manifest) (AES-GCM seq 0).
  - `frameStream` = concatenated length-prefixed frames (seq 1,2,…).
- Response 200: `{ "id": <string>, "expiresAt": <unix seconds> }`.
- Errors: 401 unauth, 413 over quota / too large, 429 rate-limited, 503 storage down.
- The share link is `<origin>/d/<id>#k=<base64url key>` — key ONLY in the fragment.

## Download (unauthenticated, zero-knowledge)
- `GET /api/files/<id>/meta` → `{ "encManifest": <base64 standard>, "size": <int>,
  "burnAfterRead": <bool>, "expiresAt": <unix> }`. No auth.
- `GET /api/files/<id>/blob` → body is the frameStream ONLY (server split the
  manifest off at upload; it is served base64 in /meta, not in the blob). No auth.
  - May 302 to a storage node with a one-shot token (follow redirects).
  - A replayed request can return 403 from the node; re-request /blob ONCE to mint
    a fresh token. A second 403 is a real failure.
- Recipient flow: fetch /meta → decryptManifest(key, base64decode(encManifest)) →
  expectedBytes = Σ file sizes; then stream /blob through StoreDecryptor, and call
  end(expectedBytes) — a truncated stream MUST fail, not report success.

## burn-after-read / ttl
- burnAfterRead: the transfer is destroyed after the first successful blob read.
- ttl: seconds until expiry (server clamps to the uploader's plan retention).
