# Android development

**Status: public preview.** `apps/android/` is the native Android client at
0.1.1 (versionCode 2), applicationId `com.relayium.android`, distributed as a
direct APK only — no Google Play listing, no Play Billing, and no Play Services
or GMS dependency of any kind.

Its first published build was join-only; the current source additionally creates
cross-network links and has a real account surface (see below). That is source
state, not a release: no version number has moved and nothing is published for it.

Since 2026-09-08 the website offers it: `/apps` renders a download card whenever
`web/android-release.json` says a release is published, and the same document is
copied to `web/public/apps/android/update.json`, which is the feed an installed
build reads when the user presses **Check for updates**. Until the APK is published
the manifest says `available: false`, and every surface — the card, the
static twins and the app itself — reports "no download is published" rather than
inventing one.

## What the app can do today, honestly

**Cross-network transfer, both directions.** The app can now CREATE a link as
well as join one:

* **Join** — a six-digit code or a `https://relayium.com/cross-network#c=…`
  link, **anonymously**. Joining has never needed an account and still does not.
* **Create** — `POST /api/pair` under the signed-in account's bearer, showing the
  six digits and the full official link with a live countdown, and joining the
  room those digits name through the same controller a pasted code goes through.
  Creating needs an account because whatever the room relays is metered against
  the creating account's monthly allowance (`account.PairMintRefusal`); a mint
  itself costs nothing.

Once connected, both sides send and receive files and messages. With a Web peer
or another Android device that is one verified `link/1` session carrying both.
With an Apple peer it is the shipped older wire, which carries files **or**
messages per connection — see "Two wires, and which peer gets which" below for
which one a session gets and what the UI says about it.

**Nearby, without a code.** The app can find other Relayium devices on the same
network and transfer to one the user picks, with no six-digit code involved. It
offers two rooms, and they are genuinely different products rather than one
feature with a setting:

* **On this network only** — Bonjour (`NsdManager`) discovery and direct TCP
  signalling on the local link. **No Relayium server is contacted at all**, not
  even to introduce the two devices, and no ICE credentials are fetched; two
  devices on one link reach each other on host candidates. This is the same
  rendezvous the iOS client uses (`_relayium._tcp`, a 32-hex per-channel
  identity as the instance name, TXT `i`/`n`/`c`), so an iPhone and an Android
  phone on one Wi-Fi network can find each other directly.
* **Through relayium.com** — the code-less rendezvous room the Web and macOS
  clients join, which the server keys by the **public address it observes**. The
  UI says so, because it matters: anything else reaching the internet from that
  address can appear in the list. The introduction goes through relayium.com;
  the transfer itself is still device to device and end-to-end encrypted.

In both rooms **nothing connects without a person**. The device list is only a
list: an outgoing connection needs an explicit selection, and an inbound one
raises a prompt naming the peer that must be accepted. A second device asking
while a prompt is up is refused in band rather than replacing the question, a
live session is never replaced by tapping another row, and the peer list is
never a queue whose first or newest entry is taken automatically. Discovery caps
are treated as compatibility hints and nothing else — the commit-reveal
handshake and the six-digit SAS are what authenticate a session, exactly as on
a pairing code.

Nearby is **foreground only** and the app says so. Leaving the app stops
advertising, stops browsing, closes every socket and ends any transfer, because
this build has no foreground service and cannot honour a presence claim it
cannot keep. Its own document picker and a configuration change are NOT leaving
the app — both stop the Activity, and treating either as abandonment made the
file flows impossible to complete.

**An account.** Email/password sign-in, registration with email verification and
resend, password-reset request, browser-approved sign-in for accounts that have
no password at all, restore across launches, explicit sign-out with real
revocation, and the account's identity, plan, quota and device list read from the
existing server APIs. See "Account" below.

**Stored (cloud) transfers, both directions.** Files are encrypted on the device
and uploaded as one opaque object; the link that opens them carries the key in
its `#k=` fragment, which a browser never sends to a server, so the server holds
ciphertext it cannot read.

