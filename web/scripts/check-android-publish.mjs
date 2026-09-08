#!/usr/bin/env node
// web/scripts/check-android-publish.mjs — does this APK match this manifest?
//
// The publish helper used to compare only the SHA-256 and the size. That makes
// it a checksum tool: it proves the file is the one the manifest describes, but
// nothing about what that file IS. If a wrong manifest were ever committed —
// staged from an unsigned build, or hand-edited — the publisher would happily
// push it live, because the artifact and the metadata agree with each other and
// neither was checked against reality.
//
// So the publisher re-observes the artifact with the SDK, exactly as staging
// did, and compares EVERY field. Verification at staging time and verification
// at publish time are different moments with different inputs, and the second
// one is the one that decides what becomes permanent.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { EXPECTED_CERT_SHA256, VerifyError, observeApk } from "./verify-android-apk.mjs";
import { buildAndroidRelease } from "./stage-android-release.mjs";

function fail(message) {
  console.error(`check-android-publish: ${message}`);
  process.exit(1);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key.startsWith("--")) fail(`unexpected argument ${key}`);
  const value = process.argv[i + 1];
  if (value === undefined) fail(`${key} needs a value`);
  args[key.slice(2)] = value;
}
for (const required of ["manifest", "apk"]) {
  if (!args[required]) fail(`--${required} is required`);
}

let doc;
try {
  doc = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
} catch (err) {
  fail(`${args.manifest} is not readable JSON (${err.message})`);
}

const a = doc?.android;
if (!a || a.available !== true) fail("the manifest does not advertise a release");

let observed;
try {
  observed = observeApk(resolve(args.apk));
} catch (err) {
  fail(err instanceof VerifyError ? err.message : String(err));
}

// The comparison is a REBUILD, not a field-by-field string match.
//
// String equality on a few fields proves the numbers agree; it says nothing
// about whether the document is one the Android client would accept. A manifest
// with `schema: 99`, a foreign `applicationId`, a `versionCode` that is a
// string, or no `notes` at all would satisfy every checksum and still be
// refused on every device — an update nobody can take, published permanently.
//
// So the canonical document is reconstructed from the OBSERVED facts, with the
// certificate pinned, and compared whole. `buildAndroidRelease` is the same
// function staging used, so anything it refuses cannot be published either, and
// the deep comparison catches every field it does not validate directly.
let expected;
try {
  expected = buildAndroidRelease({
    // Passed through UNCOERCED on purpose: a string "2" must fail validation
    // rather than be quietly turned into the number the client expects.
    versionName: a.versionName,
    versionCode: a.versionCode,
    notes: a.notes,
    sha256: observed.sha256,
    size: observed.size,
    apkName: observed.apkName,
    apkPackage: observed.apkPackage,
    apkVersionCode: observed.apkVersionCode,
    apkVersionName: observed.apkVersionName,
    certSha256: observed.certSha256,
    expectedCertSha256: EXPECTED_CERT_SHA256,
  });
} catch (err) {
  fail(`the committed manifest is not a publishable document: ${err.message}`);
}

// Key order is not part of the contract, so compare structurally.
const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  );

if (canonical(doc) !== canonical(expected)) {
  console.error("check-android-publish: the committed manifest is not what these bytes describe");
  console.error(`  committed: ${canonical(doc)}`);
  console.error(`  expected:  ${canonical(expected)}`);
  process.exit(1);
}

console.log(
  `check-android-publish: ${basename(args.apk)} verified\n` +
    `  package ${observed.apkPackage}\n` +
    `  version ${observed.apkVersionName} (${observed.apkVersionCode})\n` +
    `  schemes ${observed.schemes?.join(", ") ?? "v2/v3"}\n` +
    `  cert    ${observed.certSha256}\n` +
    `  sha256  ${observed.sha256}`,
);
