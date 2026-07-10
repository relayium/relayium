# SP2 — Node Storage (Distributed Blob, Central-Proxy)

Date: 2026-07-10
Status: Approved (design)
Part of: relay-node fleet system. SP1 (foundation + relay + fleet telemetry) is shipped on
main (merge f29b440). This is SP2. SP3 (BYO user nodes) follows.
Prior specs: `docs/superpowers/specs/2026-07-10-relay-node-sp1-design.md`.

## Goal

Let a registered relay node also STORE stored-transfer blobs on its own disk, so blob storage
spreads across the fleet instead of piling onto the central server's volume (the M3b
disk-soft-cap bottleneck). Central keeps the metadata directory; blob bytes live on a node.
Routing is **central-proxy**: browser ↔ central ↔ node — the node needs no browser-facing TLS,
preserving the "deploy on any bare-IP box" ethos. E2E is unchanged: nodes store ciphertext only.

Success: with a storage-capable node online, a new upload's ciphertext lands on that node's
disk (not central's), the file downloads correctly through central, the admin dashboard shows
the node's real stored bytes, and deleting/expiring the file reclaims the node's disk.

**Decided:** central-proxy routing (not direct-to-node — that's an SP3/bandwidth concern needing
per-node TLS). Random placement among eligible nodes. No replication (a file lives on exactly
one node; that node offline ⇒ the file is temporarily unavailable — VIP HA is future).

## Non-goals (explicitly later)

- Direct browser↔node transfer / bandwidth offload (needs per-node public TLS+domain; SP3-era).
- Replication / high availability (future VIP feature).
- Capacity-weighted or region-aware placement (random is v1; refine later).
- BYO account-bound storage nodes + per-user routing (SP3).

## Architecture

The single `s.blobs BlobStore` becomes a per-file lookup. `storage.BlobStore` (unchanged 3-method
interface: `Put(ctx,key,r)(int64,err)`, `Get(ctx,key)(ReadCloser,err)`, `Delete(ctx,key)err`,
`ErrNotFound`) gets a second implementation.

```
browser ──PUT /api/files──▶ central                     node (storage-capable)
                            pick eligible node N          HTTP: PUT/GET/DELETE /blob/{key}
                            s.blobFor(N.id).Put ──────────▶  backed by storage.DiskStore
                            StoredFile{node_id=N.id}          (ciphertext on node disk)
browser ◀─GET .../blob──── s.blobFor(sf.node_id).Get ◀────   node streams ciphertext
```

- `s.blobFor(nodeID)` returns the local `DiskStore` when `nodeID` is empty/"central", else a
  `remoteNodeBlobStore{url, secret, httpClient}` built from the node's row (`storage_url`,
  `storage_secret`). Central is "the first node" (local DiskStore = the `node_id=""` case).
- Upload/download/delete/GC change only their blob-store acquisition (`s.blobs.X` →
  `s.blobFor(id).X`); the burn-after-read claim, daily-quota `ReserveUpload`, `cappedReader`
  size cap (`MaxFileSize`, enforced central-side), manifest handling, and stats/meter calls are
  untouched.

## Component 1 — `storage.RemoteBlobStore` (central-side)

New type in `internal/storage` (co-located with `DiskStore`, same package, satisfies `BlobStore`):

- `NewRemoteBlobStore(baseURL, secret string, hc *http.Client) *RemoteBlobStore`.
- `Put(ctx, key, r)`: `PUT <baseURL>/blob/<key>` with body = `r` (streamed, chunked),
  `Authorization: Bearer <secret>`. The node responds `{ "size": <int64> }`; return that size.
  The `cappedReader` central wraps `r` in still enforces `MaxFileSize`: if it trips `errTooLarge`
  mid-stream, the HTTP body read fails; `Put` must surface an error the caller can match with
  `errors.Is(err, errTooLarge)` (wrap the reader error through). On a non-2xx node response,
  return a non-nil error (and the caller deletes any partial via `Delete`).
- `Get(ctx, key)`: `GET <baseURL>/blob/<key>` with the bearer; return the response body as the
  `io.ReadCloser` (streamed to the browser). A 404 from the node → `storage.ErrNotFound`.
- `Delete(ctx, key)`: `DELETE <baseURL>/blob/<key>` with the bearer; 404 is treated as success
  (idempotent delete).