* **Send** — a SAF selection, a retention choice and an optional
  burn-after-read, uploaded under the signed-in account's bearer. The link is
  composed against this app's OWN resolved origin, never against anything the
  server said, and the expiry shown is the server's own `expiresAt` rather than
  the requested TTL — the account's plan may shorten it. Uploading needs an
  account because the bytes are stored and metered against one.

  Two paths, chosen by size. Below `CloudUploadModel.RESUMABLE_MIN_BYTES`
  (8 MiB) it is a single streamed `POST /api/files`: nothing is staged, and an
  interruption costs one re-pick, which the surface says before the upload
  rather than after. At or above it the selection is encrypted ONCE into a spool
  in `noBackupFilesDir` and driven through the resumable API
  (`POST /api/uploads` → `PATCH` → `finalize`), so an interrupted upload can be
  continued — see "Recoverable uploads" below.
* **Receive** — any `…/d/<id>#k=<key>` link on this app's origin, **anonymously**
  and with no account at all, decrypted on the device and saved into a folder the
  user chose. The ciphertext read carries no bearer and no cookie.

The wire is `docs/protocol/relayium-stored-wire-v1.md`, and the Kotlin port is
pinned to the same frozen `store-wire-vectors.json` the Web and Swift ports
assert against. Cross-codec interop with the Web implementation is verified in
both directions.

**Recoverable uploads and the file list.** A large upload survives process
death, and the account's stored files are listed with the links this device can
still rebuild.

* **The spool is immutable.** The selection is encrypted once into
  `noBackupFilesDir/cloud/pending-uploads/<job>/spool.bin`, and a resume replays
  exactly those bytes from the offset the server reports. Re-encrypting the
  user's current files instead would seal DIFFERENT plaintext under the same key
  and frame sequence, which destroys the integrity of every frame already
  uploaded. The plan and the content key sit beside it, each AES-GCM-wrapped by
  an `AndroidKeyStore` alias that is deliberately NOT the bearer's — signing out
  hides a pending upload, it does not shred it.
* **Offsets are payload-relative.** The init header (`uint32BE(len)||encManifest`)
  is stored separately by the server, so every `Content-Range` counts framed file
  ciphertext from zero and the completeness gate is `cipherSize(sizes)`. The
  server silently caps one append and does not verify completeness at finalize,
  so both are the client's job.
* **A lost finalize answer becomes uncertainty, never a second object.** An
  attempt marker is fsync'd — file, then the directory that names it — before
  finalize is requested. After that a retry may re-ask the SAME session; nothing
  may open a new one, because 409 and 404 carry no object id and prove neither
  publication nor its absence. The surface offers a retry and a local discard and
  points at the file list; it never republishes on its own.
* **Cleanup is licensed by the key being filed.** A finished job is removed only
  once its key is durably stored under the account, because until then the job
  directory holds the only copy of the key to an object the account is paying
  for.
* **The file list is `GET /api/files`** — server facts only, share-purpose rows
  only. A row with no link is not a missing file: the key never reaches the
  server, so an object uploaded from another device is listed, deletable, and
  has no link that can be rebuilt here. Deletion is confirmed, and a 404 is
  reported as "the server no longer has this", never as a deletion this device
  performed. The list is unpaged server-side, so an account holding more than
  `CloudClient.MAX_HISTORY_ROWS` rows is refused with an actionable message
  rather than shown partially.

**What it does NOT do.** Uploading runs only while the app does. There is no
foreground service and no background delivery: what is promised, and what the
copy says, is that an interrupted upload can be *continued*, not that it
continues on its own. Uploads below the staging threshold are not resumable at
all.

**Three destinations**, Transfer, Cloud and Account, and nothing else: this build
has no tab that opens onto a placeholder.

### Two wires, and which peer gets which

Android speaks **both** cross-network wires now, and which one a session uses is
decided by what the peer announced rather than by a preference:

* **`link/1`** — one connection carrying an ordered file lane and an ordered
  text lane, five control bytes, an abort barrier that retires one batch without
  ending the connection, and an authenticated leave. This is what the Web client
  and another Android device speak. Its role comes from the two hub ids, sorted,
  computed identically by both peers.
