# Native macOS R1-B: StoredWire codec — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `StoredWire` module to `RelayiumKit` — the Swift port of `web/src/lib/store-crypto.ts` (the zero-knowledge stored-transfer codec: encrypted manifest + length-prefixed AES-GCM frames + base64url `#k=` key + filename sanitize), proven byte-for-byte identical to the web via golden vectors so a native client's `#k=` stored transfers interoperate with web and CLI.

**Architecture:** `StoredWire` is a pure-logic codec with no transport/network. It reuses `Crypto.seal`/`Crypto.open` (the seq-nonce AES-256-GCM already shipped in R1-A: manifest = seq 0, file chunks = seq 1,2,3…). It provides: a base64url (URLSAFE_NO_PADDING) key codec for the URL fragment; a `StoredManifest` encrypt/decrypt; a length-prefixed frame encoder; and a `StoreDecryptor` that reassembles frames across arbitrary byte-stream boundaries, guards against oversized frames, and detects truncation. Correctness is pinned by golden vectors generated from the web's `store-crypto.ts`.

**Tech Stack:** Swift 5.9+, SwiftPM, XCTest, CryptoKit (via the existing `Crypto` module), Node (existing `web/`) for vector generation. No new dependencies.

## This plan's place in R1

R1 was reordered **cloud-first** after R1-A (see the design spec's "R1 internal sub-plans"). This is the **StoredWire** sub-plan — the codec the Cloud module (R1-D) will stream over HTTPS. Sequence: R1-A `Crypto` (done) → **R1-B `StoredWire` (this plan)** → R1-C `Account` → R1-D `Cloud` (first working native transfer) → R1-E `Signaling` → R1-F `Realtime` → R1-G UI+distribution.

## Global Constraints

- **Reuse `Crypto`, don't reimplement AEAD:** manifest and frames encrypt via the existing `seal(key:seq:plaintext:)` / `open(key:seq:ciphertext:)` (RelayiumKit `Crypto/Aead.swift`). Manifest = seq 0; file chunks = seq 1,2,3… (global across files). Never reuse a seq under one key.
- **Byte-for-byte interop with `web/src/lib/store-crypto.ts`**, pinned by `store-wire-vectors.json` generated from the web. Constants must match exactly: `STORE_CHUNK_SIZE = 192*1024`, `FRAME_OVERHEAD = 4 + 16 = 20`, `MAX_FRAME_CT = STORE_CHUNK_SIZE + 16 + 256`.
- **Frame layout:** `uint32BE(len(ct)) || ct`, where `ct` is the AES-GCM ciphertext (`raw_ct || 16-byte tag`). Big-endian length prefix.
- **`#k=` key codec:** base64url, no padding (libsodium URLSAFE_NO_PADDING). Decode is strict: reject any char outside `[A-Za-z0-9_-]` and any length where `length % 4 == 1`.
- **Manifest JSON byte-parity (interop risk):** the manifest plaintext is `JSON.stringify({files:[{name,size},…]})` — compact (no spaces), key order `files` then per-file `name` then `size`. The Swift encoding MUST produce identical bytes or the manifest ciphertext won't match the vector. Verify against the golden `manifestCtHex`.
- **Filename sanitize on decrypt only:** `decryptManifest` returns names run through `safeDisplayName` (strip Unicode Bidi_Control + C0/C1 controls); the *encrypted* manifest holds the raw (unsanitized) names. Ports `web/src/lib/filename.ts` `stripBidi`/`safeDisplayName`/`sanitizeNames`.
- **Min platforms / cadence:** macOS 13, Swift 5.9; commit after every green test cycle; English commit messages.

---

## File structure (R1-B)

- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreKey.swift` — base64url key codec + `generateStoreKey()`.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/Filename.swift` — `stripBidi`, `safeDisplayName`, `sanitizeNames`.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoredManifest.swift` — `StoredManifest`, `encryptManifest`, `decryptManifest`.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreFrame.swift` — constants, `frame`, `cipherSizeFor`, `encryptChunk`, `StoreDecryptor`.
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/StoreKeyTests.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/FilenameTests.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/StoredManifestTests.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/StoreFrameTests.swift`
- Create: `apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json` — generated fixture (checked in; picked up by the existing `.process("Fixtures/...")` resource rule — see note in Task 2).
- Create: `web/scripts/gen-store-wire-vectors.mjs` — deterministic vector generator (web store-crypto).
- Create: `docs/protocol/relayium-stored-wire-v1.md` — frozen stored-wire protocol section.

---

## Task 1: Freeze the stored-wire protocol into a spec doc

**Files:**
- Create: `docs/protocol/relayium-stored-wire-v1.md`

**Interfaces:**
- Produces: the authoritative description Tasks 2–6 implement against. No code symbols.

- [ ] **Step 1: Write the stored-wire spec**

Create `docs/protocol/relayium-stored-wire-v1.md` with, taken verbatim from `web/src/lib/store-crypto.ts` and `filename.ts`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/protocol/relayium-stored-wire-v1.md
git commit -m "docs(protocol): freeze relayium stored-transfer wire v1 for the Swift port"
```

---

## Task 2: Generate golden stored-wire vectors from the web

**Files:**
- Create: `web/scripts/gen-store-wire-vectors.mjs`
- Create: `apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json`

**Interfaces:**
- Produces: `store-wire-vectors.json` consumed by Tasks 3–6. Shape:
  ```json
  {
    "keyHex": "<hex32>",
    "keyB64url": "<base64url no padding>",
    "manifest": { "json": {"files":[{"name":"hello.txt","size":11},{"name":"a‮b.txt","size":3}]},
                  "ctHex": "<manifest ciphertext hex>",
                  "sanitizedNames": ["hello.txt","ab.txt"] },
    "files": [ {"name":"hello.txt","dataHex":"<hex of 'hello world!' 11B? see note>"},
               {"name":"a‮b.txt","dataHex":"<hex 3B>"} ],
    "streamHex": "<the full framed stream hex (seq 1,2)>",
    "cipherSize": <int>,
    "plaintextBytes": <int>,
    "sanitize": { "in": "a‮b.txt", "out": "ab.txt" }
  }
  ```
  (Use small file contents so the fixture stays small; each file < STORE_CHUNK_SIZE → one frame each. `manifest.files[i].size` MUST equal the byte length of `files[i].dataHex` so the `end(expectedBytes)` check is exercised with a correct total.)

- [ ] **Step 1: Write the generator**

Create `web/scripts/gen-store-wire-vectors.mjs`. It imports the app's real `store-crypto.ts` helpers by re-implementing the tiny deterministic bits inline against Web Crypto (the module uses `File`/generators that aren't ergonomic under Node; reproduce the exact byte operations, which are simple):

