#!/usr/bin/env node
// scripts/test/android-publish-behavior-test.mjs — RUN the publish helper.
//
// The sibling `android-publish-order-test.mjs` reads the script as text. That
// catches a deleted flag, and nothing else: it cannot tell whether a failed API
// read is reported as success, whether an existing draft is refused, or whether
// the alias comparison actually happens — all of which were real defects.
//
// So this file executes the script for real, against:
//
//   * a DISPOSABLE Git repository built per case, so the provenance guards run
//     rather than being bypassed;
//   * a fake `gh` on PATH that records its invocation and answers from a
//     scripted table. Nothing here touches GitHub, the real repository, or any
//     remote; the only writes are inside a temp directory.
//
// ## What the artifact half of this is, honestly
//
// The publisher verifies the APK for real, with `apksigner` and `apkanalyzer`.
// This test does NOT ship a signed APK, and it must not skip its alias and
// provenance cases on a machine without one — a gate that silently stops
// checking is the same failure it exists to catch.
//
// So the SDK tools are MOCKED, through the same `RELAYIUM_APKSIGNER` /
// `RELAYIUM_APKANALYZER` overrides an operator with a relocated SDK would use.
// That exercises the publisher's control flow and proves the observer is really
// invoked and its answers really compared. It does NOT prove authenticity, and
// nothing here should be read as proving it: signature authenticity is
// established separately, against the genuine signed artifact and a real SDK.
//
// The operator entry point keeps no skip flag and no key override; the mock is
// reachable only by pointing the tool paths somewhere else, which is exactly
// what a missing tool already refuses to let you get away with.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "publish-android-release.sh");

/** The fixture certificate the mocked apksigner reports: the real pinned one,
 *  because the publisher compares against it and a different value would make
 *  every positive case fail for the wrong reason. */
const PINNED_CERT = "ac867828a511f15e9214498f234d8898bbd56033342edd7e70d8037c20380aad";

/**
 * Mocked SDK tools.
 *
 * `apksigner` refuses a file that does not look like the fixture APK, so the
 * "unsigned file" case still exercises a real refusal path rather than being
 * asserted into existence.
 */
