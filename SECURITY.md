# Security Policy

Relayium's whole reason to exist is end-to-end encryption, so we take security reports seriously and
appreciate responsible disclosure.

> ⚠️ **Status:** Relayium is an early MVP (**M0**) and has **not** undergone an independent security audit.
> Please do not rely on it for high-stakes threats yet.

## Supported versions

The project is pre-1.0 and moves fast. Only the **latest `main`** (and the live deployment at
[relayium.com](https://relayium.com/)) is supported for security fixes.

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

Out of scope for now (known limitations, documented in [`docs/TESTING.md`](docs/TESTING.md)):

- Denial-of-service against the public demo's signaling server.
- Cross-NAT / TURN relay (not implemented yet — M2).
- Persistent device identity (not implemented yet — M1).

## Disclosure

We follow coordinated disclosure: please give us a reasonable window to ship a fix before publishing
details. We're happy to credit reporters in the release notes unless you'd prefer to remain anonymous.
