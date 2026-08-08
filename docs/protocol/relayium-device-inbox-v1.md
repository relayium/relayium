# Relayium Device Inbox v1 — device identity, keys, capabilities, presence

Status: **Phase 1A only.** This document specifies device enrolment, end-to-end
public-key registration/rotation/revocation, capability negotiation and presence.
The encrypted task queue itself (Phase 1B), the CLI `inbox` commands (1C) and the
web/native device UI (1D, 2, 3) are **not** specified here and are not
implemented. Product source of truth: `DEVICE-INBOX-PRD.md` §6, §8, §10, §11.

Authoritative implementation: `server/internal/inbox/inbox.go` (protocol
vocabulary), `server/account/deviceinbox.go` (HTTP), `server/account/
deviceinbox_store.go` (storage). Any change here requires changing those and
their tests together.

## 1. Invariants

1. **Zero knowledge.** Central receives, stores and returns device **public**
   keys only. It never receives a device private key, a content key, a file
   name, a directory or plaintext. No request field and no column exists that
   could carry one.
2. **Fail closed on version.** A device whose protocol version or receive
   capability central does not share is refused and stores nothing. An
   unrecognised version never degrades to a default.
3. **Fail closed on key material.** A public key that is malformed or is a
   low-order Curve25519 point is refused before storage, so no sender ever wraps
   a content key to a value the whole world can compute.
4. **Presence expires.** Presence is derived from a stored expiry timestamp at
   read time. There is no stored `online` boolean and no sweeper; a device that
   stops heartbeating goes offline by itself.
5. **Revocation fails safe.** A revoked device cannot receive, cannot heartbeat,
   cannot register a new key, and cannot clear its own revocation.
6. **Only the device speaks for the device.** Presence and key custody are
   asserted only by a bearer bound to that device row. Revocation is
   account-scoped, because it must work from a *different* machine.

## 2. Key wrapping (specified here, used from Phase 1B)

- Algorithm identifier: `x25519-sealedbox-v1`.
- Primitive: libsodium `crypto_box_seal` — X25519 + XSalsa20-Poly1305 with an
  ephemeral sender key. Go: `golang.org/x/crypto/nacl/box.SealAnonymous` /
  `OpenAnonymous`. Web: `sodium.crypto_box_seal`. Swift: the same libsodium call.
- Device public key: raw 32-byte X25519, **base64url without padding** — the same
  spelling `storecrypto` uses for the `#k=` content key, so clients implement one
  encoding rule.
- What is wrapped: the task's 32-byte one-time AES-256-GCM content key (the same
  key `store-crypto.ts` / `storecrypto.go` already produce). The manifest and the
  file chunks are encrypted with that content key exactly as today; Device Inbox
  changes only how the key reaches the target.
- No sender identity is carried. Authorisation for the MVP is the **account**
  (PRD §8: same-account only), not a sender key. A sealed box is chosen partly
  for that reason: it needs no sender long-term key to exist.

Central cannot open a sealed box: it never holds the device private key. This is
what keeps "Relayium cannot read your files" true for the inbox path.

### Rejected public keys

`ValidatePublicKey` rejects, in order: unknown algorithm; non-canonical
base64url; length ≠ 32; and any point for which X25519 yields the all-zero shared
secret (the canonical Curve25519 low-order set). The last check is the important
one: such a key parses and is the right length, and every "wrap" to it is
recoverable by anybody.

## 3. Protocol version negotiation

Central supports versions `[1]`. The device announces the set it supports;
central selects the **highest common** version and echoes it.

- Highest-common, not lowest-common, so a fleet upgrades as its clients do.
- An empty intersection is `409 unsupported_protocol_version`, with
  `supportedProtocols` in the body, and **nothing is stored**.
- The negotiated version is what is persisted. Central never treats a device as
  speaking a version the device did not claim.

## 4. Capabilities

A capability token is `<segment>(.<segment>)*.v<N>`: lowercase alphanumeric
segments, mandatory version suffix, no leading zeros, ≤64 bytes, ≤32 tokens per
device. The version suffix is mandatory so no unversioned token can exist to be
silently redefined in a later release.

Defined in v1:

| Token | Meaning |
|---|---|
| `inbox.receive.v1` | **Required.** The device can claim a queued task, unwrap its content key, verify and commit atomically. |
| `inbox.autoaccept.v1` | The device implements the same-account automatic-receive policy (PRD §8). Absence is meaningful: such a device may only be sent to under `ask`. |
| `inbox.resume.v1` | The device resumes an interrupted ciphertext download from a complete frame boundary. |

Negotiation rules:

- The **receive family** is negotiated: central must recognise one of the
  `inbox.receive.v*` tokens the device announces, or the enrolment is refused
  with `409 unsupported_capability` and nothing is stored. A device central
  cannot describe must not appear as a send target.