* **the shipped older wire** — one `data` channel carrying **either** files
  **or** messages and never both, a control set of exactly `0xfe`/`0xff`/`0xfd`,
  no barrier, no resume and no leave. This is what the Apple clients speak in a
  pairing-code room: `PeerCapabilityRegistry.LINK_PAIRING_ROOM_SUPPORT` is false
  on iOS, so an iPhone announces only `text/1` there and answers nothing else.
  Its role is the user's **intent** — whoever created the code offers, whoever
  joined answers — which is why `TransferController.join` takes a
  `MINTER`/`JOINER` and never derives one.

The choice is the frozen `capability.promotion` table in
`apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json`, and
`LegacyVectorTest` reads it rather than restating it: a peer announcing `link/1`
resolves to a link immediately; a peer announcing exactly `text/1` resolves to a
legacy message connection immediately; anything else — an empty announcement,
`link/2`, `LINK/1`, `text/2`, or silence — resolves to a legacy file connection
at the five-second settle edge, because until then "nothing yet" and "nothing at
all" are the same observation. A joiner never offers at all: the generation of
the offer it receives is authoritative, and a `text` offer without exact
`text/1` in its `caps` is ignored, exactly as `inboundOfferGeneration` ignores
one.

This client therefore announces `["text/1", "link/1"]` — the fixture's
`capability.hello.native`, which is what both Apple clients say. The two halves
move together on purpose and `android-policy-test.mjs` enforces it: announcing
`text/1` without `LegacyTextLane` would invite a peer onto a connection that
cannot open, and implementing it without announcing it would be worse than
useless, because `RealtimeConnectionFactory.connectInRoom` refuses to offer a
message connection until it hears the exact string back.

**What differs for the user, and is said in the UI rather than discovered.** A
legacy connection carries one capability, so the other card names itself and
explains what to do instead of offering a control over a lane no frame can
reach. And a cancel on that wire is a disconnect: the shipped sender re-reads
`rejected` only *before* it streams (`RealtimeConnection.waitForAccept`), so a
mid-transfer cancel that left the socket open would leave the user watching a
cancelled transfer keep arriving. The buttons say "Cancel and disconnect" and
"End conversation and disconnect" for that reason. A decline at the prompt is
different and stays non-terminal: it is a complete in-band exchange with nothing
in flight.

Every failure that is *not* a button — a storage queue overflow, a failed write,
a failed export, a source that could not be opened or read, any protocol failure
— retires the connection the same way, through one point in
`TransferController.onLaneFailure`. On `link/1` those stay lane-scoped and the
connection survives; on the older wire there is no barrier to tell the peer and
no second lane to preserve.

**What is proved, and by what.** `scripts/android-apple-legacy-acceptance.sh`
runs the real APK on an emulator against the **unchanged shipped
`RealtimeConnection`** compiled from `apps/RelayiumKit` — both roles, both
generations, both byte directions on separate connections, per-file SHA-256
compared on each side independently, the SAS compared across the two
implementations, and three adversarial paths. Read its claim precisely: that
Apple half is the shipped Swift **transport** running as a host process. It is
not an iOS binary and not a device, so it establishes that the two
implementations agree on the wire and nothing about iOS packaging, lifecycle or
UI. A real iPhone can join the same code against the same server without any
source change, and that run — not this one — would license a claim about the
App.

### What is still absent, and is not claimed anywhere

No LAN/nearby discovery, no Device Inbox, no `ACTION_SEND` share target, no QR
entry point, and no billing of any kind — the app makes no checkout,
subscription or plan-change request and offers no control that would start one.
(Stored `#k=` transfers WERE absent and are not any more: this section said so
until the cloud slices landed send, receive, resumable uploads and the file
list, and the correction belongs here rather than in a later cleanup.)

There is still no resident session and no background-transfer claim: when
Android stops the process, transfers stop with it. A large cloud upload is the
one thing that survives, and only in the specific sense described above — its
encrypted spool and its plan are on disk, so the next launch can OFFER to
continue it. Nothing continues on its own, and a realtime session ends outright. The link intent filter is deliberately **not** a
verified App Link (no assetlinks.json on the server), so on Android 12+ tapping a
link opens the browser; the app is reached by pasting the code or link into the
join form, or by the user enabling "open supported links" manually.

## Account

