# Resumable chunked upload

Date: 2026-07-13

## Problem

The web `/offline-transfer` upload is one long XHR POST of the whole
ciphertext Blob. There is no size limit server-side (probed: nginx passes
≥90 MB through), but a single 50 MB POST over a slower/flakier uplink is long
enough that a transient reset or stall kills the whole thing — with zero
retry and zero resume. High observed failure rate; the user must re-pick the
file.

## Goal

Upload the ciphertext in chunks so a reset loses only the current chunk and
the upload resumes from the last committed byte. Preserves E2E (server sees
only ciphertext chunks), quota, placement, size cap, and metering.

## Sessions: in-memory

An in-memory map on the Service: `uploadId → session{blobKey, nodeID,
encManifest, ttl, maxDL, burn, userID, billable, received, createdAt}`.
Relayium is a single instance and a session need only outlive one upload
(seconds–minutes); a server restart mid-upload fails that upload (rare,
acceptable). Orphaned pending blobs are reaped by age (see GC), decoupled
from the in-memory sessions.

## Endpoints (all require auth; bodies are opaque ciphertext)

1. `POST /api/files/uploads` (init) — body `uint32BE(len)‖encManifest`; query
   `burnAfterRead/ttl/maxDownloads`. Server runs the existing placeUpload +
   daily-quota pre-check (against `Content-Length`/declared size), mints a
   session + random blobKey, returns `{uploadId, chunkSize}` (8 MiB).
2. `PATCH /api/files/uploads/{uploadId}` — `Content-Range: bytes start-end/total`,
   body = that chunk. Requires `start == session.received`; `start < received`
   is idempotent (already have it) and just returns the current offset;
   `start > received` is 409 (gap). Enforces cumulative `≤ MaxFileSize`.
   Appends to the pending blob, advances `received`, returns `{received}`.
3. `POST /api/files/uploads/{uploadId}/finalize` — ReserveUpload(actual
   `received`) for quota, CreateStoredFile, AddUploadStat + RecordMeter, drop
   the session, return `{id, expiresAt}`.
4. `GET /api/files/uploads/{uploadId}` — `{received}` so a client resumes.

Ownership: every op checks `session.userID == u.ID`; unknown/foreign
uploadId → 404.

## Blob append

`BlobStore.Append(ctx, key string, offset int64, r io.Reader) (int64, error)`:
- DiskStore: open/create the shard file, require its current size == offset
  (else ErrOffsetMismatch — the caller re-syncs), append, return new size.
- RemoteBlobStore: `PATCH /blob/{key}` with `Content-Range: bytes offset-…/…`.
- relayium-node: new `PATCH /blob/{key}` appends at the offset (same size==offset
  guard).

`start==0` Append creates the object. Mirrors the GetRange addition.

## GC

Reap pending blobs older than `pendingUploadTTL` (1 h): a DiskStore/​node
sweep by mtime for blobs not referenced by any stored_files row. Simplest:
sessions expire in memory after the TTL and their blobs are dropped; a
periodic age-based sweep (like CleanupTemp) covers blobs stranded by a
restart. Never touch a blob younger than the TTL (avoids racing an active
upload).

## Quota / cap / metering

- Daily-quota pre-check at init (fail fast on declared size); authoritative
  ReserveUpload at finalize with the real byte count. On a quota failure at
  finalize, drop the blob + session (nothing was billed).
- MaxFileSize enforced cumulatively across chunks in PATCH.
- AddUploadStat + RecordMeter at finalize only (one upload = one event).

## Client (`web/src/lib/stored-file.ts`)

`uploadFileResumable(files, opts, onProgress, signal)`:
- Encrypt into the assembled ciphertext Blob (as today) so chunks can be
  re-sent without re-encrypting.
- init → loop `blob.slice(offset, offset+chunkSize)` PATCH with Content-Range,
  **per-chunk retry with backoff** on a network error (re-GET the offset to
  re-sync if needed), update offset + `uploading` progress → finalize.
- Abort (AbortSignal) honored between/within chunks.
- On a non-retryable status (413/429/401) surface UploadError(status) as today.

`StoredUpload.svelte` switches to the resumable path; the existing two-phase
progress (encrypting → uploading) is reused, uploading now spanning chunks.

## Compatibility

The old single `POST /api/files` stays for the CLI (`relayium up`) and older
web clients. Only the new web upload uses chunks. No wire change to existing
endpoints.

## Testing

- storage Append: disk offset-append + offset-mismatch guard; remote PATCH
  Content-Range; node PATCH append + 206-style guard.
- account: init→PATCH×N→finalize round-trips and stores the right blob/size;
  resume (GET offset, re-PATCH from it); ownership 404; cumulative MaxFileSize
  → 413; quota reserve at finalize; GC reaps an abandoned pending blob.
- client: chunk loop uploads a multi-chunk blob; a chunk that fails once then
  succeeds resumes; abort mid-upload rejects.

## Rollout
Server deploys with main; web ships in the SPA bundle. CLI unaffected.