function fakeSdk(dir, { pkg = "com.relayium.android", versionCode = 1, versionName = "0.1.0",
                        cert = PINNED_CERT, marker = "RELAYIUM-FIXTURE-APK" } = {}) {
  const bin = join(dir, "sdk-bin");
  mkdirSync(bin, { recursive: true });

  writeFileSync(join(bin, "apksigner"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const apk = args[args.length - 1];
const body = fs.readFileSync(apk, "utf8");
if (!body.startsWith(${JSON.stringify(marker)})) {
  console.error("Malformed APK: not a ZIP archive");
  process.exit(1);
}
console.log([
  "Signer #1 certificate SHA-256 digest: ${cert}",
  "Verified using v1 scheme (JAR signing): false",
  "Verified using v2 scheme (APK Signature Scheme v2): true",
  "Verified using v3 scheme (APK Signature Scheme v3): true",
].join(String.fromCharCode(10)));
`);
  writeFileSync(join(bin, "apkanalyzer"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const which = args[1];
const answers = {
  "application-id": ${JSON.stringify(pkg)},
  "version-code": ${JSON.stringify(String(versionCode))},
  "version-name": ${JSON.stringify(versionName)},
};
if (!(which in answers)) { console.error("unsupported"); process.exit(1); }
console.log(answers[which]);
`);
  chmodSync(join(bin, "apksigner"), 0o755);
  chmodSync(join(bin, "apkanalyzer"), 0o755);
  return { apksigner: join(bin, "apksigner"), apkanalyzer: join(bin, "apkanalyzer"), marker };
}

const failures = [];
let ran = 0;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A throwaway repository holding a canonical manifest for the given APK. */
function fixture({ apk, available = true, versionName = "0.1.0", versionCode = 1, commit = true }) {
  // The repository and the scratch space are SEPARATE directories. Dropping the
  // APK or the fake `gh` inside the repo would leave it dirty, and the script's
  // clean-tree guard would then refuse every case for the wrong reason — the
  // guard would look tested while the behaviour under test never ran.
  const base = mkdtempSync(join(tmpdir(), "relayium-publish-"));
  const dir = join(base, "repo");
  const work = join(base, "work");
  mkdirSync(dir, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(dir, "web"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  // The helper resolves its siblings relative to its own location.
  cpSync(script, join(dir, "scripts", "publish-android-release.sh"));
  chmodSync(join(dir, "scripts", "publish-android-release.sh"), 0o755);
  cpSync(join(repoRoot, "web", "scripts"), join(dir, "web", "scripts"), { recursive: true });

  const doc = available
    ? {
        schema: 1,
        android: {
          available: true,
          applicationId: "com.relayium.android",
          versionCode,
          versionName,
          downloadUrl:
            `https://github.com/relayium/relayium/releases/download/android-v${versionName}/` +
            `Relayium-${versionName}-${versionCode}.apk`,
          sha256: apk ? sha256(apk) : "a".repeat(64),
          size: apk ? statSync(apk).size : 1,
          notes: { en: "Preview.", zh: "预览版。" },
        },
      }
    : { schema: 1, android: { available: false } };
  writeFileSync(join(dir, "web", "android-release.json"), `${JSON.stringify(doc, null, 2)}\n`);

  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "publish behaviour test");
  if (commit) {
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
  }
  return { base, dir, work, manifest: join(dir, "web", "android-release.json"), git };
}

/**
 * A fake `gh` whose answers are a table.
 *
 * `spec` maps a matcher to `{ exit, out, err }`. Every invocation is appended to
 * `calls.log` so a test can assert what the script actually asked for — which is
 * the only way to check that the alias is read BOTH before and after.
 */
function fakeGh(dir, spec) {
  const bin = join(dir, "gh-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "calls.log");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const spec = ${JSON.stringify(spec)};
for (const [match, answer] of spec) {
  if (args.join(" ").includes(match)) {
    if (answer.out) process.stdout.write(answer.out);
    if (answer.err) process.stderr.write(answer.err);
    process.exit(answer.exit ?? 0);
  }
}
process.stderr.write("fake gh: no rule for: " + args.join(" ") + "\\n");
process.exit(70);
`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function run({ dir, manifest, apk, ghBin, sdk, extra = [] }) {
  const result = spawnSync(
    "bash",
    [join(dir, "scripts", "publish-android-release.sh"), "--apk", apk, "--manifest", manifest, ...extra],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${ghBin}:${process.env.PATH}`,
        ...(sdk ? { RELAYIUM_APKSIGNER: sdk.apksigner, RELAYIUM_APKANALYZER: sdk.apkanalyzer } : {}),
      },
    },
  );
  const logPath = join(dirname(ghBin), "calls.log");
  const calls = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  return { ...result, calls };
}