`app/src/main/kotlin/com/relayium/android/account/` is a JVM-testable core with
the Android types pushed to its edges: an injected HTTP transport, an injected
token store, an injected clock, and one owning dispatcher.

```
AccountTransport.kt      the request/response seam and the body ceiling.
OkHttpAccountTransport.kt the real transport: bounded body, redirects REFUSED,
                         strict UTF-8, bodies consumed off the main thread.
AccountClient.kt         what each server answer MEANS. Strict; never guesses.
AccountModels.kt         the outcomes, and the failure CLASSIFICATION the UI
                         renders in the user's language.
AccountState.kt          every state the surface can be in.
AccountSession.kt        the state machine: one dispatcher, one generation.
BrowserLoginModel.kt     the device-authorization approval loop.
CreateLinkModel.kt       minting six digits, and the three fences on using them.
PairCodeExpiry.kt        what a code's deadline means on screen.
AccountAccessDraft.kt    the address and form mode, owned outside the composition.
Bearer.kt                what this app will accept as a token, before adopting it.
TokenStore.kt            the persistence contract: every failure is reported.
KeystoreTokenStore.kt    AndroidKeyStore AES-GCM, in noBackupFilesDir, atomic.
```

### Where the credential lives

The bearer — and only the bearer; never a password, never the pending-deletion
reactivation token — is wrapped by an `AndroidKeyStore` AES-GCM key this process
cannot export, and the ciphertext is written into `noBackupFilesDir` with a
temp-file-plus-`fsync`-plus-rename replacement. It is **not** described as
hardware-backed: whether the key sits in a TEE or in a software keymaster is a
property of the device, and the AOSP emulator every acceptance here runs on has
the latter. `scripts/test/android-policy-test.mjs` asserts the storage shape,
that nothing in the package logs, that no bearer reaches a URL query, and that
the password is never put into saved instance state.

### The rules that took a bug to learn

Each of these was reproduced before it was fixed:

* **A token is validated before it is adopted.** A bearer containing a newline is
  accepted by a lenient reader, stored, and then thrown out of OkHttp as an
  `IllegalArgumentException` — from a value that came off the wire, with the
  credential quoted in the message. `Bearer` refuses it at issue and the
  transport classifies the throw as well.
* **A quota is refused rather than rounded.** `cap <= 0` is the server's spelling
  of "unlimited", so a negative cap read leniently renders a broken response as
  an *unlimited* plan. And at or above 2^53 consecutive integers stop being
  distinguishable, so `9007199254740993` silently becomes `…992`.
* **The poll interval is the server's floor**, refused rather than clamped: a
  client that polls faster than asked earns a 429 that reads as a failed login.
* **`persisted` belongs to the credential, not the screen.** Derived per load it
  reported a durable sign-in that was never written, as soon as one load failed
  in between.
* **A sign-out cannot be overtaken.** `SigningOut` is entered BEFORE the request,
  so `authority()` answers null and nothing — a mint, a room, a device list —
  can start on a credential being destroyed. A revocation that FAILS keeps the
  token for an explicit retry rather than forgetting a credential that may still
  be live.
* **A bearer that arrives too late is revoked, not dropped.** An abandoned
  browser approval, or a sign-in that landed after a sign-out, has produced a
  live long-lived credential; silently discarding it leaves a working token on
  the account that this device can no longer revoke.
* **One account-access attempt at a time.** The browser approval claims an
  attempt number from the session and hands it back at the adopt commit, so
  "start a browser approval → sign in with a password → sign out → the approval
  finally completes" ends signed out.
* **The access draft lives outside the composition.** The form is REMOVED while a
  request is in flight, so a rejection used to come back beside two empty fields
  — and a refused registration came back as a sign-in form.
* **"Back to sign in" selects the sign-in half explicitly**, because the way a
  user reaches the check-email screen is by registering.

### The browser-approved route, and why it exists

Plenty of Relayium accounts have no password: they were created with Sign in with
Apple or Google. This build ships **no Google SDK and no Play Services**, so
without a browser-delegated route those accounts could not sign in on Android at
all. The flow is the server's existing device-authorization pair
(`/api/cli/device/{start,poll}`), which the CLI already uses. The one rule that
carries the whole flow: the server's `verification_uri` must be on the app's own
resolved origin, PARSED rather than prefix-matched, or the page is refused rather
than opened — it is where a human is asked to authorise a credential.

