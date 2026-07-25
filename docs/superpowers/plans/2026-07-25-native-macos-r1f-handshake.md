# Native macOS R1-F (part 2): Handshake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `Handshake` module to `RelayiumKit` — the commit-reveal SAS key-agreement state machine the realtime path runs over R1-E `SignalingClient` before opening the DataChannel. It reuses R1-A `Crypto` (generateKeyPair/randomNonce/commitKey/verifyCommit/deriveSession/sas) and mirrors `web/src/lib/webrtc.ts`'s `connect()` handshake, so a native peer and a browser peer agree the same session keys and show the same 6-digit SAS.

**Architecture:** `Handshake` is a pure crypto state machine with no WebRTC/network. Each side generates a crypto_kx keypair + a commitment nonce and computes `commit = BLAKE2b(pub || nonce)`. Commit is exchanged first (it rides the SDP signaling in the WebRTC glue); only after recording the peer's commit does a side reveal `(pub, nonce)`; the peer's reveal is verified against its earlier commit (mismatch = MITM, abort). Then `deriveSession(role, selfKeypair, peerPub)` yields the mirrored session keys and `sas(selfPub, peerPub)` the shared 6-digit code. It hashes RAW bytes (pub/nonce, sorted pubs) — never JSON — so no canonicalization concern. Commit/SAS byte-parity with the browser is inherited from R1-A's golden-vector-verified `commitKey`/`sas`.

**Tech Stack:** Swift 5.9+, reuses R1-A `Crypto` + R1-E `JSONValue` (to bridge commit/reveal into the signal `data`), XCTest. No new dependencies.

## This plan's place in R1

