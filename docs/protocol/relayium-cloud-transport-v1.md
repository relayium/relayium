# Relayium stored-transfer HTTP transport v1 (authoritative)

Scope: this page retains the single-shot stored HTTP contract. Resumable
`POST /api/uploads` / `PATCH` / offset / finalize behavior is documented in
[upload-pipeline.md](../upload-pipeline.md),
[upload-chunk-tuning.md](../upload-chunk-tuning.md) and
[relayium-append-durability-v1.md](relayium-append-durability-v1.md).
The near-16-MiB native packing preference is source-delivered; it is not a
change to an already published binary or a claim of live backend deployment.

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
  - Fleet stored downloads are proxied by central. An eligible opted-in BYO
    own-node download may 302 with a one-shot token (follow redirects); see
    [direct-download-deploy.md](../direct-download-deploy.md).
  - A replayed request can return 403 from the node; re-request /blob ONCE to mint
    a fresh token. A second 403 is a real failure.
- Recipient flow: fetch /meta → decryptManifest(key, base64decode(encManifest)) →
  expectedBytes = Σ file sizes; then stream /blob through StoreDecryptor, and call
  end(expectedBytes) — a truncated stream MUST fail, not report success.

## burn-after-read / ttl
- burnAfterRead: a one-download limit. Central claims the download slot before
  sending the blob; a claimed slot is not proof that the recipient received or
  decrypted every byte. Network interruption does not promise another slot.
  Cleanup and download accounting follow the current server retention rules.
- ttl: seconds until expiry (server clamps to the uploader's plan retention).
