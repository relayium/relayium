# Android Device Inbox — live acceptance against a real macOS endpoint

`scripts/android-host-inbox-acceptance.sh` is the **live** half of the Android
host evidence. Its offline sibling, `scripts/android-host-acceptance.sh`, proves
the shared host's own rules — five destinations, the bounded picker lease, the
share ingress, the scanner entry point — and says plainly that it does not prove
a real external share, a real permission journey or a real SAF round trip.

This run is where the Device Inbox actually crosses the wire.

```
ANDROID_SERIAL=emulator-5580 \
RELAYIUM_EXTERNAL_READER_APK=/path/to/private-inbox-reader-debug.apk \
  ./scripts/android-host-inbox-acceptance.sh
```

**Prerequisites.** An emulator on **API 33 or later** — the separate-UID reader
fixture declares `minSdk 33` — and a **disposable** one: this run resets the
debug application's data (see *Device state*). A Swift toolchain builds the peer
and the Go toolchain builds the throwaway server, both from source, every run.

`RELAYIUM_HOST_INBOX_LEGS=<n>` runs only the first *n* legs and stops. It takes a
count, not a name, and runs a **prefix** deliberately: the legs are a dependency
order, so selecting a later one without the history the earlier ones created
would assert against a device that never received anything. A truncated run says
so on the way out — *"This is not the suite"* — and leaves every claim below
unearned.

## The shape of the run

Three real participants, and no imitations of any of them:

| Participant | What it actually is |
|---|---|
| Android | the real `MainActivity`, its real `TransferViewModel`, the real `InboxRuntime`, the real Android Keystore |
| macOS | `LocalTransferPeer --role inbox-endpoint`, composing the shipped `InboxController`, `InboxSendModel` and `AccountSession` over a durable state root |
| Server | a throwaway Go server on an ephemeral loopback port |

Both sides are asked what they hold, and the two answers are compared. The
macOS endpoint walks its own receive root **off disk** rather than reporting its
own metadata, and the Android side does the same — so a comparison is between
two independent walks, not one value copied twice.

### One `am instrument` invocation per leg

`am instrument` exits `0` almost unconditionally: when the app crashed, when the
instrumentation could not be found, when the target package is not installed,
and when it printed nothing at all. Every leg is therefore checked by
`scripts/lib/instrumentation-result.sh`, which requires a specific number of
tests to have been **observed** to finish.

Running one `@Test` method per invocation makes that number exactly `1`, and it
makes each leg's barrier real: the fixture is re-provisioned per leg, and every
leg whose subject is *receiving* waits for the product's own `LISTENING` before
the Mac is asked to send.

The send-only legs deliberately do **not** wait for `LISTENING`. Sending does not
depend on the receive policy, and coupling them would make each send leg depend
on whatever policy its predecessor left behind — after the `OFF` leg, that wait
could never be satisfied.

State is **not** reset between legs. The reset happens once for the whole run
(see *Device state*), and the legs depend on that: later ones read the history
earlier ones created, and `historySurvivesARestart` exists to require specific
entries back.

**There is no `Assume` in `HostInboxLiveTest`, deliberately.** An
assumption-skipped test does not emit `INSTRUMENTATION_STATUS_CODE: 0`, so a leg
that quietly opted out would break the count — and a harness that then relaxed
the count would lose the ability to tell a passing run from an empty one.

The leg order in the script is a **dependency order**. Later legs read history
that earlier ones created, and `aNewIdentityCancelsTheOldAccountsWork` runs last
because it deliberately destroys the first account's state.

## What the suite asserts

Everything below is what a **passing** run has established. It is not a record of
what has been observed: legs are added and repaired over time, and a leg that has
never executed asserts exactly nothing. Per-run results live in the run's own
artifacts, and the standing limits are in *What this run does NOT prove*.

1. **A real sign-in, through the Account form.** Typed email and password, not
   an injected bearer — which is what exercises the host's credential adoption:
   `InboxHost.run` observing the account flow, `InboxAdoption` deciding this is
   a new identity, the runtime enrolling a device key under it. It then reaches
   Inbox registration, a device list that names the Mac and **excludes this
   device**, and a foreground worker that is actually listening. The Mac
   independently confirms it can see the Android row.
2. **Android → Mac.** A message whose leading and trailing whitespace is
   load-bearing, compared byte for byte against what the Mac read back through
   `InboxController.message`/`sentMessage` — the production accessors. Then two
   real `DocumentsUI` picks: an empty file, and one of 307 200 bytes with a
   Unicode name.
3. **Mac → Android.** The `android-parity` batch, compared by relative path,
   size and SHA-256 against an independent walk of what landed on disk. Nested
   Unicode path preserved, zero-byte leaf present, one file past a chunk
   boundary.
