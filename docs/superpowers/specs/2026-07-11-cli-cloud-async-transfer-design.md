# CLI Cloud Async Transfer (account-bound up/down) — Design

Date: 2026-07-11
Status: Approved (brainstorming), ready for implementation plan
Sub-project: **B** of the "CLI async sync + account deletion" batch. Sub-project **A**
(self-service account deletion with 30-day grace) is designed separately, after B.

## Goal

Let a user push files to the cloud on one machine and download them on another,
asynchronously (decoupled in time), from the CLI. This requires the CLI to talk
to the account server — every existing CLI feature is local/P2P. Add an
**optional** account binding so the cloud feature works while everything else
keeps working with no login.

Interop is a first-class requirement: a file uploaded from the **web** can be
pulled from the **CLI** on another machine, and vice versa.

## Key decisions (locked during brainstorming)

1. **Binding = device-code / browser authorization flow** (like `gh auth login`).
   No password typed into the terminal.
2. **Key model = link / claim-code (existing zero-knowledge share model).**
   The AES key lives only in the download link fragment; the server never sees
   plaintext, filenames, or key. Web↔CLI interop is automatic because both sides
   share the same `id#key` link. Chosen over a vault-passphrase model (Mode 2)
   and over server-escrowed keys — minimal change, preserves zero-knowledge.
3. **Commands = new top-level verbs `up` / `down`.**
   `push`/`pull` are already taken (SSH + daemon-direct).
4. **Retention policies = all three:** burn-after-read, keep-N-days (TTL),
   limited-to-N-downloads. Admin configures the default (**default = burn**) and
   the upper bounds.
5. **Per-push override = allowed but clamped to admin bounds** (same philosophy
   as the existing `clampTTL`).
6. **Login is only required for `up`** (and future `cloud ls/rm`). `down` needs
   only a claim code. All other CLI commands never require login.

## What already exists (reused, not rebuilt)

- Zero-knowledge stored-transfer storage: `POST/GET/DELETE /api/files`,
  `GET /api/files/{id}/meta`, `GET /api/files/{id}/blob` in
  `internal/account/files.go`. Session-authed upload/list/delete; public
  meta/blob download. Blob store, per-account daily quota, `burnAfterRead`, TTL.
- Client-side crypto contract: `web/src/lib/store-crypto.ts` — random
  AES-256-GCM key per upload, 192 KiB chunks, nonce = 4 zero bytes + 64-bit BE
  counter, length-prefixed `uint32BE(len)||ct` frames, manifest at seq 0, file
  chunks at seq 1…, key encoded base64url-no-padding in the link fragment.
  `buildDownloadLink(origin, id, key)` builds `<origin>/d/<id>#<key>`.
- Admin-editable live settings: `internal/account/settings.go` (`settings` table,
  `default_ttl`/`max_ttl`, `clampTTL`) + `POST /admin/settings`.
- Device registry: `Device{ID,UserID,Name,CreatedAt,LastSeenAt}` in
  `internal/account/store.go`; `GET/POST/PATCH/DELETE /api/devices`.
- Session token resolution: `sessionCookie` in `internal/account/service.go`;
  tokens stored hashed.
- CLI config dir convention: `~/.config/relayium` (`--config-dir`).

## Architecture / units

New, well-bounded units:

- **`internal/storecrypto`** (Go, pure): mirrors `store-crypto.ts` byte-for-byte.
  `GenerateKey`, `EncryptManifest`/`DecryptManifest`, streaming
  `EncryptFiles`/`Decryptor`, `EncodeKey`/`DecodeKey`. No I/O, no HTTP. Verified
  against a fixed cross-language test vector shared with `stored-file.test.ts`.
- **`internal/cloud`** (Go, CLI-side client): credential storage (load/save/clear
  `~/.config/relayium/credentials`, 0600), device-code login driver, `Upload`
  and `Download` HTTP clients. Depends on `storecrypto`. No CLI/flag parsing.
- **`internal/account`** additions: device-code endpoints, bearer auth
  resolution (`RequireAuth`), `MaxDownloads` retention, admin retention settings.
