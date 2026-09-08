# Android Device Inbox protocol foundation

The pure-JVM half of `inbox/3` on Android: the wire vocabulary, the v3 encrypted
manifest codec, and the `x25519-sealedbox-v1` content-key wrap. It lives in
`apps/android/protocol/src/main/kotlin/com/relayium/protocol/inbox/`, has no
Android dependency, and runs in the SDK-free `:protocol:test` lane.

**This is not a shipped Inbox feature.** No Android build registers a device
inbox, announces a capability, claims a task or receives a delivery. What exists
is the layer those things will be built on, pinned to the same frozen vectors and
the same libsodium bytes the other clients are pinned to, so the app slice that
follows starts from a codec that already agrees with central, the Web, the CLI
and RelayiumKit.

## The three files

### `InboxProtocol.kt` — vocabulary and bounds

Mirrors `server/internal/inbox/{inbox,task}.go` and RelayiumKit's
`InboxProtocol.swift`. Constants (`VERSIONS`, `KEY_ALGORITHM`,
`SEALED_BOX_BYTES`, lease/heartbeat/claim values, announce bounds) plus the
closed sets: `InboxAutoAccept`, `InboxPresence`, `InboxTaskState`,
`InboxDeviceErrorCode`, `InboxCentralErrorCode`, `InboxTaskErrorCode`,
`InboxRejection`, and `InboxCapability`'s tokens.

Every set fails closed: `fromWire` returns `null` for a token this build does not
know, and no caller may turn that into a default. Three splits are load-bearing:

* **v3 only.** `VERSIONS` is `[3]`. v1 and v2 are named so they can be refused by
  name, not so they can be negotiated down to.
* **Device codes and central codes are different sets.** A device may submit
  `disk_full`; it may never submit `lease_expired`. `InboxTaskErrorCode` unions
  them for READING a row, and the report path stays restricted to
  `InboxDeviceErrorCode`.
* **`isDeviceReportable` is narrower than central's transition table.** The table
  itself is deliberately not mirrored here — it is central's authority over rows
  this device does not own.

`InboxCapability` names the tokens but there is **no announced-capability
constant**. A token is a claim about a surface that ships; the app slice that
builds a receive surface announces exactly the tokens it implements.

### `InboxManifest.kt` — the v3 encrypted manifest

The fourth implementation of one codec, after `server/internal/inboxmanifest`,
`web/src/lib/inbox-manifest.ts` and RelayiumKit. Encoder, strict decoder, the
bounds, and the frame-0 seal/open.

Deliberately **separate from the Stored-Wire manifest**
(`com.relayium.protocol.stored.StoredManifest`). Both occupy frame 0, under the
same content key, at the same sequence number; a v1 `{"files":[…]}` document must
therefore fail here as an unsupported VERSION rather than be read as a nameless
file. `InboxManifestStrictnessTest` asserts that refusal in both directions.

Invariants: kind is sealed (central cannot tell a message from a file delivery);
one kind per delivery; canonical or refused (`decode` re-encodes and requires
byte equality); AEAD is not validation; the message text never appears in the
manifest, only its length.

`isAcceptableName` is the **platform-neutral** rule — the same names accepted on
every receiver. Platform hardening (SAF display names, Windows reserved names,
case-insensitive collisions) belongs to the receiver's destination planner, which
on Android is `Filename.resolveRelativePath` and `StoredDestinations`. Those run
*after* this rule, never instead of it, which is why no destination validator is
exposed here.

### `InboxSealedBox.kt` — `x25519-sealedbox-v1`

libsodium's `crypto_box_seal`, composed from the lightweight BouncyCastle
primitives already pinned in `gradle/libs.versions.toml` (1.85.2). No JCE
provider is registered and no native dependency is added.

