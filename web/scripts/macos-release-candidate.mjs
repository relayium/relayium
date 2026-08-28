#!/usr/bin/env node
// web/scripts/macos-release-candidate.mjs — the two mechanical halves of the
// complete post-notarization metadata candidate.
//
// A macOS release moves in two stages. Xcode's marketing version and build
// advance first, on a release branch; the manifest, the signed appcast and every
// document that names the download can only follow once the DMG is notarized,
// because the appcast signs the FINAL stapled bytes and the manifest points at
// an asset that does not exist until the release does. `MacSurfaceGuardTests`
// documents that split at length, and it is why the READMEs cannot be bumped in
// the prepare commit: between prepare and publish they would advertise a tag
// that 404s.
//
// The consequence is that manifest, appcast, READMEs, the maintained
// English/Simplified Chinese release source and its generated pages all have to
// move in ONE commit, assembled after notarization. Publication run 31931451292
// and the 1.2.4 release before it both created the immutable GitHub Release
// first and only then discovered that half of that commit was missing: the
// release was public and permanent while relayium.com and the READMEs still
// named the previous version. This file exists so the whole commit is built and
// tested BEFORE anything immutable is created.
//
// Two functions, both pure enough to test:
//
//   * `bumpReleaseDocs` rewrites the prose that names the published release.
//   * `checkCandidateScope` decides whether an assembled candidate is complete
//     and touches nothing it must not touch.
//
// Everything else the candidate needs is already owned elsewhere and is
// deliberately not re-implemented here: the artifact-derived manifest and
// appcast come from `stage-macos-release.mjs`, the generated pages come from
// `gen-pages.mjs`, and whether the resulting prose is TRUE is decided by
// `repository-status.test.mjs`, `releases.test.mjs`,
// `macos-release-surface.test.mjs` and `MacSurfaceGuardTests`. This file only
// makes the candidate; the suites judge it, and they run before publication.

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The prose that names the published macOS release, repository-relative.
 *
 * All three carry the version as a literal, all three are read by a guard that
 * derives the expected value from `web/native-releases.json`, and all three went
 * stale together in both failed publications.
 */
export const RELEASE_DOCS = [
  "README.md",
  "apps/README.md",
  "web/scripts/pages/content/releases.mjs",
];

export const RELEASE_HISTORY_DOC = "web/scripts/pages/content/releases.mjs";

/**
 * The artifact-derived half of the candidate: written by the workflow from the
 * signed build's own upload, never by this file and never by hand.
 */
export const RELEASE_ARTIFACT_FILES = [
  // The server embeds this allow-list at build time. Omitting it leaves the
  // runtime admin policy unable to select the release even though the public
  // manifest and appcast already advertise it.
  "server/account/macos_release_catalog.json",
  "web/native-releases.json",
  "web/public/apps/macos/appcast.xml",
  // The native client policy, both copies. `stage-macos-release.mjs` moves its
  // `latestVersion` to the release being published and carries the requirement
  // fields through untouched — so this is artifact-derived like the two above,
  // and it is REQUIRED for the same reason they are: a release that left it
  // behind would leave every installed client recommending an update to a
  // version that is no longer the latest, with nothing failing.
  "web/native-client-policy.json",
  "web/public/apps/macos/client-policy.json",
];

/**
 * The committed pages a version bump regenerates, for the two maintained
 * languages only.
 *
 * `/releases` names the tag in its own prose; `/apps` carries the download URL,
 * which contains the tag. These are the bytes a reader without JavaScript — or a
 * crawler, or an answer engine — actually fetches, so a candidate that moved the
 * source and not these ships a truthful repository and a lying website.
 *
 * Three maintained release/app pages are required. English `/apps` has no
 * static twin. It is an SPA route
 * rendered from `src/lib/AppsPage.svelte` and the i18n tables, which read the
 * manifest at build time — `buildModePages` generates the localized twins only.
 * `macos-release-surface.test.mjs` is what holds that half to the manifest.
 */
export const MAINTAINED_GENERATED_PAGES = [
  "web/public/releases/index.html",
  "web/public/zh/apps/index.html",
  "web/public/zh/releases/index.html",
];

/** The sitemap changes only when synchronized CLI history advances a document
 * date. A macOS-only release may legitimately reproduce it byte for byte. */
export const OPTIONAL_GENERATED_PAGES = ["web/public/sitemap.xml"];

