# Relayium Device Inbox v1 — device identity, keys, capabilities, presence

Status: **Phases 1A, 1B, 1C and 1D-A.** This document specifies device enrolment,
end-to-end public-key registration/rotation/revocation, capability negotiation
and presence (§1-§10), the encrypted asynchronous task queue with its full
server-visible state machine (§11-§18), the obligations of a RECEIVING
CLIENT (§19-§23), and the SERVER half of the sender: the task-purpose opaque
upload, its authorization boundaries, binding and cleanup (§24-§28).

The web/native device UI — the Web sender (1D-B) and the native clients (2, 3) —
is **not** specified here and is not implemented. Product source of truth:
`DEVICE-INBOX-PRD.md` §6, §8, §9, §10, §11.

Authoritative implementation: `server/internal/inbox/inbox.go` and
`server/internal/inbox/task.go` (protocol vocabulary and the state machine),
`server/account/deviceinbox.go` and `server/account/deviceinbox_task.go` (HTTP),
`server/account/deviceinbox_store.go` and
`server/account/deviceinbox_task_store.go` (storage),
`server/account/taskobject.go` with `server/account/files.go`,
`server/account/uploads_resumable.go` and `server/account/gc.go` (the
task-purpose object: purpose/binding vocabulary, the two upload paths, and the
reclaim sweep), `server/internal/inboxclient/` and
`server/cmd/relayium/inbox.go` (the CLI receiver). Any change here requires
changing those and their tests together.

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

---

# Phase 1B — the encrypted asynchronous task queue

## 11. Invariants (queue)

1. **Zero knowledge, again.** A task row holds the owning account, the source
   and target devices, the ciphertext byte count, timestamps, a state, an opaque
   error token and idempotency metadata — plus two blobs central cannot read:
   the encrypted manifest and the content key sealed to the target device's
   public key. There is no column, and no request field, for plaintext, a file
   or directory name, the target's real path, a content key or a private key.
2. **A public link never writes to disk.** Every queue endpoint is
   authenticated, and the target device is always resolved under the caller's
   own account. A capability link authenticates nothing and reaches none of it.
   MVP task creation is same-account only (PRD §8).
3. **Session ≠ device.** A browser session may create, list, read and delete
   tasks — it is the primary *sender*. Only the machine itself may claim work or
   assert what it did with a file.
4. **The key binding is fixed at creation.** A rotation preserves an existing
   task's claim on the superseded key; revoking that key makes its unfinished
   tasks terminal `revoked`.
5. **Exactly one claimant.** Concurrent claims produce one winner; an expired
   lease returns the work to the pool and makes the previous claimant stale.
6. **Retries converge.** Duplicate create, claim, progress and `saved` reports
   never duplicate work or falsify a timestamp.
7. **`saved` is earned.** It is reachable only from `verifying`, only with an
   explicit device assertion that authenticated decryption, complete
   verification and the atomic local commit all succeeded. Ciphertext arriving
   at central is never `saved`.
8. **Fail closed on transitions.** An explicit table decides every pair;
   unknown states, terminal sources and unlisted pairs are all refused.

## 12. The data path: an existing Stored Object, by reference

A task does **not** carry or duplicate ciphertext. It references an existing
same-account encrypted Stored Object (`stored_files`), and inherits from it:

- the **encrypted manifest**, copied from the object at creation — never taken
  from the request, so the manifest and the ciphertext cannot disagree;
- the **ciphertext byte count**, read from the row, so a sender cannot describe
  its own object dishonestly;
- the **expiry**. A task cannot outlive the ciphertext it points at, so there is
  no second retention window and no invented quota. Storage volume is already
  bounded by the account's existing plan limits, because the object was uploaded
  under them.

A task never *owns* a share. Deleting a task therefore cannot orphan one, and
never destroys the download link the object still is. The reference must use an
**unlimited-until-TTL** Stored Object (`max_downloads = 0`, not burn-after-read):
a public-link read could otherwise spend the final slot and strand a supposedly
reliable device delivery. Deleting the object explicitly before TTL atomically
ends unfinished tasks as `failed_terminal`/`stored_object_unavailable`.

