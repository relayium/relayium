# Resumable cloud downloads (HTTP Range)

Date: 2026-07-13

## Problem

`relayium down` streams the blob in one shot. A mid-stream reset — observed
as `stream error: … INTERNAL_ERROR; received from peer` from the reverse
proxy in front of relayium.com — aborts the whole download and leaves a
truncated file on disk. There is no retry and no resume, so any transient
interruption of a large transfer fails it outright.

(The in-repo Go timeouts were all ruled out as the cause: the front server
sets no WriteTimeout, `nodeHTTP` has no total timeout, the node blob server
has no WriteTimeout. The reset originates at the proxy/edge, likely because
the origin closed the blob connection early — e.g. a remote storage node
dropped mid-stream. Resilience is the durable fix regardless of the trigger.)

## Goal

Make `relayium down` survive a mid-stream interruption by reconnecting and
continuing from where it stopped (HTTP Range), within a single `down` run.
Cross-invocation resume (Ctrl-C then re-run) is out of scope.

## Why frame boundaries make this clean

The blob is pure framed ciphertext: `uint32BE(len(ct)) || ct` frames, seq
1,2,3…, nonce = 4 zero bytes || BE64(seq). `Decryptor` consumes whole frames
and buffers any partial frame. So the byte offset of the last fully-consumed
frame is always a valid resume point: `Range: bytes=<offset>-` returns the
next frame, and decryption continues from the next seq with no wire/nonce
changes.

## Changes by layer

### 1. storecrypto (`storecrypto.go`)
Two small methods on `Decryptor`:
- `ConsumedCipher() int64` — cumulative bytes of fully-decoded frames
  (frame-aligned; add `4+len(ct)` per completed frame).
- `ResetBuffer()` — drop the partial-frame buffer, called before feeding a
  Range-resumed body that begins on a frame boundary.
seq/nonce/wire format unchanged.

### 2. storage.BlobStore (`blob.go`, `disk.go`, `remote.go`)
Add `GetRange(ctx, key, start int64) (io.ReadCloser, error)` to the interface:
- `DiskStore`: open the file and `Seek(start)`.
- `RemoteBlobStore`: send `Range: bytes=<start>-`; accept 200 (server ignored
  Range) or 206.
- `start == 0` behaves exactly like `Get`.
Update all implementations and test fakes.

### 3. node blob server (`cmd/relayium-node/storage.go`)
`GET /blob/{key}`: replace `io.Copy` with `http.ServeContent` (the disk blob
is an `*os.File`), which handles Range/206/Content-Range and advertises
`Accept-Ranges` automatically.

### 4. central handler (`internal/account/files.go`)
Range support only for **unlimited** files (`MaxDownloads == 0`); limited /
burn files keep today's exact behaviour (claim a slot, stream the whole blob,
Range ignored) because a resumed download is multiple stateless GETs that
can't be counted as one. So the slot/burn code path is untouched.
- Parse `Range: bytes=<start>-` (only this form; clamp `0 <= start <= size`;
  malformed → treat as full).
- Call `GetRange(ctx, key, start)`; for `start > 0` write `206` +
  `Content-Range: bytes start-(size-1)/size` + `Content-Length: size-start`;
  for a full request keep `200` + `Content-Length: size` and
  `Accept-Ranges: bytes`.
- Metering/stats: record one download of `sf.Size` only on a **full** (non-
  Range) delivery, preserving the existing deliver-then-count semantics; a
  Range continuation records nothing (avoids double counting).

### 5. client (`internal/cloud/transfer.go`)
`Download` gains an in-process resume loop:
- Keep one `manifestWriter` and one `Decryptor` across reconnects.
- Request `Range: bytes=<dec.ConsumedCipher()>-` when resuming.
- Feed the body; on a mid-stream read error (network / stream reset), if
  under the retry cap (5) and progress was made or attempts remain, back off
  (exponential) and retry from `ConsumedCipher()` after `dec.ResetBuffer()`.
- If the server answers `200` to a resume attempt (ignored Range — a limited/
  burn file), restart cleanly: reset writer, decryptor, offset to 0
  (re-truncating outputs).
- On EOF success: `dec.End(expectedTotal)` + `w.finish()` as today.
- On final give-up: delete the partial output files (`w.paths`) so a failed
  download never leaves a truncated file masquerading as complete (the bug
  behind the unusable `mixin-cli.zip`).
- Progress reporting (Client.Progress) reused unchanged.

## Testing
- storecrypto: `ConsumedCipher` advances by frame size and stays frame-aligned
  across split Pushes; `ResetBuffer` drops a partial frame.
- disk/remote `GetRange`: start>0 returns the tail; remote sends the Range
  header and handles 200 vs 206.
- node: a Range request returns 206 with the correct slice.
- central: unlimited file honours Range (206 tail); limited file ignores it
  (200, slot claimed); metering fires once on full, not on Range.
- client: a server that drops mid-stream once then serves the tail on the
  Range retry completes the file correctly; a 200-on-resume triggers a clean
  restart; exhausted retries remove partial files.

## Rollout
Ships in the next CLI tag; server side deploys with main. Old clients keep
working (they simply never send Range). New clients resume against the
Range-capable server; against an old server that ignores Range they fall back
to full re-download (the 200 path).