/** The seven archived locales, as `web/public/` path prefixes. */
export const FROZEN_PAGE_PREFIXES = [
  "web/public/ar/",
  "web/public/de/",
  "web/public/es/",
  "web/public/fr/",
  "web/public/ja/",
  "web/public/ko/",
  "web/public/pt/",
];

/**
 * The seven archived `/apps` pages, which are the ONE exception to the freeze.
 *
 * An archived translation freezes PROSE. It does not freeze an operational
 * pointer that the manifest derives, and `/apps` is the only archived page that
 * carries one: its macOS CTA is `native-releases.json`'s `downloadUrl`,
 * rendered into the committed HTML by `gen-pages.mjs`.
 *
 * Treating that href as frozen prose is what produced the drift this list
 * exists to end. `gen-pages.mjs` writes all nine `/apps` pages from the
 * manifest, the runtime suites hold the source to the manifest, and production
 * serves whatever the build most recently generated — while the publication job
 * restored these seven back onto the previously published tag before committing.
 * Committed main therefore named a superseded release, every ordinary `npm run
 * build` dirtied seven tracked files, and the deployed site disagreed with the
 * repository. Both tags happened to still resolve, so it read as noise rather
 * than as the release-trust defect it was.
 *
 * So these seven are REQUIRED candidate content, exactly like the maintained
 * generated pages: a release that moves the manifest and leaves them behind is
 * incomplete. Their prose is still frozen — `releases.test.mjs` and
 * `macos-release-surface.test.mjs` own that half, and every OTHER archived path
 * stays byte-for-byte frozen and is still rejected below.
 */
export const ARCHIVED_APP_PAGES = FROZEN_PAGE_PREFIXES.map(
  (prefix) => `${prefix}apps/index.html`,
);

/** Every path a complete candidate is required to contain, and the only ones
 *  it is allowed to contain. */
export const CANDIDATE_PATHS = [
  ...RELEASE_ARTIFACT_FILES,
  ...RELEASE_DOCS,
  ...MAINTAINED_GENERATED_PAGES,
  ...ARCHIVED_APP_PAGES,
];

const VERSION = /^[0-9]+(?:\.[0-9]+){1,2}$/;

function assertVersion(version, label) {
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`${label} is not a supported app version: ${version}`);
  }
}

const CLI_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const TAG_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELEASES_BLOCK = /export const RELEASES = \[\n(?:  \{ version: "v\d+\.\d+\.\d+", date: "\d{4}-\d{2}-\d{2}" \},\n)+\];/;

/** Parse the full repository tag table into the CLI releases the public page owns. */
export function cliReleasesFromTagTable(tagTable) {
  const releases = [];
  const seen = new Set();
  for (const line of tagTable.split("\n")) {
    if (!line.trim()) continue;
    const [version, date, ...extra] = line.split("\t");
    const match = CLI_TAG.exec(version);
    if (!match) continue;
    if (!TAG_DATE.test(date ?? "") || extra.length > 0) {
      throw new Error(`git returned an invalid release tag row: ${JSON.stringify(line)}`);
    }
    if (seen.has(version)) throw new Error(`git returned duplicate release tag ${version}`);
    seen.add(version);
    releases.push({ version, date, numeric: match.slice(1).map(Number) });
  }
  if (releases.length === 0) throw new Error("git returned no CLI release tags");
  releases.sort((left, right) => {
    const date = right.date.localeCompare(left.date);
    if (date !== 0) return date;
    for (let index = 0; index < 3; index += 1) {
      const component = right.numeric[index] - left.numeric[index];
      if (component !== 0) return component;
    }
    return 0;
  });
  return releases.map(({ version, date }) => ({ version, date }));
}