Note for harness authors: `verification_uri` is `<BaseURL>/device` from the
server's **configured** base URL, not the request origin, so a local harness must
start the server with `RELAYIUM_BASE_URL` set to the exact origin the device
resolves. Widening the app's trust check to make a harness pass would remove the
only thing protecting that page.

## Update checking

Manual only. There is no polling, no worker and no lifecycle observer: the only
thing that starts a check is a button on the join screen, which is also the only
screen that draws it — in `CONNECTING`, `WAITING_PEER` and `CONNECTED` the row is
not in the composition at all, so "a check cannot interrupt a transfer" is
structural rather than a runtime guard someone can forget.

Four files, split so each half is testable without the others:

```
update/UpdateFeed.kt      pure JVM: the document's schema, its validation rules,
                          and the version comparison. No Android type, no socket.
update/UpdateSource.kt    the bounded OkHttp fetch.
update/UpdateChecker.kt   the state machine the UI renders, driven through
                          injected seams so every state is a unit test.
update/UpdateEndpoint.kt  WHICH document is read, with the release fence.
```

What the client refuses, and why each one matters:

* **Anything that is not `200 OK`**, including 3xx — the feed lives at one fixed
  URL, and redirects are not followed. Production's nginx answers a missing file
  with a 404 and an HTML body, so that HTML never reaches the parser.
* **A body over 64 KiB**, rejected rather than truncated. A prefix of a JSON
  document is either invalid or a *shorter valid document* saying something the
  publisher never wrote.
* **A `versionCode` that is not an exact positive int32.** It is the only
  ordering the check uses; `versionName` is a display string, and `"0.1.10"`
  sorts before `"0.1.9"` as text.
* **A `downloadUrl` that is not the exact official asset for the advertised
  version.** Parsed, never prefix-matched — `https://github.com@evil.example/…`
  passes a prefix check — and the path is *derived* from the version, so a feed
  cannot advertise `0.1.2` while pointing at the `0.1.1` artifact.
* **A newer build is never assumed.** Every transport and parse failure renders
  as an error; a check that could not reach the publisher has learned nothing.
  `available: false` is its own answer, distinct from both.
* **A downgrade is never offered.** A feed that has gone backwards reads as up
  to date.

The app never downloads or installs anything. It hands the URL to the system
browser, the user chooses to open the file, and Android installs it only if the
signature matches — which is also why the manifest carries `sha256` and `size`
as *published facts a person can check*, never as something the app verified. It
holds no `REQUEST_INSTALL_PACKAGES`; `scripts/test/android-policy-test.mjs`
asserts that, along with the release feed fence.

`UpdateEndpoint` accepts a debug-only loopback feed override
(`adb shell setprop debug.relayium.updatefeed http://10.0.2.2:8181/update.json`),
fenced exactly as `Backend` is: false in release as a *mandatory* conjunct, a
debug-only cleartext policy, and read from a system property rather than
anything exported. It exists because 0.1.1 is the first build with an updater —
without it, the "an update is available" branch could not be exercised on a
device until something newer was already public.

## Publishing a release

Metadata is derived from the artifact, never written by hand:

```sh
# 1. root builds and signs the APK (outside this repository)
# 2. observe those exact bytes and write the metadata.
#    --web-root is REQUIRED from the repository root: the tool defaults its web
#    root to the working directory, so without it this writes
#    <repo>/android-release.json instead of web/android-release.json.
node web/scripts/stage-android-release.mjs --web-root web \
     --apk Relayium-0.1.1-2.apk \
     --version 0.1.1 --code 2 --notes-en "…" --notes-zh "…"
# 3. commit the metadata-only diff
# 4. publish the SAME file
scripts/publish-android-release.sh --apk Relayium-0.1.1-2.apk
```

The staging tool reads the package, versionCode, versionName and signing
certificate out of the APK with `apksigner` and `apkanalyzer` — they are not
arguments, and there is no way to skip the check. The publisher re-observes them
before creating anything, requires the manifest to be committed and canonical,
pins the tag to an explicit commit, and passes `--latest=false`: GitHub's
`latest` alias is repository-wide and `web/public/install.sh` resolves it, so an
Android release taking it would break the CLI installer for everyone. The alias
is read before *and* after, and a failed read is a hard error rather than an
assumed absence.

