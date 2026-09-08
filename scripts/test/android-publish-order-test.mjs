#!/usr/bin/env node
// scripts/test/android-publish-order-test.mjs — the Android publish helper's
// safety properties, asserted as text because nothing else can see them.
//
// A GitHub Release is immutable and public the instant it is created, so every
// check that can still say "no" has to run BEFORE `gh release create`. And one
// specific flag is load-bearing far beyond this product:
//
// GitHub's `latest` alias is REPOSITORY-WIDE. `web/public/install.sh` downloads
// the CLI from `releases/latest/download`, so a release that takes the alias
// turns `curl -fsSL https://relayium.com/install.sh | sh` into a 404 for every
// user, on a URL nothing in this repository publishes or can revise. It has
// already happened twice from macOS releases. An Android release is a THIRD tag
// namespace in the same repository and can do it again, so `--latest=false` is
// asserted here and the read-back that proves the outcome is asserted too.
//
// Run by repo-hygiene.yml on every push, which is the point: a check that only
// ran when someone remembered it is the state that lets these recur.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const script = readFileSync(resolve(repoRoot, "scripts/publish-android-release.sh"), "utf8");

/** Source with COMMENTS removed.
 *
 *  This file's subject explains itself at length, including by naming the very
 *  things being required ("--latest=false is load-bearing"). A check that
 *  matched the prose would pass on the explanation rather than on the code, so
 *  the assertions below run against executable lines only. */
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

const at = (needle) => code.indexOf(needle);

// ── the alias ───────────────────────────────────────────────────────────────

check(
  /--latest=false/.test(code),
  "publish-android-release.sh must pass --latest=false; without it an Android release " +
    "can take the repository-wide alias that https://relayium.com/install.sh resolves",
);

check(
  /--prerelease/.test(code),
  "the public preview must be created as a prerelease, so the listing does not read as a stable launch",
);

// The flag is a request; the read-back is the proof. The alias is read TWICE —
// once before, once after — because "it is not this tag" is only meaningful
// against what it was beforehand, and a single post-hoc read cannot tell a
// moved alias from one that was always there.
const aliasReads = (code.match(/releases\/latest/g) ?? []).length;
check(
  aliasReads >= 2,
  `the alias must be read before AND after publishing; found ${aliasReads} read(s)`,
);
check(
  code.lastIndexOf("releases/latest") > at("gh release create"),
  "the alias read-back must run AFTER the release is created, or it proves nothing",
);
// A failed read is not evidence. This was a real defect: `gh api` exiting
// non-zero was reported as "no alias exists" and the script returned success.
check(
  /could not READ the latest alias/.test(code) && /could not READ BACK the latest alias/.test(code),
  "a failed alias read must be a hard error, never reported as 'no alias'",
);
check(
  /HTTP 404|Not Found/.test(code),
  "the script must distinguish a 404 from a failed request; they mean different things",
);

// ── the tag namespace ───────────────────────────────────────────────────────

check(
  /TAG="android-v\$\{VERSION\}"/.test(code),
  'the tag must be android-v<version>: "macos-v…" belongs to the Mac release and a bare "v…" to the CLI',
);

check(
  /Relayium-\$\{VERSION\}-\$\{CODE\}\.apk/.test(code),
  "the asset name must be Relayium-<version>-<code>.apk, which is what the app derives and compares",
);

// ── everything that can still say no runs first ─────────────────────────────

const createAt = at("gh release create");
check(createAt > 0, "the script must create a release");

for (const [needle, why] of [
  ["shasum -a 256", "the APK hash must be verified"],
  ["does not match the committed metadata", "a hash/size mismatch must be refused"],
  ["must be published as", "an asset-name mismatch must be refused"],
  ["metadata downloadUrl is", "a download-url mismatch must be refused"],
]) {
  const idx = at(needle);
  check(idx > 0, `publish-android-release.sh must check: ${why}`);
  check(
    idx > 0 && idx < createAt,
    `${why} — this check runs AFTER gh release create, which is too late to matter`,
  );
}

// The committed manifest is the contract. Publishing from a manifest that does
// not advertise a release would put bytes behind a URL nothing points at.
check(
  at("android.available") > 0 && at("android.available") < createAt,
  "the script must refuse to publish unless web/android-release.json advertises this release",
);

// ── immutability ────────────────────────────────────────────────────────────

check(
  at("releases/tags/") > 0 && at("releases/tags/") < createAt,
  "an existing tag must be inspected before creating one, so a rerun never replaces published bytes",
);
check(
  !/--clobber/.test(code),
  "--clobber would let a rerun overwrite published assets; a release is immutable",
);
check(
  /--target/.test(code),
  "the release must be pinned to an explicit commit; without --target gh tags the remote default branch",
);
check(
  !/--repo\)/.test(code) && /readonly REPO=/.test(code),
  "the repository must be hardcoded; a --repo flag is a way to publish official-looking bytes elsewhere",
);
// The artifact itself, not just its checksum. Hash equality proves the file is
// the one the manifest describes and nothing about what that file IS.
check(
  /check-android-publish\.mjs/.test(code) && at("check-android-publish.mjs") < createAt,
  "the publisher must re-observe the APK with the SDK before creating anything",
);
check(
  /CANONICAL_REL="web\/android-release\.json"/.test(code),
  "the manifest must be the canonical document, not merely a tracked file somewhere",
);
check(
  /status --porcelain/.test(code) && /show "HEAD:\$rel"/.test(code),
  "release inputs must be committed and byte-identical to their committed blob",
);
check(
  /already exists and holds DIFFERENT bytes/.test(code),
  "a tag that exists with different bytes must be a hard failure, never a silent replace",
);

// ── the script does not advance the website ─────────────────────────────────
//
// Publishing and deploying are separate on purpose: a deployed feed advertising
// an asset that 404s is worse than no feed at all, because installed clients act
// on it. The ordering rule is only real if this script cannot do both.
check(
  !/git\s+(commit|push)/.test(code),
  "the publish helper must not commit or push; metadata is committed before publishing, by a person",
);
// Matched as INVOCATIONS, not as words. The script's own closing instructions
// legitimately talk about advancing the deployed site — telling the operator the
// ordering rule is the point — and a word-level ban would fail on the sentence
// that documents the very property being asserted.
check(
  !/^\s*(npm|pnpm|yarn|node)\s/m.test(code) || !/^\s*(npm run build|node .*gen-pages)/m.test(code),
  "the publish helper must not build or regenerate the website",
);
check(
  !/^\s*(rsync|scp|ssh|systemctl|.*auto-deploy)\b/m.test(code),
  "the publish helper must not deploy; the site advances only after the published asset is verified",
);
check(
  /is NOT updated by this script/.test(script),
  "the script must state that it does not update the website, so the ordering rule is visible to its operator",
);

// ── the staging tool it depends on ──────────────────────────────────────────

const stage = readFileSync(resolve(repoRoot, "web/scripts/stage-android-release.mjs"), "utf8");
check(
  !/execSync|spawnSync|child_process/.test(stage),
  "the staging tool must not build or sign anything; it reads bytes that already exist",
);
check(
  /createHash\("sha256"\)/.test(stage),
  "the staging tool must derive the hash from the real file rather than accept one",
);

if (failures.length > 0) {
  console.error("android-publish-order-test: FAIL");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("android-publish-order-test: ok");
