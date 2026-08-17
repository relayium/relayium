# Relayium Device Inbox v2 — content kind, the encrypted manifest, negotiation

Status: **stages S1 and S2 delivered.** This document specifies what v2 changes
about v1: the protocol and capability vocabulary central negotiates (§2-§4), the
one non-opaque field a sender declares when it creates a task (§5), and the v2
**encrypted manifest** — its shape, its canonical bytes, its bounds and its
refusals (§6-§11).

Everything v1 specified and v2 does not restate is unchanged and still current:
device enrolment, public-key registration/rotation/revocation, presence, the
task queue and its server-visible state machine, the receiving-client
obligations, the task-purpose opaque upload, and the native macOS receiver core.
Read `relayium-device-inbox-v1.md` for those, with the substitutions in §2-§5
applied. It is **historical for the vocabulary it defines** and current for
everything else; it is not a compatibility target.

**There is no v1/v2 dual stack and no downgrade path.** The owner waived
old-client and old-protocol compatibility on 2026-08-17: there are no external
users yet and the release forces an update. Central speaks protocol 2 only,
negotiates `inbox.receive.v2` only, and refuses v1 rather than degrading to it.

**What S2 did NOT do, stated plainly: nothing calls the manifest codec yet.**
All three implementations exist, agree byte-for-byte on the frozen vectors, and
have no caller. No sender seals a v2 manifest and no receiver decodes one, so
frame 0 of a delivery on the wire today is still the shared Stored-Wire
manifest, exactly as in v1. §6-§11 therefore specify the format and the three
validated codecs that implement it — not yet the bytes any live delivery
carries. Wiring the codec into the sender and the receiver is S3, and until then
`protocolVersion: 2` on a create (§5) identifies the protocol generation both
sides negotiated, not a v2 manifest already inside that ciphertext. That gap is
safe only because there is no dual stack and no external users: every sender and
every receiver moves together, so no build ever reads a manifest written by a
build that disagreed with it.

Also not specified or implemented as of S2: which sender produces a text
delivery, which receiver presents one, how a message is stored locally, and the
migration/cutover of deployed clients. Those are stages S3 and later. Nothing in
this document describes shipped end-user behaviour on its own.

Authoritative implementation:

- `server/internal/inbox/inbox.go`, `server/internal/inbox/task.go` — protocol
  and capability vocabulary, and the create-side version check.
- `server/account/deviceinbox.go`, `server/account/deviceinbox_task.go`,
  `server/account/deviceinbox_store.go` — HTTP negotiation, task create, and
  send-target eligibility.
- `server/internal/inboxmanifest/` — the Go manifest codec.
- `apps/RelayiumKit/Sources/RelayiumKit/DeviceInbox/InboxManifest.swift` and
  `InboxProtocol.swift` — the Swift codec and vocabulary.
- `web/src/lib/inbox-manifest.ts` and `web/src/lib/device-inbox.ts` — the
  TypeScript codec and vocabulary.
- `apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v2-vectors.json` — the
  frozen cross-language vectors all three codecs are tested against.

Product source of truth: `DEVICE-INBOX-PRD.md`.

---

## 1. Invariants

v1's six invariants (§1 there) all still hold. v2 adds five.

1. **Kind is sealed.** A delivery's content kind — files or a message — exists
   only inside the authenticated encrypted manifest. Central never sees it. No
   request field, no response field, no column, no log line and no notification
   carries it, so a message and a file delivery are indistinguishable to the
   server, to its operators and to anyone reading its storage.
2. **One kind per delivery.** Every manifest item declares its kind and all of
   them must agree. A mixed manifest is refused, not partly honoured: a receiver
   that split one would have to write half a delivery into the user's receive
   folder and half into its message store.
3. **Canonical or refused.** A manifest has exactly ONE valid byte sequence.
   Decoders re-encode what they parsed and require equality, so unknown fields,
   omitted fields, reordered keys, duplicate keys, whitespace and non-canonical
   number spellings are refusals rather than tolerated variations.
4. **AEAD is not validation.** Opening the seal proves who wrote the bytes. It
   says nothing about whether the numbers and names inside them are safe to act
   on, so every bound in §8-§10 is applied after decryption, on the assumption
   that a sender may be hostile or simply broken.
5. **Text is not in the manifest.** A message's bytes travel in the encrypted
   frames like any other payload; the manifest carries only its length. Putting
   the message in the manifest would make the manifest's size a function of its
   content and would put plaintext into the one structure every receiver parses
   before it has decided the delivery is safe to accept.

