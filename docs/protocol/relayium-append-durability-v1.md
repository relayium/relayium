# Relayium append durability v1 (authoritative)

Version string: **`v1`** in header `X-Relayium-Append-Durability`

Reference implementation: `server/internal/storage/disk.go` (`DiskStore.Append`),
`server/internal/storage/append_state.go`, `server/internal/storage/remote.go`,
`server/cmd/relayium-node/storage.go` (`writeAppendAnswer`),
`server/account/uploads_resumable.go`, `server/account/sqlite.go`
(`CommitUploadProgress`).

Tests: `server/internal/storage/append_state_test.go`,
`server/cmd/relayium-node/storage_durability_test.go`,
`server/account/upload_durability_test.go`,
`server/account/upload_session_store_test.go`.

This document governs how the server stores resumable-upload ciphertext and
how it accounts for it. It changes nothing a client sends or receives: the
client PATCH, GET status, 200/409 bodies and the 500 class are unchanged. It is
an internal contract between central's account service, its blob stores, and
storage nodes.

---

## 0. The two numbers

Every upload session has two watermarks, and they answer different questions.

| Column | Meaning | Moves when | Used for |
|---|---|---|---|
| `received` | **durable** offset: every byte below it is known to be on stable storage | a store proves a durable size | resume offset, room deadline renewal, a finalized object's size |
| `metered` | **accepted** high-water: every offset some append got bytes onto the blob for | any append accepted bytes, durable or not | billing, once per offset |

`metered >= received` for every billable session. The bill for one commit is
`max(0, accepted - metered)`. A byte accepted while the disk could not make it
durable is billed then; its replay (same offset, now durable) advances
`received` and costs nothing more. On every row where the two have stayed equal
the arithmetic is exactly the pre-v1 one. Own-node (non-billable) sessions keep
`metered` 0 and are never billed.

Terminal hand-offs (orphan cleanup, purge, refused finalize, pair-room void)
floor their billing obligation at `max(received, metered)`, so bytes already
billed but still on the blob are not billed again by GC.

## 1. What a store may report

A size an append returns with success or with an offset mismatch is
**durable**. Bytes a store holds but cannot vouch for are reported as
**not durable** with three absolute numbers:

- `durable`: the size the session may resume from;
- `physical`: the blob's size on the file system; `[durable, physical)` is
  accepted-but-not-durable evidence;
- `written`: bytes THIS append wrote from its body; this says nothing about
  whether the HTTP transport still owns the reader. Never reuse that reader.

A store certifies a size past the caller's offset only by its own record of a
flush it performed (bounded, in memory, per process). After a restart, an
eviction, or a failed flush, such a tail is **not known durable** — a later
successful `fsync` is never taken as proof, because it cannot certify pages an
earlier flush failed to write. A zero-byte probe never flushes and never
certifies.

## 2. Settlement and fresh-request replay

A failed file or directory flush leaves written bytes in place and reports
`durable = offset`. Central settles accepted bytes using `metered`, without
advancing the resume offset or renewing the room deadline. It takes back the
request body using the synchronized upload reader before reading its final
count or committing settlement. One client PATCH makes exactly one append;
zero node-side writes never authorize reuse of the same HTTP reader.

The next **fresh client request**, retaining its original ciphertext, carries
the server-owned settled floor from the session row (`metered`, or an unlimited
floor for a nonbillable own-node session). If the floor covers the entire
physical tail, the store compares overlapping bytes under the same-key lock
and rewrites only identical bytes. Conflicting bytes fail without overwriting
them. Existing bytes are never truncated, including after restart, certificate
eviction, or a short/interrupted replay. This preserves an earlier successful
append whose ACK or database commit is still in flight.

Only the prefix rewritten by this call and successfully flushed is certified.
A shorter matching replay returns not-durable with its verified prefix and the
full retained physical extent; central reports the new durable offset via 409,
and a subsequent fresh request can continue there. A failed flush certifies
nothing new. An empty settled replay of a retained tail neither flushes nor
certifies. Healthy sequential chunks retain their existing single file-flush
budget; recovery may require an additional client round trip. The floor never
comes from anything a client sent.

## 3. Wire, central to node

Request headers (central always sends the first):

| Header | Value |
|---|---|
| `X-Relayium-Append-Durability` | `v1` |
| `X-Relayium-Settled-Through` | decimal settled floor; only when central authorizes a repair |

A v1 node echoes `X-Relayium-Append-Durability: v1` on every answer to a v1
request:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"size":N}` | durable N |
| 409 | `{"size":N}` | offset mismatch, durable N |
| 500 | `{"notDurable":true,"durable":D,"physical":P,"written":W}` | not durable (§1) |
| 400 | text | malformed settled floor |

Central rejects a not-durable body that is malformed, has negative numbers, or
has `physical < durable` or `written > physical`, and treats it as a plain
failure. It caps `written` at the bytes it actually forwarded, and a tail the
node says was already there at the session's `max_size` — the same trust a
pre-v1 409 size had, no wider.

## 4. Mixed versions

| Central | Node | Behaviour |
|---|---|---|
| v1 | v1 | everything above |
| v1 | legacy (no echo) | 200 durable (legacy nodes fail the append on a failed flush); 409 size is PHYSICAL and marked unattested; central keeps the pre-v1 handling for it; no repair |
| legacy | v1 | the node answers a request without the v1 header exactly as a legacy node did: uncertified tail -> 409 with the physical size, failed flush -> 500, no repair, no v1 claim |

**Not guaranteed on a legacy node:** after that node's flush fails, a 409 or
probe size may include bytes no flush certified, and central cannot tell.
Upgrading the node closes it. No claim is made that every node is upgraded.

## 5. Deployment and rollback boundary

The two watermarks change the meaning of existing columns; their mere presence
is not a compatibility marker. Legacy central binaries calculate progress
against `received` and can charge an already accepted tail again. Mixed legacy
and v1 central writers sharing one database are unsupported. Managed deployment
must have one central writer.

Ops must install the reviewed rollback guard before promoting this server. Its
offline automatic-fallback check refuses any billable upload row with
`metered > received`, including terminal rows, malformed counters, and unknown
upload table shapes. Its immutable-source fence uses the regular Git file
`server/internal/storage/append_state.go`, first introduced with this version,
to reject deliberate legacy downgrades in both `promote.sh` and the actual
auto-deploy consumer. Hosted-check waivers cannot waive this fence. A compatible
forward fix is the normal recovery; any database-specific legacy downgrade
needs a separately reviewed compatibility plan. No live database migration,
manual counter edit, or backend promotion is implied by installing this guard.

## 6. Residuals

- Active resumable rows use `received` only for durable bytes. Terminal
  unresolved cleanup may store a physical billing floor in `received` with
  `done=1`; those rows cannot resume or finalize.
- A retained physical extent above the authorized `max_size` cannot obtain a
  settled repair floor; terminal cleanup remains bounded by existing policy.
- A not-durable append whose reply is lost is billed only when a later probe or
  append reaches a v1 node holding the retained tail.
- The late-append-after-finalize residual (at most one chunk past the object
  size, not billed) is unchanged.
- Node direct downloads (`registerDownloadRoutes`) serve the whole physical
  file, not bounded by the object size; central downloads are bounded
  (`files.go`). Pre-existing, owner-node only.
- No power-loss or lying-hardware claim; ordinary `fsync` success semantics.
- Timed appends / server-side partial 200 are not part of v1.
