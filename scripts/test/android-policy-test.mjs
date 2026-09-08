#!/usr/bin/env node
// scripts/test/android-policy-test.mjs — the Android build-configuration and
// source-set facts that no Kotlin test can assert about itself.
//
// ## Why these live here and not in `app/src/test`
//
// AGP generates host unit tests for the TEST BUILD TYPE ONLY. There is no
// `testReleaseUnitTest` task in this project, so a Kotlin assertion about the
// release variant is either skipped in every run that exists — which reports
// as a pass and proves nothing — or it is not a variant assertion at all.
//
// The facts below are exactly the ones with that shape:
//
//   * the release build's `ALLOW_BACKEND_OVERRIDE` really is `false`, so
//     `Backend.resolve`'s mandatory fence is closed in a shipped build;
//   * that fence is MANDATORY rather than a default parameter, so an explicit
//     `allowOverride = true` cannot reopen it (R18);
//   * the debug-only surfaces — the cleartext network policy, the disposable
//     documents provider, the instrumentation hook that stores a ViewModel —
//     are in the debug source set and NOT in `main` or `release`, so they are
//     compiled out of a release APK rather than merely disabled;
//   * the release build carries no signing configuration, so `assembleRelease`
//     produces an artifact that cannot be mistaken for a distributable one.
//
// Each is a one-line edit away from being silently untrue, and each would then
// be invisible: the app still builds, every Kotlin test still passes, and the
// only evidence is inside an APK nobody unzips.
//
// Run by `repo-hygiene.yml` on every push, which is the point — a check that
// only ran when someone remembered it is the state that lets these recur.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const android = resolve(repoRoot, "apps/android");

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

const read = (relative) => {
  const path = resolve(android, relative);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
};

/**
 * Source with its COMMENTS removed.
 *
 * Every rule below asks whether something is DECLARED, and this file's subjects
 * are heavily commented — including with comments that name the very construct
 * being forbidden ("NO signingConfig", "there is no ACTION_SEND handler"). A
 * check that matched those would fail on the prose that explains why it passes,
 * which is worse than not checking: the fix would be to delete the explanation.
 */
const codeOf = (text) => text
  .replace(/<!--[\s\S]*?-->/g, "")   // XML
  .replace(/\/\*[\s\S]*?\*\//g, "")  // block
  .replace(/\/\/[^\n]*/g, "");      // line

// ── 0. the platform exists at all ───────────────────────────────────────────
//
// Asserted rather than assumed: a file this test reads that has been renamed
// must fail by name here, not silently pass every rule by matching nothing.

const REQUIRED = [
  "app/build.gradle.kts",
  "app/src/main/kotlin/com/relayium/android/Backend.kt",
  "app/src/main/AndroidManifest.xml",
  "app/src/debug/AndroidManifest.xml",
  "app/src/debug/kotlin/com/relayium/android/TestHooks.kt",
  "app/src/release/kotlin/com/relayium/android/TestHooks.kt",
  "app/src/debug/kotlin/com/relayium/android/TestDocumentsProvider.kt",
  "app/src/main/kotlin/com/relayium/android/account/KeystoreTokenStore.kt",
  "app/src/main/kotlin/com/relayium/android/account/OkHttpAccountTransport.kt",
  "app/src/main/kotlin/com/relayium/android/ui/AccountScreen.kt",
  "app/src/main/kotlin/com/relayium/android/ui/CloudScreen.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/CloudClient.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/CloudLinkDraft.kt",
  "protocol/src/main/kotlin/com/relayium/protocol/legacy/LegacyProtocol.kt",
  "protocol/src/main/kotlin/com/relayium/protocol/legacy/LegacyTextLane.kt",
  "protocol/src/main/kotlin/com/relayium/protocol/legacy/WireProfile.kt",
  "app/src/androidTest/kotlin/com/relayium/android/LegacyInteropAcceptanceTest.kt",
];
for (const relative of REQUIRED) {
  check(read(relative) !== null, `apps/android/${relative} is missing. This file asserts rules `
    + `ABOUT it, so a rename that is not reflected here turns every rule below into a check `
    + `that matches nothing and passes.`);
}
// ── recoverable uploads: the facts no Kotlin test can assert about itself ────
//
// A resumable upload leaves the user's ciphertext, its content key and their
// filenames on the device between two processes. Three properties make that
// safe, and each is one edit away from being silently untrue while every test
// still passes.

const pendingStore = codeOf(read("app/src/main/kotlin/com/relayium/android/cloud/PendingUpload.kt") ?? "");
const secretBox = codeOf(read("app/src/main/kotlin/com/relayium/android/cloud/SecretBox.kt") ?? "");
const cloudWiring = codeOf(read("app/src/main/kotlin/com/relayium/android/TransferViewModel.kt") ?? "");
const bearerStore = codeOf(read("app/src/main/kotlin/com/relayium/android/account/KeystoreTokenStore.kt") ?? "");

// 1. Both stores live where Android's backup machinery cannot reach them. A
//    restored spool is inert — the keystore key is not backed up either — but an
//    inert blob that still looks like a resumable upload is exactly the
//    confusing state `noBackupFilesDir` exists to prevent.
check(
  /noBackupFilesDir/.test(cloudWiring)
  && /PendingUploadStore\(/.test(cloudWiring)
  && /StoredLinkKeyStore\(/.test(cloudWiring),
  "the pending-upload and stored-link-key stores are not constructed under "
  + "`noBackupFilesDir` in TransferViewModel. Both hold the user's filenames and an object's "
  + "content key; a path outside it is copied by backup and device transfer.",
);

// 2. The pending-upload keystore alias is NOT the bearer's. KeystoreTokenStore
//    DELETES its alias on `clear()`, which is what makes a sign-out
//    unrecoverable — and would, if the alias were shared, shred the content key
//    of every interrupted upload on the device, including one belonging to the
//    account the user is about to sign back into.
const bearerAlias = /const val ALIAS = "([^"]+)"/.exec(bearerStore)?.[1];
const pendingAlias = /const val DEFAULT_ALIAS = "([^"]+)"/.exec(secretBox)?.[1];
check(
  Boolean(bearerAlias) && Boolean(pendingAlias) && bearerAlias !== pendingAlias,
  "the pending-upload keystore alias is missing or is the same as the bearer's "
  + `(bearer ${bearerAlias}, pending ${pendingAlias}). KeystoreTokenStore.clear deletes its `
  + "alias, so sharing one would make signing out destroy every interrupted upload's key.",
);
check(
  !/deleteEntry/.test(secretBox),
  "KeystoreSecretBox deletes its keystore entry. Discarding a job removes that job's own files, "
  + "which is what makes its key unrecoverable; deleting the alias would take every OTHER "
  + "pending upload and every stored-link key with it.",
);