**Status:** this by-reference path is unchanged and remains supported. The
task-owned opaque upload it deferred — one object created for the queue alone,
with no share link — is specified in **§24–§27 (Phase 1D-A)**. A task may
therefore be backed by either kind of object, and §24 states exactly where the
two behave differently.

## 13. State machine

Server-visible states (PRD §10 items 3-12): `queued`, `notified`,
`downloading`, `verifying`, `saved`, `attention_required`, `expired`, `revoked`,
`failed_retryable`, `failed_terminal`.

`encrypting` and `uploading` (PRD §10 items 1-2) are **sender-local**. Central
cannot observe either, so it stores neither and refuses them *by name* with a
distinct error rather than as unknown strings. The database `CHECK` constraint
repeats the server set, so no write path can invent a state.

| From | May become |
|---|---|
| `queued` | `notified`, `downloading`, `attention_required`, `expired`, `revoked`, `failed_terminal` |
| `notified` | `queued`, `downloading`, `attention_required`, `expired`, `revoked`, `failed_terminal` |
| `downloading` | `verifying`, `queued`, `attention_required`, `failed_retryable`, `failed_terminal`, `expired`, `revoked` |
| `verifying` | **`saved`**, `queued`, `attention_required`, `failed_retryable`, `failed_terminal`, `expired`, `revoked` |
| `attention_required` | `queued`, `failed_terminal`, `expired`, `revoked` |
| `failed_retryable` | `queued`, `failed_terminal`, `expired`, `revoked` |
| `saved`, `expired`, `revoked`, `failed_terminal` | — terminal |

Reporting the state a task is already in is **not** a transition: it is an
idempotent no-op. In `downloading` or `verifying`, it renews the lease (a
progress heartbeat); other non-working states do not acquire a lease;
terminal, it returns the stored row unchanged, so a retried `saved` gets the
timestamp of the real commit rather than the retry.

A device may report only `downloading`, `verifying`, `saved`,
`attention_required`, `failed_retryable`, `failed_terminal`. `expired` and
`revoked` are central's judgements about time and authorization;
`queued`/`notified` are central's scheduling — a device that could report
`queued` could reset its own backoff.

### Who drives each transition

- **create** → `queued` (policy `auto`) or `attention_required` (policy `ask`).
- **`GET …/inbox/pending`** → `queued` becomes `notified`. In the polling
  transport the device asking and central answering *is* the notification.
- **`POST …/inbox/claim`** → `queued`/`notified` become `downloading`, leased.
- **device report** → `verifying`, `saved`, `attention_required`,
  `failed_retryable`, `failed_terminal`.
- **`POST …/tasks/{id}/accept`** → `attention_required` becomes `queued`
  (accepted) or `failed_terminal`/`user_declined` (declined). Only that state is
  acceptable, so a device cannot cancel its own live lease to skip a backoff.
- **lease expiry** → `downloading`/`verifying` return to `queued` with
  `lease_expired`, the claimant cleared, and a backoff measured from when the
  lease was *lost*.
- **backoff elapsed** → `failed_retryable` returns to `queued`.
- **TTL** → anything unfinished becomes `expired`.
- **key revocation / enrolment clear** → unfinished tasks become `revoked` with
  `key_revoked`, in the same transaction as the key change.

## 14. Automatic-receive policy at creation

| Policy | Result |
|---|---|
| `off` | `409 auto_receive_disabled`. Nothing is stored: queuing a task the device will never take would be a lie in the sender's UI. |
| `ask` | `attention_required`. Held until a person at *that* machine accepts. |
| `auto` | `queued` — but only if the device announced `inbox.autoaccept.v1` **and** last reported a usable receive directory. `auto` with an unusable directory starts `attention_required`, because the honest reason nothing will land is a local problem the user must fix. |

The policy is read inside the create transaction, so a device switched to `off`
a moment earlier wins the race.

## 15. Claims, leases and idempotency

- A claim mints a **raw claim token**, returned exactly once in the claim
  response; only `authx.HashToken` of it is stored. Every progress report
  carries it, and it is matched inside the update transaction.
