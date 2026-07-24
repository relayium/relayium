# Native macOS R1-A: Foundation & Crypto core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the in-repo Swift toolchain (a `RelayiumKit` Swift package + a macOS app shell that builds and launches) and ship the first RelayiumKit module — `Crypto` — proven byte-for-byte identical to the web implementation via golden vectors exported from the existing web test suite.

**Architecture:** A new in-repo `apps/` tree holds a SwiftPM package `RelayiumKit` (pure logic, later extracted per R2) and a thin macOS SwiftUI app that depends on it. The `Crypto` module wraps **libsodium** (via `swift-sodium`) for `crypto_kx` key agreement and `crypto_generichash` (BLAKE2b), plus AES-GCM with a seq-derived nonce — mirroring `web/src/lib/crypto.ts` exactly. Correctness is pinned by a shared golden-vector JSON generated from the web's libsodium so the Swift port cannot silently diverge.

**Tech Stack:** Swift 5.9+, SwiftPM, XCTest, macOS 13+ target, `swift-sodium` (libsodium), CryptoKit (AES-GCM only, optional), Node/vitest (existing) for vector generation.

## This plan's place in R1

R1 (native macOS app) is delivered as six sequential plans. This is **plan 1 of 6**. Each produces working, testable software on its own.

| Plan | Deliverable |
|---|---|
| **R1-A (this plan)** | `apps/` scaffold + `RelayiumKit` package + macOS app shell + **Crypto module** (golden-vector verified) |
| R1-B | **Wire module**: manifest + framing + resumable offsets; frozen wire-protocol spec doc; golden vectors |
| R1-C | **Signaling module**: WS client to `/signal` (code rooms, pairing, commit/reveal handshake, ICE/SDP envelopes) |
| R1-D | **Realtime module**: native WebRTC (`stasel/WebRTC`) + ACK credit-window flow control + `WireVersion`; browser↔native E2E |
| R1-E | **Cloud + Account modules**: URLSession background up/down, `#k=` stored links, 302 node-follow; native login + Keychain + usage/plan |
| R1-F | **macOS UI + distribution**: window/menu-bar/drag-drop/notifications/Universal Links; Developer ID sign + notarize + Sparkle + `.dmg`; `/apps` card flip |

## Global Constraints

- **Repo layout:** all native code lives under `apps/` at repo root. Package: `apps/RelayiumKit/`. macOS app: `apps/mac/`. Shared golden vectors: `apps/RelayiumKit/Tests/Fixtures/`.
- **Crypto parity is non-negotiable:** `crypto_kx` and all BLAKE2b (`crypto_generichash`) operations MUST go through libsodium (`swift-sodium`), never CryptoKit — CryptoKit lacks both and cannot reproduce libsodium's KDF/hash byte layout.
- **AES-GCM layout:** 12-byte nonce = `nonceFromSeq(seq)` (4 zero bytes, then big-endian high 32 bits of seq at offset 4, low 32 bits at offset 8); ciphertext is `raw_ct || 16-byte_tag` (Web Crypto / libsodium combined-mode layout).
- **Golden vectors are the source of truth:** the Swift port asserts equality against `crypto-vectors.json` generated from the web's libsodium. Regenerating vectors and updating both sides is the only sanctioned way to change the crypto wire.
- **Min platforms:** macOS 13 (Ventura), Swift tools 5.9, Xcode 15.
- **Commit cadence:** commit after every green test cycle. English commit messages.

---

## File structure (R1-A)

- Create: `apps/RelayiumKit/Package.swift` — SwiftPM manifest; product `RelayiumKit`, dep `swift-sodium`, test target `RelayiumKitTests`.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Sodium+Ready.swift` — libsodium init guard.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/KeyAgreement.swift` — keypair + `deriveSession` (crypto_kx).
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Aead.swift` — `seal`/`open` (AES-GCM, seq nonce).
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Sas.swift` — `sas`, `commitKey`, `verifyCommit`, `randomNonce`.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/ResumeAuth.swift` — `deriveResumeAuth`, `signResume`, `verifyResume`.
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/CryptoVectorTests.swift` — golden-vector assertions.
- Create: `apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json` — generated fixture (checked in).
- Create: `web/scripts/gen-crypto-vectors.mjs` — deterministic vector generator (web libsodium).
- Create: `apps/mac/` — Xcode SwiftUI app shell depending on the local `RelayiumKit` package.
- Create: `docs/protocol/relayium-crypto-v1.md` — frozen crypto-layer protocol section.
- Create: `apps/README.md` — how to build/test the native tree.