/** Make the committed release ledger agree with the immutable CLI tag namespace. */
export async function syncCliReleaseHistory({ repoRoot, tagTable } = {}) {
  const root = resolve(repoRoot ?? process.cwd());
  const tags = tagTable ?? execFileSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)%09%(creatordate:short)", "refs/tags"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const releases = cliReleasesFromTagTable(tags);
  const path = resolve(root, RELEASE_HISTORY_DOC);
  const before = await readFile(path, "utf8");
  const matches = before.match(new RegExp(RELEASES_BLOCK.source, "g")) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${RELEASE_HISTORY_DOC} has ${matches.length} canonical RELEASES blocks`);
  }
  const block = `export const RELEASES = [\n${releases
    .map(({ version, date }) => `  { version: "${version}", date: "${date}" },`)
    .join("\n")}\n];`;
  const after = before.replace(RELEASES_BLOCK, block);
  if (after !== before) await writeFile(path, after, "utf8");
  return { changed: after !== before, releases };
}

/**
 * The version literal, matched only where it names the DIRECT-DOWNLOAD release.
 *
 * Three constraints, and the third is the one that matters:
 *
 *   * Not preceded by a digit, nor by a digit and a dot, so `macos-v1.2.4`
 *     matches on the `1` while `11.2.4` does not, and neither does the tail of a
 *     longer dotted number that happens to end in the same components.
 *   * Not followed by a digit, nor by a dot and a digit, so `1.2.4` does not
 *     match inside `1.2.41`, nor inside a longer version that merely begins with
 *     the same components. A bare trailing dot is a
 *     SENTENCE, not a version component, and must still match: "**Status:
 *     released as 1.2.4.**" is one of the claims `MacSurfaceGuardTests` reads,
 *     and an earlier `(?![0-9.])` skipped it and left the status line a version
 *     behind while every other sentence in the same file moved.
 *   * Not followed by ` (<digit>`, which is the Mac App Store package form —
 *     "App Store-signed 1.2.4 (11) package was built, verified locally, and
 *     uploaded to App Store Connect on 2026-08-15". That sentence is a fact
 *     about a DIFFERENT artifact on a DIFFERENT channel, and it does not become
 *     true of 1.2.5 because the Developer ID release moved. A blind substitution
 *     would turn every macOS release into a claim that a TestFlight build exists
 *     that nobody archived or uploaded — the precise class of untrue
 *     distribution claim the surface guards exist to prevent. It stays put and a
 *     human edits it when the App Store side actually moves.
 */
function releaseVersionPattern(version) {
  const escaped = version.replace(/\./g, "\\.");
  return new RegExp(
    `(?<![0-9])(?<![0-9]\\.)${escaped}(?![0-9])(?!\\.[0-9])(?! \\([0-9])`,
    "g",
  );
}

/**
 * Rewrite the three release documents from the previously published version to
 * the one being published.
 *
 * Keyed on the OLD version rather than on a pattern for "any version", so the
 * seven archived locales inside `content/releases.mjs` are left alone by
 * construction: they name the version they were published with (1.2.3 at the
 * time of writing), not the current one, so nothing in them matches. That is a
 * property worth stating rather than relying on — `checkCandidateScope` fails
 * on any frozen page that moves except the seven manifest-derived `/apps`
 * twins, and `releases.test.mjs` fails if a frozen locale's tag and lead stop
 * agreeing with each other.
 *
 * A document that does not name `from` at all is an error, not a no-op. It means
 * the prose drifted off the published version at some earlier point, and
 * silently returning "nothing to do" would hand the publication step a candidate
 * that is incomplete in exactly the way this whole file exists to prevent.
 */
export async function bumpReleaseDocs({ repoRoot, from, to, docs = RELEASE_DOCS }) {
  assertVersion(from, "the previously published version");
  assertVersion(to, "the version being published");
  if (from === to) {
    throw new Error(`the published version is already ${to}; nothing to bump`);
  }

  // Every document is read and checked before any is written, so a third
  // document that no longer names `from` cannot leave the first two rewritten.
  // A half-bumped tree is a worse thing to debug than a refusal, and the whole
  // point of failing here is that the publication has not started yet.
  const pattern = releaseVersionPattern(from);
  const rewritten = [];
  for (const doc of docs) {
    const path = resolve(repoRoot, doc);
    const before = await readFile(path, "utf8");
    const after = before.replace(pattern, to);
    if (after === before) {
      throw new Error(`${doc} names no published macOS release ${from}`);
    }
    rewritten.push({ doc, path, after });
  }
  for (const { path, after } of rewritten) {
    await writeFile(path, after, "utf8");
  }
  return { changed: rewritten.map(({ doc }) => doc) };
}

/**
 * Judge an assembled candidate by the set of paths it changes.
 *
 * Two directions, because the two failures are opposite:
 *
 *   * MISSING. Both failed publications shipped a subset — manifest and appcast
 *     moved, READMEs and pages did not — and the immutable release was already
 *     public by the time anything noticed. Every path in `CANDIDATE_PATHS` is
 *     required, so a stale README or an unregenerated maintained page is a
 *     failure of the candidate rather than a failure discovered afterwards.
 *
 *   * EXTRA. The archived locales are byte-for-byte frozen everywhere EXCEPT
 *     their seven `/apps` twins, which carry the manifest-derived download URL
 *     and are required above. Every other archived path — a `/releases` page, a
 *     guide, a landing page — is still rejected, so a release commit cannot
 *     quietly refresh a translation the product no longer maintains. Any other
 *     unexpected path fails too, because a release commit is the worst possible
 *     place to discover unrelated staged work.
 *
 * `alreadyDelivered` inverts the first direction and only that one. It is set
 * when main already documents the version being published — a rerun of the
 * publish job after the metadata landed, which is the ordinary way to recover a
 * failed delivery. There the complete candidate is the EMPTY one: every required
 * file is already correct, so re-deriving it must reproduce main exactly, and
 * any difference at all means the reassembly is not reproducible and must not be
 * pushed on top of a release that already exists.
 */
export function checkCandidateScope(paths, { alreadyDelivered = false } = {}) {
  const seen = new Set(paths);
  // The seven `/apps` twins are subtracted from the freeze rather than added to
  // the allow-list: `frozen` is reported and rejected on its own axis, so a path
  // that stayed in it could never be satisfied by also being required.
  const archivedAppPages = new Set(ARCHIVED_APP_PAGES);
  const frozen = [...seen]
    .filter((path) => FROZEN_PAGE_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .filter((path) => !archivedAppPages.has(path))
    .sort();
  // A rerun requires the empty candidate, so it requires nothing and allows
  // nothing; both directions fall out of the same two lists.
  const required = alreadyDelivered ? [] : CANDIDATE_PATHS;
  const allowed = new Set([...required, ...(alreadyDelivered ? [] : OPTIONAL_GENERATED_PAGES)]);
  const frozenSet = new Set(frozen);
  const unexpected = [...seen]
    .filter((path) => !allowed.has(path) && !frozenSet.has(path))
    .sort();
  const missing = required.filter((path) => !seen.has(path));

  const problems = [];
  if (frozen.length > 0) {
    problems.push(`archived locales must stay byte-for-byte unchanged: ${frozen.join(", ")}`);
  }
  if (missing.length > 0) {
    problems.push(`the release candidate is incomplete: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    problems.push(
      alreadyDelivered
        ? `main already documents this release, so re-deriving it must change nothing: ${unexpected.join(", ")}`
        : `the release candidate changes unrelated files: ${unexpected.join(", ")}`,
    );
  }
  return { ok: problems.length === 0, missing, frozen, unexpected, problems };
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("expected --flag value pairs");
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function usage() {
  return [
    "Usage:",
    "  macos-release-candidate.mjs bump --from <version> --to <version> [--repo-root <dir>]",
    "  macos-release-candidate.mjs sync-cli-release-history [--repo-root <dir>]",
    "  git diff --cached --name-only | macos-release-candidate.mjs check-scope"
      + " [--already-delivered true|false]",
  ].join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const repoRoot = resolve(args["repo-root"] ?? process.cwd());

  if (command === "bump") {
    if (!args.from || !args.to) throw new Error(usage());
    const { changed } = await bumpReleaseDocs({ repoRoot, from: args.from, to: args.to });
    process.stdout.write(
      `Rewrote the published macOS release ${args.from} -> ${args.to} in ${changed.join(", ")}\n`,
    );
    return;
  }

  if (command === "sync-cli-release-history") {
    const { changed, releases } = await syncCliReleaseHistory({ repoRoot });
    process.stdout.write(
      `${changed ? "Synchronized" : "Verified"} ${releases.length} CLI release tags in ${RELEASE_HISTORY_DOC}\n`,
    );
    return;
  }

  if (command === "check-scope") {
    const paths = (await readStdin()).split("\n").map((line) => line.trim()).filter(Boolean);
    const flag = args["already-delivered"] ?? "false";
    if (flag !== "true" && flag !== "false") {
      throw new Error(`--already-delivered must be true or false, not ${flag}`);
    }
    const result = checkCandidateScope(paths, { alreadyDelivered: flag === "true" });
    if (!result.ok) {
      for (const problem of result.problems) process.stderr.write(`error: ${problem}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      flag === "true"
        ? "Release candidate reproduces the metadata already on main\n"
        : `Release candidate covers all ${CANDIDATE_PATHS.length} required files\n`,
    );
    return;
  }

  throw new Error(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