function check(name, ok, detail) {
  ran += 1;
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

/** Write the fixture "APK": arbitrary bytes the mocked apksigner accepts. Its
 *  hash and size are REAL, so the publisher's checksum comparison is genuine. */
function writeFixtureApk(path, marker) {
  writeFileSync(path, `${marker}\n${"payload".repeat(64)}\n`);
  return path;
}

const withApk = (extraSpec, extra = []) => {
  const base = mkdtempSync(join(tmpdir(), "relayium-apk-"));
  const sdk = fakeSdk(base);
  const apkSeed = writeFixtureApk(join(base, "Relayium-0.1.0-1.apk"), sdk.marker);
  const f = fixture({ apk: apkSeed, versionName: "0.1.0", versionCode: 1 });
  const apk = join(f.work, "Relayium-0.1.0-1.apk");
  cpSync(apkSeed, apk);
  const ghBin = fakeGh(f.work, extraSpec);
  const r = run({ dir: f.dir, manifest: f.manifest, apk, ghBin, sdk, extra });
  rmSync(base, { recursive: true, force: true });
  return { f, r, sdk };
};

  const LATEST_OK = ["releases/latest", { exit: 0, out: "v0.24.0\n" }];
  const TAG_ABSENT = ["releases/tags/android-v0.1.0", { exit: 1, err: "gh: Not Found (HTTP 404)\n" }];

  {
    const name = "a failed BEFORE alias read is a hard error, not 'no alias'";
    const { f, r } = withApk([["releases/latest", { exit: 1, err: "gh: API rate limit exceeded\n" }]]);
    check(name, r.status !== 0 && /could not READ the latest alias/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    check(`${name} — nothing was created`, !/release create/.test(r.calls), r.calls);
    rmSync(f.base, { recursive: true, force: true });
  }

  {
    const name = "an absent alias is refused rather than assumed harmless";
    const { f, r } = withApk([["releases/latest", { exit: 1, err: "gh: Not Found (HTTP 404)\n" }]]);
    check(name, r.status !== 0 && /no release currently holds the 'latest' alias/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    rmSync(f.base, { recursive: true, force: true });
  }

  {
    const name = "a failed tag read refuses to publish blind";
    const { f, r } = withApk([
      LATEST_OK,
      ["releases/tags/android-v0.1.0", { exit: 1, err: "gh: Bad credentials (HTTP 401)\n" }],
    ]);
    check(name, r.status !== 0 && /could not determine whether .* already exists/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    check(`${name} — nothing was created`, !/release create/.test(r.calls), r.calls);
    rmSync(f.base, { recursive: true, force: true });
  }

  {
    const name = "creates the release with --latest=false, --prerelease and an explicit target";
    const { f, r } = withApk([
      LATEST_OK,
      TAG_ABSENT,
      ["release create", { exit: 0, out: "created\n" }],
    ]);
    const head = execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    check(name, r.status === 0, `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    check(`${name} — --latest=false`, /--latest=false/.test(r.calls), r.calls);
    check(`${name} — --prerelease`, /--prerelease/.test(r.calls), r.calls);
    check(`${name} — --target ${head}`, r.calls.includes(`--target ${head}`), r.calls);
    check(`${name} — no --clobber`, !/--clobber/.test(r.calls), r.calls);
    check(`${name} — checksum asset uploaded`, /\.apk\.sha256/.test(r.calls), r.calls);
    // The alias is read BEFORE and AFTER; one read proves nothing.
    check(
      `${name} — alias read twice`,
      (r.calls.match(/releases\/latest/g) ?? []).length === 2,
      r.calls,
    );
    rmSync(f.base, { recursive: true, force: true });
  }

  {
    const name = "a failed AFTER alias read fails the run even though the release exists";
    const seedDir = mkdtempSync(join(tmpdir(), "relayium-apk-"));
    const sdk = fakeSdk(seedDir);
    const seed = writeFixtureApk(join(seedDir, "Relayium-0.1.0-1.apk"), sdk.marker);
    const f2 = fixture({ apk: seed });
    const apk = join(f2.work, "Relayium-0.1.0-1.apk");
    cpSync(seed, apk);
    // First alias read succeeds, the second fails: a counter in the fake.
    const bin = join(f2.work, "gh-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(join(f2.work, "calls.log"))}, args + "\\n");
const seen = fs.readFileSync(${JSON.stringify(join(f2.work, "calls.log"))}, "utf8");
if (args.includes("releases/latest")) {
  const n = (seen.match(/releases\\/latest/g) || []).length;
  if (n <= 1) { process.stdout.write("v0.24.0\\n"); process.exit(0); }
  process.stderr.write("gh: connection reset\\n"); process.exit(1);
}
if (args.includes("releases/tags/")) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
if (args.includes("release create")) { process.exit(0); }
process.exit(70);
`);
    chmodSync(join(bin, "gh"), 0o755);
    const r = run({ dir: f2.dir, manifest: f2.manifest, apk, ghBin: bin, sdk });
    check(name, r.status !== 0 && /could not READ BACK the latest alias/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    rmSync(f2.base, { recursive: true, force: true });
  }

  {
    const name = "refuses when the alias moved onto this tag";
    const seedDir = mkdtempSync(join(tmpdir(), "relayium-apk-"));
    const sdk = fakeSdk(seedDir);
    const seed = writeFixtureApk(join(seedDir, "Relayium-0.1.0-1.apk"), sdk.marker);
    const f3 = fixture({ apk: seed });
    const apk = join(f3.work, "Relayium-0.1.0-1.apk");
    cpSync(seed, apk);
    const bin = join(f3.work, "gh-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(join(f3.work, "calls.log"))}, args + "\\n");
const seen = fs.readFileSync(${JSON.stringify(join(f3.work, "calls.log"))}, "utf8");
if (args.includes("releases/latest")) {
  const n = (seen.match(/releases\\/latest/g) || []).length;
  process.stdout.write(n <= 1 ? "v0.24.0\\n" : "android-v0.1.0\\n");
  process.exit(0);
}
if (args.includes("releases/tags/")) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
if (args.includes("release create")) { process.exit(0); }
process.exit(70);
`);
    chmodSync(join(bin, "gh"), 0o755);
    const r = run({ dir: f3.dir, manifest: f3.manifest, apk, ghBin: bin, sdk });
    check(name, r.status !== 0 && /took the repository-wide 'latest' alias/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    rmSync(f3.base, { recursive: true, force: true });
  }

  {
    const name = "refuses an existing release that targets a different commit";
    const { f, r } = withApk([
      LATEST_OK,
      ["releases/tags/android-v0.1.0", { exit: 0, out: "{}\n" }],
      ["git/ref/tags/", { exit: 0, out: `${"b".repeat(40)}\n` }],
      ["git/tags/", { exit: 1, err: "gh: Not Found\n" }],
    ]);
    check(name, r.status !== 0 && /already targets/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    rmSync(f.base, { recursive: true, force: true });
  }

  {
    const name = "refuses an existing release that is still a draft";
    const seedDir = mkdtempSync(join(tmpdir(), "relayium-apk-"));
    const sdk = fakeSdk(seedDir);
    const seed = writeFixtureApk(join(seedDir, "Relayium-0.1.0-1.apk"), sdk.marker);
    const f4 = fixture({ apk: seed });
    const apk = join(f4.work, "Relayium-0.1.0-1.apk");
    cpSync(seed, apk);
    const head = execFileSync("git", ["-C", f4.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ghBin = fakeGh(f4.work, [
      ["releases/latest", { exit: 0, out: "v0.24.0\n" }],
      ["git/ref/tags/", { exit: 0, out: `${head}\n` }],
      ["--jq .draft", { exit: 0, out: "true\n" }],
      ["releases/tags/android-v0.1.0", { exit: 0, out: "{}\n" }],
    ]);
    const r = run({ dir: f4.dir, manifest: f4.manifest, apk, ghBin, sdk });
    check(name, r.status !== 0 && /is a draft/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    rmSync(f4.base, { recursive: true, force: true });
  }

  {
    const name = "refuses an APK whose bytes do not match the committed manifest";
    const seedDir = mkdtempSync(join(tmpdir(), "relayium-apk-"));
    const sdk = fakeSdk(seedDir);
    const seed = writeFixtureApk(join(seedDir, "Relayium-0.1.0-1.apk"), sdk.marker);
    const f5 = fixture({ apk: seed });
    const apk = join(f5.work, "Relayium-0.1.0-1.apk");
    cpSync(seed, apk);
    writeFileSync(apk, Buffer.concat([readFileSync(apk), Buffer.from("x")]));
    const ghBin = fakeGh(f5.work, [LATEST_OK, TAG_ABSENT]);
    const r = run({ dir: f5.dir, manifest: f5.manifest, apk, ghBin, sdk });
    check(name, r.status !== 0 && /does not match the committed metadata/.test(r.stderr),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    rmSync(f5.base, { recursive: true, force: true });
  }

  {
    // The check the hash comparison cannot make: a manifest that is internally
    // consistent with a file that is not a signed Relayium APK.
    const name = "refuses an unsigned file even when the manifest agrees with it";
    const dir = mkdtempSync(join(tmpdir(), "relayium-publish-"));
    const bogus = join(dir, "Relayium-0.1.0-1.apk");
    // No fixture marker: the mocked apksigner refuses it exactly as the real
    // one refuses a file that is not a ZIP archive.
    writeFileSync(bogus, "not an apk at all");
    const sdk = fakeSdk(dir);
    const f6 = fixture({ apk: bogus, versionName: "0.1.0", versionCode: 1 });
    const apk = join(f6.work, "Relayium-0.1.0-1.apk");
    cpSync(bogus, apk);
    const ghBin = fakeGh(f6.work, [LATEST_OK, TAG_ABSENT]);
    const r = run({ dir: f6.dir, manifest: f6.manifest, apk, ghBin, sdk });
    check(name, r.status !== 0 && /check-android-publish|does not match the committed manifest/.test(r.stderr + r.stdout),
      `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    check(`${name} — nothing was created`, !/release create/.test(r.calls), r.calls);
    rmSync(dir, { recursive: true, force: true });
    rmSync(f6.base, { recursive: true, force: true });
  }
  // R5.2. A checksum comparison proves the file is the one the manifest
  // describes. It says nothing about whether that manifest is a document the
  // Android client would ACCEPT — and an update no device can read is one
  // published permanently for nothing.
  for (const [label, mutate] of [
    ["an unknown schema", (d) => { d.schema = 99; }],
    ["a foreign applicationId", (d) => { d.android.applicationId = "com.evil.app"; }],
    ["a versionCode that is a string", (d) => { d.android.versionCode = "1"; }],
    ["missing release notes", (d) => { delete d.android.notes; }],
    ["notes with no Chinese", (d) => { d.android.notes = { en: "Preview." }; }],
    ["a downloadUrl for another release", (d) => {
      d.android.downloadUrl =
        "https://github.com/relayium/relayium/releases/download/android-v9.9.9/Relayium-9.9.9-999.apk";
    }],
  ]) {
    const name = `refuses ${label} even with an authentic APK`;
    const seedDir = mkdtempSync(join(tmpdir(), "relayium-apk-"));
    const sdk = fakeSdk(seedDir);
    const seed = writeFixtureApk(join(seedDir, "Relayium-0.1.0-1.apk"), sdk.marker);
    const f = fixture({ apk: seed });
    const apk = join(f.work, "Relayium-0.1.0-1.apk");
    cpSync(seed, apk);
    const doc = JSON.parse(readFileSync(f.manifest, "utf8"));
    mutate(doc);
    writeFileSync(f.manifest, `${JSON.stringify(doc, null, 2)}\n`);
    f.git("add", "-A");
    f.git("commit", "-q", "-m", "mutate");
    const ghBin = fakeGh(f.work, [
      ["releases/latest", { exit: 0, out: "v0.24.0\n" }],
      ["releases/tags/", { exit: 1, err: "gh: Not Found (HTTP 404)\n" }],
    ]);
    const r = run({ dir: f.dir, manifest: f.manifest, apk, ghBin, sdk });
    check(name, r.status !== 0, `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
    check(`${name} — nothing was created`, !/release create/.test(r.calls), r.calls);
    rmSync(f.base, { recursive: true, force: true });
  }

if (failures.length > 0) {
  console.error(`android-publish-behavior-test: FAIL (${failures.length}/${ran})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `android-publish-behavior-test: ok (${ran} assertions). ` +
    "SDK tools are mocked here: this proves the publisher's control flow and that the observer " +
    "is really invoked and compared, NOT signature authenticity.",
);
