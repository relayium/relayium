// web/scripts/verify-android-apk.mjs — OBSERVE an APK, using the Android SDK.
//
// ## Why this file exists
//
// The staging tool used to accept the package, versionCode, versionName and
// signing certificate as command-line arguments. That made them CLAIMS, not
// observations: a 20-byte text file named `Relayium-0.1.1-2.apk` passed every
// check and produced a published document saying `available: true`. Every one
// of those facts has to be read out of the artifact itself, by a tool that
// understands the format, or the metadata is describing something nobody
// verified.
//
// So: `apksigner` for the signature and certificate, `apkanalyzer` for the
// manifest. A missing tool is a hard failure — never a skipped check — because
// "we could not look" and "we looked and it was fine" must never produce the
// same result. There is deliberately no `--skip-verify`.
//
// ## Same bytes, start to finish
//
// The hash, the signature and the manifest must all describe ONE immutable
// file. The APK is hashed, then inspected, then hashed AGAIN, and a change
// between those two hashes fails the run: otherwise a file swapped mid-flight
// would be published under the digest of the one that was verified.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export class VerifyError extends Error {}

const fail = (message) => {
  throw new VerifyError(message);
};

/**
 * The established Relayium Android signing certificate.
 *
 * Public information — it is in every APK already shipped — and pinning it here
 * is what stops a release being published under a DIFFERENT key. That failure
 * is not recoverable for users: Android refuses to replace an installed app
 * whose signature does not match, so a differently-signed "update" is one every
 * existing installation must uninstall to take, losing whatever it held.
 */
export const EXPECTED_CERT_SHA256 =
  "ac867828a511f15e9214498f234d8898bbd56033342edd7e70d8037c20380aad";

/** Android's own bound. `versionCode` is a Java int in the platform. */
export const MAX_VERSION_CODE = 2147483647;

const sdkRoot = () => process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";

/** Newest first, so a machine with several build-tools uses the current one. */
function newestChild(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return names.length > 0 ? join(dir, names[0]) : null;
}

/**
 * Locate a tool.
 *
 * The environment overrides exist for a test harness and for an operator whose
 * SDK is not on the default path. They are NOT a way to disable a check: an
 * override that does not point at a real executable fails exactly as a missing
 * tool does.
 */
export function resolveTools(overrides = {}) {
  const apksigner =
    overrides.apksigner ||
    process.env.RELAYIUM_APKSIGNER ||
    (() => {
      const dir = newestChild(join(sdkRoot(), "build-tools"));
      return dir ? join(dir, "apksigner") : null;
    })();

  const apkanalyzer =
    overrides.apkanalyzer ||
    process.env.RELAYIUM_APKANALYZER ||
    (() => {
      const dir = newestChild(join(sdkRoot(), "cmdline-tools"));
      return dir ? join(dir, "bin", "apkanalyzer") : null;
    })();

  if (!apksigner || !existsSync(apksigner)) {
    fail(
      `apksigner not found (looked for ${apksigner ?? "$ANDROID_HOME/build-tools/*/apksigner"}). ` +
        "The signing certificate cannot be observed without it, and an unverified APK must not be published. " +
        "Install the SDK build-tools or set RELAYIUM_APKSIGNER.",
    );
  }
  if (!apkanalyzer || !existsSync(apkanalyzer)) {
    fail(
      `apkanalyzer not found (looked for ${apkanalyzer ?? "$ANDROID_HOME/cmdline-tools/*/bin/apkanalyzer"}). ` +
        "The manifest cannot be observed without it. Install the SDK command-line tools or set RELAYIUM_APKANALYZER.",
    );
  }
  return { apksigner, apkanalyzer };
}

function run(tool, args, what) {
  try {
    return execFileSync(tool, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    fail(`${what} failed (${basename(tool)} exited ${err.status ?? "abnormally"})${detail ? `:\n${detail}` : ""}`);
  }
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Read the signing certificates.
 *
 * `apksigner verify` is what actually validates the signature blocks; the
 * `--print-certs` output is only meaningful because the verify succeeded. A
 * file that is not a valid signed APK fails here, which is the case the old
 * claim-based tool sailed straight through.
 */
export function observeSignature(apkPath, tools) {
  const out = run(
    tools.apksigner,
    ["verify", "--print-certs", "--verbose", apkPath],
    "apksigner verification",
  );

  const digests = [...out.matchAll(/Signer #(\d+) certificate SHA-?256 digest:\s*([0-9a-fA-F]{64})/g)];
  if (digests.length === 0) fail(`apksigner printed no certificate digest for ${basename(apkPath)}`);

  const signers = new Set(digests.map((m) => m[1]));
  if (signers.size !== 1) {
    fail(
      `${basename(apkPath)} is signed by ${signers.size} signers; this channel publishes single-signer APKs only`,
    );
  }

  // v2/v3 schemes print the same signer once per scheme; differing digests
  // across those blocks would mean the schemes disagree about who signed it.
  const unique = new Set(digests.map((m) => m[2].toLowerCase()));
  if (unique.size !== 1) {
    fail(`${basename(apkPath)} presents ${unique.size} different certificate digests across its signature blocks`);
  }

  // `--verbose` prints a line PER SCHEME, including the ones that did not
  // verify: "Verified using v1 scheme (JAR signing): false". Matching the
  // scheme name alone therefore passes on a `false` line, which is how an APK
  // with no modern signature at all could read as verified. The value has to be
  // part of the match.
  const modern = [...out.matchAll(/Verified using (v[0-9.]+) scheme[^:\n]*:\s*(true|false)/g)]
    .filter(([, scheme, value]) => value === "true" && scheme !== "v1")
    .map(([, scheme]) => scheme);
  if (modern.length === 0) {
    fail(
      `${basename(apkPath)} is not verified under any modern signature scheme (v2/v3/v4). ` +
        "A v1-only APK does not protect the whole archive.",
    );
  }

  return { certSha256: [...unique][0], schemes: modern, apksignerOutput: out };
}

/** Read the manifest facts the metadata claims. */
export function observeManifest(apkPath, tools) {
  const one = (subcommand) =>
    run(tools.apkanalyzer, ["manifest", subcommand, apkPath], `apkanalyzer manifest ${subcommand}`)
      .trim();

  const versionCodeText = one("version-code");
  const versionCode = Number(versionCodeText);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
    fail(`apk versionCode ${JSON.stringify(versionCodeText)} is not a positive int32`);
  }
  return {
    apkPackage: one("application-id"),
    apkVersionCode: versionCode,
    apkVersionName: one("version-name"),
  };
}

/**
 * Everything observed about one file, proven to be one file.
 *
 * The two hashes bracket the inspection. If they differ, something replaced the
 * artifact while it was being verified, and every observation above describes
 * bytes that are no longer there.
 */
export function observeApk(apkPath, overrides = {}) {
  const path = resolve(apkPath);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${apkPath} is not a file`);

  const tools = resolveTools(overrides);
  const before = sha256File(path);
  const size = statSync(path).size;

  const signature = observeSignature(path, tools);
  const manifest = observeManifest(path, tools);

  const after = sha256File(path);
  if (before !== after) {
    fail(`${basename(path)} changed while it was being verified (${before} → ${after})`);
  }

  return {
    apkName: basename(path),
    sha256: after,
    size,
    ...manifest,
    certSha256: signature.certSha256,
  };
}