- **Device-self** says *this machine*; the **claim token** says *this machine's
  current worker*. Both are required, because a device with several workers, or
  one paused and resumed, must not overwrite the progress of whoever holds the
  task now.
- **Lease TTL 5 minutes.** It bounds how long a *crashed* claimant strands a
  task, not how long a download may take: reporting progress renews it. The
  deadline is enforced on every report and blob request even before a poll or
  GC pass has reclaimed the row, so an expired worker cannot revive itself.
  A lease is always capped at the task's own expiry and therefore cannot imply
  work remains valid beyond the ciphertext TTL.
- **Reclaim** clears the claimant, so the superseded worker's token stops
  matching (`409 stale_claim`). The claim path reclaims its own device's stale
  leases first, so a restarted CLI resumes without waiting for the GC sweep.
- The claimant hash is **retained** on a terminal row as the record of who
  finished the task. That is what makes a retried final report idempotent rather
  than a stale-claim rejection.
- **Creation idempotency** is `UNIQUE(user_id, idempotency_key)`, enforced by
  the database. An identical repeat returns `200 {"created": false}` with the
  original task; the same key with different content is
  `409 idempotency_key_conflict` — silently returning the first task would tell
  the sender their *second*, different file was queued.

### Bounds

| Bound | Value | Why |
|---|---|---|
| Lease TTL | 5 min | Bounds a crashed claimant, renewed by progress. |
| Max attempts | 8 | Then `failed_terminal`/`attempts_exhausted`, so a task that can never succeed stops consuming claims. |
| Retry backoff | 30 s, doubling, capped at 30 min | Bounded on both ends; a flapping device neither hammers central nor burns its TTL. |
| Pending rows per device | 256 | A row-count abuse bound. Bytes are already bounded by the account's storage plan. |
| Claim batch | 32 | One call cannot lease a device's whole queue and strand it for the lease TTL. |
| Terminal-row retention | 7 days | Bounds the table while a sender can still see what happened yesterday. |

None of these is a commercial quota; PRD §13 rules pricing numbers out of scope.

## 16. Error codes (queue)

Device-submittable codes are a **closed set**: `""`, `download_failed`,
`decrypt_failed`, `verify_failed`, `disk_full`, `permission_denied`,
`directory_unavailable`, `name_conflict`, `user_declined`, `unsupported`,
`internal`. There is no free-text field, so a file name or path cannot reach
central even when a device is reporting exactly why saving failed.

`lease_expired`, `attempts_exhausted`, `key_revoked` and
`stored_object_unavailable` are written by **central only**; a device submitting
one is refused, so it cannot forge central's own account of events.

| HTTP | `error` | Client action |
|---|---|---|
| 409 | `auto_receive_disabled` | The target has automatic receive off. Ask the user to enable it on that device. |
| 409 | `device_cannot_receive` | Not enrolled, unsupported version, or no active key. |
| 409 | `device_inbox_revoked` | Stop. A human must clear it from another device. |
| 409 | `stale_target_key` | Re-read the device's current key and seal again. |
| 409 | `idempotency_key_conflict` | The key was reused for different content. Use a fresh key. |
| 409 | `stored_object_unavailable` | The referenced object is gone, expired, or not yours. |
| 429 | `inbox_queue_full` | The device has too much unfinished work. Body carries `maxPendingTasks`. |
| 409 | `stale_claim` | Your lease was reclaimed or superseded. Re-claim; do not retry the report. |
| 409 | `task_terminal` | The task is finished. Body carries the task. Stop. |
| 409 | `invalid_transition` | Illegal for the task's current state. |
| 400 | `sender_local_state` | `encrypting`/`uploading` are yours to track, not central's. |
| 400 | `saved_not_asserted` | `saved` requires `committed: true`. |
| 400 | `malformed_wrapped_key` | Canonical base64url of exactly 80 bytes for `x25519-sealedbox-v1`. |
| 400 | `invalid_error_code` / `invalid_task_state` / `invalid_idempotency_key` | Fix the request. |
| 404 | — | Not yours, or does not exist. Deliberately indistinguishable. |

## 17. HTTP API (queue)

