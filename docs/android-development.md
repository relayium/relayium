# Android development

**Status: public preview.** `apps/android/` is the native Android client at
0.1.1 (versionCode 2), applicationId `com.relayium.android`, distributed as a
direct APK only — no Google Play listing, no Play Billing, and no Play Services
or GMS dependency of any kind.

Since 2026-09-08 the website offers it: `/apps` renders a download card whenever
`web/android-release.json` says a release is published, and the same document is
copied to `web/public/apps/android/update.json`, which is the feed an installed
build reads when the user presses **Check for updates**. Until the APK is published
the manifest says `available: false`, and every surface — the card, the
static twins and the app itself — reports "no download is published" rather than
inventing one.

## What the first stage is, honestly

Join-only. The app joins a live transfer another device started — a six-digit
code or a `https://relayium.com/cross-network#c=…` link — anonymously, and then
BOTH sides can send and receive files and messages on the one verified link.
It does not mint codes, has no account features, no stored-transfer (`#k=`)
support, no nearby discovery, and no background-transfer claim: there is no
resident session, so when Android stops the process the session simply ends,
and the next launch opens the join form afresh (the live UI is not left
claiming a session that is gone). The link intent filter is deliberately
**not** a verified App Link (no assetlinks.json on the server), so on Android
12+ tapping a link opens the browser; the app is reached by pasting the code or
link into the join form, or — for a link — by the user enabling "open
supported links" manually. There is no `ACTION_SEND` handler, so sharing a link
INTO the app is not a supported entry point.

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
  app/        the Android half: Compose UI, ViewModel, TransferController
              (JVM-testable through injected seams), OkHttp signalling,
              WebRTC transport, SAF storage.
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

* `scripts/test/android-policy-test.mjs` — the build-configuration facts no
  Kotlin test can assert about itself, now including the release update-feed
  fence and the absence of `REQUEST_INSTALL_PACKAGES`.
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

`InteropAcceptanceTest` stubs only the picker UI (the grant a same-uid provider
gives is the grant the picker returns). Two more entry points cover the rest:

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
