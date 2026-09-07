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

import { readFileSync, existsSync } from "node:fs";
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

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`android-policy-test: ${failures.length} failure(s)`);
  process.exit(1);
}
console.error("android-policy-test: OK (release fence, debug-only surfaces, exported surface)");
