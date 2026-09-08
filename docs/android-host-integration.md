# The Android shared host

How the accepted Android feature modules become one app: the destinations a
person can reach, who owns which lifetime, and the fences every asynchronous
result crosses.

Each feature — account, cloud, legacy interop, LAN/Nearby, the Device Inbox, the
ingress boundary, the QR scanner — has its own document and its own tests. This
one is about the **composition**: `MainActivity`, `TransferViewModel`,
`RelayiumApp`, and the `integration/` package that joins them.

## The five destinations

`Destination` is `TRANSFER, NEARBY, INBOX, CLOUD, ACCOUNT`, in that order. Every
one opens a real surface; there is no destination for a feature that is not
implemented, because one that opens onto a placeholder is a claim the product
does not honour.

The bar has two forms. When each destination can have a full label it is a
Material `NavigationBar` with an even split; when it cannot — a genuinely narrow
screen, or a font scale above 1.3 — it becomes a horizontally scrolling row
where each destination gets the width its label needs, so nothing is abbreviated
and nothing is hidden behind a menu.

The threshold is `MIN_LABEL_DP = 72`. That is deliberate and it changed when the
fifth destination was added: at 88dp, five destinations need 440dp, which is
wider than almost every phone — so ordinary devices at the default font size
would have fallen into the scrolling form, where the fifth destination starts
off screen and has to be found by swiping a bar most people will not think to
swipe. Making Inbox and Account reachable only by a gesture is a
discoverability regression, not a layout preference. At 72dp the common case is
the standard bar with all five visible, and the scrolling form stays what it was
designed to be: the fallback for 320dp or a large font, where nothing could have
fitted and scrolling beats truncating.

## One foreground answer, app-wide

Two features make a presence claim to somebody else. Nearby advertises this
device on the local link and holds sockets open; the Device Inbox tells central
it is listening, which is what makes a sender's delivery arrive rather than wait
out a presence TTL. Neither has a foreground service or a background permission,
so both claims stop being true at the same moment — and if they computed that
moment separately, one of them would eventually be lying.

So `HostPresence` answers once, and both read it. `MainActivity.onStart`/
`onStop` report the two facts (`isChangingConfigurations`, and whether an owned
picker is outstanding) and nothing in the composition decides it: a claim made
to another device must not depend on whether a particular composable happened to
be in the tree.

`ON_STOP` is not "the user left". Three things produce it and only one is
abandonment:

- **this app's own picker came to the front.** `DocumentsUI` is a separate
  Activity, so choosing a file stops this one every time. Ending the claims here
  would make the file flows impossible to complete.
- **a configuration this Activity does not handle changed.** The Activity is
  coming straight back with the same ViewModel and the same live session.
  Announcing `offline` to central on every locale change would be presence churn
  describing nothing.
- **the user really did leave.** That one, and only that one, ends the claims.

**The Inbox follows the same rule, and is never tab-owned.** iOS ties Inbox
receiving to the scene phase — `inbox.foreground(phase != .background)` in the
app root, not in the Inbox screen — and this is the Android equivalent.
Switching to Account or Nearby must not stop receiving: the user would see
deliveries stop for a reason nothing on screen explains, and a sender would be
told this device is offline because its owner looked at another tab.

A cold launch needs no away-and-back cycle: `InboxRuntime.adopt` starts the loop
itself when the host is already live, and `foreground(true)` starts it when the
adoption came first. Whichever arrives second completes the pair.

## The bounded owned-picker lease

The picker exemption above has a hole that lifecycle events cannot close. If the
user presses **Home while still inside `DocumentsUI`**, this app receives no
second `ON_STOP` — it was already stopped — and nothing tells it the picker is
gone either. Left alone, the exemption is an indefinite advertisement lease: a
device announcing itself, holding sockets, with its owner two apps away.

`PickerLease` bounds it at **120 seconds from the launch of the picker**, on
`SystemClock.elapsedRealtime()`. That clock is monotonic and includes deep
sleep, which is correct: a device that slept for ten minutes with `DocumentsUI`
on screen was away for ten minutes.

Three properties are load-bearing:

