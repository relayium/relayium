# Android ↔ Apple on the local link: what the two rounds prove

Two acceptance runs put the Android app and the **shipped Apple local-link
modules** on one real `_relayium._tcp` link. They cover different things, they
are not interchangeable, and neither is evidence about Apple hardware.

| run | direction | who dials | what only it shows |
|---|---|---|---|
| `scripts/android-nearby-apple-acceptance.sh` | Android → Apple | Android | the Android build's discovery record parsed by the shipped Apple parser, its framing read by the Apple reader, its `link/1` handshake answered by the Apple link surface |
| `scripts/android-nearby-apple-bidirectional-acceptance.sh` | **both**, on one link | Apple by default | the shipped Apple modules ORIGINATING a transfer: their manifest, their chunk stream and their sealed text frame consumed by this app's receive path — plus an inbound link Android did not ask for |

Everything below is about the second one. The first is documented in its own
header and is unchanged by it.

## What is real, and what the Apple half actually is

* the real Android debug APK on a real instance, through its own
  `MainActivity` and the `TransferViewModel` that Activity created: real
  `NsdManager`, real TCP signalling, real native WebRTC, the real SAF stack, the
  real system **file** picker and the real system **folder** picker;
* on the Mac, a fixture **caller** under `scripts/fixtures/android-nearby-apple`
  that composes the unchanged shipped `LocalPeerAdvertisement`,
  `LocalPeerSignalingChannel`, `NetworkLocalPeerTransport`, `LanDiscoveryModel`,
  `NearbyReceiveModel` and `LinkWorkspaceModel` — the same factories, arguments
  and order `LocalTransferPeer`'s own `LocalLinkPeerHost` uses;
* real `NsdManager` on one side and real Bonjour on the other. **No address is
  passed to the Android half at any point.** It must find the Mac by the name
  and the advertisement identity the Mac minted for that run, and both are
  compared for exact equality.

**Read the Apple half precisely.** It is the shipped Swift modules compiled from
this repository, running on the host as a macOS process. It is not an iOS
binary, not the iOS app, and not a device. A Mac running shipped modules is not
an iPhone, and a green run must never be described as physical-device evidence.

### Why a fixture caller rather than the existing peer

`LocalTransferPeer --role local-link-peer` is receive-only by construction:
`LocalLinkPeerRun` finishes the moment an inbound batch commits, and the shipped
peer's `/drive` route answers 409 for that role. So the one direction it can
evidence is Android → Apple, which it has. Nothing else in the repository could
make the shipped Apple modules originate a local-link transfer against a second
implementation.

### Why one module is copied, and how that is kept honest

`apps/RelayiumKit/Package.swift` exports `RelayiumKit` (which vends `RelayiumKit`
and `RelayiumAppKit`) and `RelayiumLocalPeerKit` as products. `RelayiumPeerKit` —
`LinkCounterpart`, `LoopbackControlServer`, `FileReceipt`, `sha256Hex` — is a
**target** by design, so nothing it contains can reach a signed build, and a
target is not importable from another package.

`scripts/fixtures/android-nearby-apple/prepare.sh` therefore mirrors that
directory verbatim into a disposable copy of the fixture package and
**SHA-256 checks every file** against the repository's own before anything
compiles; the hashes are written to `module-hashes.txt` and preserved with the
run's evidence. No upstream file is edited, and no copy of it is checked in.

## Running it

```sh
export JAVA_HOME=…            # JDK 17
export ANDROID_HOME=…         # or ANDROID_SDK_ROOT
export RELAYIUM_APPLE_BIDI_ARTIFACTS="$HOME/some/evidence/dir"   # see below
./scripts/android-nearby-apple-bidirectional-acceptance.sh emulator-5580
```

Preconditions the run checks for itself, and fails on rather than works around:

* the Go toolchain, a Swift toolchain and `python3`;
* the instance is reachable and reports an `ro.product.model`, which is the name
  the app advertises (`TransferViewModel` reads `Build.MODEL` once and
  `LocalPeerAdvertisement.sanitizeName` trims it);
* **exactly one** device on the link answers to that name. Two identical
  emulator images report the same model, and a round that could not say which
  one it linked to would be reporting a coin toss.

### Evidence

On failure the shared cleanup keeps the run root and prints a diagnosis. On
**success** it removes the run root, so set `RELAYIUM_APPLE_BIDI_ARTIFACTS` to a
directory to keep the reports, both logs and the mirrored-module hashes. A
passing round whose evidence was deleted cannot be audited afterwards.

### The one device setting it changes, and how it is put back

The run points the app at its own throwaway server through
`debug.relayium.backend`. That property belongs to the device, and
`Backend.readDebugOverride` fails **closed** to the real service — so
`setprop … ""` does not mean "leave it as it was", it means "point this device
at production on its next launch". The run therefore:

* captures the previous value **before** writing anything, and restores only if
  it captured *and* overwrote — a failure in the preflight or either build
  leaves the property untouched;
* quotes the captured value as one POSIX token and **proves the quoting against
  the device** before mutating anything, because `adb shell` re-joins argv into
  a single remote command line where an unquoted value would split or execute;
