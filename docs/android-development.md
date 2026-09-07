# Android development

**Status: in development, not public.** `apps/android/` is the native Android
client at 0.1.0 (versionCode 1), applicationId `com.relayium.android`,
distributed as a direct APK only — no Google Play listing, no Play Billing, and
no Play Services or GMS dependency of any kind. Nothing under `web/` advertises
it; do not read this document as a release claim.

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
APK on purpose, and the signing identity is held outside this repository.

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