- **The deadline is anchored to the original launch and nothing renews it.** The
  lease lives in the ViewModel, which survives the recreation that happens
  behind a picker; the composition holds only the token. There is no second
  place the clock is kept, so no path can restart it.
- **Tokens cannot alias across a restart.** `ActivityResultRegistry` restores
  pending results across process death, so a token in saved state really can
  come back to a lease that did not issue it. A counter restarting at 1 would
  collide with the new process's first token and apply the old pick to a
  different operation, so a token is `<random-runtime>:<counter>`.
- **Expiry is `>=`, not `>`.** A host that slept until exactly its own
  `nextDeadline` must find the lease finished; otherwise it wakes, sweeps
  nothing, computes a remaining delay of zero, and spins.

What expiry *does* depends on what the round trip claimed:

| claim | round trip | on expiry |
| --- | --- | --- |
| `PRESENCE` | a session/Nearby file or folder pick | the operation is retired and its late result refused; the presence claim is withdrawn **if the app is genuinely away** |
| `DATA` | a cloud upload choice, an Inbox send choice, an export folder | the covered state ends; the user's choice is **not** discarded — the receiving model's own request fence decides whether it is still the one it asked for |

The presence qualifier matters: a lease expiring while the user is back on
screen means a pick was lost, not that they left, and stopping Nearby there
would be a session destroyed by navigation — the exact failure the exemption
exists to prevent.

This is a platform accommodation, not a background service. Nothing keeps
working while the app is away; the copy on the Nearby surface says exactly that
and promises no background delivery.

## Everything from outside crosses one boundary

`ACTION_VIEW`, `ACTION_SEND` and `ACTION_SEND_MULTIPLE` all reach
`TransferViewModel.deliverIntent`, which hands them to `IngressIntents.read` and
then to the one `IngressCoordinator`. `MainActivity` parses nothing and decides
nothing.

The coordinator's vocabulary has **no case that can join, download or send**. A
link prefills a field and selects a screen; a share is staged as references —
nothing opened, copied or read — and waits for a destination. The behaviour this
replaced called `viewModel.join(url)` on any `ACTION_VIEW`, which tore down
whatever transfer was running with no confirmation.

**The launch intent is consumed exactly once.** `onCreate` runs again on every
recreation with the original intent still attached; the `savedInstanceState !=
null` guard is what stops it being routed a second time. After process death the
app comes back with nothing pending, which is the truthful outcome — the staged
references and their grants died with the process, and nothing reconstructs
them.

Navigation is **one-shot**: the shell consumes the request and it is never
re-raised, so a recreation cannot yank the screen away from wherever the user
has since gone.

### Staging identity is not the account

A share is account-independent input: another app hands over a photo, and
nothing about that says who is signed in. The user may well sign in *afterwards*
precisely because they want to send it somewhere that needs an account.

`ShareEpoch` therefore advances only when a signed-in identity is **replaced**:

| before | after | epoch |
| --- | --- | --- |
| nobody | A | unchanged — the cold restore, and the share survives it |
| A | A | unchanged |
| A | B | advances |
| A | nobody | advances |

The first row is the point. At a cold launch the account arrives
asynchronously, and an epoch that counted "nobody → A" as a change would release
every cold-start share at the exact moment the restore completed.

A **delivery**, by contrast, is account-bound. `DispatchAuthority` is captured at
the explicit destination tap and re-checked before every side effect: the
staging epoch, the credential (account id *and* generation, so a re-login as the
same account is a different session), and the chosen target. Cloud and Inbox
carry a credential; cross-network and Nearby carry none, because they present no
bearer and nobody pays for them.

### Where a staged share can go

Cross-network/Nearby, cloud storage, or a device in the Inbox — each a button,
on a screen naming what will be sent and where. Text offers the session's
message draft and an Inbox message, and only to devices that announced they can
*present* a message.

Account-bound destinations are **gated, not hidden**, when signed out: they say
why and offer the way in, and the share survives that trip. A hidden control
would read as a destination this build does not have.

A share the user navigates away from is not lost: a banner on every destination
says something is waiting and offers the way back. Discarding **releases** the
grants rather than merely hiding the screen.

