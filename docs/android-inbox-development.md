# Device Inbox on Android

Send files and messages straight to your own other devices, end-to-end
encrypted, through the account you are already signed in to. This document is
the development record for the Android half: what exists and what it
deliberately does not do.

## Status

**Component, runtime and host integration complete; the feature is
user-reachable.** `RelayiumApp` has an `Inbox` destination that opens
`InboxScreen` against the real `InboxRuntime`, and `TransferViewModel` owns one
runtime for the life of the process, adopted into each account in turn. `open`,
`export` and `share` are supplied for real — through a non-exported,
token-addressed grant provider and a SAF folder choice — so no control on the
surface is a menu item that does nothing.

Receiving is live whenever the APP is in the foreground, across all five
destinations: it is not tied to the Inbox tab being selected. The composition,
its lifetime rules and its fences are documented in
`docs/android-host-integration.md`.

The end-to-end gate has now been run, on the AOSP 36 emulator against the real
Go backend and the real Apple host modules: real files and messages exchanged
through an unchanged server, with the payloads checked by hash rather than by
the sender's own report. The receiving-policy transitions (`ask`, `off`), a send
cancelled mid-upload, and history read back after a restart — named entries, a
file's SHA-256, a message body, a deleted entry's tombstone — are part of that
run, as is the account boundary: a reader in a separate uid holding retained
grants finds every one of them unreadable after an actual account switch, and a
conversation the previous account owned is visible zero times.

What the emulator does not stand in for is a physical phone or an iPhone.
Everything above is real execution — the UI, the system services, the provider,
the peer — but none of it is a device certification, and no release note should
claim one.

One state on this surface has no live coverage and is not claimed to have any.
An upload whose single-shot publish never answered renders a dedicated
non-retryable row. A real dropped response reaches it, so it is not
unreachable — it is simply not produced by any run made so far, none of which
loses a response. It is covered by the JVM cases in `InboxRuntimeTest`, by the
string-parity test, and by review of the compiled surface.

The protocol foundation (`protocol/.../inbox/**`) is documented separately in
`docs/android-inbox-protocol.md`.

## What it does

- **Receiving is OFF by default**, and OFF means no heartbeat, no poll and no
  claim — enforced in this client, not only by the server refusing to queue.
  `ask` holds each delivery until a person on this device accepts it; `auto`
  accepts deliveries from the account's own devices.
- **Receiving happens only while the surface is open.** There is no background
  service and no notification, and the copy says so. Stopping tells the server
  the device is offline rather than leaving senders to wait out a presence TTL.
- **Sending** stages a durable job — content key, sealed manifest, framed
  ciphertext and idempotency key — before anything reaches the network, then
  uploads the ciphertext as a `device_task` object and creates the task. A retry
  names the JOB, so a repeat converges on the delivery the server already holds
  instead of creating a second one.
- **History** is rebuilt from durable sources: the receipts that prove a
  delivery landed, the messages that ARE the delivery, and the outgoing jobs.
  Deleting is a local tombstone; it cancels nothing and clears nobody's inbox.
- **Key health** is reported honestly, and a repair is explicit: it states that
  anything already queued to the old key stays sealed to it.

## The pieces

| File | What it owns |
| --- | --- |
| `inbox/InboxModel.kt` | The published state, and the authority that decides whether a result may still be published. Adoption cancels and joins the previous account's work before the new authority exists. |
| `inbox/InboxRuntime.kt` | The composition: refresh, the receive loop, policy, key repair, staging and sending, history commands. |
| `inbox/InboxServices.kt` | One account's pinned bundle, the durable policy store, and the descriptor lease that owns what a staging opens. |
| `inbox/InboxAndroidServices.kt` | The production factory: real Keystore, `noBackupFilesDir`, `StorageManager`, `ContentResolver`. |
| `inbox/InboxOutgoingText.kt` | The sender's own copy of a message it sent, so its history can show it. |
| `ui/InboxScreen.kt` | The surface, plus `InboxActions` — the seam a host constructs. |

The receiver, engine, commit, journal, key store, conversation ledger, send
plan, coordinator, preparer, transport and uploader are the accepted component
layer beneath this and are unchanged by it.

## Decisions worth knowing

**The authority fence, and why it cancels.** Almost everything suspends, and an
account can be switched mid-flight. Refusing to PUBLISH a stale result is not
enough: a superseded body can still be inside a durable write, a report to the
server, or an upload carrying the previous bearer. So `InboxModel.adopt`
invalidates first, cancels every owned job, JOINS them, and only then installs
the new authority — and it keeps ownership of a job until that job actually
completes, so an adoption that is itself cancelled (a host cancelling a
`LaunchedEffect` does exactly this) cannot orphan work the next adoption should
have waited for.