All routes require `RequireAuth` (session cookie **or** CLI bearer).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/devices/{id}/inbox/tasks` | account | Queue one encrypted delivery |
| `GET` | `/api/devices/{id}/inbox/tasks` | account | List, newest first (`?limit=`) |
| `GET` | `/api/devices/{id}/inbox/tasks/{taskId}` | account | Read one |
| `DELETE` | `/api/devices/{id}/inbox/tasks/{taskId}` | account | Cancel/remove the task; refuses `downloading`/`verifying` so ciphertext cannot disappear under a live receiver |
| `GET` | `/api/devices/{id}/inbox/pending` | device-self | "Is there work"; marks `notified`; leases nothing |
| `POST` | `/api/devices/{id}/inbox/claim` | device-self | Lease work; the ONLY source of delivery material |
| `GET` | `/api/devices/{id}/inbox/tasks/{taskId}/blob` | device-self + current claim token | Resumable ciphertext stream; token in `X-Relayium-Inbox-Claim` |
| `POST` | `/api/devices/{id}/inbox/tasks/{taskId}/report` | device-self + claim token | Progress / saved / failure |
| `POST` | `/api/devices/{id}/inbox/tasks/{taskId}/accept` | device-self | Resolve `attention_required` |

Device-side verbs live at `…/inbox/pending` and `…/inbox/claim` rather than
under `…/inbox/tasks/`, so no fixed word can ever shadow a task id.

### `POST /api/devices/{id}/inbox/tasks`

```json
{ "idempotencyKey": "sender-chosen, ≤128 printable ASCII bytes",
  "storedFileId": "<an existing same-account Stored Object>",
  "wrapAlgorithm": "x25519-sealedbox-v1",
  "wrappedKey": "<base64url, exactly 80 raw bytes>",
  "targetKeyId": "<the device's CURRENT key id>",
  "targetKeyGeneration": 1 }