Staged files are read only through `StagedShare.open`. The ingress module keeps
the real `Uri` objects private on purpose — the handle map is the capability —
so `StagedInboxSources` composes the production Inbox factory with one seam
substituted rather than the Inbox ever being handed a raw `Uri`, and the cloud
uploader resolves a `relayium-share:` reference through the same staging.

## Handing a received delivery to another app

`InboxSharedFileProvider` is **not exported**. No app can address it; what
reaches it is a URI this app put into an intent with
`FLAG_GRANT_READ_URI_PERMISSION`, which the system turns into a per-URI grant
for exactly that consumer.

The URI carries an **opaque token, never a path**. There is nothing to traverse,
because the provider does not accept a path at all — it accepts a token this
process minted, and answers only for files already registered from inside the
app's own `noBackupFilesDir`. Path confinement is a property of what can be
*registered*, checked once, rather than of every request.

Grants behave like an ordinary read-only provider: query and open work
repeatedly, because real consumers query the name, then the size, then open,
then re-open after their own recreation. A grant retired on first touch would
pass a test and fail in front of a user, mid-attach. What bounds it instead is:

- **ten minutes** from the mint, on the monotonic clock;
- **the account session** it was minted under — an account change revokes every
  grant, because the bytes are the same bytes and that is exactly why the check
  cannot be about the file;
- **the process** — the registry is memory only, so after process death an
  outstanding URI resolves to nothing and the consumer gets an ordinary "not
  found", which is what actually happened.

Validation and the descriptor open are **one serialized registry operation**.
Resolving first and opening afterwards has a window: an account change
completing in between revokes the grant and the descriptor is handed out anyway
— the previous session's file, delivered after the app decided that session was
over. A descriptor already handed to another app is that app's to own;
revocation stops the *next* open and does not pretend to reach through an FD the
system has already duplicated.

Expired grants are pruned by every operation that touches the registry, not only
when a token happens to be resolved again — the ordinary case is a share that
*succeeded* and whose token nothing ever asks about again.

## The Inbox adapter

One `InboxRuntime` for the life of the process, adopted into each account in
turn. The per-account object is the immutable `InboxServices` bundle;
`adopt` swaps it behind a gate that cancels and **joins** everything the previous
account owned before the new authority exists. Building a second runtime would
leave the first holding a receive loop, an in-flight upload carrying the previous
bearer, and a half-finished durable write, with nothing left pointing at it.

Every credential generation is an adoption, including a same-account re-login
and a bearer replaced mid-session by a browser approval.

The orchestration is **latest-cancelling**, and a plain sequential collector is
not enough. `adopt` suspends in the middle, so a collector that awaited it before
reading the next value would hold account B behind account A's teardown — and
when A's adoption finally returned it would install and publish a session the
user had already left. `collectLatest` cancels the superseded adoption before it
can publish; that is safe because `InboxModel` releases ownership when a job
*completes* rather than when an adoption begins, so the next adoption still
cancels and joins the old work. Identical credentials are filtered *before* the
cancellation point, or a usage refresh would cancel a legitimate adoption and
then decide there was nothing to do.

`InboxActions.open`, `export` and `share` are supplied for real. Each re-checks
the account after every await: `locate` refuses an entry whose account is no
longer adopted, and the host compares the binding again before handing a URI to
another app or writing into a chosen folder.

## Storage and backup

Inbox stores live under `noBackupFilesDir`, and the manifest keeps
`allowBackup="false"` with every storage domain excluded for both cloud backup
and device transfer. The two protections are independent on purpose.

Nothing that is saved instance state carries a payload: the picker lease token is
an opaque `<runtime>:<counter>` string, the share surface saves a boolean, and
the scanner saves a request counter. Shared text, staged URIs, message drafts
and pairing codes live in the ViewModel, whose lifetime is rotation and the
picker round trip — and process death honestly ends them.

## Evidence

- `:app:testDebugUnitTest` and `:protocol:test` — the host's own JVM cases live
  in `com.relayium.android.integration`: the picker lease including the
  boundary and cross-process aliasing cases, the presence rule, the staging
  epoch and dispatch authority, the adoption orchestration including a
  superseded adoption that must not publish, and the grant registry including
  an adversarial revocation interleaved with an open.
