// web/scripts/stage-android-release.mjs — turn a REAL signed APK into the
// published Android update metadata.
//
// ## The circularity this avoids
//
// The document has to carry the artifact's SHA-256 and size, and the artifact
// is built from a commit. If the metadata were written by hand before the build
// — or worse, derived from a rebuild — the numbers would describe bytes nobody
// published. So the order is fixed and one-directional:
//
//   1. build and sign the APK (root-owned; this script never builds or signs);
//   2. run THIS tool against those exact bytes — it reads them, it does not
//      make them, and it refuses anything that disagrees with them;
//   3. commit the metadata-only diff;
//   4. publish the immutable release with the SAME file this tool measured.
//
// The download URL is knowable at step 2 without the release existing, because
// the tag is derived from the version rather than discovered. Nothing here ever
// needs the published URL to resolve, so there is no ordering paradox — only an
// ordering RULE, which `scripts/publish-android-release.sh` enforces.
//
// ## What it refuses
//
// Everything it cannot prove. A file name that does not match the version, a
// versionCode that does not match the APK's own manifest, a package that is not
// this app, a certificate digest that differs from the one already shipping, a
// size outside the publisher policy, a hash the caller supplied that does not
// match the bytes on disk. Each of those is a way to publish an update offer
// that installs something other than what the metadata claims.

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { EXPECTED_CERT_SHA256, MAX_VERSION_CODE, VerifyError, observeApk } from "./verify-android-apk.mjs";

/** The canonical document a person edits and the website imports. */
export const ANDROID_RELEASE_FILE = "android-release.json";

/** Where gen-pages publishes it, relative to `public/`. Leading slash so it
 *  reads as the URL path it becomes. */
export const PUBLISHED_ANDROID_FEED_PATH = "/apps/android/update.json";

/** The public URL an installed build reads. Must equal `UpdateFeed.OFFICIAL_URL`. */
export const ANDROID_FEED_URL = "https://relayium.com/apps/android/update.json";

export const APPLICATION_ID = "com.relayium.android";
export const SCHEMA = 1;

/** Publisher policy, identical to `UpdateFeed.MAX_APK_BYTES`. A document that
 *  would be refused on a device must not be publishable either. */
export const MAX_APK_BYTES = 512 * 1024 * 1024;

const VERSION_NAME = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;

/** `android-v<versionName>` — this product's own tag namespace. `macos-v…`
 *  belongs to the Mac release and a bare `v…` to the CLI, and the CLI's
 *  installer resolves `releases/latest`, which is why an Android release must
 *  never claim that alias. See `scripts/publish-android-release.sh`. */
export const tagFor = (versionName) => `android-v${versionName}`;

/** `Relayium-<versionName>-<versionCode>.apk` — the shape the signing helper
 *  actually produces. The app derives the same name and compares it exactly. */
export const assetNameFor = (versionName, versionCode) =>
  `Relayium-${versionName}-${versionCode}.apk`;

export const downloadUrlFor = (versionName, versionCode) =>
  `https://github.com/relayium/relayium/releases/download/${tagFor(versionName)}/` +
  assetNameFor(versionName, versionCode);

class StageError extends Error {}

const fail = (message) => {
  throw new StageError(message);
};

/**
 * Build the metadata document for a release.
 *
 * `facts` is what was independently observed about the APK — its size, its
 * hash, and (when the caller could read them) the package, versionCode,
 * versionName and signing-certificate digest from the artifact itself. Every
 * one of those that is present is CHECKED, never trusted as the answer.
 */