The `http.Client` has no total timeout (uploads/downloads are large streams) but sets a
dial/response-header timeout so an unreachable node fails fast rather than hanging a request.

## Component 2 — node blob HTTP server (`relayium-node`)

The node gains an HTTP server (separate from pion/turn UDP) on a TCP port (`-storage-port`,
default 8081), enabled only when storage is turned on (`-storage-dir` set, default
`/var/lib/relayium-node/blobs`). Routes, all requiring `Authorization: Bearer <storageSecret>`
(constant-time compare; the secret is generated once and persisted in `state.json` next to
`turnSecret`):

- `PUT /blob/{key}` — stream body into `storage.DiskStore.Put(key, body)`; respond
  `{ "size": <written> }`. DiskStore's temp-file+rename means an aborted upload commits nothing.
  Enforce a node-side max (defense in depth; central's cap is authoritative) — reject bodies
  over a configured ceiling.
- `GET /blob/{key}` — `DiskStore.Get(key)`; 404 on `ErrNotFound`; stream with
  `Content-Type: application/octet-stream`.
- `DELETE /blob/{key}` — `DiskStore.Delete(key)`; 204; missing key is still 204 (idempotent).

`key` is validated as an opaque token (hex/base64 charset, bounded length) to prevent path
traversal — `DiskStore.paths` already shards by key, but the handler must reject a key with
`/`, `..`, etc. before touching the store.

The node reuses `internal/storage.DiskStore` verbatim (same package the central server uses),
and `storage.DiskUsage` on the blob dir for its free/total telemetry.

## Component 3 — registration / capability / schema changes

**Node → central register** (`nodeRegisterReq`) gains, when storage is enabled:
`capabilities` includes `"storage"`, plus `storageURL` (`http://<public-ip>:<storage-port>`),
`storageSecret`, `storageTotal`, `storageFree` (bytes, from `DiskUsage`). Heartbeat gains
`storedBytes` (already an SP1 field — now the real blob-dir usage) and refreshed
`storageFree`/`storageTotal`.

**`nodes` table** gains columns (idempotent `ALTER`, following the existing migration idiom):
`storage_url TEXT`, `storage_secret TEXT`, `storage_enabled INTEGER NOT NULL DEFAULT 0`,
`storage_total INTEGER NOT NULL DEFAULT 0`, `storage_free INTEGER NOT NULL DEFAULT 0`.
`storage_enabled` is set to 1 at register when the node's `capabilities` include `"storage"`
(a plain boolean column keeps the `StorageNodes` query simple; `capabilities` stays a
request-body field, not persisted as its own column). `Node` struct gains
`StorageURL, StorageSecret string; StorageEnabled bool; StorageTotal, StorageFree int64`.
Store methods extended: `UpsertNode`/`TouchNode` carry the new fields; a new
`StorageNodes(ctx, since, minFree int64) ([]Node, error)` returns online
(`last_seen_at >= since`) fleet nodes with `storage_enabled = 1` and `storage_free >= minFree`.

**`stored_files` table** gains `node_id TEXT` (nullable; idempotent `ALTER`; NULL/"" = central
local blob, so every existing row and the no-storage-node path stay valid). `StoredFile` struct
gains `NodeID string`. `CreateStoredFile` and the select column lists include it.

**`pending_node_deletes` table** (orphan-cleanup retry queue): `blob_key TEXT`, `node_id TEXT`,
`enqueued_at INTEGER`. Store methods `EnqueueNodeDelete`, `ListPendingNodeDeletes`,
`DeletePendingNodeDelete`.

## Component 4 — upload routing + random placement

In `handleUploadFile`, after the ciphertext is ready to store, choose the target node:

- `placeUpload(ctx) (nodeID string, bs BlobStore)`: query `StorageNodes(ctx, now-nodeOnlineWindow,
  minFreeMargin)`; if any, pick one uniformly at random and return `(node.ID,
  RemoteBlobStore(node))`; else return `("", localDiskStore)` (central fallback). `minFreeMargin`
  is a configured headroom (e.g. `MaxFileSize` × small factor) so a near-full node isn't chosen.
- `Put` streams to the chosen store; the resulting `StoredFile.NodeID` records placement. On
  `Put` error, the existing rollback (delete blob, no row, refund reserve) runs against the SAME
  chosen store.

Random selection uses `crypto/rand` (no `math/rand` global-seed concerns); an injectable picker
keeps it testable. Placement is decided once per upload and never changes for that file.

## Component 5 — download / delete / GC routing

- `handleFileBlob`: `bs := s.blobFor(sf.NodeID)`; `bs.Get(sf.BlobKey)`. If the node is offline /
  unreachable (dial fails) → **503** with a clear "storage node offline, try again later"
  (distinct from 404-not-found, since the file exists but its single copy is unreachable — the
  accepted no-replica behavior). The burn-after-read claim still happens BEFORE the fetch; note a
  burn file whose node is offline is a hard case — see Error handling.
- `handleDeleteFile`: `s.blobFor(sf.NodeID).Delete`; if the node is unreachable, enqueue a
  `pending_node_deletes` row and still delete the `stored_files` row (file is gone from the user).
- **GC** (`gc.sweep`): for each expired file, `blobFor(f.NodeID).Delete`; on unreachable-node
  error, `EnqueueNodeDelete(f.BlobKey, f.NodeID)`. Each sweep also drains
  `ListPendingNodeDeletes`: retry each against its node; on success `DeletePendingNodeDelete`,
  on still-unreachable leave it for the next sweep. This reclaims orphaned node blobs once the
  node returns, keeping node disk bounded under the no-replica model.

## Component 6 — telemetry / admin

The admin Nodes section (SP1) now shows real `stored_bytes` and adds storage free/total (or
percent full). No new page — extend the existing `adminNodeView`/template. Optionally surface a
file's `node_id` in the admin file view (nice-to-have, not required).

## Error handling

- **Upload, node dies mid-PUT:** `Put` returns an error → central deletes any partial on the node
  (best-effort), does NOT create the `StoredFile` row, refunds the daily-quota reserve — reusing
  the existing upload-rollback path. The user gets 5xx and retries (a fresh placement).
- **Download, node offline:** 503, file untouched (still exists, just unreachable now). For a
  **burn-after-read** file: the claim is taken before the fetch; if the fetch then 503s because
  the node is offline, the burn would be spent with nothing delivered. To avoid burning a shot on
  an unreachable node, `handleFileBlob` for a remote burn file must probe node reachability (or
  attempt the `Get` and, only on success, take the burn claim). Resolve by taking the burn claim
  AFTER a successful node `Get` open for remote files — the claim+stream ordering already exists
  for local; for remote, open first, then claim, then stream (the small TOCTOU window is
  acceptable and strictly better than burning on an offline node). This nuance is called out for
  the plan.
- **Central↔node transport:** bearer `storageSecret`, constant-time compared; opaque unguessable
  `blob_key`; path-traversal-safe key validation on the node. Plain HTTP is acceptable because
  the payload is E2E ciphertext (confidentiality) authenticated by the client's AEAD (tamper
  detection on decrypt); TLS-pinning is a noted hardening follow-up.