**One reconciler, not two deltas.** `start`, `stop` and a policy change do not
each apply a change to the loop; they record the desired state and run one
serialized reconciliation. Without that, a stop that had released the worker
handle and was still joining could be overtaken by a start — two loops, each
holding a claim — and the stop's `offline` announcement could land after the
start had said the device was listening. A finished key repair restarts through
the same gate for the same reason.

**The stored policy is authoritative, and arrives late.** A session begins at
OFF because that is the safe placeholder rather than an answer. `start()`
therefore sequences the refresh (which opens the services and reads the stored
policy) before the reconciliation, so a cold start with `auto` already chosen
begins receiving without the user toggling anything. A choice made while that
load is in flight is the newer fact and wins.

**Descriptors are owned by a lease, not by a `finally`.** A staging reads
through `ContentResolver`, and a provider read blocks in another process. A
`finally` runs when the block RETURNS — and the block is what is stuck — so the
lease closes from a coroutine that is cancelled alongside the read, on a
different dispatcher, and the close is what ends it. The provider is opened with
`openAssetFileDescriptor(uri, "r", CancellationSignal)`, which is cancellable
and also carries the subsection shape a plain descriptor cannot; the typed
variant follows for a provider that only streams. There is deliberately no
`openInputStream` fallback: it is the same binder call with nowhere to put a
signal, and using it after two cancellable forms failed would reintroduce the
hang the lease exists to prevent.

**A sent message keeps its own copy.** The spool is released when a job ends and
the manifest is sealed to a key that is destroyed after staging, so without a
record the sender's history could only say "a message, 41 bytes".
`InboxOutgoingTextStore` writes one sealed, account- and job-bound record at
staging. A job's identity is immutable: an identical repeat is idempotent, and a
DIFFERENT text under the same job id is refused rather than allowed to make the
history assert one message while the recipient receives another. Deleting a
history entry deletes the body with it, bodies first and the tombstone after —
the other order would leave plaintext the user believes they deleted.

**`saved` means the server said `saved`.** Expired, revoked and failed are all
terminal and none of them is evidence a file landed, so they record as stopped.

**Unknown free space is not zero.** The `StorageManager` seam answers null when
it cannot tell, and a null lets the delivery proceed and be decided by the write
itself. A zero would report `disk_full` on a device with plenty of room.

**No invented progress.** The upload reports no byte progress, so the surface
shows an indeterminate indicator and no percentage.

## Tests

JVM (`gradle -Prelayium.android=true :app:testDebugUnitTest`):

- `InboxRuntimeTest` — refresh and device partitioning, the two-current-rows
  refusal, off means no traffic, the durable policy, a key that needs repair
  stopping the loop before any claim, a delivery becoming exactly one unread
  entry, a text send with its stored body, retry not creating a second task,
  terminal-is-not-saved, local deletion that does not come back, a failed accept
  keeping the question, and an account switch that hides one history and
  preserves both.
- `InboxLifecycleTest` — adversarial gated suspensions: concurrent adoptions
  each returning their own authority, no authority published while old work is
  finishing, a cancelled adoption still leaving the next one waiting, rapid
  stop/start converging on one loop, a superseded stop not announcing offline, a
  cold start with a stored policy, one attempt per job with a blocked upload, and
  a repair that does not restart a loop the lifecycle stopped.
- `InboxSourceLeaseTest` — a REAL blocked loopback-socket read released by
  cancellation alone, with nothing external unblocking it.
- `InboxOutgoingTextStoreTest`, `InboxStringsParityTest`.

Instrumented (`scripts/android-inbox-acceptance.sh`): the real `InboxScreen`
under both maintained languages at font scales 1.0 and 2.0, every control
reached by scrolling.

## What is not covered

Each suite answers for its own scope, and mistaking one for another is how a
doc ends up claiming less than the project can prove. The runtime suites use
real stores and a SCRIPTED server, on purpose — they are component tests.
`scripts/android-host-acceptance.sh` is the composed-screen gate and exchanges
nothing, because a composed-screen test was never evidence about an app.
`scripts/android-host-system-acceptance.sh` owns what needs another process,
including nine `ExternalShareIngressTest` cases fed by a separate-uid sender
APK. `scripts/android-host-inbox-acceptance.sh` owns the live legs, and it is
the run described under Status: a real external open of one file and a real
share of three, whose bytes are checked by hash, the account and history
boundaries, and an end-to-end exchange against an unchanged Go backend and the
real Apple host modules. None of those is an open
gap; what follows is.

- **A physical phone, and an iPhone peer.** Every result above comes from the
  AOSP 36 emulator. What runs there is real, but hardware behaviour is not
  established by it and no result here claims to be a device certification.
- **The unresolved-upload row.** A real single-shot publish whose response is
  dropped reaches this state — it is not unreachable. It is simply not produced
  by the signed-out release navigation smoke, which never signs in and never
  uploads. Covered by the JVM cases in `InboxRuntimeTest`, by the string-parity
  test, and by review of the compiled surface.
- **Background delivery.** Not implemented, not promised, and the copy says so.
