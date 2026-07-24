# Relayium stored-transfer wire v1 (authoritative)

Source of truth for the Swift port. Zero-knowledge stored transfers: one random
AES-256-GCM key per upload encrypts both the manifest and the file bytes; the key
lives only in the URL fragment (`#k=`), the server stores opaque ciphertext.
Any change requires regenerating `apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json`
and updating web + Swift together.

## Key
- 32-byte random AES-256-GCM key.
- `#k=` fragment encoding: base64url, NO padding (libsodium URLSAFE_NO_PADDING):
  standard base64 then `+`→`-`, `/`→`_`, strip trailing `=`.
- Decode is strict: reject any char outside [A-Za-z0-9_-]; reject length where
  `length % 4 == 1` (base64 can't produce it — a silently truncated key must fail
  loudly, not decrypt to garbage).

## Nonce (shared with realtime + Crypto)
- 12 bytes: 4 zero bytes then a 64-bit big-endian counter (seq).
- Manifest = seq 0. File chunks = seq 1,2,3,… global across all files.

## Manifest
- Plaintext = compact JSON `{"files":[{"name":<string>,"size":<int>},…]}`
  (no spaces; key order files, then name, size). UTF-8.
- Ciphertext = AES-256-GCM(key, nonce(0), plaintext) — `raw_ct || 16-byte tag`.
- Travels in the upload `init` body (not framed).
- On decrypt: JSON-parse, then run every `name` (and each `/`-segment of `path`
  if present) through safeDisplayName (below). Encrypted manifest holds RAW names.

## File frames (the streamed body)
- STORE_CHUNK_SIZE = 192*1024. Each file is split into ≤STORE_CHUNK_SIZE chunks;
  the last chunk is NOT padded; there is NO separator frame between files.
- Each chunk → ct = AES-256-GCM(key, nonce(seq), chunk); frame = uint32BE(len(ct)) || ct.
- FRAME_OVERHEAD = 4 + 16 = 20 (length prefix + GCM tag).
- cipherSize(files) = Σ over files of size + FRAME_OVERHEAD*ceil(size/STORE_CHUNK_SIZE).
- MAX_FRAME_CT = STORE_CHUNK_SIZE + 16 + 256. A decoder MUST reject any frame whose
  length prefix exceeds this before allocating (the prefix is attacker-controlled).

## Decode / reassembly
- Frames arrive across arbitrary network chunk boundaries; buffer and emit whole
  frames in order, decrypting each at the next seq (starting 1).
- Finalization MUST reject trailing bytes (a dangling partial frame = truncation)
  and, when an expected plaintext total is known (from the manifest sizes), assert
  the decrypted total matches — a stream truncated on a frame boundary is otherwise
  indistinguishable from a clean end.

## safeDisplayName (filename sanitize, from filename.ts)
- stripBidi: remove all Unicode Bidi_Control code points:
  U+061C, U+200E, U+200F, U+202A, U+202B, U+202C, U+202D, U+202E, U+2066, U+2067, U+2068, U+2069.
- then remove C0/C1 controls: U+0000–U+001F, U+007F, U+0080–U+009F.
- sanitizeNames({name, path?}): name→safeDisplayName(name); path→split "/", map
  safeDisplayName, join "/".