* refuses to overwrite a value it could not reproduce, rather than replacing it
  with a guess;
* removes only the single `\n` that `getprop` terminates its output with.
  Whitespace inside the value is part of the value.

## Which side dials, and which assignment has actually passed

Two assignments, and **only one of them has produced a green round.** Read this
before reporting anything about this lane.

### `--dial-side android` — the assignment that passes

The phone presses Connect. This is the configuration the complete round has been
observed green in: both directions, all three file shapes each way, the nested
Apple path, text both ways, matching SAS, real SAF on both pickers and both
teardown barriers.

Because the phone dials, **this assignment does not exercise the phone's inbound
consent path.** The Mac's fixture admits an unsolicited link without a person,
and the oracle requires the `promptedBy` evidence only for the other assignment.
A green android-dial round says nothing about the phone answering a link it did
not ask for.

### `--dial-side apple` — the DEFAULT, and its route is unverified

The Mac presses Connect, so the round would also cover the inbound consent the
other assignment cannot. It has been attempted and has **not** completed:

* the Mac took the initiator branch and its transport failed at its own 30 s
  deadline, while the phone's admission path never saw anything. Its roster held
  the Mac throughout, so the manifest guard in `offerAdmission` is not the
  explanation, and the Mac's own outbound stream never closed;
* a raw `NWConnection` probe to the same service, with the same parameters,
  reported **`indeterminate`** — `.preparing` only for 30 s, zero bytes. Neither
  `ready` nor a route failure.

So the honest state is: **the host→instance dial has not been shown to work and
has not been shown to fail.** `NWEndpoint.service` folds mDNS resolution and the
TCP handshake into `.preparing`, so that probe cannot separate "the instance
name never resolved" from "it resolved and the SYN went unanswered". There is a
reason to suspect resolution: the phone's own browse loses the Mac repeatedly on
this link (`1→0→1→0` over a couple of minutes) while the Mac's browse holds the
phone continuously, and a service-addressed dial re-resolves at connect time.

**No claim is made that the route is impossible.** It is unmeasured, on this
host, with this emulator networking.

`apple` remains the default because changing it is a product-harness decision
rather than a documentation one, and the file is frozen. Anyone running this for
the reverse-direction evidence should pass `--dial-side android` explicitly, and
whoever next owns the file should consider whether the proven assignment ought
to be the default.

### Answering the dial question in half a minute

The fixture package also builds a `dial-probe` role, which is a **diagnostic and
not an acceptance**. It advertises, waits for the named Android instance, dials
the product's own service triple (`LOCAL_PEER_SERVICE_TYPE` /
`LOCAL_PEER_SERVICE_DOMAIN`, addressed by identity) and reports what
`NWConnection`'s own state machine said:

| verdict | what it means |
|---|---|
| `ready` | **positive** — the TCP connection was established to the resolved service. Not a claim that a `link/1` would succeed over it; only the round shows that |
| `failed` | **positive** — refused, or the route could not be used. Carries the framework's own error |
| `waiting` | **positive**, and distinct from a refusal — the path cannot currently be satisfied and the framework is still retrying. Carries the error |
| `indeterminate` | **no conclusion.** Still `.preparing` at the bound. An unanswered SYN looks exactly like this, and so does a slow one |

The ordered transition list and any bytes received are reported beside the
verdict as secondary facts; neither is the verdict. `ready` is reported even if
the connection later closed, because a connection that was established proves
the route exists — telling that apart from an unroutable address is the whole
reason this shape exists.

An earlier version of this probe inferred a single word from "no close within
the window", which observed nothing: a connection still in `.preparing` neither
closes nor connects, and a close can be an application-level close after a
perfectly reachable handshake. Both readings were reported as one answer. It was
replaced, and a run must not be diagnosed from the old wording.

The **parameters** are reconstructed (`.tcp`, `includePeerToPeer = false`, empty
`prohibitedInterfaceTypes`) rather than taken from the product, because
`NetworkLocalPeerTransport.parameters(_:)` is `internal` and the fixture package
is outside its module. That is why this is a private diagnostic and not
transport acceptance: a verdict here is about a route, never about the product's
own dial. No product module is modified or reached into.

It needs the Android instance to be advertising, which means the app's Nearby
surface has to be running — started through the real UI, or by a round that got
that far.

## What the round actually asserts

Three file shapes travel in **each** direction, because each has passed
something it should not have before: a payload past the 192 KiB logical fragment
boundary, a **zero-byte** file (which every length-based check passes
trivially), and a **Unicode** name.

Nested `path` is exercised **Apple → Android only**, and that is a product fact
rather than a gap: Android's Nearby send surface is
`ActivityResultContracts.OpenMultipleDocuments` — files, never a folder — so the
app cannot originate one. The launcher, the instrumentation and the oracle each
state this where it applies.

Every claim is judged by `scripts/test/android-nearby-apple-bidirectional-oracle.py`
from the two halves' own reports, and it holds three rules:

1. **every receipt is read from the RECEIVING side.** The Apple half's are read
   off `LinkCounterpart.liveReceipts`, which re-reads what the link's own writer
   left on disk; the Android half's are read back through the real
   `ContentResolver`, keyed by the document ids the app's own accepted manifest
   named. Neither side's digest for a file it *sent* appears in either report.
   The expected digests come from the launcher, which generated the bytes and is
   the only party that is neither sender nor receiver;
2. **a tuple is matched whole** — name, path, size and digest together, one
   receipt per expected file and one expected file per receipt. Field-by-field
   matching is how a round passes with one file's name and another's digest, and
   how a receiver that flattened a folder passes on names alone;
3. **nothing is a prefix, a substring or a truthy value.** Counts are strict
   integers (`isinstance(True, int)` is True in Python, and a count answered
   with `true` once passed this file); the SAS is checked for the six ASCII
   digits both implementations derive rather than merely for equality; and the
   origin is parsed for scheme, userinfo, host, port and path rather than
   prefix-matched, because `http://127.0.0.1:80@evil.invalid` satisfies the
   prefix and names a remote server.

### Two harness rules the first live rounds bought

**A press is scrolled to, proven reachable, and made once.** Compose will click a
node that exists in the semantics tree but is scrolled off screen, and report
success while nothing happens — indistinguishable from the product ignoring the
press. This round sends three batches on one link and the session column grows a
row per batch, so the choose-files button moves down the screen as it proceeds.
Every in-app press therefore does `performScrollTo`, then `assertIsDisplayed`
and `assertIsEnabled`, then exactly one `performClick`. Appearance is retried;
the press never is, because an assertion that passes only because it pressed
twice is not evidence about the press. "Could not reach it" and "it did nothing"
are separate failures, and the first carries the control's geometry — geometry
only, no label text and no content.

**A pick is confirmed by the send counter, never by the transient.**
`state.outgoing` is cleared on `SendComplete`, so a zero-byte file can be
picked, sent and acknowledged inside one 50 ms sample. A round whose counter had
already reached 2 failed waiting for the third pick to "come back" — the batch
had been delivered and the transient was simply never observed. The wait now
accepts *either* a pending pick *or* an already-advanced counter, and then still
requires the exact expected counter. That weakens nothing: the counter only
advances on the peer's own verified COMPLETE, and the oracle independently
requires one receipt per file at the receiving side.

For the same reason the post-disconnect roster claim is a bounded wait rather
than one sample: discovery on this link legitimately flaps — a measured round saw
the phone's own list go 1→0→1→0→1→0 across two minutes while the Mac advertised
continuously — so a single read can land in a gap. The wait is for the REAL
roster to list the exact device the round linked to; nothing fabricates a peer.

It also asserts the two implementations agreed on the **manifest itself** — what
the Mac declared and what the Android half accepted, including `path` — because
a disagreement there is the class of defect neither side's own tests can see,
and it would otherwise surface only as a digest mismatch blaming the wrong
cause.

### The two barriers

There are two moments where one endpoint's ordinary next step destroys something
the other is still asserting against, and one barrier only moves the race to the
phase after it:

* **transfer** — the Mac's receipts are read off a *live* link and the local
  message history is session state, so neither side may end the session while
  the other is still reading it. The launcher snapshots `/observed` while the
  link is open, then releases the phone;
* **room** — each side legitimately vanishes from the other's list the moment it
  stops advertising, which is correct product behaviour. The Mac withdraws its
  advertisement only after the phone has checked its own roster, and the phone
  stops Nearby only after the Mac has checked its own.

Both are out of band on purpose: the transfer's own wire is the thing under test
and cannot be its own completion oracle. Neither is a sleep.

## What has been observed green

On `--dial-side android`, one complete round: real Bonjour discovery with no
address ever passed to the phone, exact advertisement identities on both sides,
one `link/1` session with matching SAS, text in both directions compared by
equality at each receiving side, and every file matched as a whole tuple — name,
path, size, SHA-256 — at the RECEIVING side:

* **Apple → Android**: 307 200 bytes, a zero-byte file, and a nested Unicode
  path materialised under the real SAF tree grant;
* **Android → Apple**: 307 200 bytes, a zero-byte file, and a Unicode name, as
  three batches on the one link;

with real DocumentsUI on the file picker and the real tree grant on the folder
picker, and both teardown barriers released.

## What a green run does NOT prove

* **no physical device, anywhere.** The Apple half is the shipped Swift modules
  **compiled on the host and run as a macOS process**. It is not an iOS binary,
  not the iOS app, and not an iPhone; the Android half is an emulator, not a
  phone. This lane is evidence about the two IMPLEMENTATIONS agreeing on the
  wire, and it must never be described as physical-device evidence or as an
  iPhone result.
* **the Apple-initiated route is unverified.** See the dial section: the only
  green round is `--dial-side android`, and with it the phone's inbound consent
  path is not exercised. This is the one open evidence limit on this lane.
* it says nothing about the hub's code-less room, which is a WebSocket
  rendezvous rather than Bonjour, and nothing about the pairing-code path.
* Android → Apple travels as one batch per file, because this harness taps one
  document per visit to the real picker. Multi-select through DocumentsUI is not
  covered; several batches on one link is, and a single-batch round never took
  that path.