---

## Task 1: Freeze the crypto layer into a protocol spec

**Files:**
- Create: `docs/protocol/relayium-crypto-v1.md`

**Interfaces:**
- Produces: the authoritative description Tasks 2–7 implement against. No code symbols.

- [ ] **Step 1: Write the crypto-layer spec**

Create `docs/protocol/relayium-crypto-v1.md` documenting, with exact primitives and byte layouts taken from `web/src/lib/crypto.ts`:

```markdown
# Relayium crypto layer v1 (authoritative)

Source of truth for the Swift port. Any change requires regenerating
`apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json` and updating web + Swift together.

## Key agreement
- Primitive: libsodium `crypto_kx` (X25519 + BLAKE2b KDF).
- `generateKeyPair()` → `crypto_kx_keypair()` (32-byte public, 32-byte secret).
- `deriveSession(role, self, peerPublic)`:
  - role "initiator" → `crypto_kx_client_session_keys(selfPub, selfSec, peerPub)` → (rx, tx)
  - role "responder" → `crypto_kx_server_session_keys(selfPub, selfSec, peerPub)` → (rx, tx)
  - `send` key = tx (sharedTx), `recv` key = rx (sharedRx). Each 32 bytes, used as AES-256-GCM keys.

## AEAD (per-frame)
- AES-256-GCM. Key = the 32-byte send/recv session key.
- Nonce (12 bytes) = nonceFromSeq(seq): bytes[0..4)=0; bytes[4..8)=BE(uint32(floor(seq/2^32))); bytes[8..12)=BE(uint32(seq mod 2^32)).
- `seal(key,seq,pt)` → AES-GCM ciphertext with 16-byte tag appended (combined mode).
- `open(key,seq,ct)` → inverse; auth failure is a hard error.

## Commitment (commit-then-reveal, anti-MITM on the 6-digit SAS)
- COMMIT_BYTES=32, NONCE_BYTES=32.
- `randomNonce()` = 32 random bytes.
- `commitKey(pub,nonce)` = BLAKE2b-256(pub || nonce) via `crypto_generichash(32, pub||nonce)`.
- `verifyCommit(commit,pub,nonce)` = constant-time equal to commitKey; false on length mismatch.

## SAS (6-digit)
- Inputs: the two raw public keys. Sort ascending (bytewise) → (a,b).
- digest = `crypto_generichash(8, a||b)` (unkeyed BLAKE2b, 8-byte output).
- num = (BE uint32 at offset 0) XOR (BE uint32 at offset 4), unsigned.
- SAS = (num mod 1_000_000) as zero-padded 6-digit decimal string.

## Resume-auth key (HMAC key both sides derive identically)
- Domain = ASCII "relayium-resume-auth-v1\0" (24 bytes incl. trailing NUL).
- Sort session (tx,rx) bytewise ascending → (a,b).
- raw = `crypto_generichash(32, domain || a || b)`.
- Used as HMAC-SHA-256 key.
- `signResume(key,payload)` = base64(HMAC-SHA256(key, utf8(payload))).
- `verifyResume(key,payload,mac)` = constant-time verify; absent/malformed mac = false.
```

- [ ] **Step 2: Commit**

```bash
git add docs/protocol/relayium-crypto-v1.md
git commit -m "docs(protocol): freeze relayium crypto layer v1 for the Swift port"
```

---

## Task 2: Generate golden crypto vectors from the web libsodium

**Files:**
- Create: `web/scripts/gen-crypto-vectors.mjs`
- Create: `apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json`

**Interfaces:**
- Produces: `crypto-vectors.json` with fixed keypairs and expected outputs consumed by Task 3–7 Swift tests. Shape:
  ```json
  {
    "alice": {"pub": "<hex32>", "sec": "<hex32>"},
    "bob":   {"pub": "<hex32>", "sec": "<hex32>"},
    "session": {"aliceSend": "<hex32>", "aliceRecv": "<hex32>", "bobSend": "<hex32>", "bobRecv": "<hex32>"},
    "sas": "<6 digits>",
    "commit": {"nonce": "<hex32>", "value": "<hex32>"},
    "aead": {"keyHex": "<hex32>", "seq": 5, "ptHex": "<hex>", "ctHex": "<hex>"},
    "resumeAuth": {"keyHex": "<hex32>", "payload": "resume:offset=1024", "mac": "<base64>"}
  }
  ```

- [ ] **Step 1: Write the generator**

Create `web/scripts/gen-crypto-vectors.mjs`. It uses the same `libsodium-wrappers` the app uses, with **fixed** keypairs so the output is deterministic:

```js
import _sodium from "libsodium-wrappers";
import { writeFileSync } from "node:fs";

await _sodium.ready;
const s = _sodium;
const hex = (u) => s.to_hex(u);
const fromHex = (h) => s.from_hex(h);

// Fixed 32-byte secrets → deterministic crypto_kx keypairs via seed.
const aliceSeed = fromHex("11".repeat(32));
const bobSeed = fromHex("22".repeat(32));
const alice = s.crypto_kx_seed_keypair(aliceSeed);
const bob = s.crypto_kx_seed_keypair(bobSeed);

// Byte-wise comparator matching web/src/lib/crypto.ts exactly (memcmp/lexicographic
// semantics, byte 0 first). NOTE: do NOT use libsodium's s.compare here — that is
// sodium_compare, which treats the bytes as a LITTLE-endian number (last byte most
// significant) and does not match crypto.ts's ordering.
function compareBytes(x, y) {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

// role initiator = client; responder = server. Alice initiates.
const aliceK = s.crypto_kx_client_session_keys(alice.publicKey, alice.privateKey, bob.publicKey);
const bobK = s.crypto_kx_server_session_keys(bob.publicKey, bob.privateKey, alice.publicKey);

// SAS (sort raw pubs, generichash 8)
const sasOf = (x, y) => {
  const [a, b] = compareBytes(x, y) <= 0 ? [x, y] : [y, x];
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0); combined.set(b, a.length);
  const d = s.crypto_generichash(8, combined, null);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const num = (dv.getUint32(0) ^ dv.getUint32(4)) >>> 0;
  return (num % 1_000_000).toString().padStart(6, "0");
};

// commitment
const nonce = fromHex("33".repeat(32));
const commitInput = new Uint8Array(alice.publicKey.length + nonce.length);
commitInput.set(alice.publicKey, 0); commitInput.set(nonce, alice.publicKey.length);
const commit = s.crypto_generichash(32, commitInput, null);

// AEAD via Web Crypto AES-GCM with seq nonce (matches crypto.ts seal)
const keyRaw = fromHex("44".repeat(32));
const seq = 5;
const nonceFromSeq = (n) => {
  const b = new Uint8Array(12);
  const dv = new DataView(b.buffer);
  dv.setUint32(4, Math.floor(n / 2 ** 32)); dv.setUint32(8, n >>> 0);
  return b;
};
const pt = new TextEncoder().encode("relayium frame payload");
const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceFromSeq(seq) }, key, pt));

// resume-auth key + mac
const DOMAIN = new TextEncoder().encode("relayium-resume-auth-v1\0");
const [ra, rb] = compareBytes(aliceK.sharedTx, aliceK.sharedRx) <= 0
  ? [aliceK.sharedTx, aliceK.sharedRx] : [aliceK.sharedRx, aliceK.sharedTx];
const raInput = new Uint8Array(DOMAIN.length + ra.length + rb.length);
raInput.set(DOMAIN, 0); raInput.set(ra, DOMAIN.length); raInput.set(rb, DOMAIN.length + ra.length);
const raRaw = s.crypto_generichash(32, raInput, null);
const payload = "resume:offset=1024";
const hkey = await crypto.subtle.importKey("raw", raRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const macBuf = new Uint8Array(await crypto.subtle.sign("HMAC", hkey, new TextEncoder().encode(payload)));
const mac = btoa(String.fromCharCode(...macBuf));

const out = {
  alice: { pub: hex(alice.publicKey), sec: hex(alice.privateKey) },
  bob: { pub: hex(bob.publicKey), sec: hex(bob.privateKey) },
  session: { aliceSend: hex(aliceK.sharedTx), aliceRecv: hex(aliceK.sharedRx), bobSend: hex(bobK.sharedTx), bobRecv: hex(bobK.sharedRx) },
  sas: sasOf(alice.publicKey, bob.publicKey),
  commit: { nonce: hex(nonce), value: hex(commit) },
  aead: { keyHex: hex(keyRaw), seq, ptHex: hex(pt), ctHex: hex(ct) },
  resumeAuth: { keyHex: hex(raRaw), payload, mac },
};
writeFileSync("../apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote crypto-vectors.json");
```

- [ ] **Step 2: Run the generator**

Run (from `web/`): `mkdir -p ../apps/RelayiumKit/Tests/Fixtures && node scripts/gen-crypto-vectors.mjs`
Expected: prints `wrote crypto-vectors.json`; the JSON exists with non-empty hex fields.