---

## 2. Protocol version

Central speaks exactly one version.

| | value |
|---|---|
| `MinProtocolVersion` | 2 |
| `MaxProtocolVersion` | 2 |

Negotiation itself is unchanged from v1 §3: a client announces the set it
supports, central returns the highest common one, and an empty intersection is a
409 `unsupported_protocol_version` carrying `supportedProtocols` — never a
silent fallback to the minimum.

What changed is that the set now contains only `2`. A client announcing `[1]` is
refused. `ProtocolV1 = 1` remains a **named constant** in every implementation
precisely so that refusal can be asserted by name and read as deliberate rather
than as an accident of a range check.

## 3. Capabilities

| token | required | meaning |
|---|---|---|
| `inbox.receive.v2` | **yes** | this device can claim a queued task, unwrap its content key, decode a v2 manifest, verify, and commit atomically |
| `inbox.text.v1` | no | this receiver presents a text delivery **as text** |
| `inbox.autoaccept.v1` | no | implements the default-off automatic-receive policy (v1 §5) |
| `inbox.resume.v1` | no | resumes an interrupted ciphertext download from a complete frame boundary |
| `inbox.receive.v1` | — | **historical.** Not negotiable. Named so it can be refused by name. |

`inbox.receive.v2` is the only family central negotiates, for the reason v1 gave
in §4: a device central cannot describe must not appear in a send target list at
all. Every other token is carried verbatim, deduplicated and sorted, for a
SENDER to interpret.

### `inbox.text.v1` is a truth claim, not a feature flag

Central neither requires nor interprets it, and could not verify it if it wanted
to — content kind is sealed (invariant 1). The token exists for the sender,
which reads it off the device list to decide whether offering "send text" to
that target would be honest.

Its **absence is meaningful**. A receiver that would write a message into the
user's downloads folder as a `.txt` file must not announce it: the sender would
then promise a message and deliver a file. A build announces `inbox.text.v1` in
the same commit that makes it true and never one commit earlier.

As of S2: the CLI receiver announces `inbox.receive.v2`, `inbox.autoaccept.v1`
and `inbox.resume.v1`, and deliberately not `inbox.text.v1` — it has no message
store. RelayiumKit announces the same three for the same reason; the token is
defined in `InboxCapability.textV1` and added when S3 ships the store and its
surface.

## 4. Send-target eligibility

A stored `device_inbox` row keeps whatever `receive_capability` was negotiated
when it last registered, so eligibility must be re-decided against **the
currently negotiable set**, not against a hard-coded token. Written as
`== inbox.receive.v1`, this check kept every previously-enrolled device eligible
straight through a protocol bump, and would have offered v2 senders a target
that can only read v1 — discovered only after the file was encrypted, uploaded
and queued.

`DeviceCanReceive` therefore requires: enrolled, not revoked, stored protocol
version within `[Min, Max]`, stored receive capability ∈
`SupportedReceiveCapabilities()`, and an active public key. Presence is
deliberately not part of it (v1 §7.3): an offline but properly enrolled device
is a legitimate target.

## 5. Task create gains exactly one field

`POST /api/devices/{id}/inbox/tasks` (v1 §17) gains a **required** integer:

```jsonc
{
  "idempotencyKey": "…",
  "storedFileId": "…",
  "protocolVersion": 2,   // NEW in v2, required
  "wrapAlgorithm": "x25519-sealedbox-v1",
  "wrappedKey": "…",
  "targetKeyId": "…",
  "targetKeyGeneration": 1
}
```

Seven keys, and the seventh is a bare integer. There is **no** `kind`, `text`,
`message`, `name`, `path`, `manifest`, `itemCount` or key material on this
request and there must never be one — that is the whole reason kind moved inside
the seal. Decoding is strict, so a create carrying any of those is a 400 rather
than a field central silently ignores today and a later, less careful edit
starts honouring.

`protocolVersion` says which protocol the manifest sealed inside the ciphertext
was **written to**. It is checked at create rather than inferred from the target
device's registered version, because they are different claims by different
parties: the device says what it can READ, the sender says what it WROTE, and
only the sender knows. (As of S2 no sender has written a v2 manifest yet, so the
field currently carries the negotiated protocol generation and acquires its full
meaning when S3 seals one — see the status note at the top.)