export function buildAndroidRelease({
  versionName,
  versionCode,
  sha256,
  size,
  notes,
  apkName,
  apkPackage,
  apkVersionCode,
  apkVersionName,
  certSha256,
  expectedCertSha256,
}) {
  if (!VERSION_NAME.test(String(versionName ?? ""))) {
    fail(`versionName must be X.Y.Z with plain integers; got ${JSON.stringify(versionName)}`);
  }
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
    fail(
      `versionCode must be a positive int32 (1..${MAX_VERSION_CODE}); got ${JSON.stringify(versionCode)}. ` +
        "Android stores it as a Java int, and the client parses it as one, so a larger value is unpublishable.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(String(sha256 ?? ""))) {
    fail(`sha256 must be 64 lowercase hex characters; got ${JSON.stringify(sha256)}`);
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_APK_BYTES) {
    fail(`size must be a positive integer of at most ${MAX_APK_BYTES} bytes; got ${JSON.stringify(size)}`);
  }

  // The file on disk must be the file the URL will name. A mismatch here is
  // precisely the "advertise 0.1.2, ship 0.1.1" defect, caught before it can be
  // written down.
  const expectedName = assetNameFor(versionName, versionCode);
  if (apkName != null && apkName !== expectedName) {
    fail(`apk file name is ${apkName}, but ${versionName} (${versionCode}) must be published as ${expectedName}`);
  }

  // The APK's own manifest must agree with what is being advertised.
  if (apkPackage != null && apkPackage !== APPLICATION_ID) {
    fail(`apk package is ${apkPackage}, expected ${APPLICATION_ID}`);
  }
  if (apkVersionCode != null && Number(apkVersionCode) !== versionCode) {
    fail(`apk versionCode is ${apkVersionCode}, but the metadata says ${versionCode}`);
  }
  if (apkVersionName != null && apkVersionName !== versionName) {
    fail(`apk versionName is ${apkVersionName}, but the metadata says ${versionName}`);
  }

  // Update identity is the signing certificate: Android refuses to replace an
  // installed app with a differently-signed one, so publishing a differently
  // signed APK would produce an update every existing user cannot install.
  if (expectedCertSha256 != null) {
    if (certSha256 == null) fail("a certificate digest was required but none was observed");
    if (certSha256.toLowerCase() !== expectedCertSha256.toLowerCase()) {
      fail(
        `apk signing certificate ${certSha256} does not match the established ` +
          `certificate ${expectedCertSha256}; every installed user would be unable to update`,
      );
    }
  }

  const en = notes?.en;
  if (typeof en !== "string" || en.trim() === "") {
    fail("notes.en is required — English is the fallback every device can render");
  }
  const zh = notes?.zh;
  if (typeof zh !== "string" || zh.trim() === "") {
    fail("notes.zh is required — zh-Hans is a maintained product language");
  }
  for (const [tag, text] of Object.entries(notes)) {
    if (typeof text !== "string") fail(`notes.${tag} must be a string`);
    // Plain text: the app renders these without parsing markup, and a control
    // character would let a note redraw the block it sits in.
    if (/[\u0000-\u0009\u000B-\u001F\u007F]/.test(text)) {
      fail(`notes.${tag} contains a control character`);
    }
    if (text.length > 2000) fail(`notes.${tag} is longer than 2000 characters`);
  }

  return {
    schema: SCHEMA,
    android: {
      available: true,
      applicationId: APPLICATION_ID,
      versionCode,
      versionName,
      downloadUrl: downloadUrlFor(versionName, versionCode),
      sha256,
      size,
      notes,
    },
  };
}

/**
 * The withdrawn/placeholder document: coherent, and offering nothing.
 *
 * `lastPublishedVersionCode` is carried through deliberately. Withdrawing a
 * release must not erase how high the channel has already been: without it, the
 * next `stage` sees "no previous release", the monotonicity check has nothing
 * to compare against, and a LOWER versionCode publishes cleanly — which would
 * tell every installed client at the higher code that it is up to date, forever.
 *
 * The Android client ignores fields it does not recognise (that tolerance is an
 * explicit part of the schema), so this is invisible to an installed build and
 * still means `available: false` to it.
 */
export function buildUnavailableRelease(previous = null) {
  const height = publishedHeight(previous);
  return {
    schema: SCHEMA,
    android: height == null
      ? { available: false }
      : { available: false, lastPublishedVersionCode: height },
  };
}

/**
 * Validate a previously published document, fail-closed.
 *
 * The point of separating this out is that a SUBTLY wrong history is more
 * dangerous than an obviously missing one. If `publishedHeight` merely returned
 * `null` for a document whose `versionCode` was a string, or out of int range,
 * or whose schema was something else entirely, the monotonicity check would
 * find nothing to compare against and a LOWER version would publish cleanly —
 * the same outcome as having no history at all, reached by a document that
 * plainly has one. So anything that is present must be well formed.
 */