```

→ `201 {"task": {…}, "created": true}`, or `200 {"created": false}` on a
converged retry.

There is deliberately **no** field for the manifest, the size, the expiry or the
state: central derives all four from state it can verify. Request objects are
strict, so `contentKey`, `fileName`, `destinationPath` and friends are `400`s,
not silently ignored fields.

### `POST /api/devices/{id}/inbox/claim`

```json
{ "max": 8 }
```

→ `200 {"tasks": [{ …task…, "EncManifest": "<base64>", "WrappedKey": "<base64url>",
"ClaimToken": "<returned once>" }], "leaseSeconds": 300}`

Sent `Cache-Control: private, no-store`. The account-scoped reads never return
`EncManifest`, `WrappedKey` or `ClaimToken`: a stolen session must not yield
every queued task's sealed key.

The claimed worker downloads ciphertext from
`GET …/inbox/tasks/{taskId}/blob` with its device bearer and
`X-Relayium-Inbox-Claim: <ClaimToken>`. This path supports `Range`, does not
consume public-link download slots, checks the lease deadline itself, and
renews the lease when an authorized stream starts.

### `POST /api/devices/{id}/inbox/tasks/{taskId}/report`

```json
{ "claimToken": "…", "state": "verifying", "errorCode": "", "committed": false }
```

`state: "saved"` additionally requires `committed: true` — the device stating
that authenticated decryption, complete verification and the atomic local commit
all succeeded. Central cannot observe any of that, so its absence is a refusal,
never an assumption.

## 18. Storage (queue)

`inbox_tasks`, `REFERENCES devices(id) ON DELETE CASCADE`, so
`DELETE /api/devices/{id}` removes the queue along with the enrolment, the key
history and the bearer. Account deletion purges the rows by `user_id` as well.
Neither can orphan a blob: a task borrows a `stored_files` row it does not own,
and that table keeps its own lifecycle.

`stored_file_id` is deliberately **not** a foreign key. The owner may delete the
object without a task blocking that control. `DeleteStoredFile` first updates
unfinished referencing tasks in the same writer transaction: past-TTL rows
become `expired`; early deletion becomes
`failed_terminal`/`stored_object_unavailable`; already terminal rows retain
their historical truth. Then the object row is removed.

Constraints, so the invariants do not rest on application code alone:

- `UNIQUE(user_id, idempotency_key)` — creation idempotency survives a
  concurrent duplicate the application read would miss.
- `CHECK (state IN …)` — the closed PRD §10 server set.
- `CHECK (saved_at = 0 OR state = 'saved')` — no code path can leave a "saved
  at" timestamp on a task that was never saved.
- `CHECK (lease_expires_at = 0 OR claim_token_hash <> '')` — a lease always has
  a holder. The converse is allowed on purpose: the claimant hash outlives its
  lease on a terminal row, which is what makes a retried final report idempotent.

GC sweeps the queue each pass: reclaim expired leases, expire past TTL, delete
terminal rows past retention.

---

# Phase 1C — the receiving client

§1-§18 describe what central will accept. This half describes what a device must
DO to be a correct receiver, because most of the properties users actually care
about — no overwritten file, no duplicate delivery, no false `saved` — are
enforced entirely on the device. Central cannot observe any of them.

The reference implementation is the Relayium CLI (`server/internal/inboxclient/`,
`server/cmd/relayium/inbox.go`); the operator-facing guide is
`docs/device-inbox-cli.md`. A macOS or iOS client implementing §19-§22 is
interoperable with it and with the same server.

## 19. Client obligations

1. **Persist before publish.** A generated private key MUST be durable on the
   device (atomically written, fsynced) BEFORE its public half is registered. The
   reverse order can publish a key whose private half never reached disk, making
   every task sealed to it undecryptable by anyone, permanently.
2. **Retain by generation.** A rotation MUST NOT delete the superseded private
   key. Central binds a task to the key it was sealed to (§11.4), so dropping the
   old key strands every task queued before the rotation. Keys are indexed by
   central's key id, which a claim names in `TargetKeyID`.
3. **Reconcile, do not regenerate.** If a registration response is lost, the
   device asks for its key history (`GET …/inbox/keys`) and binds the id central
   gave the key it already holds. Minting a second key would abandon the first.
4. **Rotate to recover.** If central's ACTIVE key has no local private half — a
   restored backup, a wiped state directory — the device compare-and-swaps onto a
   fresh key (`previousKeyId` = the unusable one). Tasks already sealed to the old
   key remain undecryptable and are reported
   `failed_terminal`/`decrypt_failed`; the device does not pretend otherwise.
5. **Fail closed on negotiation.** A device MUST verify the version, receive
   capability and key algorithm central selected are ones it actually implements,
   and stop if not. A 409 from enrolment is "upgrade or stop", never "retry with
   a default".
6. **Presence is a claim about now.** A device heartbeats only while it can
   actually receive. Paused, or with an unusable receive directory, it MUST NOT
   assert presence, and it MUST report `receiveDirReady` from a check made
   immediately before the call — a real create-and-remove probe, not an
   inspection of permission bits.
7. **Both credentials, every time.** Ciphertext reads and progress reports carry
   the device bearer AND the current claim token; the claim token travels in the
   `X-Relayium-Inbox-Claim` header, never in a URL.
8. **Renew before the deadline.** A working device re-reports its current state
   periodically (an idempotent no-op that renews the lease). A refused renewal
   means the lease is gone: the device MUST abandon the task WITHOUT reporting,
   rather than finish work it is no longer authorised to assert.
9. **Secrets stay local.** Private keys, the unsealed content key, the manifest,
   file names and destination paths MUST NOT appear in logs, in error messages,
   or in any field sent to central. Error reporting is the closed §16 code set.

## 20. The receive pipeline

A conforming device performs, in this order, and produces nothing observable
until every step before the commit has succeeded:

1. **Unseal** the content key with the private key named by `TargetKeyID`.
2. **Decrypt and validate** the copied encrypted manifest with that key, and
   cross-check it: declared plaintext MUST NOT exceed the task's
   `CiphertextBytes`, because framing and Poly1305 tags make the ciphertext
   strictly larger.
3. **Plan** every destination (§21) and make the plan DURABLE before any
   destination can exist.
4. **Preflight** free space for the declared total.
5. **Stream** the ciphertext into a per-task staging area on the same filesystem
   as the receive directory, authenticating every frame, resuming interrupted
   transfers from `Range` at a complete frame boundary only.
6. **Verify** the whole stream: no trailing bytes, total length exactly as
   declared, and each staged file at exactly its declared size with no executable
   bit.
7. Report **`verifying`**.
8. **Commit** (§22).
9. Report **`saved`** with `committed: true` — and only from a completed commit.

A failure at any step before 8 MUST leave nothing outside the staging area, which
is then removed.

## 21. Destination rules

AEAD proves who built a manifest. It does not make its names safe: a name is an
instruction to the receiving filesystem. A conforming device REFUSES an entry
whose name is empty, over-long, not valid UTF-8, contains a control byte or a
backslash, is absolute or drive-qualified, contains an empty, `.` or `..`
component, has a component ending in a dot or a space, is a Windows reserved
device name, or is excessively nested. It refuses a MANIFEST in which two entries
resolve to the same destination, including differing only by case — a
case-insensitive filesystem would silently collapse them and lose one.

A destination name occupied by ANYTHING — a file, a directory, a socket, a FIFO,
a device node, or a dangling symlink — is occupied. The device does not write
through it. Automatic collisions take a deterministic `name (2)`, `name (3)`
suffix with the extension preserved, searched lowest-first so the same manifest
against the same directory always yields the same plan; that determinism is what
lets a resumed task compare its journal against reality.

Directories are created one component at a time, checking each with an lstat
BEFORE descending: a symlink or a non-directory stops the delivery. A recursive
"make all parents" call is not sufficient, because it follows an existing
symlinked component before anything can object.

Received files carry no executable bit on any platform, and their mode is set
explicitly rather than inherited from the process umask.

## 22. Commit and crash recovery

The commit MUST have no-replace semantics as a single operation. `rename(2)` is
not acceptable: it replaces its destination silently, so every "check, then
rename" has a window — minutes wide, since the check happens before the download
— in which a file created meanwhile is destroyed with no error. `link(2)` fails
if the destination name is taken by anything, and the kernel makes the test and
the creation atomic. (This is also why the staging area must be on the same
filesystem.)

A conforming device keeps a durable per-task journal and follows this order for
each planned destination:

```text
link -> fsync the destination directory -> record it in the journal -> unlink the staged source
```

which makes every crash boundary answerable:

| Crashed after | Recovery |
|---|---|
| journalling the plan | discard staging, re-download into the SAME plan (never a recomputed one, which would walk the collision suffix forward and deliver twice) |
| `link`, before journalling | the staged source survives and shares an inode with the destination, proving the link was this task's; the journal catches up |
| journalling, before `unlink` | the entry is skipped and the stale source removed |
| the full commit, before `saved` landed | the task is re-claimed, the receipt recognised, `saved` re-reported with NO re-download and NO re-commit |

A destination that exists and is NOT this task's staged inode is ambiguous. The
device MUST stop at `attention_required`/`name_conflict`. It never overwrites,
never merges, and never guesses.

Receipts are retained longer than central's terminal-row retention (§15), so a
duplicate delivery attempt for a task this device already saved is recognisable
from local evidence alone.

## 23. Deployment shape

`inbox run` is a foreground process: it does not fork, writes no pid file, logs
to stdout/stderr, and exits 0 on `SIGTERM`. That single shape serves an
interactive terminal, a systemd unit, a launchd agent and a container entrypoint;
supervision, restarts and log handling belong to the supervisor.

Exactly one worker may run per state directory, enforced by an advisory file lock
the kernel releases if the process dies. Central's claim tokens prevent two
workers from corrupting a TASK, but nothing on the server can stop two local
processes from racing on one directory.

---

# Phase 1D-A — the task-purpose opaque upload

§12 delivers a task by REFERENCE: it points at a Stored Object the account
already shared. That works, but it forces the sender to create a public
capability link for a file it only ever wanted to put on its own laptop. This
half specifies the other kind of object — ciphertext uploaded for ONE device
delivery, with no link, which no unauthenticated reader can reach.

Phase 1D-A is the SERVER half only: persistence, the upload paths, the
authorization boundaries, binding and cleanup. The Web sender that drives it is
Phase 1D-B.

## 24. Two purposes, one object model

Every `stored_files` row now carries an explicit `purpose`:

| purpose | What it is | Public `meta`/`blob` | In `GET /api/files` | Bound to a task | Deleted with its task |
|---|---|---|---|---|---|
| `share` | The capability-link object; the only kind before this phase | yes | yes | never | no |
| `device_task` | Ciphertext for one Device Inbox delivery | **no — 404** | **no** | exactly once | yes |

The purpose is **persisted, not inferred**. Deriving "is this a delivery?" from
the existence of a task elsewhere would make an object read as a public share
during the window between its upload and its task — which is precisely the
window in which a leaked id would be spent. A row that predates the column reads
as `share`, which is what it has always been.

Everything a `device_task` object shares with a share, it shares completely: node
placement, the global disk cap, the daily upload quota (including the
minimum-billable floor), the per-plan storage and traffic caps, `max_file_size`,
the write cap, TTL clamping and the plan retention cap, lifetime upload/download
stats, monthly metering, expiry, and the GC expiry sweep. No second quota is
invented and none is skipped: the account pays for delivery ciphertext exactly as
it pays for a share.

What it never gains is capability-link semantics. `liveFile` — the single
resolver behind both unauthenticated endpoints — refuses a non-`share` object, so
`GET /api/files/{id}/meta` and `GET /api/files/{id}/blob` are `404` for
**everyone, including the owner's own authenticated session**. That is not an
oversight: those endpoints ARE the capability link, and a public surface with a
second, owner-only behaviour would be a second surface to get wrong. The sender
does not need them — its ciphertext reaches the device through the task blob
endpoint. A `device_task` object is likewise absent from the account file list,
spends no download slot, and cannot be reconciled by a fleet download receipt
(central never issues a direct-download `302` for one, so a receipt naming its
blob describes a transfer that never happened).

## 25. Uploading one

Both upload routes take `?purpose=device_task`:

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/files?purpose=device_task` | Single-shot; body is `uint32BE(len) ‖ encManifest ‖ ciphertext` |
| `POST` | `/api/uploads?purpose=device_task` | Resumable init; `PATCH`/`finalize`/status are unchanged |