- **`cmd/relayium`** additions: thin wiring for `login`/`logout`/`whoami`/
  `up`/`down` that parse flags and call `internal/cloud`.

## Module 1 — Account binding (device-code flow)

Simplified RFC 8628 device authorization grant.

Server endpoints (mounted on the account mux):

- `POST /api/cli/device/start` (no auth) → create a pending device-auth request:
  - `device_code`: long opaque secret (stored hashed).
  - `user_code`: short human code, e.g. `WDJB-MJHT` (unambiguous alphabet, no
    0/O/1/I). Stored for lookup.
  - Pending row: `{user_code, device_code_hash, created_at, expires_at (~10 min),
    status: pending|approved|denied, user_id (null until approved),
    issued_token (null until first successful poll)}`.
  - Returns `{user_code, verification_uri, interval (~5s), expires_in}`.
- `POST /api/cli/device/poll` (no auth, body `{device_code}`):
  - Look up by hash. Enforce `interval` (return `slow_down` if polled too fast).
  - `pending` → `authorization_pending`; expired → `expired`; denied → `denied`;
    approved → issue the CLI token **once**, return `{access_token, account_email}`,
    then mark consumed.
- `POST /api/cli/device/approve` (`RequireSession`, body `{user_code}`):
  - Resolve pending row by `user_code`; must be pending + not expired.
  - Bind to the session user, mark approved, create a `Device{Kind: "cli"}` row,
    mint a long-lived CLI token (opaque `rlm_cli_<random>`, stored **hashed** and
    linked to that Device).
- Web: a minimal `/cli` (a.k.a. `/device`) confirm page — enter `user_code`,
  show which account will be bound, Approve/Deny. Uses the existing session.

CLI token model:
- Opaque random, prefix `rlm_cli_`, stored hashed (same treatment as sessions).
- Attached to a `Device` row; extend `Device` with a `Kind` field
  (`"browser"` default, `"cli"`). Revocable via existing `DELETE /api/devices/{id}`.
- Long-lived (no fixed expiry; relies on revocation). `LastSeenAt` updated on use.

Bearer auth:
- Add `RequireAuth(handler)` that resolves a `User` from **either** the session
  cookie **or** `Authorization: Bearer rlm_cli_…`. On bearer, look up the token
  hash → Device → User; touch `LastSeenAt`.
- Switch `/api/files` upload/list/delete from `RequireSession` to `RequireAuth`
  so both web and CLI can use them. Public meta/blob stay unauthenticated.

CLI commands:
- `relayium login [--server URL]`: POST start; print `user_code` +
  `verification_uri`; poll at `interval` until approved/expired; on success save
  `{server, access_token, account_email}` to `~/.config/relayium/credentials`
  (0600). Default server = the public Relayium origin; `--server` for self-hosted.
- `relayium logout`: best-effort server-side revoke (delete the CLI device), then
  clear local credentials.
- `relayium whoami`: print bound account email + server, or "not logged in".
- **Optionality:** every other command runs with no credentials. `up` (and future
  `cloud ls/rm`) print a clear "run `relayium login` first" if unauthenticated.

## Module 2 — `up` / `down`

`relayium up <src...> [flags]`:
1. Require credentials (bearer token) → else friendly error.
2. Walk paths into a `StoredManifest{files:[{name,size}]}` (reuse the path-walking
   from `xfer.BuildManifest`, adapted to the store manifest shape).
3. `storecrypto.GenerateKey()`; encrypt manifest (seq 0) + file chunks (seq 1…)
   exactly per the TS contract.
4. `POST <server>/api/files?burnAfterRead=…&ttl=…&maxDownloads=…` with
   `Authorization: Bearer …`; body = `uint32BE(mlen)||encManifest||framedCiphertext`
   (matches `handleUploadFile`).
5. Print the claim link `<origin>/d/<id>#<key>` (the primary artifact) and note it
   works in a browser and via `relayium down`.

Retention flags, clamped to admin bounds: `--burn`, `--ttl <dur>`,
`--max-downloads <n>`. None given → server applies the admin default.

