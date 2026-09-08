# Device Inbox on Android

Send files and messages straight to your own other devices, end-to-end
encrypted, through the account you are already signed in to. This document is
the development record for the Android half: what exists, what it deliberately
does not do, and what still has no host.

## Status

**Component and runtime complete; not yet reachable in the app.** Everything
below is implemented, tested and composable, but nothing in `MainActivity`,
`RelayiumApp` or the navigation opens `InboxScreen` yet — that integration is a
separate, serialized task, because the shared navigation and Activity files are
owned by other in-flight work. Until it lands, the feature ships as code that is
built and tested but not user-reachable, and no release note should claim
otherwise.

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

- **Navigation, SAF and share-target ingress.** The surface exposes state and
  actions; no host constructs them yet. A composed-screen test is not evidence
  about an app.
- **A live server.** The runtime suites use real stores and a scripted server;
  the end-to-end run against an unchanged backend, with real files and messages
  in both directions, is the integration harness's gate.
- **Background delivery.** Not implemented, not promised, and the copy says so.