Both require `RequireAuth`. There is no unauthenticated way to create one, and
no request shape that names another account.

Two refusals, both `400`:

- an **unknown purpose**. Unrecognised values are rejected rather than defaulted,
  so a typo cannot silently produce a public share;
- `burnAfterRead=1` or `maxDownloads>0` **together with** `purpose=device_task`.
  The queue requires an unlimited-until-TTL object (§12), so limited retention is
  a contradiction — refused by name rather than quietly rewritten into retention
  the caller did not request.

The deployment-wide DEFAULT retention policy is deliberately **not** applied to a
task upload. That policy governs public shares; on a deployment defaulting to
burn-after-read it would otherwise produce delivery objects the queue then
refuses, for a reason the sender can neither see nor change. TTL resolution,
clamping and the plan retention cap are identical for both purposes.

A resumable session persists its purpose, because `finalize` may run on a
different instance and must not re-derive an authorization-relevant decision from
a query string it can no longer see.

## 26. Binding

`POST /api/devices/{id}/inbox/tasks` accepts either kind of object. For a
`device_task` object it additionally **binds** it, inside the create's own
transaction:

- the object must belong to the caller's account (a cross-account
  `storedFileId` is `stored_object_unavailable`, exactly as before — it never
  discloses that the id exists);
- it must be **unbound**. An already-bound object is `409`
  `stored_object_already_bound`;