`relayium down <code|url> [destdir]`:
1. Parse `id` + `key` from a full link (`…/d/<id>#<key>`) or a compact code.
2. No login. `GET /api/files/<id>/meta` → decrypt manifest → names/sizes.
3. `GET /api/files/<id>/blob` → stream, decrypt chunk-by-chunk, write into
   `destdir` (default `.`). Verify total decrypted length against the manifest.
4. Server enforces burn / download-count / TTL; a spent/expired object → 404.

Go crypto mirror lives in `internal/storecrypto`; a fixed test vector is decrypted
by **both** the Go test and `stored-file.test.ts` to prove interop.

## Module 3 — Retention policy (server + admin)

- `StoredFile`: add `MaxDownloads int64`. Semantics: `0` = unlimited until TTL;
  `N` = delete after the Nth successful download. `burnAfterRead` retained for
  back-compat and is equivalent to `MaxDownloads == 1`; upload normalizes
  `--burn` → `MaxDownloads = 1`.
- Reuse `DownloadCount` and generalize the `ClaimBurnDownload`/`ReleaseBurnDownload`
  claim mechanism into a claim-slot that is concurrency-safe for arbitrary N: a
  download claims a slot, and on completed delivery increments `DownloadCount`;
  when it reaches `MaxDownloads` the object is deleted. Incomplete delivery
  releases the claim so a retry/concurrent request can win.
- New admin settings keys (live, DB-over-default like the others):
  - `default_retention` ∈ {`burn`, `ttl`, `count`} — **default `burn`**.
  - `default_max_downloads`, `max_max_downloads` (bounds for `count` mode).
  - Reuse existing `default_ttl` / `max_ttl` for `ttl` mode.
- Upload handler: if the request omits retention params, apply the admin default
  policy; if provided, clamp to admin bounds (extend `clampTTL` with a
  `clampMaxDownloads`).
- Admin UI: extend `POST /admin/settings` + the admin template to edit the default
  retention mode and its bounds.

## Module 4 — Web interop

No web change is required for interop: `down` consumes web links and `up` emits
web links; the crypto is identical by construction (shared test vector).
Exposing `--max-downloads` in the web upload UI is a **deferred** nice-to-have.

## Error handling

- `login`: render `authorization_pending`/`slow_down` quietly (keep polling);
  `expired`/`denied` → clear message and non-zero exit; overall timeout at
  `expires_in`.
- `up`: not logged in → guidance; `429` quota → "daily quota exceeded";
  `413`/oversize → "file exceeds server max size"; `401` → "session expired, run
  `relayium login` again".
- `down`: malformed code → usage error; `404` → "link expired, spent, or
  burned"; distinguish a **decrypt/integrity failure** (wrong key or corrupt)
  from a **network drop mid-stream** (mirror the web `DownloadNetworkError`
  distinction) so the user gets an accurate message.

## Testing

- `internal/storecrypto`: unit tests + a **fixed cross-language vector** also
  asserted in `stored-file.test.ts` (round-trip both directions).
- Device-code flow: start → approve → poll happy path; expiry; one-time token
  issuance; `slow_down` on fast polling; deny path.
- Bearer auth: `RequireAuth` accepts cookie and bearer, rejects bad/revoked
  tokens, touches `LastSeenAt`.
- `up`/`down` end-to-end: against an in-process account server (reuse the
  `internal/account` httptest patterns and the `cmd/relayium` e2e harness),
  including a web-uploaded → CLI-downloaded fixture.
- Retention: burn (N=1), TTL expiry, `MaxDownloads=N` count enforcement, and
  concurrency on the claim mechanism (extend the existing burn-claim tests).
- Admin: settings round-trip + clamping of per-push overrides.

## Out of scope (this spec)

- Sub-project A (30-day account deletion) — separate design.
- `cloud ls` / `cloud rm` (listing/managing your own uploads) — natural follow-up
  once bearer auth + login exist; not required for push-then-pull.
- Vault-passphrase "pull by name" (Mode 2) — explicitly not chosen.
- Web upload UI exposing `--max-downloads`.
- Continuous/watched folder mirroring to cloud (this is one-shot async transfer,
  not a live sync; `relayium sync` remains local-only).
