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
];
for (const relative of REQUIRED) {
  check(read(relative) !== null, `apps/android/${relative} is missing. This file asserts rules `
    + `ABOUT it, so a rename that is not reflected here turns every rule below into a check `
    + `that matches nothing and passes.`);
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
  + "account credential, stored-transfer key)",
);
