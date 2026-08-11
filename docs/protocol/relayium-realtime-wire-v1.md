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
- 10 CHUNK_PART / 11 BATCH_PART — transport fragmentation. A logical CHUNK_SIZE
  chunk (or the manifest) that does not fit one DataChannel message goes out as
  PART…PART terminated by the ordinary CHUNK/BATCH kind. Each piece is sealed
  separately and burns its own seq; the receiver reassembles the plaintext before
  hashing or parsing. Shipped with fragmentation and present in both the Web
  client and the Swift port (`RealtimeKind.chunkPart`/`batchPart`).
  **They were missing from this list**, which is how relayium-pair-room-v1.md
  came to assign STORED_KEYS to kind 10 — a value that was not free. A handoff
  sent as kind 10 would have been authenticated in sequence as a chunk fragment
  and spliced into the middle of a file. Any new kind is chosen against THIS
  list, and this list is the code.
- 12 STORED_KEYS — the pre-upload key handoff. Gated on the `preupload/1`
  capability for exactly the reason kind 9 is gated: an unknown kind is a hard
  error, so a speculative send fails the whole transfer instead of degrading.
  Sealed with its OWN derived key (`preuploadSend`/`preuploadRecv`, domain
  `relayium-preupload-v1\0`) and its own per-direction counter starting at 0 —
  NOT the session key and NOT this seq space. Same reason kind 9 has its own
  key: the file stream's seq safety rests on having exactly one producer, and
  the handoff is a second one (it fires on link establishment, on every rebuild,
  and whenever another upload lands). Its independence is also what makes
  "re-send on every re-established link" implementable at all — it never has to
  be ordered against a batch in flight or against a resume realignment. Unlike
  every other kind in this list, its receive sequence is forward-only rather than
  gap-free: a seq at or below the last consumed is a replay and is refused, while
  one ahead is accepted if it opens, and the expectation advances on that OPEN
  rather than on the payload decoding. That is not a weakening — the sender
  spends a seq synchronously and seals asynchronously, so frames are genuinely
  destroyed with their numbers spent, and a counter that can never roll back (the
  seq is the nonce) needs a receiver that can step over the hole. For the same
  reason there is no retry at a spent number to hold the expectation open for.
  **Demux by kind alone**, including a frame too short to be a valid one: a
  truncated kind 12 is still not the file stream's, and handing it to the file
  receiver fails that lane on a frame it never sent. Payload, ordering, retry and
  idempotency are relayium-pair-room-v1.md's business.
- 2 DONE_LEGACY / 3 BATCH_LEGACY — REJECTED (peer on an older version); never parsed.
- Single-byte control (recv→sender): 0xfe ACCEPT, 0xff REJECT, 0xfd COMPLETE.
  ACCEPT/REJECT are reused unchanged as the message session's activation handshake
  (relayium-text-v1.md); COMPLETE has no meaning there. A 1-byte control frame is
  structurally disjoint from any 5-byte-header frame, so the two never collide.
  ACCEPT means "the recipient's handler is attached and content may flow" — a
  default client emits it automatically once the link is up, and only advanced
  verification holds it for a human. It is not a signal that anyone approved
  anything, and must not be read as one. The FILE accept prompt is a separate
  step and is unaffected. The ordering invariant is unchanged in both cases:
  attach the receive handler BEFORE sending ACCEPT, and send no content before it.

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