> Cross-check invariant (sanity, not a code step): `session.aliceSend` MUST equal `session.bobRecv`, and `session.aliceRecv` MUST equal `session.bobSend` (crypto_kx mirror property). If not, the generator is wrong — fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add web/scripts/gen-crypto-vectors.mjs apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json
git commit -m "test(native): generate golden crypto vectors from web libsodium"
```

---

## Task 3: RelayiumKit package + libsodium init + macOS app shell

**Files:**
- Create: `apps/RelayiumKit/Package.swift`
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Sodium+Ready.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/SodiumReadyTests.swift`
- Create: `apps/README.md`
- Create: `apps/mac/` (Xcode project referencing the local package)

**Interfaces:**
- Produces: `RelayiumKit.sodiumReady() -> Bool` (true once libsodium initialised); `Sodium` instance accessor `RelayiumKit.sodium` for other modules.

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/SodiumReadyTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class SodiumReadyTests: XCTestCase {
    func testSodiumInitialises() {
        XCTAssertTrue(RelayiumKit.sodiumReady())
    }
}
```

- [ ] **Step 2: Write the package manifest**

Create `apps/RelayiumKit/Package.swift`:

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RelayiumKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "RelayiumKit", targets: ["RelayiumKit"])],
    dependencies: [
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1"),
    ],
    targets: [
        .target(name: "RelayiumKit", dependencies: [.product(name: "Sodium", package: "swift-sodium")]),
        .testTarget(name: "RelayiumKitTests", dependencies: ["RelayiumKit"],
                    resources: [.copy("../Fixtures/crypto-vectors.json")]),
    ]
)
```

- [ ] **Step 3: Write the init shim**

Create `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Sodium+Ready.swift`:

```swift
import Foundation
import Sodium

/// Shared libsodium handle. swift-sodium initialises libsodium in its own
/// initialiser, so constructing `Sodium()` is the readiness gate.
public let sodium = Sodium()

/// True once libsodium is usable. A trivial op that would fail pre-init.
public func sodiumReady() -> Bool {
    return sodium.utils.hex2bin("00") != nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/RelayiumKit/`): `swift test --filter SodiumReadyTests`
Expected: PASS (1 test). If `swift-sodium` fails to resolve, confirm network + that the pinned version exists.

- [ ] **Step 5: Create the macOS app shell**

In Xcode: File → New → Project → macOS App (SwiftUI, name `Relayium`, bundle id `com.relayium.mac`), save under `apps/mac/`. Add the local package: File → Add Package Dependencies → Add Local → select `apps/RelayiumKit`. In `RelayiumApp`'s `ContentView`, render `Text(RelayiumKit.sodiumReady() ? "core ready" : "core FAILED")`. Build & Run — a window shows "core ready".

- [ ] **Step 6: Write apps/README.md**

Create `apps/README.md`:

```markdown
# Relayium native apps

- `RelayiumKit/` — pure-logic Swift package (transport, signaling, crypto, wire). Test: `cd RelayiumKit && swift test`.
- `mac/` — macOS SwiftUI app (`com.relayium.mac`), depends on the local RelayiumKit package.

Golden crypto vectors live in `RelayiumKit/Tests/Fixtures/crypto-vectors.json`,
generated by `web/scripts/gen-crypto-vectors.mjs`. Regenerate on any crypto change.
```

- [ ] **Step 7: Commit**

```bash
git add apps/
git commit -m "feat(native): RelayiumKit package + libsodium init + macOS app shell"
```

---

## Task 4: Crypto — key agreement (crypto_kx)

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/KeyAgreement.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/KeyAgreementTests.swift`

**Interfaces:**
- Consumes: `sodium` (Task 3); `crypto-vectors.json`.
- Produces:
  - `struct KeyPair { public let publicKey: [UInt8]; public let secretKey: [UInt8] }`
  - `enum Role { case initiator, responder }`
  - `struct SessionKeys { public let send: [UInt8]; public let recv: [UInt8] }`
  - `func generateKeyPair() -> KeyPair`
  - `func deriveSession(role: Role, self selfKeys: KeyPair, peerPublic: [UInt8]) -> SessionKeys`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/KeyAgreementTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class KeyAgreementTests: XCTestCase {
    func testDeriveSessionMatchesVectors() throws {
        let v = try Vectors.load()
        let alice = KeyPair(publicKey: v.hex("alice.pub"), secretKey: v.hex("alice.sec"))
        let bobPub = v.hex("bob.pub")
        let keys = deriveSession(role: .initiator, self: alice, peerPublic: bobPub)
        XCTAssertEqual(keys.send, v.hex("session.aliceSend"))
        XCTAssertEqual(keys.recv, v.hex("session.aliceRecv"))
    }
}
```