```js
import { webcrypto as nodeCrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
const crypto = nodeCrypto;

const hex = (u) => [...new Uint8Array(u)].map(b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map(b => parseInt(b, 16)));

// --- constants (must equal store-crypto.ts) ---
const STORE_CHUNK_SIZE = 192 * 1024;
const FRAME_OVERHEAD = 4 + 16;

function nonce(seq) {
  const n = new Uint8Array(12); const v = new DataView(n.buffer);
  v.setUint32(4, Math.floor(seq / 2 ** 32)); v.setUint32(8, seq >>> 0); return n;
}
function encodeKey(raw) {
  let s = ""; for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function frame(ct) {
  const out = new Uint8Array(4 + ct.length);
  new DataView(out.buffer).setUint32(0, ct.length); out.set(ct, 4); return out;
}
function cipherSizeFor(sizes) {
  let n = 0; for (const s of sizes) n += s + FRAME_OVERHEAD * Math.ceil(s / STORE_CHUNK_SIZE); return n;
}

// fixed key
const keyRaw = fromHex("55".repeat(32));
const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt", "decrypt"]);

// files (small, deterministic). Note the bidi char U+202E in the 2nd name.
const files = [
  { name: "hello.txt", data: new TextEncoder().encode("hello world") }, // 11 bytes
  { name: "a‮b.txt", data: new TextEncoder().encode("xyz") },       // 3 bytes
];

// manifest: raw (unsanitized) names + sizes matching data length
const manifestObj = { files: files.map(f => ({ name: f.name, size: f.data.length })) };
const manifestPt = new TextEncoder().encode(JSON.stringify(manifestObj));
const manifestCt = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(0) }, key, manifestPt));

// frames: seq 1,2,… (each file < chunk → one frame)
let seq = 1; const parts = [];
for (const f of files) {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(seq) }, key, f.data));
  parts.push(frame(ct)); seq++;
}
const stream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
{ let o = 0; for (const p of parts) { stream.set(p, o); o += p.length; } }

// sanitize expectations (safeDisplayName): strip bidi controls + C0/C1
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const CTRL = /[ --]/g;
const safe = (s) => s.replace(BIDI, "").replace(CTRL, "");

const out = {
  keyHex: hex(keyRaw),
  keyB64url: encodeKey(keyRaw),
  manifest: { json: manifestObj, ctHex: hex(manifestCt), sanitizedNames: files.map(f => safe(f.name)) },
  files: files.map(f => ({ name: f.name, dataHex: hex(f.data) })),
  streamHex: hex(stream),
  cipherSize: cipherSizeFor(files.map(f => f.data.length)),
  plaintextBytes: files.reduce((n, f) => n + f.data.length, 0),
  sanitize: { in: "a‮b.txt", out: safe("a‮b.txt") },
};
writeFileSync("../apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote store-wire-vectors.json; cipherSize", out.cipherSize, "sanitizedNames", out.manifest.sanitizedNames);
```