## Layout

```
apps/android/
  protocol/   pure-JVM Kotlin: crypto, frames, both lane state machines,
              manifest/path safety, join-input parsing. No Android type
              appears anywhere in it, and its conformance suite reads the
              SAME frozen fixtures under apps/RelayiumKit/Tests/Fixtures/
              that the Swift and Web suites assert against.
              The `stored/` package there is the zero-knowledge cloud wire:
              key codec, framing, manifest, destination planning.
  app/        the Android half: Compose UI, ViewModel, TransferController
              (JVM-testable through injected seams), OkHttp signalling,
              WebRTC transport, SAF storage, and `cloud/` — the stored-transfer
              transport and its two models.
```

The build has two shapes, chosen by an explicit property
(`settings.gradle.kts` documents the precedence):

```sh
# Pure JVM: no SDK, no AGP resolved — what compat.yml runs.
./gradlew -Prelayium.android=false :protocol:test

# The app: needs ANDROID_HOME with platforms;android-37.0.
./gradlew -Prelayium.android=true :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Toolchain: JDK 17, Gradle 9.3.1 through the SHA-256-pinned wrapper, AGP 9.1.1
(built-in Kotlin — the standalone Kotlin Android plugin must NOT be added),
compileSdk 37 / targetSdk 36 / minSdk 26, arm64-v8a + x86_64 only. Every
dependency version is pinned in `gradle/libs.versions.toml`;
`scripts/test/dependency-pinning-test.mjs` refuses a dynamic version there and
a wrapper without its distribution checksum.

## CI

Three lanes, wired the day the platform root appeared (see
`docs/CI-PLATFORM-BOUNDARY.md`):

* `android.yml` — the heavy owner of `apps/android/**`: protocol tests, app
  unit tests, lint (warnings are errors), debug assemble, on `ubuntu-latest`.
* `android-interop.yml` — the emulator↔browser acceptance
  (`scripts/android-interop-acceptance.sh`): the real APK on a real emulator
  against a real Chrome on the real Web bundle, over a real local server.
* `compat.yml` / `android-protocol` — the pure-JVM conformance suite, always
  on, unfiltered, structurally SDK-free (`-Prelayium.android=false` excludes
  `:app` at settings evaluation and the job greps the exclusion line).

Release signing is not in any of them: `assembleRelease` produces an UNSIGNED
APK on purpose, and the signing identity is held outside this repository — so
there is no signing secret in CI and no automated job that could publish.

Three further gates run outside the Android lanes, in `repo-hygiene.yml`:

* `scripts/test/android-policy-test.mjs` — the build-configuration and
  source-shape facts no Kotlin test can assert about itself: the release
  backend and update-feed fences, the absence of `REQUEST_INSTALL_PACKAGES`,
  and the account credential's storage shape, no-logging rule, header-only
  bearer and never-saved password.
* `scripts/test/android-publish-order-test.mjs` — the publish helper's ordering
  and flags, read as text.
* `scripts/test/android-publish-behavior-test.mjs` — the publish helper actually
  RUN, against a disposable Git repository, a fake `gh`, and **mocked** SDK
  tools reached through the same `RELAYIUM_APKSIGNER`/`RELAYIUM_APKANALYZER`
  overrides an operator with a relocated SDK would use. That proves the control
  flow and that the observer is really invoked and compared; it does **not**
  prove signature authenticity, which is established separately against the
  genuine signed artifact and a real SDK. It skips nothing on a checkout with no
  SDK, because a gate that silently stops checking is the failure it exists to
  catch.

## Local acceptance

`scripts/android-interop-acceptance.sh` is the whole story: it builds the
server and the Web bundle, installs the debug APK on an ALREADY-RUNNING
emulator (it does not create one — start one first, or set `ANDROID_SERIAL`),
mints a real cross-network code through the product APIs, and drives both
directions with the browser as the peer. The debug build accepts a loopback
backend override via `adb shell setprop debug.relayium.backend …` — three
independent fences keep that out of release builds (`Backend.kt` documents
them).

It runs several rounds on one code each: both hub role assignments (the run
fails unless it observed the browser as initiator AND responder), a SAS
comparison round, and the two cancels — a cancelled receive that leaves nothing
of its own behind, and a cancelled send observed as retired at the peer — each
followed by a fresh transfer on the same link. Files are compared by SHA-256 in
both directions and include a zero-byte file and a >192 KiB body; repeated
batches on one link prove the global file sequence advances. A terminal in-band
handshake holds the Activity open until the browser confirms it saw everything.

`scripts/android-nearby-acceptance.sh` is the Nearby evidence, and it needs TWO
running instances — it takes both serials and creates neither. It builds the
debug and instrumentation APKs, installs on both, and runs
`NearbyLanAcceptanceTest` on each with opposite roles: one selects the other
from its discovered list, the other accepts the prompt that produces. Nothing in
the run passes an address to either half, so a round that never LISTED the peer
fails as the discovery failure it is rather than falling through to something
that would pass.

`scripts/test/android-nearby-oracle.py` owns every comparison and is a separate
program on purpose: a shell that greps its own log for the word it printed is
checking that it printed a word. It re-derives each claim from what the two
halves independently observed — that both listed a peer and reported DIFFERENT
peer ids, that the host was prompted by the device it selected, that both
derived the SAME SAS, that both established `link/1`, that each saved exactly
the bytes the other sent (SHA-256, in both directions), that finishing returned
to a live device list rather than ending the room, and that the session survived
its own document picker. A missing field is a failure, never a default: "the
round stopped before observing it" and "the round observed false" must not look
alike.

The `direct` mode additionally points each build at a loopback port with nothing
but a **connection counter** behind it, and the round fails if a single
connection arrives. That is the only honest way to check "this path contacts no
server": asserting that a URL was empty proves nothing, and "the request failed"
is a different claim from "no request was made". A run where the property was
never set fails at the first assertion rather than quietly proving nothing.

`NearbyLifecycleAcceptanceTest` is the single-device half of the same question:
on the real `MainActivity`, leaving the app stops Nearby, a recreation does not,
and switching between the Nearby and cross-network surfaces requires a button
that names what it ends. A run that "passes" by ending and rejoining a session
is a run that failed — the assertions are on the same room and link identity,
not on a session existing again afterwards.

Neither is physical-phone evidence, and neither says anything about the Apple
counterpart: that lane is separate, and a manually entered address is never a
substitute for a Bonjour discovery.

`scripts/android-account-acceptance.sh` is the account and create evidence. It
starts its OWN throwaway server — with `RELAYIUM_BASE_URL` pointed at
`http://10.0.2.2:<port>`, for the reason above — creates a disposable fixture
account, and runs `AccountAcceptanceTest` under BOTH maintained languages against
the real `MainActivity`. It covers native sign-in and the server's own account
facts, a refused sign-in and a refused registration each returning to a form that
still has what the user typed, registration success and the way back from it,
browser-approved sign-in (the shell half approves the code the app displays,
through the server's own session-authed approval endpoint), a real mint whose
room is actually joined, navigation not disturbing that live session, and a
sign-out reaching the state only a server-confirmed revocation can reach. No
credential is ever printed or written into a report.

`scripts/android-cloud-acceptance.sh` is the stored-transfer evidence, on the
same shape: its own throwaway server, a disposable fixture account, and
`CloudAcceptanceTest` under BOTH maintained languages against the real
`MainActivity`. It covers the account gate (uploading needs one, opening a link
does not), a mixed selection — a zero-byte file, one larger than a 192 KiB
chunk, and a small one — uploaded and then opened from its own link and saved,
compared by SHA-256 at both ends; burn-after-read saved once with the second
open correctly reporting the object gone; a hostile manifest (a traversing name,
and two entries that would land on one document) refused BEFORE a folder is
asked for and with nothing created in the tree; a finished upload surviving an
Activity recreation; and one case that drives the REAL DocumentsUI through the
cloud surface's own launchers, across a recreation, into a system-granted tree.
That last one exists because the cloud launchers are not the session launchers:
`android-ui-session-acceptance.sh` says nothing about them. Outgoing fixtures
and saved documents live in different trees, so the store's refusal to overwrite
is never mistaken for a failure. No link is printed or written into a report — a
stored link carries its decryption key.

`scripts/android-cloud-recovery-acceptance.sh` is the evidence for recoverable
uploads, and it is the one harness here that cannot be a single instrumentation
run. `ActivityScenario.recreate` restarts an Activity inside a living process,
and the whole claim is about the process ENDING — so the shell runs
`CloudRecoveryAcceptanceTest`'s four phases separately and `am force-stop`s the
app between the first and the rest, verifying with `pidof` that it actually
died. Phase one stages a 12 MiB selection and lets the server commit part of it;
phase two finds the offer in a process that has never seen the user's files and
resumes it to a link; phase three downloads what the server ended up holding
through the app's own receive path and compares SHA-256 against phase one's
fixture — a stream re-encrypted rather than replayed fails there and nowhere
else; phase four lists the object and deletes it on confirmation. The app's data
is cleared once, before phase one; clearing between phases would delete the
thing under test. `scripts/test/android-policy-test.mjs` asserts that ordering,
because a future edit replacing the kill with a recreation would leave a green
suite proving nothing. Set `RELAYIUM_RECOVERY_PROXY` to exercise a committed
append whose response is dropped as well as the process-death path.

`InteropAcceptanceTest` stubs only the picker UI (the grant a same-uid provider
gives is the grant the picker returns). Two more entry points cover the rest:

`scripts/android-apple-legacy-acceptance.sh` is the Android↔Apple evidence, on
the shipped pre-`link/1` wire that every cross-network session with an iPhone
actually uses. It builds the server, the debug APK and its instrumentation, and
an Apple-side caller compiled from the unchanged shipped `RelayiumKit` and
`RelayiumPeerKit` — mirrored into a scratch package because `RelayiumPeerKit` is
a target rather than a product, with every mirrored file SHA-256 checked against
the repository's own copy so "unchanged" is verified rather than asserted. Ten
rounds cover both roles, both generations, both byte directions, a decline, a
mid-transfer cancel, a refused conversation and a fresh session afterwards. Each
round gets its OWN server, database, account and log in its own child directory:
the per-IP join budget is production and must not be relaxed for a test, and
sharing one backend would mean sleeping out that window between rounds while a
refusal read exactly like a protocol disagreement. The comparison is made by
`scripts/test/android-apple-legacy-oracle.py`, which neither half runs, and
whose `--self-test` proves it still rejects a moved digest, a missing file, a
disagreeing SAS, a record with no observations and a cancel that left the
connection open — that runs before the rounds, so an oracle reduced to a no-op
is caught rather than passing ten rounds against nothing.

* `scripts/android-ui-acceptance.sh` runs `UiAcceptanceTest` OFFLINE across two
  configuration corners (en/light/default and zh/dark/320 dp/font 2), asserting
  the join form's validation is VISIBLE after submit and the launch link is
  consumed once across a recreation, with a screenshot per corner.
* `scripts/android-ui-session-acceptance.sh` runs `UiSessionAcceptanceTest`
  against the same live browser peer, taking its folder and file grants from
  the REAL system DocumentsUI through UIAutomator, with an Activity recreation
  mid-session and the bytes compared both ways. Both entry points run in the
  same emulator boot as the wire interop in `android-interop.yml`.

The send-cancel round has a boundary worth stating plainly: on a sender cancel,
the real Web (`mixed-file-session.svelte.ts` `closeSink`) calls `close()` on the
receiving sink even on the abort path, so it can genuinely leave a PARTIAL file
in the browser's chosen folder. The acceptance does not pretend otherwise — it
requires the cancelled file, if present at all, to be strictly SMALLER than the
full payload (a full-size or digest match is a completed transfer, and fails),
and it drives the cancel deterministically (the browser holds the first write so
the sender stalls) rather than racing a timeout. All of it is an AOSP emulator
with no Google Play services — not physical-device evidence.

`scripts/test/android-interop-oracle.py` is the comparison the acceptance is
judged by; `scripts/test/android-interop-oracle-test.mjs` mutation-tests it,
and `android-interop.yml` watches the oracle as a runtime input.