export function assertReadableHistory(doc) {
  const android = doc?.android;
  if (!android || typeof android !== "object") {
    fail("the existing android-release.json has no android object");
  }
  if (doc.schema !== SCHEMA) {
    fail(
      `the existing android-release.json declares schema ${JSON.stringify(doc.schema)}, not ${SCHEMA}; ` +
        "its version history cannot be interpreted and publishing against it could go backwards",
    );
  }
  if (android.available !== true && android.available !== false) {
    fail("the existing android-release.json has no boolean android.available");
  }
  const code = (value, label) => {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 1 || value > MAX_VERSION_CODE) {
      fail(
        `the existing android-release.json has ${label} = ${JSON.stringify(value)}, ` +
          `which is not a positive int32; refusing to publish against an unreadable history`,
      );
    }
    return value;
  };
  const live = code(android.versionCode, "android.versionCode");
  const remembered = code(android.lastPublishedVersionCode, "android.lastPublishedVersionCode");
  if (android.available === true && live == null) {
    fail("the existing android-release.json says available:true but carries no usable versionCode");
  }
  return { live, remembered };
}

/**
 * How high this channel has ever been published, live or withdrawn.
 *
 * A withdrawn document can carry the height in either of two places, and BOTH
 * are honoured rather than one being ignored:
 *
 *  * `lastPublishedVersionCode`, which is what `buildUnavailableRelease` writes;
 *  * a leftover `versionCode`, which is the shape a hand-written or older
 *    withdrawal produces. Reading it is strictly safer than ignoring it —
 *    ignoring it loses the height, and losing the height is what lets the next
 *    release go backwards.
 *
 * The maximum of whatever is present wins, so no route ever LOWERS the
 * remembered height.
 */
export function publishedHeight(doc) {
  if (doc == null) return null;
  const { live, remembered } = assertReadableHistory(doc);
  const known = [live, remembered].filter((value) => value != null);
  return known.length > 0 ? Math.max(...known) : null;
}

/**
 * Measure a real APK.
 *
 * Deliberately separate from [buildAndroidRelease] so the pure rules above are
 * testable with no file on disk, and so this half can be pointed at bytes that
 * were produced elsewhere — which is the actual workflow, since signing happens
 * outside this repository.
 */