- `scripts/android-host-acceptance.sh` — `HostIntegrationTest` against the real
  `MainActivity`, under English/light/default and Simplified Chinese/dark/320dp/
  font 2.

- `scripts/android-host-system-acceptance.sh` — the three gates the offline
  matrix cannot reach, each because it needs something outside this process.

Everything below runs on the AOSP 36 emulator. That is not a hedge about what
executes: the UI, the system services, SAF and `DocumentsUI`, the non-exported
provider, the separate-uid fixture process and the Go and Apple host modules on
the other side of the wire are all real and all run for these results. What the
emulator does not stand in for is a physical phone or iPhone, so nothing here is
a device-certification claim.

The last full native run observed every leg of the matrix pass:

- All fifteen legs, in one 397.89-second run. Beyond the offline matrix and the
  three system gates, that covers the receiving-policy transitions (`ask`,
  `off`) and a send cancelled mid-upload; one real external open of a
  single file and one real share of three files, whose bytes are checked by
  hash; a second read of the same
  grant; a refused write; a nested SAF choice; and a delete.
- **Grants do not survive the account they were issued under.** A reader in a
  separate uid holding three retained grants finds all three unreadable after an
  actual account switch — not after a simulated one, and observed from the
  process that would have to be refused.
- **History is what the record says, across a restart.** After a real restart
  the named entries, a file's SHA-256, a message body and a deleted entry's
  tombstone all read back as they were written, and a conversation the previous
  account owned is visible zero times.

## The system gates

`android-host-acceptance.sh` proves the host's own rules against the real
`MainActivity`. Three things it deliberately cannot prove have their own
harness, `android-host-system-acceptance.sh`, and each is separate for a
concrete reason rather than for tidiness.

**A real share, from a real other application.** `ExternalShareIngressTest`
receives from a private fixture APK running under its own uid, with its own
non-exported provider and its own grants. Admission refuses this app's own
provider by design, so an intent built locally — carrying a URI this process can
already read — exercises none of the path a real share takes. The fixture's
payload is deterministic, so the bytes read back are checked against a hash.
Covered: staging with no dispatch, provider bytes across a recreation, a share
with no read grant, an unreadable `Parcelable` (single and list) that must be
refused rather than crash the receiver, and hostile display-name metadata whose
traversal must not survive onto the screen.

One honest limit: the fixture serves the same bytes for the same URI, so this
run cannot say WHICH provider access answered a second delivery. The
staged-share binding rule is established by the JVM suite, where each access
serves a different byte and the case went red before the fix; the system run
adds that the real cross-uid read still works after a second delivery.

**The operating system's permission UI.** `ScannerPermissionJourneyTest` denies,
retries, denies permanently, opens Settings, grants there by real taps, and
comes back — nothing injected. `grantRuntimePermission` would make every one of
those assertions pass without touching the path a user walks, and the defect
this area actually produced (a granted camera showing a refusal screen) lived
exactly in that gap. It asserts `CAMERA` is revoked at entry rather than
skipping: a run starting from a permanent refusal cannot make a first denial.

**Real elapsed time, and a real peer.** `NearbyPickerLeaseWallClockTest`
establishes a Nearby session against the unchanged shipped `LocalTransferPeer`
in its `local-link-peer` role — discovered over real Bonjour by name, connected
on `link/1`, and then left alone, because the point is what happens to a session
nobody is using. It launches an owned document picker, recreates the Activity
*behind* it, presses Home from inside `DocumentsUI`, and waits the shipped 120
seconds on `SystemClock.elapsedRealtime`. The debug clock offset is asserted to
be zero and never touched: moving it would prove arithmetic the JVM suite
already covers and would say nothing about whether the app stops when nobody is
looking. The recreation is placed early and the check late, so a lease renewed
by the recreation shows up as still-running rather than being missed by a
margin. The late result is a real document chosen by its own label through
`DocumentsUiDriver`, not a tap on whatever happened to be clickable.

The script skips a gate LOUDLY and fails the run when its fixture or peer is
absent, rather than reporting a pass for a gate it did not execute.
