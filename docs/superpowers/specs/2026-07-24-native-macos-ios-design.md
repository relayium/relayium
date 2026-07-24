# Native macOS + iOS apps — program design & Round 1 (macOS) spec

Date: 2026-07-24
Status: approved (brainstorm)

Supersedes the planning appendix "Section B" of
`2026-07-19-apps-page-and-native-roadmap-design.md` with concrete decisions.

## Goal

Ship true-native Swift macOS and iOS clients with **no feature reduction
relative to the web app**. "No reduction" means: any function a browser user can
perform, a native user can too — delivered across rounds, not all in Round 1.
Marketing/SEO pages and ops/admin surfaces are not app features and their
absence is not a reduction.

## Locked decisions (from brainstorm)

1. **True native Swift**, not a webview wrapper.
2. **Platform order**: macOS first (R1) → extract `RelayiumKit` (R2) → iOS (R3).
   macOS is the lowest-risk surface (relaxed background/sandbox/local-network
   rules) to prove interop and the wire core before iOS.
3. **Core architecture**: pure-Swift `RelayiumKit` + **native WebRTC**
   (`stasel/WebRTC`) for the realtime path so native interoperates with the
   browser peer base; **URLSession** background sessions for the cloud-async path
   (which also sidesteps iOS backgrounding later).
   - **Crypto correction (from grounding in `web/src/lib/crypto.ts`)**: the web
     crypto is **not** pure Web Crypto — its key agreement is libsodium
     `crypto_kx` (X25519 + libsodium's BLAKE2b KDF) and its commitment/SAS/
     resume-auth-key all use `crypto_generichash` (BLAKE2b). CryptoKit provides
     neither `crypto_kx` nor BLAKE2b, so byte-identical interop is impossible on
     CryptoKit alone. The Swift `Crypto` module therefore wraps **libsodium**
     (`swift-sodium` / `Clibsodium`) for `crypto_kx` and `crypto_generichash`;
     AES-GCM (12-byte nonce derived from the frame seq, per `nonceFromSeq`) may
     use libsodium or CryptoKit as long as the byte layout matches.
4. **iOS paid plans**: Apple **IAP (StoreKit)** — deferred to R4.
5. **macOS distribution/billing (R1)**: **direct download (.dmg)** with
   Developer ID signing + notarization; billing stays on the existing **Stripe
   web** flow (macOS direct-download is not bound by iOS external-purchase
   rules). **R1 does not touch IAP.**

## Verified architecture facts (drive the design)

- The server has **no WebRTC**. `server/internal/signal` is a pure WS signaling
  hub (code rooms, pairing, guess-breaker, roomkey). The WebRTC peer connection
  lives entirely on the browser side; coturn provides TURN relay fallback.
- The Go **CLI realtime path does not use WebRTC**. It shares the same signaling
  rendezvous rooms (`internal/rzvous`, same `signal.Envelope`) but its data
  plane is a self-rolled **direct TCP + pinned-TLS** connection (`internal/xfer`),
  direct-only, no relay.
- **Interop boundaries today**:
  - Cloud-async / stored `#k=`: encrypted blobs over HTTPS — fully interoperable
    web ↔ CLI ↔ (future native).
  - Realtime direct: browser (WebRTC) and CLI (TCP/TLS) do **not** interop on the
    data plane. Each connects to its own kind.
- Consequence: to interop with the dominant (browser) peer base on realtime,
  native **must** speak WebRTC — hence decision (3). Native ↔ CLI direct realtime
  interop is a future nice-to-have, not required for parity with web.

## Program decomposition (5 rounds)

Each round is its own spec → plan → implementation cycle.

| Round | Sub-project | Deliverable |
|---|---|---|
| **R1** | **macOS app** (this round writes it) | Full-feature native macOS client; pure Swift + native WebRTC; .dmg direct download + Stripe web billing |
| R2 | **`RelayiumKit` extraction** | Factor the R1-proven transfer/signaling/crypto/wire logic into a standalone Swift Package |
| R3 | **iOS app** | Reuse `RelayiumKit` + SwiftUI; local-network permission, Share Extension, background transfer |
| R4 | **StoreKit IAP + reconciliation** | iOS in-app purchase ↔ backend account/plan mapping and reconciliation (server + client work) |
| R5 | **APNs push service** | Offline "someone wants to send you a file" wake-ups; new server-side APNs service + cert/entitlement |

Sequencing rationale: R1 uses a permissive platform to flatten the hardest work
(wire interop with browser/CLI) before iOS; R2 extracts only after the shape is
proven (avoid premature abstraction); R4/R5 are orthogonal, independent items
that must not block a usable client shipping.

## Existing-codebase adjustments to support native

Mostly **enabling dormant capabilities**, not building from scratch.

1. **Enable Universal Links**: set `RELAYIUM_APPLE_APP_IDS`. The committed
   placeholder AASA (`server/wellknown.go`) already reserves `com.relayium.mac`
   (macOS) and `com.relayium.app` (iOS) and hands off `/d/*` + `/cross-network`.
   R1 needs the macOS App ID (`<TeamID>.com.relayium.mac`) added.
2. **Freeze the wire protocol into an authoritative spec doc**: the WebRTC
   DataChannel **ACK credit-window flow control**, `WireVersion` handshake, and
   the zero-knowledge `#k=` format currently live only in the JS/Go
   implementations. Write one authoritative protocol spec that Swift implements
   against (not by guessing from JS). This is the single biggest insurance
   against silent feature/interop reduction. (This doc is a prerequisite for R1's
   Realtime/Wire/Crypto modules; produced at the start of the R1 plan.)
3. **Native login already exists**: `POST /api/auth/native/login`
   (`server/internal/account/native.go`) mints `rlm_cli_…` bearer tokens and
   creates a `Device{Kind:"app"}`; native Sign in with Apple endpoints exist.
   R1 consumes these unchanged — no new auth work.
4. **`/apps` page flip**: on R1 release, the macOS "Coming soon" card becomes a
   `.dmg` download link.
5. **Deferred**: APNs and IAP reconciliation move to R5/R4. macOS stays online
   for receive via a persistent WS long-connection (menu-bar residency), so R1
   does not depend on push.

---

## Round 1 — macOS app: scope

Web feature surface mapped to macOS. Each row is tagged **native-reimplemented**,
**opens web**, or **N/A in app** so nothing functional is lost.

### A. Transfer — native-reimplemented (the app's body)

| Feature | Handling |
|---|---|
| LAN direct transfer (WebRTC same network) | Native WebRTC + Bonjour peer discovery (Device Radar parity) |
| Cross-network realtime (pairing code ⊕ share link, merged) | Native WebRTC + TURN (relay-only ICE fallback, per existing fix) |
| Cloud-async upload (zero-knowledge, ttl / burn / count) | CryptoKit encrypt + URLSession background upload |
| Cloud-async download (`#k=` links; follow 302 to node for ciphertext) | URLSession background download + decentralized-stored 302 following |
| Multiple files / folders / resumable / progress | Wire module: manifest + resumable offsets |
| Receiving `relayium.com/d/*` and `/cross-network` links | Universal Links handed off in-app |

### B. Account — native login, billing opens web

| Feature | Handling |
|---|---|
| Login: password / **Sign in with Apple (native)** / magic link | Native; SiwA native endpoints already exist (a macOS UX win) |
| This device (`Device{Kind:"app"}`), device list | Native, via existing `native/login` |
| Usage / quota meters, transfer history | Native, rendering existing APIs |
| Upgrade plan / manage subscription | **Opens browser to Stripe** (macOS direct-download is compliant; no IAP). App shows current tier read-only |

### C. Platform-native capabilities (web can't do these — additive, not cuts)

- Menu-bar residency (persistent WS long-connection → online receive; no APNs in R1)
- Native drag in/out, filesystem-level receive notifications, Finder
  "Reveal in Finder", default to Downloads
- Sparkle auto-update (for direct-download distribution)

### D. Explicitly not in R1 (none are reductions vs web)

- Marketing / SEO pages → not needed inside an app
- BYO relay node management, admin backend → ops/power features; app provides a
  "manage on web" entry point, not a native reimplementation
- APNs push → R5; IAP → R4

---

## Round 1 — RelayiumKit architecture

Built as modular internal targets in R1; extracted verbatim into a standalone
Swift Package in R2.

```
UI (macOS SwiftUI — NOT part of Kit)
  main window (send / receive / history) · menu-bar extra · drag-drop ·
  notifications · settings · login / onboarding
  │
RelayiumKit (extractable pure-logic core)
  ├─ Signaling   WS client → /signal rooms/pairing/ICE·SDP envelopes;
  │              mirrors internal/signal Envelope semantics
  ├─ Realtime    native WebRTC (stasel/WebRTC); DataChannel + ACK credit-window
  │              flow control + WireVersion handshake; TURN relay-only fallback
  ├─ Crypto      libsodium (swift-sodium) crypto_kx + generichash(BLAKE2b) +
  │              AES-GCM (seq nonce) + #k= derivation + SAS/commitment + Identity;
  │              byte-for-byte aligned with web crypto.ts
  ├─ Wire        manifest / framing / resumable offsets; data-plane message
  │              format shared with JS
  ├─ Cloud       URLSession background up/down; chunked resume; stored-link
  │              (#k=) create/fetch; follow 302 to node
  └─ Account     native login · Keychain token storage · device registration ·
                 usage / quota / plan fetch
```

Module contracts (what each does, how it's used, what it depends on):

- **Signaling** — join a code room, run pairing/handshake, relay ICE/SDP
  envelopes. Depends on: nothing but the WS + `Envelope` format. Consumers:
  Realtime.
- **Realtime** — establish a WebRTC peer connection and stream a `Wire` transfer
  with credit-window backpressure. Depends on: Signaling, Crypto, Wire.
- **Crypto** — encrypt/decrypt payloads, derive `#k=` keys, produce/verify SAS,
  manage identity. Depends on: CryptoKit only. Golden-vector tested against web.
- **Wire** — encode/decode manifests and framed chunks, track resumable offsets.
  Pure codec; no I/O. Depends on: nothing. Shared by Realtime and Cloud.
- **Cloud** — create/fetch stored transfers over HTTPS with background sessions,
  follow node 302s. Depends on: Crypto, Wire, Account (for auth).
- **Account** — authenticate, persist tokens in Keychain, register the device,
  fetch usage/plan. Depends on: the HTTP API only.

## Interop-safety (the core "no reduction" risk)

1. **Freeze the wire protocol into an authoritative spec first** (adjustment #2)
   — Swift implements against the spec, not by guessing from JS.
2. **Extend the existing headless E2E** (`web/e2e/lan-transfer.mjs`, run via
   `npm run test:e2e`) with a Swift/RelayiumKit peer, covering **browser ↔ native
   bidirectional realtime** and **native ↔ cloud ↔ browser**. Any transfer change
   must run it.
3. **`WireVersion` mismatch fails closed** — never silently downgrade.

## Testing strategy

- Per-module XCTest unit tests for every RelayiumKit module.
- **Crypto/Wire golden vectors**: web-produced test vectors serve as golden
  values the Swift implementation must reproduce byte-for-byte.
- Integration: the cross-endpoint E2E above.

## Out of scope for R1

Writing the iOS app, `RelayiumKit` package extraction, StoreKit IAP, APNs push,
Mac App Store submission, BYO-node native management, admin backend. Each is a
later round with its own spec.