export async function measureApk(path) {
  const info = await stat(path);
  if (!info.isFile()) fail(`${path} is not a file`);
  const bytes = await readFile(path);
  return {
    apkName: basename(path),
    size: info.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Read the current published document.
 *
 *  Returns `null` ONLY when the file genuinely does not exist. Unreadable or
 *  malformed content throws instead: treating a corrupt manifest as "there is
 *  no previous release" is how a downgrade gets published, because the
 *  monotonicity check then has nothing to compare against. */
export async function readAndroidRelease(webRoot) {
  const path = resolve(webRoot, ANDROID_RELEASE_FILE);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    fail(`${path} could not be read (${err.code ?? err.message}); refusing to treat that as a first release`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    fail(`${path} is not valid JSON (${err.message}); refusing to treat that as a first release`);
  }
  assertReadableHistory(doc);
  return doc;
}

/** Write it back in the exact shape `gen-pages` will copy byte for byte. */
export async function writeAndroidRelease(webRoot, doc) {
  await writeFile(
    resolve(webRoot, ANDROID_RELEASE_FILE),
    `${JSON.stringify(doc, null, 2)}\n`,
    "utf8",
  );
}

/**
 * A release must never go backwards.
 *
 * `versionCode` is what an installed build compares, so republishing a lower
 * one would silently tell every user they are up to date when they are not —
 * and would make the site offer an older APK than the one already out.
 */
export function assertMonotonic(previous, next) {
  const before = publishedHeight(previous);
  if (before == null) return;
  const after = next.android.versionCode;
  if (!(after > before)) {
    fail(
      `versionCode must increase: ${before} has already been published on this channel, ` +
        `refusing to publish ${after}. Every installed build at ${before} would be told it is up to date.`,
    );
  }
}

export { StageError };

// ── CLI ─────────────────────────────────────────────────────────────────────
//
// Invoked by root against a real signed APK. It never builds, never signs and
// never publishes; it reads bytes and writes one JSON file, so the diff it
// produces is metadata-only and the artifact it describes already exists.

function usage() {
  return [
    "Usage:",
    "  stage-android-release.mjs --apk <path> --version <X.Y.Z> --code <n> \\",
    "      --notes-en <text> --notes-zh <text> [--web-root <path>] [--allow-first-release]",
    "  stage-android-release.mjs --withdraw [--web-root <path>]",
    "",
    "The APK's package, versionCode, versionName and signing certificate are READ",
    "from the artifact with apksigner and apkanalyzer. They are not accepted as",
    "arguments and there is no way to skip the check: an unverified file must not",
    "become a published update offer.",
    "",
    "Tool locations may be overridden with RELAYIUM_APKSIGNER / RELAYIUM_APKANALYZER",
    "for an operator whose SDK is elsewhere. An override that is not a real",
    "executable fails exactly as a missing tool does.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === "withdraw" || name === "allow-first-release") {
      out[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${key} needs a value`);
    out[name] = value;
    i += 1;
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const webRoot = resolve(args["web-root"] ?? process.cwd());
  const previous = await readAndroidRelease(webRoot);

  if (args.withdraw) {
    // Carries the published height forward — see buildUnavailableRelease.
    await writeAndroidRelease(webRoot, buildUnavailableRelease(previous));
    const height = publishedHeight(previous);
    console.log(
      "stage-android-release: android-release.json now advertises no download" +
        (height == null ? "" : ` (channel height ${height} preserved)`),
    );
    return;
  }

  for (const required of ["apk", "version", "code", "notes-en", "notes-zh"]) {
    if (args[required] === undefined) fail(`--${required} is required\n\n${usage()}`);
  }
  for (const rejected of ["apk-package", "apk-version-code", "apk-version-name", "cert-sha256",
    "expect-cert-sha256", "skip-verify"]) {
    if (args[rejected] !== undefined) {
      fail(
        `--${rejected} is not accepted. These facts are OBSERVED from the APK with apksigner and ` +
          "apkanalyzer, never supplied; a caller-provided value would be a claim about a file nobody read.",
      );
    }
  }

  // Hash, signature and manifest, all from the same immutable bytes.
  const observed = observeApk(resolve(args.apk));
  const versionCode = Number(args.code);

  const doc = buildAndroidRelease({
    versionName: args.version,
    versionCode,
    sha256: observed.sha256,
    size: observed.size,
    notes: { en: args["notes-en"], zh: args["notes-zh"] },
    apkName: observed.apkName,
    apkPackage: observed.apkPackage,
    apkVersionCode: observed.apkVersionCode,
    apkVersionName: observed.apkVersionName,
    certSha256: observed.certSha256,
    // Always pinned. Passing null here would make the certificate check
    // optional, which is exactly the shape this tool had when a 20-byte text
    // file could be published as a release.
    expectedCertSha256: EXPECTED_CERT_SHA256,
  });

  if (previous == null && !args["allow-first-release"]) {
    fail("no existing android-release.json; pass --allow-first-release if that is intended");
  }
  assertMonotonic(previous, doc);

  await writeAndroidRelease(webRoot, doc);
  console.log(
    `stage-android-release: ${doc.android.versionName} (${doc.android.versionCode})\n` +
      `  asset   ${observed.apkName}\n` +
      `  package ${observed.apkPackage}\n` +
      `  cert    ${observed.certSha256}\n` +
      `  sha256  ${observed.sha256}\n` +
      `  size    ${observed.size}\n` +
      `  url     ${doc.android.downloadUrl}\n` +
      "Commit this, then publish the SAME file at that URL before advancing the website.",
  );
}

if (process.argv[1] && process.argv[1].endsWith("stage-android-release.mjs")) {
  main(process.argv.slice(2)).catch((err) => {
    const known = err instanceof StageError || err instanceof VerifyError;
    console.error(known ? `stage-android-release: ${err.message}` : err);
    process.exit(1);
  });
}