// 3. Durability is a real barrier, not a comment. The recovery rules turn on
//    "this write landed before that request left", and a rename is a DIRECTORY
//    write that an fsync on the renamed file says nothing about.
check(
  /Os\.fsync/.test(secretBox) && /S_ISDIR/.test(secretBox),
  "SecretBox.kt does not fsync a directory whose type it has checked. The finalize-attempt "
  + "marker and the plan-written-last rule are claims about directory entries; without a "
  + "directory sync they are claims about the page cache.",
);
check(
  /class PendingUploadStore\([\s\S]{0,400}?durable: DurableFiles = DurableFiles\.Platform/.test(pendingStore),
  "PendingUploadStore does not default its write barriers to DurableFiles.Platform. The "
  + "injectable seam exists so a test can fail a NAMED barrier; the platform one must be what "
  + "the app gets without asking.",
);

// ── the recovery acceptance is a process death, not a recreation ─────────────
//
// This is the assertion the harness cannot make about itself. `ActivityScenario
// .recreate` restarts an Activity inside a living process; the whole claim of a
// resumable upload is about the process ENDING. A future edit that replaced the
// force-stop with a recreation would leave a green suite proving nothing.
const recoveryScript = readFileSync(
  resolve(repoRoot, "scripts/android-cloud-recovery-acceptance.sh"), "utf8",
);
// Matched on ORDER, not on presence. The script's cleanup handler force-stops
// the app too, so "a force-stop appears somewhere" would stay true after the
// phase-boundary kill was deleted — which is exactly the edit this must catch.
const firstPhase = recoveryScript.indexOf('-e class "$test_class#${phases[0]}"');
const boundaryKill = recoveryScript.indexOf(
  'adbs shell am force-stop "$app_id" >/dev/null || fail',
);
// The script asks `pidof` twice — once to prove the app is ALIVE at the moment
// of the kill, once to prove it is gone afterwards — so the two are located
// from opposite ends rather than by a first match.
const livenessVerified = recoveryScript.indexOf('pidof "$app_id"');
const deathVerified = recoveryScript.lastIndexOf('pidof "$app_id"');
const laterPhases = recoveryScript.indexOf('for phase in "${phases[@]:1}"');
check(
  firstPhase >= 0 && boundaryKill > firstPhase && laterPhases > boundaryKill,
  "scripts/android-cloud-recovery-acceptance.sh does not force-stop the app BETWEEN the first "
  + "phase and the rest. Without that kill it is an Activity-recreation test, and the durable "
  + "spool, plan and content key are never recovered from disk by a new process.",
);
check(
  deathVerified > boundaryKill && deathVerified < laterPhases,
  "the recovery acceptance does not verify the app process actually died before the resuming "
  + "phases. `am force-stop` returning is not the process being gone, and a phase that ran in "
  + "the surviving process would pass while proving nothing.",
);
check(
  livenessVerified > firstPhase && livenessVerified < boundaryKill,
  "the recovery acceptance does not verify the app was still RUNNING when the kill was due. "
  + "Killing a process that had already finished its upload proves nothing about recovery.",
);
// Decoded plaintext at the far end does NOT distinguish a replay from a client
// that re-encrypted the user's files and uploaded them from zero — both produce
// the same bytes. The job's identity is what tells them apart, so the run has
// to compare it.
check(
  /spoolSha256/.test(recoveryScript) && /uploadId/.test(recoveryScript),
  "the recovery acceptance does not compare the job's spool hash and upload id across the "
  + "process death. Without them a re-encrypted, re-initialised upload passes the digest check "
  + "and the replay claim is unproven.",
);
check(
  (recoveryScript.match(/pm clear/g) ?? []).length === 1,
  "the recovery acceptance clears the app's data more than once. It must be cleared ONLY before "
  + "the first phase: a clear between phases deletes the staged upload the run exists to recover.",
);

// Every phase the script orders must exist as a test method, and vice versa: a
// renamed method would otherwise make `am instrument` run zero tests, which the
// per-phase count check catches, while a method the script never runs would be
// dead evidence nobody notices.
const recoveryTest = readFileSync(
  resolve(android, "app/src/androidTest/kotlin/com/relayium/android/CloudRecoveryAcceptanceTest.kt"),
  "utf8",
);
const scriptPhases = /phases=\(([^)]*)\)/.exec(recoveryScript)?.[1]
  ?.split(/\s+/).filter((line) => /^[a-zA-Z]/.test(line)) ?? [];