- the binding is taken with a conditional `UPDATE … WHERE inbox_task_id = ''`,
  so of two concurrent creates naming one object exactly one wins;
- a partial `UNIQUE` index on `inbox_task_id` makes a second binding impossible
  at the database level even if the application check were bypassed;
- because it is the create's own transaction, a create that fails any later
  check releases the binding with it. An object is never left owned by a task
  that does not exist.

**Idempotency, stated honestly.** A retried create carrying the SAME
idempotency key converges on the task that already owns the object and returns
`created: false` — the binding does not move. A DIFFERENT idempotency key naming
a bound object is refused. Those are genuinely different requests: the second one
asks to queue another delivery, and answering it with the first task's id would
misreport what was queued and to which device. One ciphertext, one delivery; a
second send is a second upload.

A share is never bound. It may back several tasks, keeps its link, and no task
owns it — the Phase 1B rule, unchanged.

**Reading it back.** `GET …/inbox/tasks/{taskId}/blob` keeps every Phase 1B
check (device-self, current claim token, live lease, non-terminal state, bounded
resumable stream) and adds one: a `device_task` object serves **only the task it
is bound to**. The check is applied at authorization time and again at the point
bytes leave, so a task row repointed by any means still cannot borrow another
delivery's ciphertext. Neither guard is load-bearing alone; a test proves the
property fails only when BOTH are removed.