- Every other syntactically valid token is **carried verbatim**, including ones
  central does not know. Central is a relay for this field, not its semantic
  authority; dropping an unknown token would hide a capability from a newer
  sender that does understand it.
- Request objects are strict: unknown fields and trailing JSON values are
  rejected. In particular, fields such as `privateKey` or `contentKey` cannot
  be silently accepted by an older central that does not understand them.

## 5. Automatic-receive policy

`off` (default) | `ask` | `auto`. Omission resolves to `off`; an unknown value is
refused, never coerced. `auto` additionally requires the device to announce
`inbox.autoaccept.v1`; the contradictory combination fails negotiation instead
of storing a policy the client did not prove it implements. The column defaults
to `'off'` in the schema as well, so no row can come into existence already
permitted to write to a user's disk. Directory selection and the enable flow are
Phase 1C.

## 6. Presence

- Heartbeat interval: **30 s** (advertised to the device).
- Presence TTL: **90 s** — a device may miss two consecutive heartbeats before it
  is declared offline.
- Stored state is `last_heartbeat_at` and `presence_expires_at`. Presence is
  `online` iff `now < presence_expires_at` and the enrolment is not revoked;
  otherwise `offline`. There is no third state and no "unknown".
- **Registering is not presence.** Enrolment says what a device can do, not that
  it is running; only a heartbeat sets presence.
- **Graceful goodbye** (`POST …/inbox/offline`) expires presence immediately.
  `last_heartbeat_at` is left alone — it is the honest record of when the device
  was last heard from.
- `CanReceive` is deliberately **separate** from presence. An offline but
  properly enrolled device is still a valid queue target (PRD §7.3); conflating
  the two would turn "offline" into "rejected" and remove the whole reason the
  asynchronous queue exists.

iOS note (PRD §11.2): a heartbeat from an iOS app expires exactly like any other.
Nothing in this design lets iOS be presented as always-online.

## 7. Key lifecycle

Each device has an ordered key history. `generation` starts at 1 and is unique
per device by database constraint. A separate partial unique index on
`device_id WHERE superseded_at = 0` makes two current rows impossible even if a
future write path bypasses the rotation compare-and-swap.

| State | Meaning |
|---|---|
| active (`superseded_at = 0`, `revoked_at = 0`) | The key new tasks are sealed to. At most one per device. |
| superseded (`superseded_at ≠ 0`) | Rotated away from. Not used for new tasks; the device still holds the private key and can drain tasks already sealed to it. |
| revoked (`revoked_at ≠ 0`) | Withdrawn. Never usable again, for new or queued tasks. |

Superseded and revoked are **not** the same state. Collapsing them would either
strand tasks queued before a rotation (PRD open question §16.2) or keep trusting
a key a human withdrew.

### Rotation is a compare-and-swap

Every registration names the key it replaces:

- `previousKeyId` absent means "I have no key yet", and is refused if one exists.
- `previousKeyId = X` is refused unless X is currently active.

This is what makes a captured request useless on replay: a first-registration
replayed after two rotations fails, and an `A→B` rotation replayed once the
device is on `C` fails. Rotating **onto** a key that already appears in the
device's history is refused as `device_key_reused` — that is a downgrade, not a
rotation.

Retrying the *same* rotation is safe: if the submitted key is already active, the
existing row is returned unchanged, so a client that lost the response converges
instead of deadlocking against its own CAS.

### Revocation

Revoking the **active** key also revokes the enrolment and expires presence in
the same transaction. There is therefore no window in which a keyless device is
still advertised as a valid, online target.

A revoked enrolment is terminal for the device itself: it cannot heartbeat,
register a key, re-enrol, or clear its own revocation. Without that last rule
revocation would be theatre — the device whose key was revoked *because it was
stolen* still holds a working account bearer and would simply clear its own
revocation and register a fresh key.

Clearing requires a browser session or another device's credential
(`DELETE …/inbox`, which also deletes the key history). The complete remedy for a
lost machine remains `DELETE /api/devices/{id}`, which cascades the enrolment,
the key history **and** the bearer token.

Revoking a **superseded** key withdraws that key alone; the device stays in
service on its current key.

## 8. HTTP API

All routes are under the account API and require `RequireAuth` (session cookie
**or** `Authorization: Bearer rlm_cli_…`). Cross-account access returns `404`,
never `403`, so the API never confirms another account's device id exists.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `PUT` | `/api/devices/{id}/inbox` | device-self | Enrol / re-announce capabilities |
| `DELETE` | `/api/devices/{id}/inbox` | account, **not** the device itself when revoked | Clear enrolment + key history |
| `POST` | `/api/devices/{id}/inbox/keys` | device-self | Register or rotate the public key |
| `GET` | `/api/devices/{id}/inbox/keys` | account | Key history, newest first |
| `POST` | `/api/devices/{id}/inbox/keys/{keyId}/revoke` | account | Revoke one key |
| `POST` | `/api/devices/{id}/inbox/heartbeat` | device-self | Refresh presence |
| `POST` | `/api/devices/{id}/inbox/offline` | device-self | Graceful goodbye |