```
ephemeral_pk = X25519_base(ephemeral_sk)             // fresh per seal
k            = HSalsa20(X25519(ephemeral_sk, target_pk), zero16)
nonce        = BLAKE2b-24(ephemeral_pk || target_pk)
stream       = XSalsa20(k, nonce)
ciphertext   = content_key XOR stream[32…]
tag          = Poly1305(stream[0…32), ciphertext)
sealed       = ephemeral_pk || tag || ciphertext     // 32 + 16 + 32 = 80 bytes
```

Three details a port gets wrong, each with its own test: the tag precedes the
ciphertext; the Poly1305 key is `r || s` unswapped; HSalsa20 is the Salsa20 core
with the feed-forward **subtracted**, words 0, 5, 10, 15, 6, 7, 8, 9.

Public API: `encode`/`decode` (canonical unpadded base64url, length-checked
first — 43 characters for a public key, 107 for a wrapped key),
`validatePublicKey`, `isLowOrder`, `generateKeyPair`, `sealContentKey`,
`unsealContentKey`. `InboxDeviceKeyPair` validates both halves at construction,
copies in and out, redacts its `toString`, and refuses use after `destroy()`.

Failures are `InboxKeyException(InboxKeyReason)` and carry no values. `UNSEAL` is
deliberately opaque — wrong key, tampered box and low-order ephemeral key are one
answer, because naming the difference would be an oracle and the caller's
response is identical either way.

## Tests

`:protocol:test`, 40 cases across four classes, all SDK-free:

| class | what it pins |
| --- | --- |
| `InboxProtocolTest` | the closed sets and bounds, and that an unknown token is `null` |
| `InboxManifestVectorTest` | the frozen `device-inbox-manifest-v3-vectors.json`: 13 accept, 55 refuse, 6 generated |
| `InboxManifestStrictnessTest` | what a JSON string cannot express — invalid UTF-8, lone surrogates, the byte-measured name bound, frame 0, and the v1/v3 separation |
| `InboxSealedBoxTest` | libsodium's own bytes, RFC 8439 Poly1305, RFC 7748 X25519, and the tamper / wrong-recipient / low-order / spelling negatives |

The manifest fixture is declared as a Gradle content input in
`protocol/build.gradle.kts`, beside the three that were already there, so a
fixture-only edit re-runs this suite instead of leaving it `UP-TO-DATE`.

The sealed-box vectors are transcribed from output the installed
`libsodium-wrappers` produced, never from this implementation — a codec checked
against its own output agrees with itself and with nobody. Their private halves
are generated test material and were never a device identity.

## What the app slice still has to build

Everything above the protocol. In rough order:

1. **Key storage.** Persist one `InboxDeviceKeyPair` per account in the Android
   Keystore-protected store. `privateKeyCopy()` exists for exactly that caller.
2. **Registration and heartbeat.** Announce `protocolVersions`, the capability
   set this build actually implements, platform, app version and the public key;
   honour central's returned lease and heartbeat values over the defaults here.
3. **Claim, download, decrypt, commit.** Claim one task
   (`InboxProtocol.CLAIM_BATCH`), unwrap the content key, open frame 0 with
   `InboxManifest.open`, and stream the rest through the existing
   `StoreDecryptor` into an account-scoped, app-owned `Received` container. The
   commit must be durable and verified, and its receipt written, BEFORE the task
   is reported `saved` — `saved` is earned by a completed local commit, not by
   bytes having arrived. Getting the file anywhere the user chooses is a
   separate, explicit open/share/SAF-export step afterwards, never part of the
   commit: SAF is a document-provider API with no POSIX atomic rename, so a
   receiver that wrote straight into a user-chosen tree could not offer the
   all-or-nothing guarantee the `saved` report claims.
4. **The destination planner**, running after `isAcceptableName` — the container
   and filesystem rules this codec must not know about.
5. **Progress reporting** restricted to `isDeviceReportable` states and
   `InboxDeviceErrorCode` values.
6. **EN/zh user-facing copy**, which belongs to the app slice, not here.

Only then does a capability token become honest enough to announce.