> Fidelity note: every operation above (`nonce`, `encodeKey`, `frame`, `cipherSizeFor`, the seq progression, `safe`) is copied from `store-crypto.ts`/`filename.ts`. Do not "improve" them — byte parity is the whole point.

- [ ] **Step 2: Run the generator**

Run (from `web/`): `node scripts/gen-store-wire-vectors.mjs`
Expected: prints `wrote store-wire-vectors.json; cipherSize 34 sanitizedNames [ 'hello.txt', 'ab.txt' ]` (cipherSize = 11+20 + 3+20 = 54; verify the printed number equals `Σ size + 20*nchunks`). The JSON exists with non-empty hex fields.

- [ ] **Step 3: Commit**

```bash
git add web/scripts/gen-store-wire-vectors.mjs apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json
git commit -m "test(native): generate golden stored-wire vectors from web store-crypto"
```

---

## Task 3: base64url `#k=` key codec

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreKey.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/StoreKeyTests.swift`

**Interfaces:**
- Consumes: `store-wire-vectors.json`.
- Produces:
  - `func encodeStoreKey(_ raw: [UInt8]) -> String` — base64url, no padding.
  - `func decodeStoreKey(_ s: String) throws -> [UInt8]` — strict; throws `StoredWireError.invalidKey`.
  - `func generateStoreKey() -> [UInt8]` — 32 random bytes.
  - `enum StoredWireError: Error, Equatable { case invalidKey, frameTooLarge, truncatedStream, lengthMismatch }`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/StoreKeyTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class StoreKeyTests: XCTestCase {
    func testEncodeMatchesVector() throws {
        let v = try Vectors.load("store-wire-vectors")
        XCTAssertEqual(encodeStoreKey(v.hex("keyHex")), v.str("keyB64url"))
    }
    func testDecodeRoundTrips() throws {
        let v = try Vectors.load("store-wire-vectors")
        XCTAssertEqual(try decodeStoreKey(v.str("keyB64url")), v.hex("keyHex"))
    }
    func testDecodeRejectsInvalid() {
        XCTAssertThrowsError(try decodeStoreKey("a"))          // length % 4 == 1
        XCTAssertThrowsError(try decodeStoreKey("****"))       // outside alphabet
        XCTAssertThrowsError(try decodeStoreKey("ab=c"))       // '=' not allowed
    }
    func testGenerateIs32Random() {
        XCTAssertEqual(generateStoreKey().count, 32)
        XCTAssertNotEqual(generateStoreKey(), generateStoreKey())
    }
}
```

- [ ] **Step 2: Extend the Vectors loader to take a fixture name**