**Device-self** means the request was authenticated by the bearer bound to that
device row. A browser session can never satisfy it: a cookie is account-wide, and
letting a signed-in tab assert a server's presence — or publish a public key
whose private half nobody holds, permanently undecryptable — is exactly the
failure this split prevents.

### `PUT /api/devices/{id}/inbox`

```json
{ "platform": "linux", "appVersion": "0.15.0",
  "protocolVersions": [1],
  "capabilities": ["inbox.receive.v1", "inbox.autoaccept.v1"],
  "autoAccept": "off", "receiveDirReady": false }
```

→ `200 {"inbox": {…}, "protocolVersion": 1, "receiveCapability": "inbox.receive.v1",
"keyAlgorithm": "x25519-sealedbox-v1"}`

### `POST /api/devices/{id}/inbox/keys`

```json
{ "algorithm": "x25519-sealedbox-v1", "publicKey": "<base64url-32>",
  "previousKeyId": "<id of the key being replaced, absent for the first>" }
```

→ `200 {"key": {"ID", "Algorithm", "PublicKey", "Generation", "CreatedAt",
"SupersededAt", "RevokedAt"}}`

### `POST /api/devices/{id}/inbox/heartbeat`

```json
{ "receiveDirReady": true }
```

→ `200 {"presence": "online", "presenceExpiresAt": 1754689200,
"heartbeatIntervalSeconds": 30}`

### Error codes

| HTTP | `error` | Client action |
|---|---|---|
| 409 | `unsupported_protocol_version` | Upgrade or stop. Body carries `supportedProtocols`. |
| 409 | `unsupported_capability` | Upgrade or stop. Body carries `supportedReceiveCapabilities`. |
| 409 | `unsupported_auto_accept_capability` | Announce `inbox.autoaccept.v1`, upgrade, or use `off`/`ask`. |
| 409 | `unsupported_key_algorithm` | Body carries `supportedAlgorithms`. |
| 400 | `unusable_public_key` | Generate a different key — this one is a low-order point. |
| 400 | `malformed_public_key` | Fix the encoding/length. |
| 400 | `invalid_capabilities` / `invalid_protocol_versions` / `invalid_auto_accept` / `invalid_device_metadata` | Fix the request. |
| 409 | `device_inbox_not_registered` | Enrol before registering a key. |
| 409 | `device_inbox_revoked` | Stop. A human must clear it from another device. |
| 409 | `stale_key_rotation` | Re-read the current key; do not retry blindly. |
| 409 | `device_key_reused` | Generate a fresh key. |
| 403 | `revoked_device_cannot_clear_itself` | Stop. |
| 404 | — | Not yours, or does not exist. Deliberately indistinguishable. |

A failed **negotiation** is `409`, not `400`: the request was well-formed and the
two sides simply do not overlap, so the client should upgrade or stop rather than
fix its JSON.

## 9. Device list additions

`GET /api/devices` gains an additive `Inbox` object per device, `null` for any
device that has never enrolled (every browser device, and any client build
predating Phase 1A). No existing field is renamed; the response keeps the
Go-default capitalization the web already reads, and the Device Inbox subtree
follows it so the key object has one spelling wherever it appears.

```jsonc
"Inbox": {
  "Presence": "online",            // derived, never stored
  "LastHeartbeatAt": 0, "PresenceExpiresAt": 0,
  "HeartbeatIntervalSeconds": 30,
  "ProtocolVersion": 1,
  "Capabilities": ["inbox.receive.v1"],
  "ReceiveCapability": "inbox.receive.v1",
  "AutoAccept": "off", "ReceiveDirReady": false,
  "Platform": "linux", "AppVersion": "0.15.0",
  "Revoked": false,
  "CanReceive": true,              // may a task be sealed to it (independent of presence)
  "RegisteredAt": 0,
  "Key": { "ID": "…", "Algorithm": "x25519-sealedbox-v1", "PublicKey": "…",
           "Generation": 1, "CreatedAt": 0, "SupersededAt": 0, "RevokedAt": 0 }
}
```

## 10. Storage

`device_inbox` (one row per enrolled device) and `device_keys` (key history),
both `REFERENCES devices(id) ON DELETE CASCADE` with the `foreign_keys` pragma
on, so deleting a device removes its enrolment, its key history and its bearer
through one existing control. `UNIQUE(device_id, generation)` makes a forked key
history impossible even under a concurrent rotation.