Refusal: **409** `unsupported_protocol_version` with `supportedProtocols`,
matching the registration path — the request was well-formed, the two sides
simply do not overlap, and the client's correct move is to upgrade, not to fix
its JSON. Checked before every other field for the same reason. Fails closed on
`0`, which is what an omitted field decodes to, so a create that forgot the
field is refused rather than defaulted to the current version.

Central validates the version and does **not** store it: there is no per-task
protocol column and none is exposed on the task view, so nothing on a task row
can later be mistaken for a description of what the delivery contains.

---

## 6. The encrypted manifest

Frame 0 of a delivery's ciphertext is the manifest; frames 1… are the payload,
concatenated in item order. The framing, chunking and AEAD are unchanged. (From
S3 — as of S2 this section specifies the format and its three codecs, and a live
delivery still carries the shared Stored-Wire manifest. See the status note at
the top.)

A **dedicated codec**, deliberately separate from the shared Stored-Wire
manifest (`storecrypto.Manifest` / `StoredManifest` / `manifest.ts`). That
manifest describes public share objects whose bytes are frozen and interop-
tested across unrelated products; teaching it a content kind would change what a
share object looks like. The Device Inbox manifest is free to be stricter, and
is. **The shared manifest's bytes are unchanged by v2.**

### Shape

```jsonc
// files
{"v":2,"items":[{"kind":"file","name":"trip/day 1/IMG_0001.jpg","size":4096}]}

// a message
{"v":2,"items":[{"kind":"text","size":11}]}
```

| field | type | rule |
|---|---|---|
| `v` | integer | exactly `2` |
| `items` | array | 1…1000 entries |
| `items[].kind` | string | `"file"` or `"text"`; all entries must agree |
| `items[].name` | string | **present for `file`, absent for `text`** |
| `items[].size` | integer | see §9 |

`name` is *absent* for text, not empty. An empty string is something a receiver
could be tempted to treat as a destination; an absent key cannot be.

## 7. Canonical bytes

Exactly one byte sequence per manifest, and it is produced by a hand-written
encoder in all three languages. No standard-library encoder is used, because
each differs somewhere that matters: Go's `encoding/json` escapes `<`, `>`, `&`
and U+2028/U+2029 by default and JavaScript's `JSON.stringify` escapes none of
them; Swift's `JSONEncoder` routes keyed output through `JSONSerialization`,
whose key order is effectively hash-ordered and can differ between two calls in
one process. A canonical form cannot be built on any of them.

The rules, which match `JSON.stringify` exactly:

- no whitespace anywhere;
- fixed key order: `v`, `items`; within an item `kind`, `name`, `size`;
- `name` omitted entirely when `kind` is `text`;
- item order is the SENDER's, never sorted;
- escaped: `"`, `\`, and the C0 controls — `\b \t \n \f \r` by name, the rest as
  lowercase `\u00xx`;
- emitted raw as UTF-8: everything else, including DEL (U+007F), C1 controls,
  bidi overrides such as U+202E, U+2028/U+2029 and all non-ASCII text;
- `/` is never escaped;
- integers in their shortest decimal form — `2`, never `2.0` or `2e0`.

Decoding parses, validates, re-encodes, and **requires the result to equal the
input bytes**. That single rule is what makes the codec strict without a
hand-written parser: it catches a duplicated key where the last would win, an
omitted `size` that defaulted to zero, `{"items":…,"v":2}` in the wrong order, a
trailing newline, an escaped `\/`, a needlessly escaped `<`, and pretty
printing — none of which a lenient parser would report on its own.

(The C0-control escapes are unreachable from a valid manifest, because §8
refuses those characters in a name outright. They stay in the encoder as the
shared written rule and as defence in depth.)

## 8. File names

Refused, in every implementation, identically:

- empty, or over **1024 UTF-8 bytes**;
- not valid UTF-8 (including a lone surrogate);
- any C0 control byte or DEL — these truncate C strings and rewrite terminal
  lines as a name is logged or displayed;
- a backslash anywhere: `/` is the separator by protocol, and a backslash means
  "separator" on Windows, so the same manifest would otherwise produce different
  trees on different receivers;
- a leading `/`, or a drive prefix (`C:…`): an absolute destination, which leaves
  the receive folder entirely;
- any `""`, `"."` or `".."` component: traversal, the classic Zip-Slip;
- more than **64** `/`-separated components.

A name MAY be a relative path, so a folder send keeps its shape.

Every positional rule above is measured on the name's **UTF-8 bytes**, not on
any runtime's string indices. The drive prefix is the one that bites: in
`é:1.txt` the `:` sits at UTF-16 index 1 and at byte index 2, so a check written
against JavaScript string indices refuses a name Go and Swift accept — one
manifest, two verdicts. The accept vector *"the drive-prefix rule is measured in
bytes, not code units"* pins it in all three.

This rule is deliberately **platform-neutral**: exactly these names are accepted
on every receiver, so one manifest is accepted or refused identically
everywhere. A name that only some of a user's devices can receive is worse than
one none of them can. Platform-specific hardening — Windows reserved device
names, components ending in a dot or a space, case-insensitive collisions —
belongs to the receiver's destination planner, which knows the filesystem it is
about to write to, and runs **after** this check, never instead of it.

## 9. Sizes

| | rule |
|---|---|
| file item | `0 ≤ size ≤ 9007199254740991` — zero is legal, an empty file is a real file |
| aggregate | the sum of all file sizes must also be ≤ 9007199254740991, checked incrementally so an int64 wraparound cannot look small |
| text item | `1 ≤ size ≤ 65536`, in UTF-8 bytes of the message |

The ceiling is JavaScript's exact-integer limit, not int64's, because one of the
three implementations runs in a browser: a size only Go and Swift could
represent exactly would decode to a different number there.

Text is bounded at 1 because an empty message is not a message and a receiver
asked to commit one would have to invent something to show; and at 64 KiB
because that is far more than anyone types and small enough for a receiver to
hold one in memory to display it without a streaming path of its own.

## 10. Text deliveries

- exactly **one** item. A second text item would have no way to be told apart
  from the first in the frame stream, since text carries no name — the receiver
  would have to guess the boundary.
- **no** `name` key.
- the message itself is **not** in the manifest (invariant 5). Its UTF-8 bytes
  are the payload frames; the manifest declares only their length.

## 11. Refusals

Each is a distinct, named clause, in this evaluation order. The order is part of
the contract: it is why a v1 `{"files":[…]}` document is diagnosed as
`version` — which a person can act on — rather than as "unknown field: files",
which is true and useless.

| order | clause | when |
|---|---|---|
| 1 | `malformed` | not JSON, not an object, trailing content after the document, or a `v` that is not an integer |
| 2 | `version` | `v` absent, or not exactly `2` (including v1's shape, which has no `v`) |
| 3 | `malformed` | unknown field on the manifest or on an item; a wrong type; a non-integer number spelling |
| 4 | `itemCount` | `items` absent, empty, or over 1000 |
| 5 | `unknownKind` | **item 0's** kind absent, empty, or not `file`/`text` (case-sensitive) |
| 6 | `mixedKinds` | any later item's kind differs from item 0's |
| 7 | *(text)* `textItemCount` → `textName` → `size` | in that order |
| 7 | *(file)* per item, in item order: `name` → `size`, then `totalOverflow` | so an item with both a bad name and a bad size is reported as `name` |
| 8 | `notCanonical` | valid, but not the one canonical spelling (§7) |

Kind validity is decided from item 0 and agreement from the rest, so a *later*
item carrying an unrecognised kind is `mixedKinds`, not `unknownKind` — it
disagrees with the delivery's kind, which is the refusal that matters.

Encoding applies the same clauses. A codec that only checked on the way IN would
seal a traversal name happily and leave the refusal to the receiver — after the
upload, and only if the receiver is this careful.

## 12. Cross-language vectors

`apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v2-vectors.json` is the
frozen accept/refuse fixture, read by all three implementations:

- Go — `server/internal/inboxmanifest/vectors_test.go`
- Swift — `InboxManifestTests` (`Bundle.module`)
- TypeScript — `web/src/lib/inbox-manifest.test.ts`

It is hand-authored, not generated. Regenerating it from an implementation would
make it agree with whatever that implementation currently does, which is the
opposite of what a frozen vector is for. It lives inside the Swift package
because SwiftPM can only load test resources from its own package directory; Go
and TypeScript reach it by relative path, so there is exactly one copy.

Each accept vector pins the canonical bytes in **both** directions — decode to
the stated shape, and encode that shape back to those exact bytes. Decoding
alone would let a lenient encoder pass.

Each refuse vector names the clause. A few carry `anyRefusal: true` and require
only that all three refuse: those are the documents the three JSON parsers
cannot observe identically — JavaScript's `JSON.parse` has already turned `1.0`,
`1e3` and `1` into one value before our code runs, and Go cannot distinguish an
absent key from a zero value without a pointer. Each language pins its own
clause for those in its unit tests.