- [ ] **Step 2: Add the vector loader helper**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/Vectors.swift`:

```swift
import Foundation
import XCTest

struct Vectors {
    let json: [String: Any]
    static func load() throws -> Vectors {
        let url = Bundle.module.url(forResource: "crypto-vectors", withExtension: "json")!
        let data = try Data(contentsOf: url)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return Vectors(json: obj)
    }
    /// Dot-path lookup returning decoded hex bytes.
    func hex(_ path: String) -> [UInt8] { hexString(path).hexBytes }
    func str(_ path: String) -> String {
        var node: Any = json
        for k in path.split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        return node as! String
    }
    func int(_ path: String) -> Int {
        var node: Any = json
        for k in path.split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        return node as! Int
    }
    private func hexString(_ path: String) -> String { str(path) }
}

extension String {
    var hexBytes: [UInt8] {
        var out = [UInt8](); var i = startIndex
        while i < endIndex {
            let j = index(i, offsetBy: 2)
            out.append(UInt8(self[i..<j], radix: 16)!); i = j
        }
        return out
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `swift test --filter KeyAgreementTests`
Expected: FAIL — `deriveSession`/`KeyPair` not defined.

- [ ] **Step 4: Implement key agreement**

Create `apps/RelayiumKit/Sources/RelayiumKit/Crypto/KeyAgreement.swift`:

```swift
import Foundation
import Sodium
import Clibsodium

public struct KeyPair {
    public let publicKey: [UInt8]
    public let secretKey: [UInt8]
    public init(publicKey: [UInt8], secretKey: [UInt8]) {
        self.publicKey = publicKey; self.secretKey = secretKey
    }
}

public enum Role { case initiator, responder }

public struct SessionKeys {
    public let send: [UInt8]  // sharedTx
    public let recv: [UInt8]  // sharedRx
}

public func generateKeyPair() -> KeyPair {
    var pk = [UInt8](repeating: 0, count: Int(crypto_kx_PUBLICKEYBYTES))
    var sk = [UInt8](repeating: 0, count: Int(crypto_kx_SECRETKEYBYTES))
    crypto_kx_keypair(&pk, &sk)
    return KeyPair(publicKey: pk, secretKey: sk)
}

public func deriveSession(role: Role, self selfKeys: KeyPair, peerPublic: [UInt8]) -> SessionKeys {
    var rx = [UInt8](repeating: 0, count: Int(crypto_kx_SESSIONKEYBYTES))
    var tx = [UInt8](repeating: 0, count: Int(crypto_kx_SESSIONKEYBYTES))
    switch role {
    case .initiator:
        crypto_kx_client_session_keys(&rx, &tx, selfKeys.publicKey, selfKeys.secretKey, peerPublic)
    case .responder:
        crypto_kx_server_session_keys(&rx, &tx, selfKeys.publicKey, selfKeys.secretKey, peerPublic)
    }
    return SessionKeys(send: tx, recv: rx)
}
```

> Note: `Clibsodium` is re-exported by `swift-sodium`; if the C symbols aren't visible, add `import Clibsodium` (already above) and confirm the module map. The web `deriveSession` maps `send = sharedTx`, `recv = sharedRx` — mirror it exactly.

- [ ] **Step 5: Run the test to verify it passes**

Run: `swift test --filter KeyAgreementTests`
Expected: PASS. Cross-check: swapping `.initiator`↔`.responder` would flip send/recv and fail — confirms role mapping is real.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Crypto/KeyAgreement.swift apps/RelayiumKit/Tests/RelayiumKitTests/
git commit -m "feat(native): RelayiumKit Crypto key agreement (crypto_kx), vector-verified"
```

---

## Task 5: Crypto — AEAD seal/open (AES-GCM, seq nonce)

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Aead.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/AeadTests.swift`

**Interfaces:**
- Consumes: `crypto-vectors.json`.
- Produces:
  - `func nonceFromSeq(_ seq: UInt64) -> [UInt8]` (12 bytes)
  - `func seal(key: [UInt8], seq: UInt64, plaintext: [UInt8]) -> [UInt8]`
  - `func open(key: [UInt8], seq: UInt64, ciphertext: [UInt8]) -> [UInt8]?` (nil on auth failure)

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/AeadTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class AeadTests: XCTestCase {
    func testSealMatchesVector() throws {
        let v = try Vectors.load()
        let key = v.hex("aead.keyHex")
        let seq = UInt64(v.int("aead.seq"))
        let pt = v.hex("aead.ptHex")
        XCTAssertEqual(seal(key: key, seq: seq, plaintext: pt), v.hex("aead.ctHex"))
    }
    func testRoundTrip() throws {
        let v = try Vectors.load()
        let key = v.hex("aead.keyHex")
        let ct = v.hex("aead.ctHex")
        XCTAssertEqual(open(key: key, seq: 5, ciphertext: ct), v.hex("aead.ptHex"))
        XCTAssertNil(open(key: key, seq: 6, ciphertext: ct)) // wrong seq → auth fail
    }
    func testNonceLayout() {
        // seq = 0x0000000100000002 → bytes 4..8 = 00 00 00 01, bytes 8..12 = 00 00 00 02
        let n = nonceFromSeq(0x0000_0001_0000_0002)
        XCTAssertEqual(n, [0,0,0,0, 0,0,0,1, 0,0,0,2])
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --filter AeadTests`
Expected: FAIL — `seal`/`open`/`nonceFromSeq` not defined.

- [ ] **Step 3: Implement AEAD**

Create `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Aead.swift`:

```swift
import Foundation
import Clibsodium

/// 12-byte nonce derived from the frame sequence number. Mirrors crypto.ts
/// nonceFromSeq: 4 zero bytes, then BE high-32 of seq, then BE low-32.
public func nonceFromSeq(_ seq: UInt64) -> [UInt8] {
    var n = [UInt8](repeating: 0, count: 12)
    let hi = UInt32(truncatingIfNeeded: seq >> 32)
    let lo = UInt32(truncatingIfNeeded: seq)
    n[4] = UInt8(hi >> 24 & 0xff); n[5] = UInt8(hi >> 16 & 0xff)
    n[6] = UInt8(hi >> 8 & 0xff);  n[7] = UInt8(hi & 0xff)
    n[8] = UInt8(lo >> 24 & 0xff); n[9] = UInt8(lo >> 16 & 0xff)
    n[10] = UInt8(lo >> 8 & 0xff); n[11] = UInt8(lo & 0xff)
    return n
}

/// AES-256-GCM, combined mode (ciphertext has the 16-byte tag appended),
/// matching Web Crypto's AES-GCM output layout.
public func seal(key: [UInt8], seq: UInt64, plaintext: [UInt8]) -> [UInt8] {
    precondition(crypto_aead_aes256gcm_is_available() == 1, "AES-GCM HW not available")
    let nonce = nonceFromSeq(seq)
    var ct = [UInt8](repeating: 0, count: plaintext.count + Int(crypto_aead_aes256gcm_ABYTES))
    var ctLen: UInt64 = 0
    _ = crypto_aead_aes256gcm_encrypt(&ct, &ctLen, plaintext, UInt64(plaintext.count),
                                      nil, 0, nil, nonce, key)
    return Array(ct.prefix(Int(ctLen)))
}

public func open(key: [UInt8], seq: UInt64, ciphertext: [UInt8]) -> [UInt8]? {
    let nonce = nonceFromSeq(seq)
    guard ciphertext.count >= Int(crypto_aead_aes256gcm_ABYTES) else { return nil }
    var pt = [UInt8](repeating: 0, count: ciphertext.count - Int(crypto_aead_aes256gcm_ABYTES))
    var ptLen: UInt64 = 0
    let rc = crypto_aead_aes256gcm_decrypt(&pt, &ptLen, nil, ciphertext, UInt64(ciphertext.count),
                                           nil, 0, nonce, key)
    return rc == 0 ? Array(pt.prefix(Int(ptLen))) : nil
}
```

> Web Crypto AES-GCM and libsodium `crypto_aead_aes256gcm` both output `ct || tag` with a 16-byte tag and identical GCM semantics, so the vector matches. On Apple Silicon `crypto_aead_aes256gcm_is_available()` is 1. If a target lacks it, the fallback (CryptoKit `AES.GCM`) is documented in Task 5's follow-up note, but is not needed for macOS.

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --filter AeadTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Crypto/Aead.swift apps/RelayiumKit/Tests/RelayiumKitTests/AeadTests.swift
git commit -m "feat(native): RelayiumKit Crypto AEAD seal/open (AES-GCM seq nonce), vector-verified"
```

---

## Task 6: Crypto — SAS + commitment (BLAKE2b)

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Sas.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/SasTests.swift`

**Interfaces:**
- Consumes: `sodium` (Task 3); `crypto-vectors.json`.
- Produces:
  - `func genericHash(_ input: [UInt8], outputLength: Int) -> [UInt8]` (BLAKE2b, unkeyed)
  - `func sas(_ selfPub: [UInt8], _ peerPub: [UInt8]) -> String`
  - `let COMMIT_BYTES = 32`, `let NONCE_BYTES = 32`
  - `func randomNonce() -> [UInt8]`
  - `func commitKey(pub: [UInt8], nonce: [UInt8]) -> [UInt8]`
  - `func verifyCommit(commit: [UInt8], pub: [UInt8], nonce: [UInt8]) -> Bool`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/SasTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class SasTests: XCTestCase {
    func testSasMatchesVectorAndIsOrderIndependent() throws {
        let v = try Vectors.load()
        let a = v.hex("alice.pub"), b = v.hex("bob.pub")
        XCTAssertEqual(sas(a, b), v.str("sas"))
        XCTAssertEqual(sas(b, a), v.str("sas")) // order independent
    }
    func testCommitMatchesVectorAndVerifies() throws {
        let v = try Vectors.load()
        let pub = v.hex("alice.pub"), nonce = v.hex("commit.nonce")
        let c = commitKey(pub: pub, nonce: nonce)
        XCTAssertEqual(c, v.hex("commit.value"))
        XCTAssertTrue(verifyCommit(commit: c, pub: pub, nonce: nonce))
        XCTAssertFalse(verifyCommit(commit: Array(c.dropLast()), pub: pub, nonce: nonce))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --filter SasTests`
Expected: FAIL — symbols not defined.

- [ ] **Step 3: Implement SAS + commitment**

Create `apps/RelayiumKit/Sources/RelayiumKit/Crypto/Sas.swift`:

```swift
import Foundation
import Clibsodium

public let COMMIT_BYTES = 32
public let NONCE_BYTES = 32

/// Unkeyed BLAKE2b = libsodium crypto_generichash.
public func genericHash(_ input: [UInt8], outputLength: Int) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: outputLength)
    _ = crypto_generichash(&out, outputLength, input, UInt64(input.count), nil, 0)
    return out
}

private func bytewiseLE(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    for i in 0..<Swift.min(a.count, b.count) { if a[i] != b[i] { return a[i] < b[i] } }
    return a.count <= b.count
}

public func sas(_ selfPub: [UInt8], _ peerPub: [UInt8]) -> String {
    let (a, b) = bytewiseLE(selfPub, peerPub) ? (selfPub, peerPub) : (peerPub, selfPub)
    let digest = genericHash(a + b, outputLength: 8)
    let hi = UInt32(digest[0]) << 24 | UInt32(digest[1]) << 16 | UInt32(digest[2]) << 8 | UInt32(digest[3])
    let lo = UInt32(digest[4]) << 24 | UInt32(digest[5]) << 16 | UInt32(digest[6]) << 8 | UInt32(digest[7])
    let num = hi ^ lo
    return String(format: "%06u", num % 1_000_000)
}

public func randomNonce() -> [UInt8] {
    var n = [UInt8](repeating: 0, count: NONCE_BYTES)
    randombytes_buf(&n, NONCE_BYTES)
    return n
}

public func commitKey(pub: [UInt8], nonce: [UInt8]) -> [UInt8] {
    return genericHash(pub + nonce, outputLength: COMMIT_BYTES)
}

public func verifyCommit(commit: [UInt8], pub: [UInt8], nonce: [UInt8]) -> Bool {
    let expected = commitKey(pub: pub, nonce: nonce)
    guard commit.count == expected.count else { return false }
    return sodium_memcmp(commit, expected, expected.count) == 0
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --filter SasTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Crypto/Sas.swift apps/RelayiumKit/Tests/RelayiumKitTests/SasTests.swift
git commit -m "feat(native): RelayiumKit Crypto SAS + commitment (BLAKE2b), vector-verified"
```

---

## Task 7: Crypto — resume-auth key + signResume/verifyResume

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Crypto/ResumeAuth.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/ResumeAuthTests.swift`

**Interfaces:**
- Consumes: `genericHash` (Task 6); `crypto-vectors.json`.
- Produces:
  - `func deriveResumeAuth(sendKey: [UInt8], recvKey: [UInt8]) -> [UInt8]` (32-byte HMAC key)
  - `func signResume(key: [UInt8], payload: String) -> String` (base64)
  - `func verifyResume(key: [UInt8], payload: String, mac: String?) -> Bool`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/ResumeAuthTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class ResumeAuthTests: XCTestCase {
    func testDeriveAndSignMatchVectors() throws {
        let v = try Vectors.load()
        // resumeAuth.keyHex is the derived HMAC key; verify signResume reproduces the mac.
        let key = v.hex("resumeAuth.keyHex")
        let payload = v.str("resumeAuth.payload")
        XCTAssertEqual(signResume(key: key, payload: payload), v.str("resumeAuth.mac"))
        XCTAssertTrue(verifyResume(key: key, payload: payload, mac: v.str("resumeAuth.mac")))
        XCTAssertFalse(verifyResume(key: key, payload: payload, mac: nil))
        XCTAssertFalse(verifyResume(key: key, payload: payload, mac: "not-base64!!"))
    }
    func testDeriveResumeAuthIsSymmetric() throws {
        let v = try Vectors.load()
        let tx = v.hex("session.aliceSend"), rx = v.hex("session.aliceRecv")
        // both key orderings must yield the same derived key (sorted internally)
        XCTAssertEqual(deriveResumeAuth(sendKey: tx, recvKey: rx),
                       deriveResumeAuth(sendKey: rx, recvKey: tx))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --filter ResumeAuthTests`
Expected: FAIL — symbols not defined.

- [ ] **Step 3: Implement resume-auth**

Create `apps/RelayiumKit/Sources/RelayiumKit/Crypto/ResumeAuth.swift`:

```swift
import Foundation
import CryptoKit

private let RESUME_AUTH_DOMAIN = Array("relayium-resume-auth-v1\0".utf8)

private func bytewiseLE(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    for i in 0..<Swift.min(a.count, b.count) { if a[i] != b[i] { return a[i] < b[i] } }
    return a.count <= b.count
}

/// 32-byte HMAC key = BLAKE2b(domain || sorted(tx,rx)). Sorting makes both peers
/// derive the same key from their mirrored session secrets.
public func deriveResumeAuth(sendKey tx: [UInt8], recvKey rx: [UInt8]) -> [UInt8] {
    let (a, b) = bytewiseLE(tx, rx) ? (tx, rx) : (rx, tx)
    return genericHash(RESUME_AUTH_DOMAIN + a + b, outputLength: 32)
}

public func signResume(key: [UInt8], payload: String) -> String {
    let mac = HMAC<SHA256>.authenticationCode(for: Array(payload.utf8), using: SymmetricKey(data: key))
    return Data(mac).base64EncodedString()
}

public func verifyResume(key: [UInt8], payload: String, mac: String?) -> Bool {
    guard let mac, let sig = Data(base64Encoded: mac) else { return false }
    let expected = HMAC<SHA256>.authenticationCode(for: Array(payload.utf8), using: SymmetricKey(data: key))
    return Data(expected) == sig
}
```

> HMAC-SHA256 is identical across CryptoKit and Web Crypto, so using CryptoKit here is safe (unlike crypto_kx/BLAKE2b). The BLAKE2b key derivation still goes through `genericHash` (libsodium).

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --filter ResumeAuthTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite**

Run (from `apps/RelayiumKit/`): `swift test`
Expected: all tests PASS (Sodium, KeyAgreement, Aead, Sas, ResumeAuth).

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Crypto/ResumeAuth.swift apps/RelayiumKit/Tests/RelayiumKitTests/ResumeAuthTests.swift
git commit -m "feat(native): RelayiumKit Crypto resume-auth key + sign/verify, vector-verified"
```

---

## Self-review (against the spec)

- **Spec coverage (R1-A slice):** Crypto module (kx, AEAD, SAS/commit, resume-auth) → Tasks 4–7; libsodium-not-CryptoKit correction → Global Constraints + Tasks 4/6; golden-vector interop safety → Tasks 1–2 + every module test; `apps/` scaffold + macOS shell → Task 3; frozen protocol doc (crypto slice) → Task 1. Wire/Signaling/Realtime/Cloud/Account/UI/distribution are R1-B..R1-F (out of scope here, listed in the roadmap).
- **Placeholders:** none — every code step carries complete code; the one fallback note (CryptoKit AES-GCM) is explicitly "not needed for macOS".
- **Type consistency:** `KeyPair`, `Role`, `SessionKeys`, `SessionKeys.send/recv`, `genericHash`, `nonceFromSeq`, `Vectors.hex/str/int` are defined once and reused with the same signatures across tasks. `deriveResumeAuth` uses `genericHash` from Task 6 (ordering: Task 6 precedes Task 7). ✓

## Next

R1-B (Wire module + full wire-protocol freeze + golden vectors) is the next plan, written when R1-A lands green.
