# Security Policy

Relayium's whole reason to exist is end-to-end encryption, so we take security reports seriously and
appreciate responsible disclosure.

> ⚠️ **Status:** Relayium is under active development and has **not**
> undergone an independent security audit. Please do not rely on it for
> high-stakes threats yet.

## Supported versions

The project moves fast and its clients have independent version numbers.
Only the **latest `main`**, latest published release in each supported channel,
and live deployment at
[relayium.com](https://relayium.com/) are supported for security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's **[Private vulnerability reporting](https://github.com/relayium/relayium/security/advisories/new)**
(the *Security → Report a vulnerability* button on the repository). This keeps the details confidential
until a fix is available.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Affected component (web client crypto/transfer, signaling server, etc.) and version/commit.
- Any suggested remediation, if you have one.

We'll aim to acknowledge a report within a few days and keep you updated on progress. We're a small project,
so timelines are best-effort — thank you for your patience.

## Scope

Especially valuable areas to scrutinize:

- **Cryptography** (`web/src/lib/crypto.ts`) — key exchange, AEAD usage, nonce handling, the SAS derivation.
- **Transfer protocol** (`web/src/lib/transfer.ts`) — framing, chunk integrity, the batch nonce counter.
- **WebRTC / signaling** (`web/src/lib/webrtc.ts`, `web/src/lib/signaling.ts`, `server/`) — what the
  signaling server can observe or tamper with, and whether the SAS reliably catches a MITM.
- **Admin dashboard auth** (`server/account/admin.go`, local `relayium-server admin`
  commands and the passkey/session handlers) — Passkey-only sign-in, privileged
  confirmation and server-local enrollment/revocation. Password and TOTP sign-in
  are retired; see [`docs/admin-passkeys.md`](docs/admin-passkeys.md) for the
  current deployer and recovery guide.
- **TURN/relay credentials and metering** (`server/account/turn.go`, `server/internal/metering/`) —
  ephemeral TURN-REST credential issuance, the multi-relay pool, and relay-usage/quota attribution for
  cross-network pairing-code transfers.
- **Device Inbox — persistent device identity and the encrypted task queue**
  (`server/internal/inbox/`, `server/account/deviceinbox*.go`,
  `server/internal/inboxclient/`, `web/src/lib/device-inbox.ts`,
  `web/src/lib/device-seal.ts`). This shipped on 2026-08-24, so the long-standing
  "not implemented" note below it was retired: devices now enrol, register and
  rotate X25519 public keys, hold presence, and claim leased work from a queue.
  The surfaces worth attacking are exactly the ones that entry used to defer —
  key registration, rotation and revocation; the sealed-box wrapping of a task's
  content key to a target device's public key; claim, lease and idempotency
  handling; and the boundary that a capability link authenticates nothing and can
  never cause a device to write to disk. The wire contract is
  [`v3`](docs/protocol/relayium-device-inbox-v3.md), with the retained vocabulary
  and bounds in [`v1`](docs/protocol/relayium-device-inbox-v1.md) and
  [`v2`](docs/protocol/relayium-device-inbox-v2.md); the frozen invariants are
  [`docs/DEVICE-INBOX-ADMISSION-CONTRACT.md`](docs/DEVICE-INBOX-ADMISSION-CONTRACT.md).

Out of scope for now:

- Denial-of-service against the public demo's signaling server.

Realtime browser and CLI transfers still use a fresh **per-transfer** ephemeral
X25519 keypair with no long-term endpoint identity, which is why their SAS is
compared per session. That is a design choice rather than an unimplemented
feature, and it is independent of the Device Inbox device keys above — the two
answer different questions and neither authenticates the other's path.

## Disclosure

We follow coordinated disclosure: please give us a reasonable window to ship a fix before publishing
details. We're happy to credit reporters in the release notes unless you'd prefer to remain anonymous.