4. **Tab independence.** `AUTO` receives while the person is looking at Account,
   Cloud or Nearby. The presence claim is app-wide; an Inbox that only worked
   while you watched it would pass a single-tab test and fail a person.
5. **Background and resume.** A real Home key withdraws receiving; coming back
   restores the chosen policy and the held delivery lands rather than vanishing.
6. **ASK and OFF.** ASK prompts and honours **both** answers. The decline is the
   half worth testing, and it is judged by the SENDER: the Mac's own send row is
   identified by id and must never report `isSavedOnTarget` — the one predicate
   `InboxSendModel` exposes for "has it arrived". A count that did not move could
   equally mean the delivery was merely slow. OFF refuses through the model's own
   guard, and the other device sees the Android row as not sendable.
7. **History and the files it published.** Unread, mark-read *by reading*, the
   stored body, and a deletion scoped to ONE entry — addressed by a file name
   only that direction uses — which must leave the other rows standing.
8. **Both doors to another app.** A real SAF export that keeps the tree, then
   `Open` (`ACTION_VIEW`) and `Share` (`Intent.createChooser`) each handed to a
   genuinely separate-UID reader, chosen **by name** in the real resolver rather
   than taken as the only row. Each hand-off's receipt is judged as it happens —
   `ok`, a non-zero count, and per file `read1 && read2 && writeDenied` — because
   both doors write the same report and the second would otherwise overwrite the
   first, leaving `Open` proving a hand-off and nothing about bytes.

   The receipt is read across the UID boundary with
   `UiAutomation.executeShellCommand` running `run-as`, which the shell user may
   do for a debuggable package. That matters for more than convenience: the
   revocation proof has to observe one grant working and then stopping inside a
   single `am instrument` invocation, because `TransferViewModel.onCleared` calls
   `SharedFileGrants.revokeAll()` and every leg's teardown runs it. A baseline
   taken in one leg and re-checked in another would show the grant gone whatever
   the account did — the teardown would have done it — and the run would report a
   revocation nobody observed.
9. **Identity and persistence.** A new identity cancels the old account's work
   and cannot see its history. A restart must return a NAMED survivor — the
   exact entry the batch leg recorded, its file still at its relative path with
   its original digest, and the message body still exact — while the deleted
   entry stays gone. "History is not empty" would pass on a store that came back
   holding the wrong thing.

## What this run does NOT prove

### Receive-side cancellation

**Send-side cancellation is covered, and the barrier is real.**
`InboxSendStatus.Phase.STAGED` is documented "Prepared and durable; nothing has
been sent", so a cancel issued in that phase is provably before any upload and
the strong claim is available: the Mac must not hold the file and the outcome
must not be ambiguous. The phase at the moment of cancelling is recorded and
decides which claim is made — if the attempt was already in flight, the product's
own `ambiguous` flag ("may or may not have created a delivery") means the only
honest assertion left is that no success is claimed. Asserting a clean Mac there
would be asserting a race. The leg reports `provedMacUntouched`, so a round that
only ever reached the weak branch says so instead of reading as full coverage.

An earlier version concluded from an eight-second silence that nothing had
arrived. That proved nothing: absence over a window is not acknowledgement.

`LocalTransferPeer` has no cancel, hold, pause, throttle or delay control —
`/drive` accepts `refresh-targets`, `refresh`, `mark-read`, `send-text`,
`send-files`, `send-competing`, `delete-entry` and `delete-conversation`, and
nothing else. There is therefore no way to hold an Apple send mid-flight to open
a window in which Android cancels a **receive**.

Rather than fake a barrier, this is stated. The receive direction needs this sequence, run by hand against a device:

1. Run the harness through `receivesTheAndroidParityBatchWhileForeground` so the
   account, both device rows and the endpoint are up.
2. Set the Android policy to `ASK`.
3. `POST /drive {"command":"send-files","name":"<android>","batch":"android-parity"}`.
   The 307 200-byte file is what makes the window observable; a zero-byte
   delivery can finish between two samples, and a cancellation asserted against
   one would be asserting about a race.
4. While the Android surface reports `RECEIVING`, decline the prompt.
5. Assert, in this order: the Android surface claims no success; nothing new is
   under the entry's receive directory; and the Mac's `/observed` receipt set is
   unchanged from before step 3.

Step 5's third clause is the one that needs the peer, which is why it is a
root-run sequence rather than a harness leg.

### Physical hardware — neither side

The Android side runs on an **emulator**. Nothing here is evidence about a
physical Android device: no real radio, no vendor Android build, no real
`DocumentsUI` variant, no thermal or memory pressure a real handset applies.

The macOS endpoint is a real composition of the shipped Inbox modules, but it is
**not** a physical iPhone. Nothing here is evidence about iOS hardware.

