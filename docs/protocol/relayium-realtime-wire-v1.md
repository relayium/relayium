# Relayium realtime DataChannel wire v1 (authoritative)

The frame format two peers exchange over the WebRTC DataChannel after the
commit-reveal handshake agrees session keys. Byte layout only — the WebRTC
transport and handshake are defined elsewhere.

## Frame
- `[kind: 1 byte][seq: uint32 BE][payload]`. CHUNK_OVERHEAD = 5 + 16 (header + GCM tag).

## Kinds
- 1 CHUNK      — one file slice, sealed(sessionKey, seq).
- 7 BATCH_ENC  — the manifest JSON, sealed(sessionKey, seq). seq 0.
- 8 DONE_ENC   — `{"sha256":<hex>}` (the file's chained hash), sealed(sessionKey, seq).
- 4 RESUME_START (plaintext, sender→recv) — `{"index","offset","seq"}`.
- 5 RESUME_REQ   (plaintext, recv→sender) — `{"index","offset"}` (non-negative ints only).
- 6 ACK          (plaintext, recv→sender) — Float64 BE cumulative bytes durably written. 13 bytes.
- 9 TEXT_ENC   — one ephemeral message, sealed with a DERIVED subkey and its own
  per-direction counter, NOT the session key or this seq space. Byte layout is the
  same `[kind][seq][sealed]`; everything else about it is
  relayium-text-v1.md's business.
- 2 DONE_LEGACY / 3 BATCH_LEGACY — REJECTED (peer on an older version); never parsed.
- Single-byte control (recv→sender): 0xfe ACCEPT, 0xff REJECT, 0xfd COMPLETE.
  ACCEPT/REJECT are reused unchanged as the message session's consent handshake
  (relayium-text-v1.md); COMPLETE has no meaning there. A 1-byte control frame is
  structurally disjoint from any 5-byte-header frame, so the two never collide.

## Seal
- AES-256-GCM with the 32-byte session key; nonce = nonceFromSeq(seq) (4 zero
  bytes + 64-bit BE counter), identical to the stored-wire/crypto layer.
- seq is a GLOBAL monotonic counter across the whole transfer (manifest=0, then
  chunks & per-file DONEs each consume one). Never rewound; never reused.

## Manifest (BATCH_ENC payload, before sealing)
- Compact JSON `{"files":[{"name":<str>,"size":<int>[,"path":<str>]},…]}` — key
  order files→(name,size,path); `path` omitted when absent. UTF-8. ≤ MANIFEST_MAX_BYTES
  (200*1024) after the 16-byte tag. On decode, filenames run through safeDisplayName.

## Integrity
- Per file: chained hash h = SHA-256(h || chunk), h starts as 32 zero bytes;
  DONE carries hex(h). Receiver recomputes and compares; resets per file.

## Flow control
- CHUNK_SIZE = 192*1024. FLOW_WINDOW = 8 MiB: the sender stays at most this many
  bytes ahead of the receiver's latest ACK (cumulative durably-written bytes).
  FLOW_ACK_INTERVAL = 512 KiB: the receiver ACKs at least this often.

## Ordering / errors
- An unknown kind is a hard error in every implementation (web, Swift, and the
  Go CLI's own separate wire). That is why a new kind is never sent
  speculatively: kind 9 is gated on the capability handshake, or an older peer
  fails the whole transfer on the frame it does not recognise.
- Receiver enforces BATCH/CHUNK/DONE seq == expected (monotonic); any mismatch,
  tamper (GCM auth fail), or legacy kind is a hard error (fail closed).
- The wire `seq` is uint32 (max 2^32-1); a RESUME_START announcing a `seq` at
  or above 2^32 can never match a real frame's on-wire seq, so it's malformed
  and rejected outright rather than accepted and left permanently unmatchable.
