# Relayium Device Inbox v3 — authenticated sender-device identity

Status: Stage 1 implemented in central, Web sender, shared protocol codecs and
tests. Native conversation presentation and local unread storage are later
stages; v3 must not deploy until the coordinated clients are ready.

v3 replaces v2 without a compatibility stack. Everything in
`relayium-device-inbox-v2.md` remains unchanged except the version/capability
vocabulary and the authenticated source-device requirement defined here.

## 1. Invariants

1. A task source is a server-minted device row ID proved by a device credential.
   It is never accepted from a create body, query, URL parameter or browser
   storage value.
2. Every new task has a nonempty source device belonging to the same account as
   its target and encrypted Stored Object. Cookie-only task creation fails.
3. Rename changes display name only. Reinstallation creates a new device ID.
4. Central may know account, source and target device IDs, ciphertext byte count,
   task state and timestamps. It still receives no plaintext, content kind,
   message, file/folder name, path, content key, private key or read state.
5. The target receives `SourceDeviceID` in its authenticated task/claim response.
   It keys a conversation by that stable ID, never by a mutable display name.
6. Protocol/capability mismatch fails with the existing closed 409 response. No
   downgrade to v2 exists.

## 2. Version and capability

- Protocol: `3` only.
- Required receive capability: `inbox.receive.v3`.
- Encrypted manifest: canonical `{"v":3,"items":[…]}` using the v2 item,
  bounds, framing and AEAD rules.
- Text presentation remains `inbox.text.v1`; auto-accept and resume capabilities
  are unchanged because their behavior did not change.

The create request still has exactly seven fields:

```json
{
  "idempotencyKey": "opaque sender key",
  "storedFileId": "opaque object id",
  "protocolVersion": 3,
  "wrapAlgorithm": "x25519-sealedbox-v1",
  "wrappedKey": "opaque sealed key",
  "targetKeyId": "server key id",
  "targetKeyGeneration": 1
}
```

`sourceDeviceId` is deliberately absent. Strict decoding rejects it, along with
all content/name/path fields. Central derives the source after authentication and
stores it in `inbox_tasks.source_device_id`.

## 3. Browser installation credential

While signed in, Web calls:

```text
POST /api/devices/browser-install
```

The server creates a browser device row and a random bearer in one transaction.
The raw credential is returned only as a cookie with `HttpOnly`, `Secure`,
`SameSite=Strict`, and `Path=/api/`; it is never returned in JSON and never put
in localStorage, sessionStorage, a URL or a log. A valid same-account cookie
converges on the existing device ID.

For task creation, central requires both the signed-in account session and this
installation credential. A credential bound to another account cannot supply a
source. A deleted device cascade-deletes its token; subsequent creates fail with
`sender_device_required`, and presenting that dead credential to the enrollment
endpoint fails with `browser_device_revoked` instead of silently undoing
revocation. Signing into another account may explicitly mint that account a new
browser identity; it never reuses the prior account's ID.

## 4. Storage migration

Old v2 rows with an empty audit source are preserved. Migration adds database
triggers that forbid every new insert, or source update, whose source is empty.
The create transaction separately proves both source and target device ownership
under the task account before insertion. Existing idempotent rows are returned
before current-device checks so a lost response can still converge after later
device removal.

Legacy empty-source rows are excluded from v3 claims and age out under their
existing TTL. A v3 receiver therefore never receives an unauthenticated empty
conversation identity, while central retains the historical row until normal
retention removes it.

Source device deletion does not erase a task's historical opaque ID. This is
intentional: a receiver may keep a local tombstoned conversation, while central
does not need a mutable display name or plaintext history.

## 5. Claim and privacy contract

Task views and claim deliveries include `SourceDeviceID`. Claim authorization,
one-time token/lease handling, target key binding, ciphertext download and state
transitions are unchanged. The source ID is metadata, not authority to claim,
read, report or cancel another device's work.

No fleet/node transport component parses Device Inbox task JSON or manifests in
the current architecture: the account server owns task schema/state and storage
nodes hold opaque Stored Objects. A fleet binary bump is therefore not required
by Stage 1 itself. A coordinated public cutover may still choose a new fleet tag
for release bookkeeping, but must not claim a node protocol dependency.

## 6. Required evidence before integration

- cookie-only, forged source, wrong-account and revoked credentials fail closed;
- enrollment response/calls contain no raw bearer;
- rename preserves source ID and reinstall produces a new one;
- duplicate create converges and source participates in request identity;
- v2-only registration/create is rejected with supported protocol `[3]`;
- old empty-source rows survive migration while new ones are refused;
- text, file and nested-folder manifests remain encrypted and vector-identical
  across Go, TypeScript and Swift;
- server requests, responses and logs expose no plaintext content/name/path/key.

Authoritative code is in `server/internal/inbox`,
`server/internal/inboxmanifest`, `server/account/deviceinbox*.go`,
`web/src/lib/{browser-device,device-inbox,device-send,inbox-manifest}.ts`, and
RelayiumKit's Device Inbox protocol/manifest models.