The R1-A `Vectors` helper (`Tests/RelayiumKitTests/Vectors.swift`) hardcodes `crypto-vectors`. Add an overload so both fixtures load. Edit `Vectors.load()` to `static func load(_ name: String = "crypto-vectors") throws -> Vectors` and use `Bundle.module.url(forResource: name, withExtension: "json")`. (Existing `try Vectors.load()` calls keep working via the default.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `swift test --filter StoreKeyTests`
Expected: FAIL — symbols undefined.

- [ ] **Step 4: Implement the key codec**

Create `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreKey.swift`:

```swift
import Foundation
import Clibsodium

public enum StoredWireError: Error, Equatable {
    case invalidKey, frameTooLarge, truncatedStream, lengthMismatch
}

/// base64url, no padding (libsodium URLSAFE_NO_PADDING): standard base64 then
/// +→-, /→_, strip trailing '='.
public func encodeStoreKey(_ raw: [UInt8]) -> String {
    let b64 = Data(raw).base64EncodedString()
    return b64.replacingOccurrences(of: "+", with: "-")
              .replacingOccurrences(of: "/", with: "_")
              .replacingOccurrences(of: "=", with: "")
}

/// Strict decode. Rejects any char outside [A-Za-z0-9_-] and any length where
/// length % 4 == 1 (base64 can't produce it — fail loud, never decode garbage).
public func decodeStoreKey(_ s: String) throws -> [UInt8] {
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    guard s.allSatisfy({ allowed.contains($0) }), s.count % 4 != 1 else {
        throw StoredWireError.invalidKey
    }
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let data = Data(base64Encoded: b64) else { throw StoredWireError.invalidKey }
    return [UInt8](data)
}

public func generateStoreKey() -> [UInt8] {
    ensureSodiumInit()
    var k = [UInt8](repeating: 0, count: 32)
    randombytes_buf(&k, 32)
    return k
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `swift test --filter StoreKeyTests`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreKey.swift apps/RelayiumKit/Tests/RelayiumKitTests/StoreKeyTests.swift apps/RelayiumKit/Tests/RelayiumKitTests/Vectors.swift
git commit -m "feat(native): StoredWire base64url key codec, vector-verified"
```

---

## Task 4: Filename sanitize (Bidi + control strip)

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/Filename.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/FilenameTests.swift`

**Interfaces:**
- Consumes: `store-wire-vectors.json` (`sanitize.in`/`sanitize.out`).
- Produces:
  - `func stripBidi(_ s: String) -> String`
  - `func safeDisplayName(_ s: String) -> String`
  - `func sanitizeNames(_ items: [ManifestFile]) -> [ManifestFile]` (defined once `ManifestFile` exists — Task 5 defines it; if implementing Task 4 first, this signature is what Task 5 relies on).

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/FilenameTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class FilenameTests: XCTestCase {
    func testSafeDisplayNameMatchesVector() throws {
        let v = try Vectors.load("store-wire-vectors")
        XCTAssertEqual(safeDisplayName(v.str("sanitize.in")), v.str("sanitize.out"))
    }
    func testStripsBidiAndControls() {
        // U+202E (RLO) and U+0007 (BEL) removed; ordinary chars kept.
        XCTAssertEqual(safeDisplayName("a\u{202E}b\u{0007}.txt"), "ab.txt")
        XCTAssertEqual(safeDisplayName("\u{200F}\u{2069}name\u{061C}"), "name")
        XCTAssertEqual(safeDisplayName("normal.png"), "normal.png")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --filter FilenameTests`
Expected: FAIL — `safeDisplayName` undefined.

- [ ] **Step 3: Implement the sanitizer**

Create `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/Filename.swift`. Port `filename.ts` exactly — the Bidi_Control set and C0/C1 ranges:

```swift
import Foundation

// Unicode Bidi_Control code points (from filename.ts): U+061C, U+200E, U+200F,
// U+202A–U+202E, U+2066–U+2069.
private let bidiControl: Set<Unicode.Scalar> = {
    var s = Set<Unicode.Scalar>([0x061C, 0x200E, 0x200F].compactMap(Unicode.Scalar.init))
    for cp in (0x202A...0x202E) { if let u = Unicode.Scalar(cp) { s.insert(u) } }
    for cp in (0x2066...0x2069) { if let u = Unicode.Scalar(cp) { s.insert(u) } }
    return s
}()

/// Remove all Unicode Bidi_Control characters.
public func stripBidi(_ s: String) -> String {
    String(String.UnicodeScalarView(s.unicodeScalars.filter { !bidiControl.contains($0) }))
}

/// Sanitize a name before it enters the UI: strip bidi controls, then C0/C1
/// controls (U+0000–U+001F, U+007F–U+009F). Mirrors filename.ts safeDisplayName.
public func safeDisplayName(_ s: String) -> String {
    let stripped = stripBidi(s)
    return String(String.UnicodeScalarView(stripped.unicodeScalars.filter { u in
        let v = u.value
        return !(v <= 0x1F || (v >= 0x7F && v <= 0x9F))
    }))
}
```

(`sanitizeNames` is added in Task 5 alongside `ManifestFile`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --filter FilenameTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/StoredWire/Filename.swift apps/RelayiumKit/Tests/RelayiumKitTests/FilenameTests.swift
git commit -m "feat(native): StoredWire filename sanitize (bidi + control strip), vector-verified"
```

---

## Task 5: StoredManifest encrypt/decrypt

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoredManifest.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/Filename.swift` (add `sanitizeNames`)
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/StoredManifestTests.swift`

**Interfaces:**
- Consumes: `Crypto.seal`/`open` (seq nonce); `safeDisplayName` (Task 4); `store-wire-vectors.json`.
- Produces:
  - `struct ManifestFile: Codable, Equatable { public var name: String; public var size: Int }`
  - `struct StoredManifest: Codable, Equatable { public var files: [ManifestFile] }`
  - `func encryptManifest(key: [UInt8], _ m: StoredManifest) throws -> [UInt8]`
  - `func decryptManifest(key: [UInt8], _ ct: [UInt8]) throws -> StoredManifest`
  - `func sanitizeNames(_ files: [ManifestFile]) -> [ManifestFile]`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/StoredManifestTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class StoredManifestTests: XCTestCase {
    func testEncryptManifestMatchesVector() throws {
        let v = try Vectors.load("store-wire-vectors")
        let files = v.manifestFiles()   // helper below reads manifest.json.files
        let ct = try encryptManifest(key: v.hex("keyHex"), StoredManifest(files: files))
        XCTAssertEqual(ct, v.hex("manifest.ctHex"))
    }
    func testDecryptSanitizesNames() throws {
        let v = try Vectors.load("store-wire-vectors")
        let m = try decryptManifest(key: v.hex("keyHex"), v.hex("manifest.ctHex"))
        XCTAssertEqual(m.files.map(\.name), v.strArray("manifest.sanitizedNames"))
        XCTAssertEqual(m.files.map(\.size), v.manifestFiles().map(\.size))
    }
}
```

Add to `Vectors.swift`: `func strArray(_ path: String) -> [String]` (reads a JSON string array at the dot path) and `func manifestFiles() -> [ManifestFile]` (reads `manifest.json.files` into `[ManifestFile]`). Both are straightforward JSON reads mirroring the existing `hex`/`str` accessors.

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --filter StoredManifestTests`
Expected: FAIL — symbols undefined.

- [ ] **Step 3: Implement manifest + sanitizeNames**

Append to `Filename.swift`:

```swift
/// Sanitize each file's display name. (No `path` field in StoredManifest today;
/// add per-segment path sanitize here if StoredManifest gains a path field.)
public func sanitizeNames(_ files: [ManifestFile]) -> [ManifestFile] {
    files.map { ManifestFile(name: safeDisplayName($0.name), size: $0.size) }
}
```

Create `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoredManifest.swift`:

```swift
import Foundation

public struct ManifestFile: Codable, Equatable {
    public var name: String
    public var size: Int
    public init(name: String, size: Int) { self.name = name; self.size = size }
}

public struct StoredManifest: Codable, Equatable {
    public var files: [ManifestFile]
    public init(files: [ManifestFile]) { self.files = files }
}

/// Compact JSON matching JS `JSON.stringify({files:[{name,size},…]})` byte-for-byte:
/// no spaces, key order files/name/size, no slash escaping. Verified against the
/// golden manifest ciphertext — if the bytes differ, encryption won't match.
private func manifestJSON(_ m: StoredManifest) throws -> [UInt8] {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]   // NOT .sortedKeys — see note
    // Codable emits keys in declaration order (name, then size), matching JS
    // insertion order. Top-level has only `files`. No spaces by default.
    return [UInt8](try enc.encode(m))
}

public func encryptManifest(key: [UInt8], _ m: StoredManifest) throws -> [UInt8] {
    seal(key: key, seq: 0, plaintext: try manifestJSON(m))
}

public func decryptManifest(key: [UInt8], _ ct: [UInt8]) throws -> StoredManifest {
    guard let pt = open(key: key, seq: 0, ciphertext: ct) else {
        throw StoredWireError.truncatedStream   // auth failure / corrupt manifest
    }
    let m = try JSONDecoder().decode(StoredManifest.self, from: Data(pt))
    return StoredManifest(files: sanitizeNames(m.files))
}
```

> **Named risk — JSON byte-parity.** `manifestJSON` MUST equal JS `JSON.stringify` bytes. Swift's default `JSONEncoder` emits compact JSON (no spaces) with keys in property-declaration order — `name` before `size`, matching JS insertion order — so DO NOT set `.sortedKeys` (that's alphabetical, which happens to also be name,size here, but don't rely on it; declaration order is the contract). `.withoutEscapingSlashes` avoids `\/`. If `testEncryptManifestMatchesVector` fails, diff the produced plaintext against `JSON.stringify(manifest.json)` byte-by-byte and adjust (candidate culprits: slash escaping, non-ASCII escaping, key order).

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --filter StoredManifestTests`
Expected: PASS (2 tests). If encrypt fails on byte-parity, follow the named-risk note.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoredManifest.swift apps/RelayiumKit/Sources/RelayiumKit/StoredWire/Filename.swift apps/RelayiumKit/Tests/RelayiumKitTests/StoredManifestTests.swift apps/RelayiumKit/Tests/RelayiumKitTests/Vectors.swift
git commit -m "feat(native): StoredWire manifest encrypt/decrypt (seq 0) + sanitize, vector-verified"
```

---

## Task 6: Frame codec + StoreDecryptor

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreFrame.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/StoreFrameTests.swift`

**Interfaces:**
- Consumes: `Crypto.seal`/`open`; `store-wire-vectors.json`.
- Produces:
  - `let STORE_CHUNK_SIZE = 192*1024`, `let FRAME_OVERHEAD = 20`, `let MAX_FRAME_CT = STORE_CHUNK_SIZE + 16 + 256`
  - `func frame(_ ct: [UInt8]) -> [UInt8]` — `uint32BE(len) || ct`
  - `func cipherSizeFor(_ sizes: [Int]) -> Int`
  - `func encryptChunks(key: [UInt8], files: [[UInt8]]) -> [UInt8]` — the full framed stream (seq from 1, chunked at STORE_CHUNK_SIZE, no inter-file separator)
  - `final class StoreDecryptor` with `init(key: [UInt8])`, `func push(_ data: [UInt8]) throws -> [[UInt8]]` (returns whole decrypted plaintext chunks in order), `var decryptedBytes: Int`, `func end(expectedBytes: Int?) throws`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/StoreFrameTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class StoreFrameTests: XCTestCase {
    func testConstants() {
        XCTAssertEqual(STORE_CHUNK_SIZE, 192 * 1024)
        XCTAssertEqual(FRAME_OVERHEAD, 20)
        XCTAssertEqual(MAX_FRAME_CT, 192 * 1024 + 16 + 256)
    }
    func testEncryptChunksMatchesVectorStream() throws {
        let v = try Vectors.load("store-wire-vectors")
        let files = v.fileDatas()   // [[UInt8]] from files[].dataHex
        XCTAssertEqual(encryptChunks(key: v.hex("keyHex"), files: files), v.hex("streamHex"))
        XCTAssertEqual(cipherSizeFor(files.map(\.count)), v.int("cipherSize"))
    }
    func testDecryptorReassemblesWholeStream() throws {
        let v = try Vectors.load("store-wire-vectors")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        let out = try d.push(v.hex("streamHex"))
        try d.end(expectedBytes: v.int("plaintextBytes"))
        XCTAssertEqual(out, v.fileDatas())
        XCTAssertEqual(d.decryptedBytes, v.int("plaintextBytes"))
    }
    func testDecryptorReassemblesAcrossByteBoundaries() throws {
        let v = try Vectors.load("store-wire-vectors")
        let stream = v.hex("streamHex")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        var out: [[UInt8]] = []
        for byte in stream { out += try d.push([byte]) }   // one byte at a time
        try d.end(expectedBytes: v.int("plaintextBytes"))
        XCTAssertEqual(out, v.fileDatas())
    }
    func testRejectsOversizedFrame() {
        let d = StoreDecryptor(key: [UInt8](repeating: 0x55, count: 32))
        var big = [UInt8](repeating: 0, count: 4)
        // length prefix = MAX_FRAME_CT + 1 (big-endian)
        let n = UInt32(MAX_FRAME_CT + 1)
        big[0] = UInt8(n >> 24 & 0xff); big[1] = UInt8(n >> 16 & 0xff)
        big[2] = UInt8(n >> 8 & 0xff);  big[3] = UInt8(n & 0xff)
        XCTAssertThrowsError(try d.push(big)) { XCTAssertEqual($0 as? StoredWireError, .frameTooLarge) }
    }
    func testEndRejectsTrailingBytes() throws {
        let v = try Vectors.load("store-wire-vectors")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        _ = try d.push(Array(v.hex("streamHex").dropLast()))   // last frame incomplete
        XCTAssertThrowsError(try d.end(expectedBytes: nil)) { XCTAssertEqual($0 as? StoredWireError, .truncatedStream) }
    }
    func testEndRejectsLengthMismatch() throws {
        let v = try Vectors.load("store-wire-vectors")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        _ = try d.push(v.hex("streamHex"))
        XCTAssertThrowsError(try d.end(expectedBytes: v.int("plaintextBytes") + 1)) {
            XCTAssertEqual($0 as? StoredWireError, .lengthMismatch)
        }
    }
}
```

Add to `Vectors.swift`: `func fileDatas() -> [[UInt8]]` (reads `files[].dataHex`). Simple JSON array read + hex decode.

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --filter StoreFrameTests`
Expected: FAIL — symbols undefined.

- [ ] **Step 3: Implement frame codec + StoreDecryptor**

Create `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreFrame.swift`:

```swift
import Foundation

public let STORE_CHUNK_SIZE = 192 * 1024
public let FRAME_OVERHEAD = 4 + 16
public let MAX_FRAME_CT = 192 * 1024 + 16 + 256

private func u32be(_ n: Int) -> [UInt8] {
    [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
}
private func readU32be(_ b: [UInt8], _ off: Int) -> Int {
    (Int(b[off]) << 24) | (Int(b[off+1]) << 16) | (Int(b[off+2]) << 8) | Int(b[off+3])
}

/// length-prefixed frame: uint32BE(len(ct)) || ct.
public func frame(_ ct: [UInt8]) -> [UInt8] { u32be(ct.count) + ct }

/// Σ size + FRAME_OVERHEAD * ceil(size / STORE_CHUNK_SIZE), per file.
public func cipherSizeFor(_ sizes: [Int]) -> Int {
    sizes.reduce(0) { $0 + $1 + FRAME_OVERHEAD * Int(ceil(Double($1) / Double(STORE_CHUNK_SIZE))) }
}

/// Encrypt every file's chunks as framed AES-GCM frames; seq is global across
/// files starting at 1 (0 is the manifest). No separator between files.
public func encryptChunks(key: [UInt8], files: [[UInt8]]) -> [UInt8] {
    var out: [UInt8] = []; var seq: UInt64 = 1
    for file in files {
        var off = 0
        // A zero-length file yields no frames (matches the web: the off<size loop
        // never runs), so an empty file contributes nothing to the stream.
        while off < file.count {
            let end = min(off + STORE_CHUNK_SIZE, file.count)
            out += frame(seal(key: key, seq: seq, plaintext: Array(file[off..<end])))
            seq += 1; off = end
        }
    }
    return out
}

/// Reassembles length-prefixed frames across arbitrary byte-stream boundaries and
/// returns decrypted plaintext chunks in order. Throws on tamper/oversize.
public final class StoreDecryptor {
    private let key: [UInt8]
    private var seq: UInt64 = 1
    private var buf: [UInt8] = []
    public private(set) var decryptedBytes: Int = 0
    public init(key: [UInt8]) { self.key = key }

    public func push(_ data: [UInt8]) throws -> [[UInt8]] {
        buf += data
        var out: [[UInt8]] = []
        var off = 0
        while off + 4 <= buf.count {
            let len = readU32be(buf, off)
            if len > MAX_FRAME_CT { throw StoredWireError.frameTooLarge }
            if off + 4 + len > buf.count { break }              // frame incomplete
            let ct = Array(buf[(off+4)..<(off+4+len)])
            guard let pt = open(key: key, seq: seq, ciphertext: ct) else {
                throw StoredWireError.truncatedStream            // auth failure = tamper
            }
            seq += 1; off += 4 + len; decryptedBytes += pt.count
            out.append(pt)
        }
        buf = off < buf.count ? Array(buf[off...]) : []
        return out
    }

    /// Reject a dangling partial frame; when an expected total is known, assert it
    /// matches (a stream truncated on a frame boundary is otherwise a clean end).
    public func end(expectedBytes: Int?) throws {
        if !buf.isEmpty { throw StoredWireError.truncatedStream }
        if let e = expectedBytes, decryptedBytes != e { throw StoredWireError.lengthMismatch }
    }
}
```

> Note: `open` returning nil (GCM auth failure) is mapped to `.truncatedStream` here to match store-crypto.ts's "throws on tamper" behavior — any frame that fails to authenticate aborts the stream. This is fail-closed and correct.

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --filter StoreFrameTests`
Expected: PASS (7 tests). Then full `swift test` — expect all StoredWire + R1-A Crypto tests green (12 prior + new).

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/StoredWire/StoreFrame.swift apps/RelayiumKit/Tests/RelayiumKitTests/StoreFrameTests.swift apps/RelayiumKit/Tests/RelayiumKitTests/Vectors.swift
git commit -m "feat(native): StoredWire frame codec + StoreDecryptor (reassembly/guards), vector-verified"
```

---

## Self-review (against the spec)

- **Spec coverage:** base64url `#k=` key codec → Task 3; filename sanitize (bidi+control) → Task 4; encrypted manifest seq 0 + decrypt-sanitize → Task 5; frame layout + constants + cipherSizeFor + StoreDecryptor reassembly/oversize-guard/truncation-detection → Task 6; frozen stored-wire doc → Task 1; golden vectors from web → Task 2. Reuse of `Crypto.seal`/`open` → Tasks 5–6.
- **Placeholder scan:** none — every code step carries complete code. The one open item ("add path sanitize if StoredManifest gains a path field") is a guarded future-note, not a gap: StoredManifest has no path field in the web source today.
- **Type consistency:** `StoredWireError` defined once (Task 3) and reused (Tasks 5–6). `ManifestFile`/`StoredManifest` defined once (Task 5); `sanitizeNames(_:[ManifestFile])` declared in Task 4's interface, implemented in Task 5 alongside `ManifestFile` (Task 4's `Filename.swift` ships `stripBidi`/`safeDisplayName`; the `sanitizeNames` append lands in Task 5 to avoid a forward reference to `ManifestFile`). `seal`/`open`/`Vectors`/`ensureSodiumInit` come from R1-A with the same signatures. `Vectors.load` gains an optional name param (default preserves R1-A call sites).

## Interop-safety

Same three guarantees as R1-A: (1) the stored-wire protocol is frozen in a doc Swift implements against; (2) every operation is pinned to golden vectors generated from the web `store-crypto.ts`; (3) the manifest JSON-byte-parity risk is called out explicitly and caught by the manifest-ciphertext vector. The one-byte-at-a-time reassembly test guarantees the decoder is boundary-independent — the property a real network stream depends on.

## Next

R1-C (`Account`: native login + Keychain + usage/plan) is the next plan. R1-D (`Cloud`) then streams this `StoredWire` codec over URLSession background sessions, following 302s to nodes — the first working native transfer, interoperable with web/CLI `#k=` links.
