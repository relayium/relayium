#!/usr/bin/env node
// scripts/test/macos-publish-order-test.mjs — the publish job's step ORDER is a
// safety property, and this is the test that holds it.
//
// A GitHub Release is immutable. Once `gh release create` runs, the tag, the
// target commit and the uploaded assets are public and permanent; there is no
// "undo" that leaves no trace, and replacing an asset on a published release is
// forbidden by this workspace's own release rules. Everything that can still say
// "no" therefore has to run BEFORE that call.
//
// Both macOS publications so far got this backwards. Run 31931451292 created
// `macos-v1.2.5` and then ran `npm test` against a tree whose manifest had moved
// and whose READMEs, release-page source and generated pages had not. The suite
// failed — correctly — but the release was already public, and the fix was a
// separate hand-assembled recovery commit. The 1.2.4 release failed the same way.
//
// Reordering the job fixed it. Nothing stopped the next edit from undoing that,
// because step order is invisible to every other check in this repository: the
// YAML is valid either way, actionlint is happy either way, and the only signal
// is another permanent release with nothing behind it. So the order is asserted
// here, on every push, by repo-hygiene.
//
// Deliberately no YAML dependency. `web/` is the only Node project in this
// repository and this test must run without it — and adding a parser to the
// dependency graph of a release-safety check is the wrong trade. The publish job
// is found by indentation and split on step boundaries, which is enough to ask
// "which step ran first" and fails loudly if the file's shape changes.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = resolve(repoRoot, ".github/workflows/macos.yml");

/** The seven archived locales, as in `web/scripts/pages/shared.mjs`. */
const FROZEN_LANGS = ["ar", "de", "es", "fr", "ja", "ko", "pt"];

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

/** The lines of one top-level job, by its two-space-indented key. */
function jobLines(workflow, job) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) throw new Error(`${workflowPath} has no ${job} job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.startsWith("#")) continue;
    // A new top-level job: two spaces of indent and no more.
    if (/^ {2}\S/.test(line)) { end = i; break; }
  }
  return lines.slice(start, end);
}

/**
 * The job's steps, in order, each as one blob of text.
 *
 * A step begins at the `- name:`/`- uses:` bullet inside `steps:`; everything up
 * to the next bullet belongs to it, comments included. Comments matter: the
 * marker strings below are matched against `run:` bodies, and a stray match
 * inside a comment would make the order test agree with a comment rather than
 * with the code. So each step records its executable body separately.
 */
function steps(lines) {
  const stepsAt = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (stepsAt < 0) throw new Error("the publish job has no steps");
  const found = [];
  for (const line of lines.slice(stepsAt + 1)) {
    if (/^ {6}- /.test(line)) {
      found.push({ name: line.replace(/^ {6}- (name|uses):\s*/, "").trim(), lines: [line] });
    } else if (found.length > 0) {
      found[found.length - 1].lines.push(line);
    }
  }
  return found.map((step) => ({
    name: step.name,
    // Comment lines dropped, so a marker named in a rationale is not mistaken
    // for a command. Every rationale in this job names the commands it is
    // explaining, so without this the test would agree with the prose rather
    // than with the code.
    code: step.lines.filter((line) => !/^\s*#/.test(line)).join("\n"),
  }));
}

/** The index of the single step whose executable body contains `marker`. */
function stepRunning(all, marker, label) {
  const matches = all.filter((step) => step.code.includes(marker));
  if (matches.length !== 1) {
    failures.push(
      `expected exactly one publish step to run ${label} (${marker}); found ${matches.length}`,
    );
    return -1;
  }
  return all.indexOf(matches[0]);
}

const workflow = await readFile(workflowPath, "utf8");
const publish = steps(jobLines(workflow, "publish"));

check(publish.length > 0, "the publish job has no steps");

const assemble = stepRunning(publish, "macos-release-candidate.mjs bump", "the document bump");
const scope = stepRunning(publish, "macos-release-candidate.mjs check-scope", "the candidate scope check");
const suite = stepRunning(publish, "npm test -- --run", "the web test suite");
const build = stepRunning(publish, "npm run build", "the web build");
const freeze = stepRunning(publish, "git commit -m", "the candidate commit");
const create = stepRunning(publish, "gh release create", "the immutable release creation");
const deliver = stepRunning(publish, "git push origin", "the delivery push");

const before = (a, b, why) => {
  if (a < 0 || b < 0) return;
  check(a < b, why);
};

// 1. The whole metadata candidate is assembled and judged before anything
//    immutable exists. This is the assertion that fails for the observed old
//    ordering, in which `gh release create` came first and `npm test -- --run`
//    ran afterwards inside the delivery step.
before(assemble, create, "the release is created before the documents are bumped");
before(suite, create, "the release is created before the web suite runs");
before(build, create, "the release is created before the web build runs");
before(scope, create, "the release is created before the candidate scope is checked");

// 2. The candidate is frozen — committed — before the release, so what is
//    delivered afterwards is exactly the bytes the suite judged.
before(freeze, create, "the candidate is not committed before the release is created");

// 3. Delivery comes last, and is only a push.
before(create, deliver, "metadata is delivered before the release exists");

// 4. Nothing that can newly fail, and nothing that can create or replace an
//    immutable artifact, may live in the delivery step. Its inputs are a commit
//    that already passed and a remote ref; re-running the suite there is what
//    made the old job fail after the point of no return, and rebuilding or
//    re-uploading there would replace assets a user may already have fetched.
if (deliver >= 0) {
  const step = publish[deliver];
  for (const forbidden of [
    "npm test",
    "npm run build",
    "npm run check",
    "npm ci",
    "gh release create",
    "gh release upload",
    "gh release edit",
    "git tag",
    "macos-release-candidate.mjs bump",
  ]) {
    check(
      !step.code.includes(forbidden),
      `"${step.name}" runs ${forbidden}; delivery must push already-tested bytes and nothing else`,
    );
  }
  check(
    !/git push[^\n]*--force/.test(step.code),
    `"${step.name}" force-pushes; a release commit must never overwrite main`,
  );
}

// 5. The candidate assembly restores the seven archived locales after
//    regeneration. `gen-pages.mjs` rewrites all nine `/apps` pages from the
//    manifest, so without this the release commit silently drags seven frozen
//    translations onto the new download URL.
const restored = publish.filter(
  (step) =>
    step.code.includes("git checkout --")
    && FROZEN_LANGS.every((lang) => step.code.includes(`web/public/${lang}`)),
);
check(
  restored.length > 0,
  "no publish step restores the seven archived locales after regenerating pages",
);
for (const step of restored) {
  before(publish.indexOf(step), create, "archived locales are restored only after the release is created");
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} publication-order assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `ok: the macos publish job assembles, tests and freezes the metadata candidate `
  + `before creating the immutable release (${publish.length} steps checked)\n`,
);