- **Node clock / secret rotation:** the `storageSecret` is static per node; re-register updates
  it centrally. A rotated secret mid-flight fails in-flight blob calls (rare; retried).

## Testing

- `RemoteBlobStore` (httptest node): Put round-trips + returns size; `errTooLarge` from the
  capped reader surfaces matchably; Get streams bytes and maps 404→`ErrNotFound`; Delete is
  idempotent; bearer required.
- Node blob handler: PUT temp+rename (aborted body commits nothing), GET, DELETE idempotent,
  auth rejects wrong/absent bearer, path-traversal keys rejected.
- `placeUpload`: with online storage nodes → returns one of them (random, injectable picker);
  none / all-too-full → central fallback (`""`).
- `StorageNodes` store query: filters online + storage-enabled + `storage_free >= minFree`.
- Download routing: local file (node_id "") served from disk; remote file served via node; node
  offline → 503 (not 404); burn file on remote node opens-then-claims (no shot burned on offline).
- GC orphan queue: node unreachable on expiry → `pending_node_deletes` enqueued + central row
  deleted; next sweep with node reachable drains the queue.
- `stored_files.node_id` migration: existing rows read back with `NodeID == ""` and serve locally.

## Out of scope / follow-ups

- Direct browser↔node transfer (bandwidth offload) — SP3-era, needs per-node TLS+domain.
- Replication / HA (VIP feature).
- Capacity-weighted / region-aware placement.
- TLS-pinning on the central↔node blob hop.
- Node-side proactive reconcile (beyond the central-driven `pending_node_deletes` retry queue).