## 27. Lifetime and cleanup

A `device_task` object is invisible by design — no link, no file-list row, no
public endpoint. That is exactly why it needs a sweeper: a share the user can see
is a share the user can delete, and this one they cannot. Three conditions mean
no legitimate reader remains, and GC reclaims the row and then the blob:

1. **unbound past the bind grace** (one hour). The sender binds moments after the
   upload finishes, so an object still unbound an hour later belongs to a send
   that never happened. Inside the grace it is kept, because the create that
   would bind it may be in flight;
2. **bound to a task that no longer exists** — cancelled by the owner, cascaded
   away with its device, or purged with the account. The task row was the only
   route to the ciphertext;
3. **bound to a task that is terminal** (`saved`, `expired`, `revoked`,
   `failed_terminal`). None can transition or be claimed again, and the blob
   endpoint only authorizes a live lease. The task ROW still survives its own
   retention window, so the sender's UI can keep explaining what happened.

The converse is the half that protects data: while a task exists and is
non-terminal, the ciphertext is kept, however long that takes. A device that is
offline, retrying, backing off or waiting on a person still has a delivery
coming, and deleting under it would turn a slow transfer into a lost one.

Two ordering rules, both deliberate:

- the reclaim pass deletes the **row first**, under a statement that re-checks
  the reclaim condition, and only then the blob. Unlike expiry, this condition
  can go from true to false — a create may bind the object between the sweep's
  list and its delete — so the conditional delete is what decides. The worst case
  is a retryable orphan blob, never ciphertext destroyed under a live delivery;
- `DELETE /api/devices/{id}/inbox/tasks/{taskId}` removes both rows atomically
  and drops the blob immediately, so cancelling a send returns the quota at once
  rather than at the next sweep. The delete predicate refuses `downloading` and
  `verifying` atomically with the removal: a queued-state UI snapshot may become
  stale while its confirmation is open, but it still cannot destroy ciphertext
  under a live lease. A share-backed task still deletes the task only.

A blob whose node is unreachable goes onto the existing `pending_node_deletes`
retry queue, the same as every other orphan; it is never silently dropped.

Deleting the object directly (`DELETE /api/files/{id}`) remains available to its
owner and keeps its Phase 1B cascade: unfinished referencing tasks become
`expired` past TTL, or `failed_terminal`/`stored_object_unavailable` when the
deletion is early.

## 28. Storage (Phase 1D-A)

Two columns on `stored_files`, both added by idempotent `ALTER` with a default,
so the migration is safe on a live database:

- `purpose TEXT NOT NULL DEFAULT 'share'`;
- `inbox_task_id TEXT NOT NULL DEFAULT ''`.

`UNIQUE(inbox_task_id) WHERE inbox_task_id <> ''` is the at-most-one-task
guarantee; a partial index on `purpose = 'device_task'` serves the reclaim sweep
without carrying every share in the table. `upload_sessions.purpose` carries the
decision from init to finalize.

Neither column can be a SQLite `CHECK`, because SQLite cannot add one by `ALTER`
to an existing table. The corresponding invariants — a binding implies
`device_task`, an unknown purpose is never written — are enforced in the store
and asserted by test instead. Unknown persisted values also fail closed at both
task creation and task-blob authorization: only an explicit `share`, or an
explicit `device_task` bound to that exact task, can back a delivery. `purpose`
is backfilled from empty to `share` on every boot rather than once, so a crash
between the `ALTER` and the first write cannot leave rows with a purpose the
public endpoints would refuse.