R1-F sub-plans: RealtimeWire ✓ → **Handshake (this plan)** → WebRTC glue (`stasel/WebRTC` + FLOW_WINDOW driver + `WireVersion`, drives this state machine's timing over the DataChannel/SDP) → browser↔native E2E. This is the last fully-unit-testable R1-F piece.

## Grounding (verified against `web/src/lib/webrtc.ts` `connect()` + `crypto.ts`)

- Each side: `selfKey` = crypto_kx public key (`generateKeyPair().publicKey`); `selfNonce = randomNonce()` (32 bytes); `selfCommit = base64(commitKey(selfKey, selfNonce))`.
- **Commit rides every SDP offer/answer** as `sdpExtra: {commit: selfCommit}`. `beforeSdp` records `peerCommit = unb64(msg.commit)` before handling the SDP.
- **Reveal** is a separate signal: `{reveal: {key: base64(selfKey), nonce: base64(selfNonce)}}`, sent once, guarded.
- Timing: the **initiator** reveals on receiving the answer (which carried the responder's commit) — `onAnswer: sendReveal`. The **responder** reveals only after it has verified the initiator's reveal — `afterSdp: if role==responder sendReveal`.
- `afterSdp` on a `reveal`: `verifyCommit(peerCommit, peerPub, peerNonce)`; on mismatch → hard fail ("key commitment mismatch — possible MITM"), never open. Duplicate reveals (ICE restart) are ignored (`peerKeyDelivered` guard).
- After a verified reveal: `onPeerKey(peerPub)` → `keys = deriveSession(role, selfKey, peerPub)` and `sasCode = sas(selfKey.publicKey, peerPub)` (`transfer-session.svelte.ts:225,610`). `role` is `"initiator"` (the offerer / the side that started) or `"responder"` (the answerer).
- base64 is standard (btoa/atob).

## Global Constraints

- **Reuse R1-A `Crypto` primitives** verbatim (generateKeyPair, randomNonce, commitKey, verifyCommit, deriveSession, sas) — do NOT reimplement any crypto. commit/reveal hash RAW bytes, never JSON.
- **Interop with the browser** is inherited: R1-A already golden-vector-proves `commitKey`/`sas` byte-for-byte against `crypto.ts`. This module additionally pins its commit/SAS against `crypto-vectors.json` (alice/bob keys) and self-consistency-tests a full two-party exchange.
- **Reveal only after recording the peer's commit** (the anti-MITM invariant). A reveal that verifies against no recorded commit, or mismatches, is a hard error.
- **Role → deriveSession**: `.initiator`→`crypto_kx_client_session_keys`, `.responder`→`crypto_kx_server_session_keys` (already in R1-A). The two peers MUST use opposite roles so their keys mirror.
- **Signal `data` bridge**: commit is `{"commit": <b64>}`, reveal is `{"reveal": {"key": <b64>, "nonce": <b64>}}` inside the R1-E signal `data` JSONValue (merged with SDP fields by the WebRTC glue). base64 STANDARD.
- **Min platforms / cadence**: macOS 13, Swift 5.9; commit after every green test cycle; English commit messages.

---

## File structure (R1-F Handshake)

- Create: `apps/RelayiumKit/Sources/RelayiumKit/Handshake/HandshakeMessage.swift` — `Reveal`, and JSONValue bridge (build/parse commit + reveal fields).
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Handshake/HandshakeState.swift` — the state machine.
- Create tests: `HandshakeMessageTests.swift`, `HandshakeStateTests.swift`.
- Create: `docs/protocol/relayium-handshake-v1.md`.

---

## Task 1: Freeze the handshake protocol doc

**Files:** Create `docs/protocol/relayium-handshake-v1.md`

- [ ] **Step 1: Write the spec** — from `webrtc.ts`/`crypto.ts`:

```markdown
# Relayium realtime commit-reveal SAS handshake v1 (authoritative)

Run over the signaling channel before the DataChannel opens. Anchors each peer's
crypto_kx public key with a commit-then-reveal so a malicious signaling relay
cannot MITM the 6-digit SAS. Hashes raw bytes only (never JSON).

## Per side
- keypair = crypto_kx keypair (X25519); selfPub = 32-byte public key.
- selfNonce = 32 random bytes.
- selfCommit = BLAKE2b-256(selfPub || selfNonce)  (R1-A commitKey), base64.

## Wire (inside the signal `data`)
- Commit: `{"commit": <base64 selfCommit>}` — attached to every SDP offer/answer.
- Reveal: `{"reveal": {"key": <base64 selfPub>, "nonce": <base64 selfNonce>}}` — a
  separate signal, sent once.
- base64 is standard (RFC 4648, with padding — btoa/atob).

## Sequence
1. Both compute selfCommit. The initiator sends an SDP offer carrying its commit;
   the responder, on receiving it, records peerCommit and sends its SDP answer
   carrying its own commit.
2. Record the peer's commit (from the SDP-carried `commit`) BEFORE handling a reveal.
3. The initiator reveals once it has the responder's commit (i.e. on the answer).
   The responder reveals only after it has verified the initiator's reveal.
4. On a peer reveal: verifyCommit(peerCommit, peerPub, peerNonce) (R1-A). Mismatch,
   or no recorded peerCommit, is a hard error ("possible MITM") — never open the
   channel. Duplicate reveals (ICE restart) are ignored.
5. After a verified reveal, both sides derive:
   - keys = deriveSession(role, selfKeypair, peerPub)  — role initiator→client,
     responder→server (crypto_kx); the two roles mirror so one's send == other's recv.
   - sas = sas(selfPub, peerPub)  — order-independent 6-digit code; identical on
     both sides; the user compares it out of band.

## Roles
- initiator = the side that started the connection (sends the SDP offer).
- responder = the side that answers. They MUST take opposite roles.
```

- [ ] **Step 2: Commit** — `git add docs/protocol/relayium-handshake-v1.md && git commit -m "docs(protocol): freeze relayium commit-reveal SAS handshake v1"`

---

## Task 2: Handshake messages — Reveal + JSONValue bridge

**Files:** Create `apps/RelayiumKit/Sources/RelayiumKit/Handshake/HandshakeMessage.swift` + `HandshakeMessageTests.swift`

**Interfaces:**
- `struct Reveal: Codable, Equatable { let key: String; let nonce: String }` (base64)
- `func commitField(_ b64: String) -> JSONValue` → `.object(["commit": .string(b64)])`
- `func revealField(_ r: Reveal) -> JSONValue` → `.object(["reveal": .object(["key": .string(r.key), "nonce": .string(r.nonce)])])`
- `func peerCommit(from data: JSONValue) -> String?` — the `commit` string if present
- `func peerReveal(from data: JSONValue) -> Reveal?` — the `reveal{key,nonce}` if present and well-formed

- [ ] **Step 1: failing test** `HandshakeMessageTests.swift`:
```swift
import XCTest
@testable import RelayiumKit
final class HandshakeMessageTests: XCTestCase {
    func testCommitFieldAndParse() {
        let j = commitField("Q29tbWl0")
        XCTAssertEqual(peerCommit(from: j), "Q29tbWl0")
        XCTAssertNil(peerReveal(from: j))
    }
    func testRevealFieldAndParse() {
        let r = Reveal(key: "S2V5", nonce: "Tm9uY2U")
        let j = revealField(r)
        XCTAssertEqual(peerReveal(from: j), r)
        XCTAssertNil(peerCommit(from: j))
    }
    func testParseIgnoresUnrelated() {
        let sdpOnly = JSONValue.object(["sdp": .string("v=0")])
        XCTAssertNil(peerCommit(from: sdpOnly))
        XCTAssertNil(peerReveal(from: sdpOnly))
    }
    func testParseMalformedReveal() {
        let bad = JSONValue.object(["reveal": .object(["key": .string("k")])])  // no nonce
        XCTAssertNil(peerReveal(from: bad))
    }
}
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** `HandshakeMessage.swift`:
```swift
import Foundation

public struct Reveal: Codable, Equatable {
    public let key: String   // base64 public key
    public let nonce: String // base64 nonce
    public init(key: String, nonce: String) { self.key = key; self.nonce = nonce }
}

public func commitField(_ b64: String) -> JSONValue { .object(["commit": .string(b64)]) }
public func revealField(_ r: Reveal) -> JSONValue {
    .object(["reveal": .object(["key": .string(r.key), "nonce": .string(r.nonce)])])
}
public func peerCommit(from data: JSONValue) -> String? {
    guard case let .object(o) = data, case let .string(c)? = o["commit"] else { return nil }
    return c
}
public func peerReveal(from data: JSONValue) -> Reveal? {
    guard case let .object(o) = data, case let .object(r)? = o["reveal"],
          case let .string(k)? = r["key"], case let .string(n)? = r["nonce"] else { return nil }
    return Reveal(key: k, nonce: n)
}
```
> Note: these are field-level (commit/reveal live alongside `sdp` in the same `data` object). The WebRTC glue merges commitField output into its SDP signal; here they're standalone for unit testing.
- [ ] **Step 4: run → PASS.** Full `swift test` green.
- [ ] **Step 5: commit** `feat(native): Handshake commit/reveal message fields + JSONValue bridge`

---

## Task 3: HandshakeState machine

**Files:** Create `apps/RelayiumKit/Sources/RelayiumKit/Handshake/HandshakeState.swift` + `HandshakeStateTests.swift`

**Interfaces:**
- `enum HandshakeError: Error, Equatable { case mitm, noCommitRecorded, badBase64 }`
- `struct HandshakeResult: Equatable { let keys: SessionKeys; let sas: String }`
- `final class HandshakeState`:
  - `init(role: Role)` — generates keypair + nonce; computes `selfCommitBase64`.
  - `var selfCommitBase64: String { get }`
  - `func recordPeerCommit(_ b64: String) throws` — decodes + stores (throws `.badBase64`).
  - `func reveal() -> Reveal` — `{key: base64(selfPub), nonce: base64(selfNonce)}`.
  - `func verifyPeerReveal(_ r: Reveal) throws -> HandshakeResult` — decode, require a recorded peer commit, `verifyCommit` (else `.mitm`), then `deriveSession(role,…)` + `sas(...)`.

- [ ] **Step 1: failing test** `HandshakeStateTests.swift` — the two-party interop proof:
```swift
import XCTest
@testable import RelayiumKit
final class HandshakeStateTests: XCTestCase {
    func testTwoPartyDerivesMirroredKeysAndMatchingSAS() throws {
        let a = HandshakeState(role: .initiator)
        let b = HandshakeState(role: .responder)
        // exchange commits
        try a.recordPeerCommit(b.selfCommitBase64)
        try b.recordPeerCommit(a.selfCommitBase64)
        // exchange + verify reveals
        let ra = try b.verifyPeerReveal(a.reveal())   // b verifies a's reveal
        let rb = try a.verifyPeerReveal(b.reveal())   // a verifies b's reveal
        // same 6-digit SAS on both sides
        XCTAssertEqual(ra.sas, rb.sas)
        XCTAssertEqual(ra.sas.count, 6)
        // mirrored session keys: a.send == b.recv and a.recv == b.send
        XCTAssertEqual(rb.keys.send, ra.keys.recv)
        XCTAssertEqual(rb.keys.recv, ra.keys.send)
    }
    func testMitmRevealRejected() throws {
        let a = HandshakeState(role: .initiator)
        let b = HandshakeState(role: .responder)
        try b.recordPeerCommit(a.selfCommitBase64)
        // a "reveals" a DIFFERENT key than it committed to (a middleman swapped it)
        var forged = a.reveal()
        let evil = HandshakeState(role: .initiator)     // some other keypair
        forged = Reveal(key: evil.reveal().key, nonce: forged.nonce)
        XCTAssertThrowsError(try b.verifyPeerReveal(forged)) { XCTAssertEqual($0 as? HandshakeError, .mitm) }
    }
    func testRevealWithoutRecordedCommitThrows() {
        let a = HandshakeState(role: .initiator)
        let b = HandshakeState(role: .responder)
        XCTAssertThrowsError(try b.verifyPeerReveal(a.reveal())) { XCTAssertEqual($0 as? HandshakeError, .noCommitRecorded) }
    }
    func testCommitAndSASMatchCryptoVectors() throws {
        // Reuse R1-A crypto-vectors: commitKey(alicePub, commit.nonce) == commit.value; sas(alice,bob)==sas.
        let v = try Vectors.load()   // crypto-vectors
        XCTAssertEqual(commitKey(pub: v.hex("alice.pub"), nonce: v.hex("commit.nonce")).base64EncodedString(),
                       Data(v.hex("commit.value")).base64EncodedString())
        XCTAssertEqual(sas(v.hex("alice.pub"), v.hex("bob.pub")), v.str("sas"))
    }
}
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** `HandshakeState.swift`:
```swift
import Foundation

public enum HandshakeError: Error, Equatable { case mitm, noCommitRecorded, badBase64, invalidKey }
public struct HandshakeResult: Equatable {
    public let keys: SessionKeys
    public let sas: String
}

public final class HandshakeState {
    private let role: Role
    private let keypair: KeyPair
    private let nonce: [UInt8]
    private var peerCommit: [UInt8]?
    public let selfCommitBase64: String

    public init(role: Role) {
        self.role = role
        self.keypair = generateKeyPair()
        self.nonce = randomNonce()
        self.selfCommitBase64 = Data(commitKey(pub: keypair.publicKey, nonce: nonce)).base64EncodedString()
    }

    public func recordPeerCommit(_ b64: String) throws {
        guard let d = Data(base64Encoded: b64) else { throw HandshakeError.badBase64 }
        peerCommit = [UInt8](d)
    }

    public func reveal() -> Reveal {
        Reveal(key: Data(keypair.publicKey).base64EncodedString(),
               nonce: Data(nonce).base64EncodedString())
    }

    public func verifyPeerReveal(_ r: Reveal) throws -> HandshakeResult {
        guard let commit = peerCommit else { throw HandshakeError.noCommitRecorded }
        guard let keyD = Data(base64Encoded: r.key), let nonceD = Data(base64Encoded: r.nonce) else {
            throw HandshakeError.badBase64
        }
        let peerPub = [UInt8](keyD)
        let peerNonce = [UInt8](nonceD)
        // verifyCommit only proves BLAKE2b(peerPub||nonce)==commit; it does not
        // constrain peerPub.count. Without this guard a malicious peer can commit
        // to a SHORT key and reveal it, passing verifyCommit — then deriveSession's
        // libsodium call reads a FIXED 32 bytes from peerPub, an out-of-bounds
        // native read on a short buffer (confirmed with AddressSanitizer: a
        // heap-buffer-overflow in blake2b_update, i.e. even verifyCommit's own
        // hashing over a short peerPub overflows first). Reject before either.
        guard peerPub.count == 32, peerNonce.count == 32 else { throw HandshakeError.invalidKey }
        guard verifyCommit(commit: commit, pub: peerPub, nonce: peerNonce) else {
            throw HandshakeError.mitm
        }
        let keys = try deriveSession(role: role, self: keypair, peerPublic: peerPub)
        return HandshakeResult(keys: keys, sas: sas(keypair.publicKey, peerPub))
    }
}
```
> **Hardening note (post-review):** `deriveSession` (`KeyAgreement.swift`) also gained its own
> `guard peerPublic.count == Int(crypto_kx_PUBLICKEYBYTES) else { throw CryptoError.keyAgreementFailed }`
> at the top, ahead of the `crypto_kx_client_session_keys`/`crypto_kx_server_session_keys` C calls.
> That's the real boundary to unsafe C, so it's guarded there too for every caller (including the
> future Realtime module), independent of whether `HandshakeState` already checked. Belt-and-suspenders,
> not a substitute for the `HandshakeState` guard above (which fires first and gives the more specific
> `.invalidKey` error instead of `.keyAgreementFailed`).
> `SessionKeys` (R1-A) is `Equatable`? If not, the mirrored-keys assertions compare `.send`/`.recv` arrays directly (they are `[UInt8]`), which the test already does — no need to make `SessionKeys` Equatable. If `HandshakeResult: Equatable` requires `SessionKeys: Equatable`, either add that conformance to R1-A `SessionKeys` (it's a struct of `[UInt8]`, trivially Equatable) or drop `Equatable` from `HandshakeResult` and compare fields in tests. Prefer adding `Equatable` to `SessionKeys`.
- [ ] **Step 4: run → PASS** (two parties derive mirrored keys + identical SAS; MITM + no-commit rejected; commit/SAS match R1-A vectors). Full `swift test` green.
- [ ] **Step 5: commit** `feat(native): Handshake commit-reveal SAS state machine (two-party interop-proven)`

---

## Self-review (against the spec)

- **Spec coverage:** handshake doc → Task 1; commit/reveal message fields + JSONValue bridge → Task 2; the state machine (commit, record-peer-commit, reveal, verify→derive+SAS, MITM/no-commit rejection) → Task 3. Reuses R1-A generateKeyPair/randomNonce/commitKey/verifyCommit/deriveSession/sas.
- **Interop proof:** Task 3's two-party test derives MIRRORED session keys (one's send == other's recv) and an IDENTICAL 6-digit SAS — the same outcome a browser peer reaches; commit/SAS byte-parity with the browser is pinned to `crypto-vectors.json` (R1-A's web-generated fixture) and inherited from R1-A's golden-vector-verified `commitKey`/`sas`.
- **Placeholder scan:** none — complete code in every step. The `SessionKeys: Equatable` note is a concrete either/or resolved in favor of adding the trivial conformance.
- **Type consistency:** `Reveal`, `HandshakeError`, `HandshakeResult`, `HandshakeState`, `commitField`/`revealField`/`peerCommit`/`peerReveal` defined once and reused. Reuses `Role`/`KeyPair`/`SessionKeys`/`commitKey`/`verifyCommit`/`deriveSession`/`sas`/`randomNonce`/`generateKeyPair` (R1-A) and `JSONValue` (R1-E) with their existing signatures.

## Interop / correctness safety

The handshake reuses only R1-A primitives already byte-pinned to `crypto.ts`, and hashes raw bytes (not JSON), so there is no serialization-canonicalization risk (unlike a naive "hash the envelope"). The two-party self-consistency test proves the full flow converges to mirrored keys + one SAS; the MITM test proves a swapped key is rejected before any channel opens. The `deriveSession` throwing on an invalid peer key (R1-A's fail-closed fix) also protects a reveal carrying a small-order key.

## Next

R1-F WebRTC glue (`stasel/WebRTC`): an `RTCPeerConnection` + `RTCDataChannel` that drives this `HandshakeState` over the SDP/signal timing (commit on SDP-extra, reveal per initiator/responder), then streams `RealtimeSender`/`Receiver` frames with the `FLOW_WINDOW` credit-window driver and a `WireVersion` guard — verified live by the browser↔native E2E. This part needs the WebRTC dependency and live peers (not unit-testable), so it is built + integration-tested, not golden-vector-tested.