check(
  scriptPhases.length === 4,
  `the recovery acceptance declares ${scriptPhases.length} phases; four are expected `
  + "(stage, resume, decode, history).",
);
for (const phase of scriptPhases) {
  check(
    new RegExp(`fun ${phase}\\(`).test(recoveryTest),
    `scripts/android-cloud-recovery-acceptance.sh runs ${phase}, which CloudRecoveryAcceptanceTest `
    + "does not declare. `am instrument` would run zero tests for it.",
  );
}
const declared = [...recoveryTest.matchAll(/@Test\s+fun ([a-zA-Z]+)\(/g)].map((m) => m[1]);
for (const method of declared) {
  check(
    scriptPhases.includes(method),
    `CloudRecoveryAcceptanceTest declares ${method}, which the recovery acceptance never runs. `
    + "An unrun phase is evidence nobody collects.",
  );
}

// ── the shipped legacy wire: the bytes it does NOT have ─────────────────────
//
// The claim these rules protect is narrow and load-bearing: this client speaks
// the older wire EXACTLY as the shipped Apple and Web clients do. The two ways
// to break that are invisible in a green unit run — announce a capability the
// implementation cannot honour, or emit a control byte the peer's three-case
// `RealtimeControl(rawValue:)` will feed to its AEAD receiver — and both are
// properties of which source declares what, which is what this file is for.

const legacyProtocol = codeOf(read("protocol/src/main/kotlin/com/relayium/protocol/legacy/LegacyProtocol.kt") ?? "");
const legacyText = codeOf(read("protocol/src/main/kotlin/com/relayium/protocol/legacy/LegacyTextLane.kt") ?? "");
const linkProtocol = codeOf(read("protocol/src/main/kotlin/com/relayium/protocol/LinkProtocol.kt") ?? "");

// The `link/1` additions, by the names the shared vocabulary gives them. A
// legacy source that reached either would be inventing a dialect.
for (const [name, source] of [["LegacyProtocol.kt", legacyProtocol], ["LegacyTextLane.kt", legacyText]]) {
  check(
    !/CTRL_BUSY|CTRL_BATCH_ABORT/.test(source),
    `${name} names a link/1-only control byte. The shipped wire's control set is exactly `
    + `ACCEPT/REJECT/COMPLETE; a peer receiving 0xf9 or 0xf8 feeds it to its AEAD receiver `
    + `and fails the whole connection.`,
  );
  check(
    !/CTRL_REQUEST|TextWire\.REQUEST|TextWire\.END/.test(source),
    `${name} names the link/1 conversation lifecycle bytes. There is no 0xfa and no 0xfb on `
    + `the shipped wire: the offer is the request, and ending means closing the connection.`,
  );
}

// `text/1` may be announced only while a handler for it exists. Announcing it
// without one invites a peer onto a connection that cannot open; implementing
// it without announcing it is worse than useless, because the Apple factory
// refuses to offer a message connection before hearing the exact string back.
const announcesText = /ADVERTISED_CAPS[^\n]*TEXT_CAPABILITY/.test(linkProtocol);
const hasTextHandler = /class LegacyTextLane/.test(legacyText);
check(
  announcesText === hasTextHandler,
  "the announced capability set and the shipped-wire message handler must move together: "
  + `announces text/1 = ${announcesText}, has a handler = ${hasTextHandler}.`,
);

// The role on this wire is the user's INTENT. A controller that derived it from
// the hub ids instead would disagree with every already-deployed peer about who
// offers, and the disagreement looks exactly like a network failure.
const legacyController = codeOf(read("app/src/main/kotlin/com/relayium/android/TransferController.kt") ?? "");
check(
  /enum class Intent \{ MINTER, JOINER \}/.test(legacyController),
  "TransferController no longer carries the minter/joiner intent. On the shipped wire the "
  + "creator of the code offers and the joiner answers; a sorted-id role there would make two "
  + "clients disagree about who offers.",
);
check(
  /WireProfile\.Legacy\(\s*LinkProtocol\.Role\.INITIATOR/.test(legacyController)
    && /WireProfile\.Legacy\(LinkProtocol\.Role\.RESPONDER/.test(legacyController),
  "the controller must build BOTH legacy roles. A build that only ever answered would leave "
  + "every session an Android user starts untested and unreachable.",
);

// The owning acceptance must name what its Apple half actually is. A harness
// that let a host-compiled Swift process be read as an iOS binary would be
// making the one claim this lane cannot support.
const legacyAcceptance = resolve(repoRoot, "scripts/android-apple-legacy-acceptance.sh");
check(existsSync(legacyAcceptance), "scripts/android-apple-legacy-acceptance.sh is missing.");
if (existsSync(legacyAcceptance)) {
  const acceptanceText = readFileSync(legacyAcceptance, "utf8");
  // Comments stripped for the PROHIBITION below, and only for it: this
  // script's own header explains that cleanup is PID-exact and no `pkill` is
  // used, and a check that matched that sentence would fail on the prose that
  // explains why it passes. The two POSITIVE claims are asserted against the
  // full text, because one of them IS a sentence.
  const acceptance = acceptanceText.replace(/^\s*#.*$/gm, "");
  check(
    /NOT an iOS binary/.test(acceptanceText) && /shasum -a 256/.test(acceptance),
    "the legacy acceptance must say plainly that its Apple half is the shipped transport "
    + "compiled on the host rather than an iOS binary, and must CHECK that the modules it "
    + "mirrors are byte-identical to the shipped ones.",
  );
  check(
    !/pkill/.test(acceptance),
    "the legacy acceptance uses pkill. Cleanup is PID-exact everywhere else in this suite.",
  );
  // The shared library treats a zero exit that never reached the PASS marker as
  // a failure, so a script without it can pass every one of its own checks and
  // still report exit 1 — which is exactly what ten green rounds did once.
  check(
    /\ncompleted=1\n?$/.test(acceptanceText.replace(/\s+$/, "\n")),
    "the legacy acceptance does not end with `completed=1`. scripts/lib/local-acceptance.sh "
    + "refuses a zero exit that never reached that marker, so without it a fully passing run "
    + "still reports failure.",
  );
}

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`android-policy-test: ${failures.length} failure(s)`);
  process.exit(1);
}

const gradle = codeOf(read("app/build.gradle.kts"));
const backend = codeOf(read("app/src/main/kotlin/com/relayium/android/Backend.kt"));
const mainManifest = codeOf(read("app/src/main/AndroidManifest.xml"));
const debugManifest = codeOf(read("app/src/debug/AndroidManifest.xml"));
const releaseHooks = codeOf(read("app/src/release/kotlin/com/relayium/android/TestHooks.kt"));

// ── 1. the release backend fence, at the build-configuration level ──────────
//
// The one fact the Kotlin suite structurally cannot reach.

const buildTypeBody = (name) => {
  const at = gradle.indexOf(`${name} {`);
  if (at < 0) return null;
  // Brace-match from the build type's own opening brace.
  let depth = 0;
  for (let i = gradle.indexOf("{", at); i < gradle.length; i++) {
    if (gradle[i] === "{") depth++;
    else if (gradle[i] === "}" && --depth === 0) return gradle.slice(at, i + 1);
  }
  return null;
};

const releaseBlock = buildTypeBody("release");
const debugBlock = buildTypeBody("debug");

check(releaseBlock !== null, "app/build.gradle.kts declares no `release {` build type block, so "
  + "nothing here can state what a shipped build resolves.");
check(debugBlock !== null, "app/build.gradle.kts declares no `debug {` build type block.");

if (releaseBlock) {
  check(
    /buildConfigField\(\s*"boolean",\s*"ALLOW_BACKEND_OVERRIDE",\s*"false"\s*\)/.test(releaseBlock),
    "the RELEASE build type does not set `ALLOW_BACKEND_OVERRIDE` to \"false\". That flag is "
    + "`Backend.resolve`'s mandatory fence: with it true, a shipped build would honour a "
    + "developer-set system property and send a pairing code to whatever origin it names. No "
    + "Kotlin test can catch this — AGP generates no release unit-test task in this project.",
  );
  check(
    !/signingConfig/.test(releaseBlock),
    "the RELEASE build type declares a `signingConfig`. Release signing is owned outside this "
    + "repository and `assembleRelease` produces an UNSIGNED artifact on purpose; a default "
    + "debug-signed \"release\" is an artifact that looks distributable and is not.",
  );
}
if (debugBlock) {
  check(
    /buildConfigField\(\s*"boolean",\s*"ALLOW_BACKEND_OVERRIDE",\s*"true"\s*\)/.test(debugBlock),
    "the DEBUG build type no longer sets `ALLOW_BACKEND_OVERRIDE` to \"true\". The emulator "
    + "acceptance points the app at a throwaway local server through it, and the app asserts "
    + "its own resolved origin before joining — so with the flag false the acceptance would "
    + "fail its preflight rather than run against production, but it would not run at all.",
  );
}

// ── 2. the fence is MANDATORY, not a default parameter (R18) ────────────────

check(
  /if\s*\(\s*!BuildConfig\.ALLOW_BACKEND_OVERRIDE\s*\|\|/.test(backend),
  "`Backend.resolve` no longer tests `BuildConfig.ALLOW_BACKEND_OVERRIDE` as a mandatory "
  + "conjunct. If the variant flag is only the DEFAULT of an `allowOverride` parameter, an "
  + "explicit `allowOverride = true` reopens the override in a release build — and the file's "
  + "own claim that production is the only value a shipped build can have becomes false.",
);
check(
  !/allowOverride:\s*Boolean\s*=\s*BuildConfig\./.test(backend),
  "`Backend.resolve`'s `allowOverride` parameter defaults to the BuildConfig flag. That is the "
  + "exact shape R18 rejects: it reads as a fence and behaves as a suggestion. The parameter "
  + "must only ever narrow; the flag must be checked unconditionally.",
);
check(
  /BuildConfig\.ALLOW_BACKEND_OVERRIDE/.test(backend)
  && /fun readDebugOverride/.test(backend),
  "`Backend.readDebugOverride` must itself be gated on the variant flag, so a release build "
  + "never even reads the system property.",
);

// ── 3. debug-only surfaces stay out of main and release ─────────────────────

check(
  !/usesCleartextTraffic\s*=\s*"true"/.test(mainManifest)
  && !/networkSecurityConfig/.test(mainManifest),
  "the MAIN manifest carries a cleartext or network-security-config attribute. The plain-HTTP "
  + "loopback policy the acceptance needs is a DEBUG overlay; in main it would ship.",
);
check(
  /networkSecurityConfig/.test(debugManifest),
  "the DEBUG manifest overlay no longer declares its network security config, so the emulator "
  + "acceptance cannot reach the local server over plain HTTP — and the reason main is clean "
  + "stops being true by construction.",
);
check(
  /TestDocumentsProvider/.test(debugManifest),
  "the disposable documents provider is not declared in the DEBUG manifest overlay.",
);
check(
  !/TestDocumentsProvider/.test(mainManifest),
  "the disposable documents provider is declared in the MAIN manifest, so it would be present "
  + "in a release APK. It is a writable provider over the app's own storage; it belongs to the "
  + "debug source set and nowhere else.",
);
check(
  !existsSync(resolve(android, "app/src/release/kotlin/com/relayium/android/TestDocumentsProvider.kt"))
  && !existsSync(resolve(android, "app/src/main/kotlin/com/relayium/android/TestDocumentsProvider.kt")),
  "a TestDocumentsProvider source file exists outside the debug source set.",
);

// The release variant of the instrumentation hook must STORE nothing: the
// point is that a release APK contains no reference to the ViewModel and no
// observation surface, rather than a disabled one.
check(
  !/\bvar\s+viewModel/.test(releaseHooks) && /=\s*Unit/.test(releaseHooks),
  "the RELEASE `TestHooks` stores a ViewModel or does real work. Its whole purpose is to "
  + "compile the observation surface OUT of a release APK; a release variant that merely "
  + "declined to use what it held would still hold it.",
);

// ── 4. the exported surface a release APK offers ────────────────────────────
//
// Nothing exported may accept a backend override, and the join intent filter
// must stay unverified — an autoVerify=true with no assetlinks.json on the
// server produces a link that silently never routes.

check(
  /android:autoVerify="false"/.test(mainManifest),
  "the join intent filter no longer declares `autoVerify=\"false\"`. There is no "
  + "assetlinks.json on the production origin, so claiming verification produces a link that "
  + "silently never routes.",
);
check(
  !/ACTION_SEND|android\.intent\.action\.SEND/.test(mainManifest),
  "the manifest declares an ACTION_SEND filter. This stage has no share handler; declaring one "
  + "would offer users an entry point that does nothing.",
);

// ── 5. the update check ─────────────────────────────────────────────────────
//
// The updater decides where an install link comes from, so its debug-only feed
// override is fenced exactly as the backend override is — and for the same
// reason. These facts have the same shape as the ones above: no Kotlin test can
// assert them, because AGP generates host unit tests for the test build type
// only, so a release assertion would be skipped in every run that exists.

const updateEndpoint = codeOf(read("app/src/main/kotlin/com/relayium/android/update/UpdateEndpoint.kt"));
// RAW, not comment-stripped. `codeOf` treats `//` as a line comment, and the
// official URL contains one inside its string literal — stripping it would
// truncate the very line being asserted and the check would fail on correct
// source. Nothing below matches a construct this file's prose also names, so
// the raw text is safe here.
const updateFeed = read("app/src/main/kotlin/com/relayium/android/update/UpdateFeed.kt");
const viewModel = codeOf(read("app/src/main/kotlin/com/relayium/android/TransferViewModel.kt"));

check(
  /buildConfigField\(\s*"boolean",\s*"ALLOW_UPDATE_FEED_OVERRIDE",\s*"false"\s*\)/.test(releaseBlock),
  "the release build no longer sets ALLOW_UPDATE_FEED_OVERRIDE=false. A shipped build could then "
  + "be pointed at a feed that is not the official one, which is where an install link comes from.",
);
check(
  /buildConfigField\(\s*"boolean",\s*"ALLOW_UPDATE_FEED_OVERRIDE",\s*"true"\s*\)/.test(debugBlock),
  "the debug build no longer sets ALLOW_UPDATE_FEED_OVERRIDE=true, so the acceptance cannot point "
  + "the real updater at a throwaway feed and the available/error branches become untestable on a device.",
);

// MANDATORY, not a default parameter. An explicit `allowOverride = true` must
// not be able to reopen it in a release build — R18's lesson, applied here.
check(
  /if\s*\(\s*!BuildConfig\.ALLOW_UPDATE_FEED_OVERRIDE\s*\|\|/.test(updateEndpoint),
  "UpdateEndpoint.resolve no longer reads BuildConfig.ALLOW_UPDATE_FEED_OVERRIDE as a mandatory "
  + "conjunct. As a default parameter it could be bypassed by an explicit argument.",
);
check(
  !/allowOverride:\s*Boolean\s*=\s*BuildConfig\./.test(updateEndpoint),
  "UpdateEndpoint.resolve makes the variant flag a DEFAULT for its parameter. That would let an "
  + "explicit `allowOverride = true` reopen the fence in a release build.",
);

// No installer privilege. The flow is browser-mediated on purpose: the browser
// downloads, and the system installer asks the user to confirm. Holding
// REQUEST_INSTALL_PACKAGES would let this app install a package itself, which
// is a materially different trust posture and is not what any of the copy says.
// ── every Android acceptance addresses the INSTRUMENTATION package ─────────
//
// The runner is registered under `<applicationId>.test`, not under the app.
// Naming the app package produces "Unable to find instrumentation info" — which
// `am instrument` reports while EXITING 0, so a driver that trusted the exit
// status reports a green run in which nothing ran at all. This has already been
// got wrong once; the shape is invisible in review and obvious here.
for (const entry of readdirSync(resolve(repoRoot, "scripts"))) {
  if (!/^android-.*acceptance\.sh$/.test(entry)) continue;
  const script = readFileSync(resolve(repoRoot, "scripts", entry), "utf8");
  if (!/am instrument/.test(script)) continue;
  check(
    !/"\$app_id\/androidx\.test/.test(script) && !/\$\{app_id\}\/androidx\.test/.test(script),
    `scripts/${entry} addresses the instrumentation as $app_id/... The runner lives in `
    + "$app_id.test; am instrument cannot find it there and still exits 0, so the run "
    + "reports success having executed nothing.",
  );
  check(
    /\$test_pkg\/\$runner|\$\{test_pkg\}\/|\.test\/androidx\.test/.test(script),
    `scripts/${entry} does not address the instrumentation through its own .test package.`,
  );
}

// The Nearby run must never be able to resolve production. Both modes point the
// build at a local origin and say which; CLEARING the override resolves to
// Backend.PRODUCTION, which is how an acceptance ends up driving the real
// service while looking green.
{
  const nearbyScript = readFileSync(resolve(repoRoot, "scripts/android-nearby-acceptance.sh"), "utf8");
  check(
    /nearby\.expectOrigin/.test(nearbyScript),
    "the Nearby acceptance no longer passes the origin it expects the build to resolve. "
    + "Backend.readDebugOverride fails closed to PRODUCTION, so a property that did not take "
    + "must fail the round rather than silently redirect it.",
  );
  check(
    /acceptance_start_server/.test(nearbyScript),
    "the Nearby acceptance's hub mode no longer starts its own throwaway server. Leaving the "
    + "override unset resolves to production.",
  );
  check(
    /go build -o "\$run_root\/relayium-server"/.test(nearbyScript),
    "the Nearby acceptance's hub mode starts a server it never builds. "
    + "acceptance_start_server EXECUTES $run_root/relayium-server and does not produce it, so "
    + "the run fails at 'the server exited' with no binary to have exited.",
  );
  check(
    !/setprop debug\.relayium\.backend ""[^"]/.test(nearbyScript),
    "the Nearby acceptance clears the backend override during a run. An empty override is "
    + "PRODUCTION, not 'no backend'.",
  );
  // macOS ships Bash 3.2, where `"${empty[@]}"` under `set -u` is an UNBOUND
  // VARIABLE error rather than an empty expansion. Two identical device models
  // leave the optional peer-name arrays empty, which is the ordinary case for a
  // two-emulator run — so the bare form fails exactly the configuration this
  // script exists for, before a single device is touched. Reproduced on
  // /bin/bash 3.2.57: `set -u; a=(); echo "${a[@]}"` → `a[@]: unbound variable`.
  for (const name of ["host_peer_args", "guest_peer_args", "mode_args"]) {
    // The lookbehind matters: the SAFE form `${name+"${name[@]}"}` contains the
    // unsafe form as a substring, so a plain match flags the fix as the defect.
    check(
      !new RegExp(`(?<!\\+)"\\$\\{${name}\\[@\\]\\}"`).test(nearbyScript),
      `scripts/android-nearby-acceptance.sh expands $${name} as "\${${name}[@]}". `
      + "On Bash 3.2 — which is what macOS runs — that is an unbound-variable error when the "
      + `array is empty. Use \${${name}+"\${${name}[@]}"}, as lib/local-acceptance.sh does.`,
    );
    check(
      new RegExp(`\\$\\{${name}\\+"\\$\\{${name}\\[@\\]\\}"\\}`).test(nearbyScript),
      `scripts/android-nearby-acceptance.sh no longer expands $${name} with the `
      + "empty-safe form; an optional argument list must survive being empty.",
    );
  }

  check(
    /run_barrier_phase transfer nearby-ready\.json/.test(nearbyScript)
    && /run_barrier_phase room nearby-room-ready\.json/.test(nearbyScript),
    "the Nearby acceptance no longer holds both halves at BOTH barriers. One guards the session "
    + "(the message history is session state, and a side that disconnects first empties its "
    + "counterpart's mid-assertion); the other guards the roster (stopping Nearby withdraws this "
    + "device's advertisement, so the peer correctly vanishes from the other's list). One barrier "
    + "alone only moves the race to the phase after it.",
  );

  check(
    /acceptance_begin/.test(nearbyScript) && /completed=1/.test(nearbyScript)
    && /acceptance_extra_cleanup\(\)/.test(nearbyScript),
    "the Nearby acceptance no longer uses the shared local-acceptance lifecycle. Its own trap "
    + "left adb children, device properties and the run's reports behind on failure.",
  );
}

// The Nearby acceptance's own diagnostic thread must never be able to fail the
// round it is watching. An uncaught InterruptedException out of a thread body
// reaches Android's default handler, which KILLS THE PROCESS — and it did,
// during the `finally` of a round whose transfers had all succeeded, turning a
// fully passing run into a failure reported by its own instrumentation.
{
  const lanTest = readFileSync(
    resolve(android, "app/src/androidTest/kotlin/com/relayium/android/nearby/NearbyLanAcceptanceTest.kt"),
    "utf8",
  );
  check(
    /catch \(_: InterruptedException\)[\s\S]{0,900}?Thread\.currentThread\(\)\.interrupt\(\)/.test(lanTest),
    "the Nearby acceptance's progression thread no longer handles its own interrupt. "
    + "close() interrupts the sampling sleep; letting that escape the thread body crashes "
    + "the app process from inside the diagnostics.",
  );
  check(
    /thread\.join\(JOIN_MS\)/.test(lanTest),
    "the progression recorder no longer joins its thread on close, so the transcript can be "
    + "read while it is still being written.",
  );
}

// The Apple counterpart judge reads a TYPED receipt, and must never go back to
// searching the document for the digest. That earlier rule was not a receipt: a
// FAILED run whose diagnostic quoted the digest it was waiting for passed it,
// and a digest and a name could be satisfied by two DIFFERENT files. The peer
// publishes `files: [{name, size, sha256, path?}]` from `FileReceipt`
// (`LocalTransferPeer/main.swift`, `State.result`), so that is what is asserted.
{
  const oracle = readFileSync(resolve(repoRoot, "scripts/test/android-nearby-oracle.py"), "utf8");
  check(
    !/walk_strings/.test(oracle),
    "the Nearby oracle is walking every string in the Apple peer's document again. A digest "
    + "found anywhere is not a receipt — a failed run that quoted it in a diagnostic passed.",
  );
  check(
    /def judge_apple/.test(oracle)
    && /phase != "done"/.test(oracle)
    && /len\(files\) != 1/.test(oracle)
    && /if name != expected_name/.test(oracle)
    && /if sha != expected_sha/.test(oracle)
    && /if size != expected_size/.test(oracle),
    "the Apple counterpart judge no longer binds phase, file count, name, digest and size to "
    + "the ONE received file. Each of those was a way a non-delivery could pass.",
  );
  check(
    /apple_sas != android_sas/.test(oracle),
    "the Apple counterpart judge no longer compares the two clients' SAS values. Two clients "
    + "can move bytes without having authenticated each other; the SAS is what shows they did.",
  );
}

// The Android ↔ Web code-less-room lane. Its central claim is a SELECTION —
// "the device the user picked, out of several" — and every way that claim can be
// weakened is invisible in review: a target that sorts first, a decoy check that
// only looks at the end, a browser half that dials instead of answering, a
// judge that reads its own side's echo. These are the guards that notice.
{
  const webScript = readFileSync(
    resolve(repoRoot, "scripts/android-nearby-web-acceptance.sh"), "utf8",
  );
  check(
    /web\.expectOrigin/.test(webScript) && /acceptance_start_server/.test(webScript)
    && /go build -o "\$run_root\/relayium-server"/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh no longer builds and starts its OWN throwaway "
    + "server and tells the build which origin to expect. Backend.readDebugOverride fails "
    + "closed to PRODUCTION, so a property that did not take must fail the round rather than "
    + "silently redirect it at the real service.",
  );
  check(
    /\ncompleted=1\n?$/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh does not end with `completed=1`. "
    + "scripts/lib/local-acceptance.sh treats a run that stops early as a failure, and that "
    + "flag on the LAST line is the only thing that distinguishes one.",
  );
  // macOS ships Bash 3.2, where `"${empty[@]}"` under `set -u` is an unbound
  // variable error rather than the empty expansion Bash 4.4+ produces — and the
  // array here is empty on every ORDINARY run, so the bare form would fail
  // exactly the configuration this script exists for.
  check(
    /\$\{negative_args\+"\$\{negative_args\[@\]\}"\}/.test(webScript),
    'scripts/android-nearby-web-acceptance.sh no longer expands $negative_args with the '
    + '${name+"${name[@]}"} form. On Bash 3.2 with set -u the bare form is an unbound '
    + "variable error whenever the array is empty, which is every ordinary run.",
  );
  check(
    /--self-check/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh no longer runs the browser half's self-check "
    + "before it starts. Those scripts run inside a page, where a mistake in them is silent: "
    + "a latch that never looked reports the same zeroes a clean decoy does.",
  );
  check(
    /RELAYIUM_NEARBY_WEB_NEGATIVE/.test(webScript)
    && /web\.wrongSelection/.test(webScript)
    && /the NEGATIVE CONTROL passed/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh no longer offers a negative control that makes "
    + "the phone tap the wrong row and REFUSES a run in which that still passed. An "
    + "acceptance whose central invariant cannot be made to fail is evidence of nothing.",
  );
  // "The round failed" is satisfied by a crash, a missing runner, an APK that
  // never built and a plain timeout — none of which exercises the selection. A
  // control built on that would always hold and would therefore say nothing.
  check(
    /judge_negative/.test(webScript) && /web-negative/.test(webScript)
    && /INCONCLUSIVE/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh accepts ANY failure as its negative control "
    + "holding. It must require the control's own typed evidence — three candidates listed, "
    + "the FIRST row tapped, a DECOY connected to, and the browser's independent sighting of "
    + "that dial — and report anything else as inconclusive.",
  );
  // A successful run's per-run root is removed by lib/local-acceptance.sh, and a
  // HELD control is a successful run — so without this the evidence for the one
  // result that most needs it is deleted.
  // The phone writes its report from a `finally`, so a FAILED round produces one
  // too — and that partial is the most valuable artefact a failed round has. The
  // judging paths all return early, so the capture cannot live inside them.
  check(
    /capture_native_report/.test(webScript)
    && /json\.load\(open\(sys\.argv\[1\]\)\)/.test(webScript)
    && webScript.indexOf("capture_native_report || true")
       < webScript.indexOf("am force-stop"),
    "scripts/android-nearby-web-acceptance.sh no longer captures the phone's partial report "
    + "before the force-stop, on every path, validating that it is JSON. A judging path that "
    + "returns early would otherwise discard the one artefact a failed round has, and an "
    + "unchecked redirect would store run-as's own error text as a report.",
  );
  check(
    /RELAYIUM_NEARBY_WEB_ARTIFACTS/.test(webScript) && /snapshot_artifacts/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh no longer offers an artifact snapshot. "
    + "lib/local-acceptance.sh removes the run root on success, so a passing round and a held "
    + "negative control both leave nothing behind.",
  );
  // Three separate ways restoring this property goes wrong, and all three have
  // been made once: clearing instead of restoring; "restoring" on a path where
  // the run never overrode it (cleanup runs on EVERY exit, including a build
  // failure long before the capture); and assembling the remote command from
  // fragments, which `adb shell`'s argv re-join can split or execute.
  check(
    /getprop debug\.relayium\.backend >"\$run_root\/backend-before\.raw"/.test(webScript)
    && /backend_overridden=1/.test(webScript)
    && /shlex\.quote/.test(webScript)
    && /UNREPRESENTABLE/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh no longer captures the debug backend property "
    + "before overriding it, gates the restore on having actually overridden it, and builds "
    + "ONE already-quoted remote command (refusing a value it cannot represent, before any "
    + "mutation). Clearing on exit is not restoration, and a cleanup that runs before the "
    + "capture would reset a device this run never changed.",
  );
  // The cleanup must have no unconditional branch: an `else` that clears is
  // exactly the pre-capture failure path that resets an untouched device.
  {
    const cleanup = /acceptance_extra_cleanup\(\) \{([\s\S]*?)\n\}/.exec(webScript)?.[1] ?? "";
    check(
      /backend_overridden/.test(cleanup) && !/\belse\b/.test(cleanup),
      "scripts/android-nearby-web-acceptance.sh's cleanup touches the backend property on a "
      + "path where this run may never have overridden it.",
    );
  }
  // A shebang picks up whatever `node` is on PATH, so a run that carefully
  // selected a Node for the browser half would build the bundle with another.
  check(
    /node_modules\/vite\/bin\/vite\.js/.test(webScript),
    "scripts/android-nearby-web-acceptance.sh builds the bundle through a shebang wrapper "
    + "instead of running vite's entry point with the Node this run selected.",
  );

  const webBrowser = readFileSync(
    resolve(repoRoot, "web/e2e/android-nearby-hub.mjs"), "utf8",
  );
  // `.open-workspace` is the OUTBOUND action on a peer card. A browser half that
  // clicked it would be dialling the phone, and "the phone chose this device"
  // would be a claim about a session this side opened.
  check(
    !/OPEN_WORKSPACE\}'\)\.click\(\)|querySelector\('\.open-workspace'\)\.click/.test(webBrowser),
    "web/e2e/android-nearby-hub.mjs clicks the peer card's own workspace action. That is the "
    + "OUTBOUND control: a browser half that dials cannot show that the PHONE selected it.",
  );
  // A page renders both directions as `.msg-body`; only the `<li>` says which.
  // Reading every one of them lets this side's own echo satisfy an assertion
  // about what arrived, which is the one thing a text lane must not be able to
  // fake.
  check(
    /\.msg:not\(\.out\) \.msg-body/.test(webBrowser),
    "web/e2e/android-nearby-hub.mjs no longer restricts the received-message reading to "
    + "INBOUND bodies. `.msg-body` renders both directions, so an unrestricted read lets the "
    + "browser's own echo satisfy an assertion about what the phone sent.",
  );
  // ── the two defects the v1 owning run exposed ─────────────────────────
  //
  // Both were harness assumptions about shipped behaviour, and both are the kind
  // that reads as a product failure. Fenced here so they cannot come back.
  //
  // 1. `MessagePanel.svelte` renders the composer whenever `composing` is true,
  //    which in the unified workspace is `open || connecting || waitingAccept`,
  //    while `canSend` requires `status === "open"`. A blocking wait for Send to
  //    enable therefore starves the very loop that answers the consent card
  //    which would have opened the lane.
  check(
    /const trySendMessage/.test(webBrowser)
    && /'send-disabled'/.test(webBrowser)
    && !/const sendMessage = async/.test(webBrowser),
    "web/e2e/android-nearby-hub.mjs is waiting for the composer's Send to enable instead of "
    + "attempting one non-blocking tick. The composer renders in connecting and waitingAccept "
    + "too, so that wait blocks the loop that answers the consent card which opens the lane — "
    + "which is exactly how the v1 owning run died.",
  );
  // The only wait left may be the one that predates any session or sentinel.
  {
    const waits = [...webBrowser.matchAll(/\.waitFor\(/g)].length;
    check(
      waits <= 1,
      `web/e2e/android-nearby-hub.mjs has ${waits} blocking waitFor calls. Every long wait in `
      + "this round must sample the decoys and answer consent while it waits "
      + "(awaitWithSentinels); only the pre-session join wait may block.",
    );
  }
  // A link the product has already declared over must be reported as that, not
  // waited out — and the fail-fast must be sticky, because the workspace head
  // unmounts and remounts as the panel switches views.
  // 4. The anti-vacuity counter must answer to the CHOOSER surface, not to the
  //    peer card's button. `App.svelte`'s chooser is empty|link|radar by
  //    visiblePeers.length, and a peer CARD renders only for `selectedPeer` —
  //    automatic only when there is exactly ONE visible peer. With three peers a
  //    page sits in radar mode with nothing selected and renders no card, so a
  //    device that never passed through a one-peer moment never sees the button.
  //    That is ordering-dependent: v3's decoy01 passed and decoy02 did not.
  check(
    /const CHOOSER = "\.radar, \.peerlink"/.test(webBrowser)
    && /querySelector\(\$\{JSON\.stringify\(CHOOSER\)\}\)\) l\.chooser\+\+/.test(webBrowser),
    "web/e2e/android-nearby-hub.mjs is using something other than the chooser surface "
    + "(.radar / .peerlink) as its anti-vacuity signal. `.open-workspace` is NOT always "
    + "present: a page in radar mode with nothing selected renders no peer card, which is "
    + "how v3 failed at the finish line having proved everything else.",
  );
  // And it must be a PRECONDITION, not only an end-of-run check — the roster
  // section is `{#if !mixed && …}`, so the chooser is gone once a workspace
  // exists, and a page that was never live would otherwise be discovered last.
  check(
    /observers are live/.test(webBrowser)
    && webBrowser.indexOf("observers are live") < webBrowser.indexOf("to be given a workspace"),
    "web/e2e/android-nearby-hub.mjs no longer proves every observer is live BEFORE the "
    + "transfer starts. The chooser it checks for is gone once a workspace exists, so this "
    + "is the last moment the check is even possible.",
  );
  check(
    /wh-restart/.test(webBrowser) && /terminalTicks >= 6/.test(webBrowser),
    "web/e2e/android-nearby-hub.mjs waits out its whole timeout on a link the product has "
    + "already ended. `.wh-restart` is the product's own terminal marker; report it, after "
    + "enough consecutive ticks that a remount cannot be mistaken for an ending.",
  );
  check(
    /function selfCheck\(/.test(webBrowser) && /runInNewContext/.test(webBrowser),
    "web/e2e/android-nearby-hub.mjs no longer carries a self-check that RUNS its injected page "
    + "scripts. Syntax alone is not the risk; a dial classifier that counted a caps broadcast, "
    + "or ignored an unrecognised frame, would silently invert the decoy claim.",
  );
  check(
    /new MutationObserver\(look\)/.test(webBrowser) && /window\.__signals/.test(webBrowser),
    "web/e2e/android-nearby-hub.mjs no longer latches the decoys at BOTH the wire and the "
    + "DOM across the whole run. A wrong dial that was abandoned leaves nothing for a final "
    + "check to find.",
  );

  // 2. The shipped Web opens the text lane BY ITSELF, once per authenticated
  //    mixed link (App.svelte's textOpener). A native half that unconditionally
  //    requests one and waits for OPEN never answers the INCOMING_REQUEST it is
  //    actually holding — `requestText` does not accept one — and both endpoints
  //    wait forever.
  {
    const nativeHalf = readFileSync(
      resolve(repoRoot,
        "apps/android/app/src/androidTest/kotlin/com/relayium/android/nearby/"
        + "NearbyWebCounterpartTest.kt"),
      "utf8",
    );
    // The phone's own receipt of the negotiation, because the oracle cannot
    // assume which side was offered the prompt. Prompts are EDGES into
    // INCOMING_REQUEST, never raw clicks.
    check(
      /observed\["textNegotiation"\]/.test(nativeHalf)
      && /incomingPrompts\+\+/.test(nativeHalf)
      && /acceptedPrompts\+\+/.test(nativeHalf)
      && /insidePrompt/.test(nativeHalf),
      "NearbyWebCounterpartTest no longer reports the text-lane negotiation it actually "
      + "observed, with prompts counted as edges into INCOMING_REQUEST. Without it the judge "
      + "has to assume which endpoint answered, which is the assumption v4 died on.",
    );
    check(
      /INCOMING_REQUEST ->/.test(nativeHalf)
      && /R\.string\.text_accept/.test(nativeHalf)
      && /State\.IDLE -> \{[\s\S]{0,200}?if \(!requestedLocally\)/.test(nativeHalf),
      "NearbyWebCounterpartTest no longer answers an INCOMING_REQUEST through the real Accept "
      + "control and request the lane only when IDLE. The shipped Web opens the text lane by "
      + "itself once per authenticated link, so an unconditional requestText() waits for an "
      + "OPEN that nothing will produce — the v1 owning run's error_connection_lost.",
    );
  }

  // 3. Every other real UI acceptance in this repository scrolls a control into
  //    view before pressing it (AccountAcceptanceTest.signInThroughTheForm,
  //    CloudAcceptanceTest). Compose will click a node that exists in the
  //    semantics tree but is scrolled off screen, so a bare performClick on a
  //    control below the fold reports success and does nothing — which reads
  //    exactly like the product ignoring the press. The composer is tall, so
  //    Send is below the fold precisely once a draft has been typed.
  {
    const nativeHalf = readFileSync(
      resolve(repoRoot,
        "apps/android/app/src/androidTest/kotlin/com/relayium/android/nearby/"
        + "NearbyWebCounterpartTest.kt"),
      "utf8",
    );
    check(
      /performScrollTo\(\)/.test(nativeHalf)
      && /assertIsDisplayed\(\)/.test(nativeHalf)
      && /assertIsEnabled\(\)/.test(nativeHalf),
      "NearbyWebCounterpartTest presses controls without scrolling to them and proving they "
      + "are displayed and enabled. Compose clicks off-screen nodes happily, so an unreachable "
      + "control looks like a product that ignored the press.",
    );
    // Exactly one click SITE in the code. A blind second Send is a second
    // message, and an assertion that only passes because it pressed twice is not
    // evidence about the press. Counted over `codeOf`, because the comments
    // explaining the rule naturally quote the call it forbids duplicating.
    {
      const clicks = (codeOf(nativeHalf).match(/\.performClick\(\)/g) ?? []).length;
      check(
        clicks === 1 && /private fun reachAndClick\(/.test(nativeHalf),
        `NearbyWebCounterpartTest has ${clicks} performClick call sites in code, not 1. Every `
        + "press must go through the single scroll-prove-click path, so a retry cannot "
        + "silently become a second message.",
      );
    }
    // The diagnostics that let a harness failure be told from a product one —
    // and never a character of the user's text.
    check(
      /draftMatchesFixture/.test(nativeHalf) && /sendGeometry/.test(nativeHalf)
      && /belowFold/.test(nativeHalf)
      && !/"draft" to draft\.text/.test(nativeHalf),
      "NearbyWebCounterpartTest no longer captures the state and geometry needed to tell a "
      + "harness failure from a product one — or it has started recording the draft's text. "
      + "Lengths and a match flag, never content.",
    );
  }

  const nearbyOracle = readFileSync(
    resolve(repoRoot, "scripts/test/android-nearby-oracle.py"), "utf8",
  );
  check(
    /def judge_web_negative/.test(nearbyOracle)
    && /selected_id == target_id/.test(nearbyOracle)
    && /tapped != shown_order\[0\]/.test(nearbyOracle),
    "the wrong-selection control's judge no longer requires the phone to have tapped the FIRST "
    + "row and connected to something OTHER than the target. Without both, any failing round "
    + "would count as the control holding.",
  );
  check(
    /def judge_web/.test(nearbyOracle)
    && /model_order\.index\(target_name\) == 0/.test(nearbyOracle)
    && /shown_order\.index\(target_name\) == 0/.test(nearbyOracle),
    "the code-less-room judge no longer refuses a round in which the target was FIRST in the "
    + "model order or the FIRST ROW on screen. Either one lets a client that simply took the "
    + "first entry connect to the target and pass while proving nothing.",
  );
  check(
    /strict_count\(decoy\.get\("dialFrames"\)[\s\S]{0,80}?\) != 0/.test(nearbyOracle)
    && /latchTicks/.test(nearbyOracle) && /latchChooser/.test(nearbyOracle),
    "the code-less-room judge no longer requires both decoys to be un-dialled AND their "
    + "latches to have observed a live DOM. A latch that never looked reports the same zeroes "
    + "a clean decoy does.",
  );
  check(
    /r\.get\("path"\) == want\["path"\]/.test(nearbyOracle),
    "the code-less-room judge no longer binds each received file to its exact relative PATH. "
    + "A nested file that landed flat satisfies a name check and is still the wrong tree.",
  );
  // 5. Which endpoint answers the text consent is decided by the SHIPPED
  //    design — the Web opens the lane by itself once per authenticated link —
  //    so an oracle that always demanded the browser's consent is asserting a
  //    party contract the product does not have. Run v4 passed every real
  //    assertion and failed on exactly that rule.
  check(
    !/acceptedTextRequest"\) is not True/.test(nearbyOracle)
    && /textNegotiation/.test(nearbyOracle)
    && /NEITHER endpoint answered/.test(nearbyOracle),
    "the code-less-room judge has gone back to requiring a particular endpoint to answer the "
    + "text consent. It must require that SOME endpoint answered a real prompt, appropriate "
    + "to the negotiation that actually happened — and still fail when neither did.",
  );
  // `bool` is a subclass of `int` in Python, so `isinstance(True, int)` holds and
  // `True >= 1` is satisfied: a receipt that said `true` where a COUNT belongs
  // would pass every naive count check. That is the shape a fabricated receipt
  // takes, so counts and decisions are read through strict typed readers.
  check(
    /def strict_count/.test(nearbyOracle) && /def strict_bool/.test(nearbyOracle)
    && /isinstance\(value, bool\) or not isinstance\(value, int\)/.test(nearbyOracle)
    && /strict_count\(browser\["target"\]\.get\("acceptedFileRequests"\)/.test(nearbyOracle)
    && /strict_count\(decoy\.get\("dialFrames"\)/.test(nearbyOracle),
    "the code-less-room judge reads counts or decisions without the strict typed readers. In "
    + "Python a boolean IS an int, so `true` satisfies a count check and `False != 0` is "
    + "false — a counterfeit receipt would read as a clean decoy.",
  );
  // A card can still be on screen on the tick after a successful press, so raw
  // clicks are not prompts.
  check(
    /acceptedPrompts/.test(nearbyOracle) && /incomingPrompts/.test(nearbyOracle)
    && /is not a second prompt/.test(nearbyOracle),
    "the code-less-room judge counts raw consent CLICKS rather than distinct prompts. A "
    + "repeated click on one card is not a second person answering a second question.",
  );
  check(
    /def selftest/.test(nearbyOracle) && /--selftest/.test(nearbyOracle),
    "scripts/test/android-nearby-oracle.py no longer carries its executable negative controls. "
    + "An oracle nobody has tried to fool is a formatting exercise.",
  );
}

// ── Nearby: the local link, and what it must never reach ───────────────────
//
// The direct path's entire claim is that nothing about a transfer leaves the
// local link. That is enforced in two places at run time — the controller skips
// the ICE fetch for a source that may not use the backend, and `RealDeps`
// refuses one again at the seam — and both are assertions about SOURCE that a
// later edit can quietly move. These are the guards that notice.

const connectionSource = codeOf(read("app/src/main/kotlin/com/relayium/android/nearby/ConnectionSource.kt"));
const realDeps = codeOf(read("app/src/main/kotlin/com/relayium/android/RealDeps.kt"));
const controller = codeOf(read("app/src/main/kotlin/com/relayium/android/TransferController.kt"));
const nsdTransport = codeOf(read("app/src/main/kotlin/com/relayium/android/nearby/NsdLocalPeerTransport.kt"));
const advertisement = codeOf(read("app/src/main/kotlin/com/relayium/android/nearby/LocalPeerAdvertisement.kt"));

check(
  /data object Direct[\s\S]{0,400}?override val usesBackend get\(\) = false/.test(connectionSource),
  "the DIRECT Nearby source no longer declares usesBackend = false. That flag is what stops the "
  + "controller fetching ICE and what RealDeps refuses on; flipping it silently turns the "
  + "no-server path into one that contacts a server.",
);
check(
  /if \(!source\.usesBackend\) return IceConfig\.Result\(emptyList\(\), ""\)/.test(realDeps),
  "RealDeps no longer refuses an ICE fetch for a source that may not use the backend. The "
  + "controller's own skip is the first fence; this is the one a controller edit cannot remove.",
);
check(
  /if \(!source\.usesBackend\) \{[\s\S]{0,200}?ice = IceConfig\.Result\(emptyList\(\), ""\)/.test(controller),
  "TransferController.openRoom no longer skips the ICE fetch for a no-backend source. An empty "
  + "result is not the same promise as a request that is never made.",
);

// The two Nearby rooms admit nobody without a person. `others.firstOrNull()` is
// correct for a two-participant pairing room and is exactly wrong for a room
// keyed by a public address or by whatever is advertising on a link.
check(
  /if \(admission == PeerAdmission\.EXPLICIT\) \{[\s\S]{0,600}?publishNearby\(\)\s*\n\s*return/.test(controller),
  "TransferController.onRoster no longer returns before establishment under EXPLICIT admission. "
  + "Without that fork the code-less room — which lists every device behind one public address — "
  + "would connect to whichever peer happened to arrive first.",
);
check(
  /fun connectToPeer\(peerId: String, expectedRoom: Int\)/.test(controller)
  && /fun admitPeer\(peerId: String, expectedPrompt: Int\)/.test(controller)
  && /fun rejectPeer\(peerId: String, expectedPrompt: Int\)/.test(controller),
  "a Nearby user action no longer carries the room or prompt it was rendered against. A peer id "
  + "alone is not authority: a local-link device keeps its identity while it keeps advertising, "
  + "so a stale tap would still name something that matches.",
);

// The platform's own local-network rules, as this build's target actually
// stands. Raising the target is a separate, deliberate decision that brings a
// runtime permission with it; it must not happen as a side effect.
check(
  /targetSdk = "36"/.test(read("gradle/libs.versions.toml")),
  "targetSdk moved off 36. Local network access is granted under INTERNET at 36 and below; "
  + "target 37 requires ACCESS_LOCAL_NETWORK at run time, with denial and revocation paths "
  + "this build has neither written nor tested.",
);
check(
  !/ACCESS_LOCAL_NETWORK|CHANGE_WIFI_MULTICAST_STATE|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION/.test(mainManifest),
  "the manifest declares a local-network, multicast or location permission. NsdManager needs "
  + "none of them at this target, and declaring one asks the user for access this build does "
  + "not use.",
);

// The wire itself. Each of these is a value an Apple peer compares exactly; a
// drift here is a device that appears on one platform and is invisible on the
// other, which no unit test on one side can see.
check(
  /const val SERVICE_TYPE = "_relayium\._tcp\."/.test(advertisement)
  && /const val IDENTITY_LENGTH = 32/.test(advertisement)
  && /const val MAX_NAME_BYTES = 64/.test(advertisement)
  && /const val MAX_CAPABILITY_BYTES = 24/.test(advertisement)
  && /const val MAX_CAPABILITIES = 8/.test(advertisement),
  "a discovery-record bound no longer matches LocalPeerAdvertisement.swift. These are compared "
  + "byte for byte by the shipped Apple clients.",
);
check(
  /LocalPeerFraming\.strictUtf8\(bytes\) \?: return/.test(nsdTransport),
  "the NSD transport no longer decodes TXT values strictly. The lenient decoder substitutes "
  + "U+FFFD, which would admit a name or a capability the peer never sent — and a capability is "
  + "compared for exact equality everywhere it is read.",
);
check(
  /const val MAX_FRAME_BYTES = 64 \* 1024/.test(
    codeOf(read("app/src/main/kotlin/com/relayium/android/nearby/LocalPeerFraming.kt")),
  ),
  "the signalling frame ceiling no longer matches LocalPeerFraming.swift's 64 KiB.",
);

check(
  !/REQUEST_INSTALL_PACKAGES/.test(mainManifest),
  "the manifest requests REQUEST_INSTALL_PACKAGES. The update flow hands a URL to the browser and "
  + "the system installer asks the user; an installer privilege is neither needed nor described anywhere.",
);
check(
  !/PackageInstaller|packageInstaller/.test(viewModel),
  "the ViewModel reaches for PackageInstaller. Nothing in this product installs a package itself.",
);

// The release TestHooks must not carry a settable launcher: the debug variant's
// stand-in exists so the acceptance can observe the download URL, and a release
// build must have exactly one launch path.
check(
  /fun updateLauncher\(\)/.test(releaseHooks) && !/\bvar\s+installedLauncher/.test(releaseHooks),
  "the RELEASE `TestHooks` exposes a settable update launcher. Its answer must be a constant null "
  + "with no field behind it, so no in-process surface can redirect where an update link sends the user.",
);

// The two halves of the version must move together. `versionCode` is the only
// ordering the update check uses; a bump of one without the other publishes a
// build the client cannot order correctly.
const versionCode = /versionCode\s*=\s*(\d+)/.exec(gradle)?.[1];
const versionName = /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1];
check(
  versionCode !== undefined && versionName !== undefined,
  "app/build.gradle.kts no longer declares both versionCode and versionName.",
);
check(
  versionName === undefined || /^\d+\.\d+\.\d+$/.test(versionName),
  `versionName ${JSON.stringify(versionName)} is not X.Y.Z. The download URL is DERIVED from it, `
  + "so an arbitrary label would mean an arbitrary path component.",
);

// The official feed URL and the publisher's must be the same string, or an
// installed build reads a document nothing publishes.
check(
  /const val OFFICIAL_URL = "https:\/\/relayium\.com\/apps\/android\/update\.json"/.test(updateFeed),
  "UpdateFeed.OFFICIAL_URL is not https://relayium.com/apps/android/update.json, which is where "
  + "gen-pages publishes the manifest. A mismatch is invisible until a user presses Check for updates.",
);

// ── 6. the account credential ───────────────────────────────────────────────
//
// These are source-shape facts, and each is a one-line edit away from being
// silently untrue in a way that no Kotlin test can observe about itself: the app
// still builds, every unit test still passes, and the only evidence is where a
// credential ended up on a real device.

const keystoreStore = codeOf(read("app/src/main/kotlin/com/relayium/android/account/KeystoreTokenStore.kt"));
const accountTransport = codeOf(read("app/src/main/kotlin/com/relayium/android/account/OkHttpAccountTransport.kt"));
const accountScreen = codeOf(read("app/src/main/kotlin/com/relayium/android/ui/AccountScreen.kt"));

// The bearer is wrapped by a key this process cannot export, and the ciphertext
// lives where the platform itself says backup and device transfer do not reach.
// `allowBackup="false"` in the manifest is the other half; neither is enough
// alone, because each is one attribute or one path away from being reverted.
check(
  /noBackupFilesDir/.test(keystoreStore),
  "KeystoreTokenStore no longer writes into noBackupFilesDir. The wrapped bearer would then be "
  + "eligible for backup and device-to-device transfer, where it is a credential in someone else's "
  + "hands rather than an inert file.",
);
check(
  /"AndroidKeyStore"/.test(keystoreStore) && /AES\/GCM\/NoPadding/.test(keystoreStore),
  "KeystoreTokenStore no longer wraps the bearer with an AndroidKeyStore AES-GCM key. Anything "
  + "weaker means the ciphertext file is openable by whoever can read it.",
);
check(
  /setRandomizedEncryptionRequired\(true\)/.test(keystoreStore),
  "KeystoreTokenStore no longer requires randomized encryption. Without it a caller may supply the "
  + "IV, and a reused nonce under one AES-GCM key destroys the integrity of every message under it.",
);
check(
  /android:allowBackup="false"/.test(read("app/src/main/AndroidManifest.xml")),
  "the manifest no longer sets allowBackup=false.",
);

// A bearer belongs in a header. In a URL it lands in every proxy and access log
// between here and the server, and in this app's own crash reports.
for (const [name, source] of [
  ["OkHttpAccountTransport", accountTransport],
  ["AccountClient", codeOf(read("app/src/main/kotlin/com/relayium/android/account/AccountClient.kt"))],
]) {
  check(
    !/[?&](token|access_token|bearer)=/.test(source),
    `${name} composes a URL carrying a credential in its query string. The bearer is an `
    + "Authorization header precisely so it does not reach a proxy log.",
  );
}
check(
  /followRedirects\(false\)/.test(accountTransport) && /followSslRedirects\(false\)/.test(accountTransport),
  "the account transport follows redirects. These requests carry a bearer, so a redirect would "
  + "forward the credential to whatever host answered.",
);

// Nothing in the account layer logs. Several of these values ARE credentials,
// and a log line is the one place they would survive outside the process.
const accountDir = resolve(android, "app/src/main/kotlin/com/relayium/android/account");
for (const file of existsSync(accountDir) ? readdirSync(accountDir) : []) {
  if (!file.endsWith(".kt")) continue;
  const body = codeOf(readFileSync(resolve(accountDir, file), "utf8"));
  check(
    !/\b(android\.util\.)?Log\.[dviwe]\s*\(|println\s*\(/.test(body),
    `apps/android/app/src/main/kotlin/com/relayium/android/account/${file} logs. Bearers, `
    + "passwords and reactivation tokens pass through this package, and a log line is the one place "
    + "they would outlive the process.",
  );
}

// The password is collected by a composable and cleared when the request owns
// it. `rememberSaveable` would write it into saved instance state, which the
// system persists OUTSIDE this process.
check(
  /var password by remember \{/.test(accountScreen),
  "AccountScreen no longer holds the password in plain `remember`. If it became `rememberSaveable` "
  + "the credential would be written into saved instance state, outside this app's memory.",
);
check(
  !/rememberSaveable[^\n]*password/i.test(accountScreen),
  "AccountScreen puts the password into rememberSaveable. Saved instance state is persisted by the "
  + "system outside this process.",
);

// The reactivation token is the one value that can undo a deletion. It is read
// from the wire and deliberately never carried into a state object or a screen.
const accountModels = codeOf(read("app/src/main/kotlin/com/relayium/android/account/AccountModels.kt"));
check(
  !/reactivateToken/.test(accountModels) && !/reactivateToken/.test(accountScreen),
  "the reactivation token has been given a home in the account models or on the account screen. It "
  + "is the single value that can undo a deletion; this app has no screen that can spend it, so it "
  + "must not be carried or displayed.",
);

// ── the stored-transfer key never reaches durable state ─────────────────────
//
// A stored link carries its decryption KEY in the `#k=` fragment, so anything
// that persists a link persists the ability to read the files. Two rules, and
// both are about a construct that would look entirely ordinary in review.

const cloudScreen = codeOf(read("app/src/main/kotlin/com/relayium/android/ui/CloudScreen.kt"));
const cloudClient = codeOf(read("app/src/main/kotlin/com/relayium/android/cloud/CloudClient.kt"));

// `rememberSaveable` writes into the Activity's saved-instance Bundle, which the
// system may persist to disk and restore into a LATER PROCESS. The pasted-link
// field is therefore a ViewModel draft (CloudLinkDraft), not saveable state. The
// two `rememberSaveable` uses this screen may legitimately have hold a copied
// flag and picker request numbers, so the rule is on what they are initialised
// WITH: anything string-typed is refused.
const saveableStrings = cloudScreen.match(/rememberSaveable\s*\{[^}]*mutableStateOf\s*\(\s*"/g);
check(
  saveableStrings === null,
  "CloudScreen.kt holds string state in `rememberSaveable`. A stored link carries its decryption "
  + "key in its `#k=` fragment and saved instance state is written to disk and restored into a "
  + "later process, so link text belongs in the ViewModel-owned CloudLinkDraft instead.",
);

// The anonymous ciphertext read must carry no credential. It has to FOLLOW
// redirects — server/account/files.go 302s to a fleet node whenever the file is
// eligible, with or without the opt-in header — so the protection cannot be the
// account transport's blanket refusal; it is that the request is anonymous and
// every hop is rebuilt rather than delegated to OkHttp's follower.
const downloadSection = cloudClient.slice(cloudClient.indexOf("fun downloadBlob"));
check(
  downloadSection.length > 0 && !/Authorization/.test(downloadSection),
  "CloudClient.downloadBlob sets an Authorization header. A stored-ciphertext read is anonymous "
  + "and follows redirects to storage nodes, including hosts a user advertised; a credential on "
  + "that request would be forwarded to them.",
);
check(
  /followRedirects\(false\)/.test(cloudClient) && /followSslRedirects\(false\)/.test(cloudClient),
  "a CloudClient OkHttp client follows redirects itself. Every hop of a blob read is rebuilt and "
  + "validated by BlobRedirect; delegating to OkHttp's follower would carry this request's headers "
  + "to the new host.",
);

// The key must not be interpolated into a request URL or a log. `#k=` belongs in
// exactly one place: the link the user is shown and chooses to share.
const cloudSources = [
  "app/src/main/kotlin/com/relayium/android/cloud/CloudClient.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/CloudUploadModel.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/CloudDownloadModel.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/CloudHistoryModel.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/PendingUpload.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/StoredLinkKeys.kt",
  "app/src/main/kotlin/com/relayium/android/cloud/SecretBox.kt",
].map((relative) => codeOf(read(relative) ?? ""));
for (const source of cloudSources) {
  check(
    !/\bLog\.[a-z]/.test(source) && !/println\(/.test(source),
    "a cloud source logs. These types hold a decryption key, a bearer and a fragment-bearing "
    + "link; none of them belongs in logcat.",
  );
}

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`android-policy-test: ${failures.length} failure(s)`);
  process.exit(1);
}
console.error(
  "android-policy-test: OK (release fence, debug-only surfaces, exported surface, "
  + "account credential, stored-transfer key, recoverable-upload storage, process-death "
  + "acceptance and the shipped legacy wire's control set, capability and roles)",
);