Both halves of that matter for a launch claim, and neither is narrowed by how
many legs pass.

### Multi-append cloud upload

307 200 bytes crosses `STORE_CHUNK_SIZE` (192 KiB) and so spans two stored-wire
chunks — which is what "multiframe" means on this transport. It is still below
`CloudInboxUploader.APPEND_CHUNK` (1 MiB), so it is a single cloud append.
Covering the multi-append loop needs a payload over 1 MiB and is a separate
fixture.

## The `android-parity` fixture case

`EndpointBatch.make` in `apps/RelayiumKit/Sources/LocalTransferPeer/main.swift`
gained one named case for this lane. It exists because **`primary` cannot serve
it**: its largest file is `bulk.bin` at 96 000 bytes, and `STORE_CHUNK_SIZE` is
196 608 on both sides. A Mac→Android run built on `primary` proves nesting and
the zero-byte leaf and never crosses a chunk boundary at all. The note on
`AcceptanceBatch` about being "larger than one DataChannel message" refers to
the **realtime** frame; the Device Inbox is the stored wire.

The case adds three files — 307 200 bytes under a nested Unicode path, a
zero-byte leaf **not** last, and a loose file — on seeds 201… , clear of
`AcceptanceBatch`'s 1…5 and the existing 101…103. Every other case, the
`default`, every other role and all the Inbox/crypto modules are unchanged, so
the payloads of the existing macOS acceptances are byte-identical.

Two fences keep that honest:

* the script greps the built binary for the literal `android-parity` and
  refuses to start without it, so a binary predating this lane cannot silently
  fall through to `default`;
* the batch's own assertions require three files, one ≥ 307 200 bytes, one of
  zero bytes and a nested non-ASCII path — which the `primary` batch fails.

The peer is compiled from source by `acceptance_build` on every run, so there is
no prebuilt to mistake for it.

## Secrets

The account password and the peer's control bearer never appear in argv, in an
environment dump, or in a log.

`am instrument -e name value` puts the value in the **argv of a process**: it is
visible to `ps`, echoed by a traced shell, and written into the instrumentation
log that a failed run gets attached to. So the values are written into the app's
own `filesDir` over `run-as … cat`, with the bytes arriving on **stdin** and the
remote command a fixed quoted string. Nothing interpolates a secret into a
command line on either side.

`LiveFixture` deletes the file as it reads it, and the script removes it again
on every exit path — including a failure part-way through, because a leg that
died before `LiveFixture.load` consumed it would otherwise leave an account
password in app storage.

The whitespace-significant message travels **base64**, because `LiveFixture`
trims each value as it parses. A message whose whitespace is the thing under
test would otherwise arrive already corrected, and the assertion would pass
against a fixture that had quietly done the product's job for it.

Per-leg evidence is read from the app's private storage and **validated** as
JSON rather than echoed. Received file names are plaintext-derived and local;
they are not printed, and neither is any server or account log.

## Device state

**This run destroys the debug application's data.** Once, after installing and
before provisioning anything, it runs `pm clear` on the debug package. Run it
only against a dedicated acceptance emulator whose contents are disposable.

The reset is not optional and not cosmetic. `install -r` *preserves* application
data — it is an upgrade — so a device that ran this suite before comes up holding
the previous run's credential and restores that session on launch. The credential
is useless by then, because every run starts its own throwaway server on a fresh
ephemeral port, so the app sits signed in to a backend that no longer exists and
the first leg looks for a sign-in form that is correctly absent.

It happens **once per run, never between legs**: the legs are a dependency chain,
and a clear between them would destroy exactly what `historySurvivesARestart`
requires back.

The target is checked rather than trusted — the script refuses any package whose
id does not end in `.debug`, and the release application id is never named in it.
`pm clear` also resets runtime permissions, so `CAMERA` is re-granted afterwards
to restore what `install -g` had set.

Besides that, the run changes one setting — `debug.relayium.backend` — and reads
its prior value **before** touching anything, so a failure part-way through
restores what it found rather than what it assumed. Cleanup runs on every exit
path and kills exactly the PIDs the run started: there is no `pkill` and no
pattern match.

## Dependencies

* `RELAYIUM_EXTERNAL_READER_APK` — the separate-UID reader fixture, built at
  `minSdk 33`. The run installs it and drives it through the product's own
  open/share actions. Its reports are read over `run-as` from two places for two
  different reasons: the harness judges the standalone hand-off leg after it
  finishes, and the identity-switch leg reads them from inside the test, because
  the revocation proof cannot survive an invocation boundary. It is not
  reimplemented here.
* Toolchain: `JAVA_HOME` on JDK 17, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, a Swift
  toolchain for the peer, and the Go toolchain for the throwaway server.
