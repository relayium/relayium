#!/usr/bin/env node
// scripts/test/macos-publish-order-test.mjs — the publish job's command ORDER is
// a safety property, and this is the test that holds it.
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
// Reordering the job fixed that, but the first reordering only fixed it at STEP
// granularity, and the defect had moved inside a step: the validate step ran
// `npm test`, then `npm run build`, then the archived-locale restore, and only
// then staged and committed. Every step-level assertion passed while the bytes
// that shipped were regenerated after the suite approved them — equal only if
// page generation is perfectly deterministic, which is an assumption and not a
// check. So this test reasons about LINE positions within the job, not step
// positions, and asserts a two-phase shape:
//
//   write phase   every command that can rewrite a tracked file
//   ---- git add -A ----
//   judge phase   scope check and web suite, reading the staged bytes only
//   ---- git commit ----
//   publish       gh release create, then a bare push
//
// Nothing else in this repository can see any of that. The YAML is valid in
// either order, actionlint is happy in either order, and the only other signal
// is another permanent release with nothing behind it. So the order is asserted
// here, on every push, by repo-hygiene.
//
// Deliberately no YAML dependency. `web/` is the only Node project in this
// repository and this test must run without it — and adding a parser to the
// dependency graph of a release-safety check is the wrong trade. The publish job
// is found by indentation and split on step boundaries, which is enough to ask
// "which command ran first" and fails loudly if the file's shape changes.

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
 * with the code. So each step records its executable lines separately.
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
    code: step.lines.filter((line) => !/^\s*#/.test(line)),
  }));
}

const workflow = await readFile(workflowPath, "utf8");
const publish = steps(jobLines(workflow, "publish"));

check(publish.length > 0, "the publish job has no steps");

/**
 * Every executable line of the job in order, each tagged with its step.
 *
 * This flattening is the whole point of the rewrite. Step indexes cannot
 * distinguish "the suite runs, then the build regenerates the pages" from "the
 * build regenerates the pages, then the suite runs" when both live in one `run:`
 * block, and that is exactly the shape the defect took.
 */
const exec = publish.flatMap((step, stepIndex) =>
  step.code.map((text) => ({ text, step: step.name, stepIndex })));

/** The index of the single executable line containing `marker`. */
function lineRunning(marker, label) {
  const matches = exec.filter((line) => line.text.includes(marker));
  if (matches.length !== 1) {
    failures.push(
      `expected exactly one publish command to run ${label} (${marker}); found ${matches.length}`,
    );
    return -1;
  }
  return exec.indexOf(matches[0]);
}

const bump = lineRunning("macos-release-candidate.mjs bump", "the document bump");
const install = lineRunning("npm ci", "the dependency install");
const genPages = lineRunning("npm run gen:pages", "page generation");
const typecheck = lineRunning("npm run check", "the typecheck");
const build = lineRunning("npm run build", "the web build");
const stage = lineRunning("git add -A", "the candidate staging");
const scope = lineRunning("macos-release-candidate.mjs check-scope", "the candidate scope check");
const suite = lineRunning("npm test -- --run", "the web test suite");
const commit = lineRunning("git commit -m", "the candidate commit");
const create = lineRunning("gh release create", "the immutable release creation");
const push = lineRunning("git push origin", "the delivery push");

/**
 * The archived-locale restore, as a line index.
 *
 * `git checkout --detach` also contains `git checkout --`, so a restore is
 * identified by its continuation: the command plus the lines that follow it name
 * all seven frozen locales.
 */
const restores = exec
  .map((line, index) => ({ line, index }))
  .filter(({ line, index }) => {
    if (!/git checkout --(?!detach)/.test(line.text)) return false;
    const block = exec.slice(index, index + 4).map((l) => l.text).join("\n");
    return FROZEN_LANGS.every((lang) => block.includes(`web/public/${lang}`));
  })
  .map(({ index }) => index);

const before = (a, b, why) => {
  if (a < 0 || b < 0) return;
  check(a < b, why);
};

// 1. The write phase. Everything that can rewrite a tracked file runs before the
//    candidate is staged, so the staged tree is the finished tree.
before(bump, genPages, "pages are generated before the documents are bumped");
before(genPages, build, "the build runs before the first page generation");
before(install, genPages, "pages are generated before dependencies are installed");
before(bump, stage, "the candidate is staged before the documents are bumped");
before(genPages, stage, "the candidate is staged before the pages are generated");
before(build, stage, "the candidate is staged before the web build regenerates the pages");
before(typecheck, stage, "the candidate is staged before the typecheck, which may emit");
check(restores.length > 0, "no publish step restores the seven archived locales after regenerating pages");
if (restores.length > 0) {
  // A restore is itself a tracked-file write, so every one of them belongs to
  // the write phase — and the last one has to fall after the last generation,
  // because `npm run build` runs gen-pages again on its way to vite. Extra
  // restores earlier in the phase are harmless and not the test's business.
  before(build, restores[restores.length - 1],
    "no archived-locale restore runs after the build regenerates the pages");
  for (const restore of restores) {
    before(restore, stage, "the candidate is staged before the archived locales are restored");
  }
}

// 2. The judge phase. Both verdicts are rendered against the staged bytes, and
//    the suite is the last of them.
before(stage, scope, "the candidate scope is checked before the candidate is staged");
before(stage, suite, "the web suite runs before the candidate is staged");
before(build, suite, "the web build regenerates the pages after the suite has judged them");
before(scope, commit, "the candidate is committed before its scope is checked");
before(suite, commit, "the candidate is committed before the web suite has judged it");

// 3. THE boundary. From `git add -A` to `git commit` the job may read and may
//    not write. This is the assertion that fails for the observed defect, in
//    which `npm run build` and the archived-locale restore ran after `npm test`
//    and before `git add -A`/`git commit`: the committed bytes were regenerated
//    after the only thing that had judged them, and were therefore equal to the
//    tested bytes only by assumption.
//
//    The window opens at the staging rather than at the suite deliberately. Both
//    verdicts — the scope check and the suite — are cast against the staged
//    bytes, so a write anywhere between them invalidates whichever verdict came
//    first, not only the last one.
//
//    It is also the assertion that holds against edits nobody has made yet. Any
//    future "just regenerate one more thing before committing" lands in this
//    window and fails here rather than in a permanent release.
const MUTATORS = [
  "npm ci", "npm test", "npm run", "npx ", "vite build", "gen-pages",
  "macos-release-candidate.mjs bump",
  "git checkout", "git restore", "git reset", "git apply", "git stash",
  "git merge", "git rebase", "git clean", "git mv", "git rm",
  // Re-staging is how a write inside the window would reach the commit; the one
  // legitimate `git add -A` opens the window and is not inside it.
  "git add",
  "cp ", "mv ", "rm ", "sed -i", "tee ",
];
if (stage >= 0 && suite >= 0 && commit >= 0) {
  for (let i = stage + 1; i < commit; i += 1) {
    // The suite's own invocation is the thing being protected, not a violation
    // of it; every other line in the window has to be read-only.
    if (i === suite) continue;
    const line = exec[i];
    for (const mutator of MUTATORS) {
      check(
        !line.text.includes(mutator),
        `"${line.step}" runs ${mutator.trim()} after the candidate is staged and before`
        + ` the commit; the committed bytes must be the bytes the suite judged`,
      );
    }
    check(
      !/>\s*\.?\/?(web|apps|README|docs)\b/.test(line.text),
      `"${line.step}" redirects output into the working tree after the candidate is`
      + ` staged and before the commit; the committed bytes must be the bytes the suite judged`,
    );
    // A named-command denylist only catches the writers that exist today. The
    // window is short and its only legitimate script is the scope check, so any
    // other `node` invocation here is a generator until proven otherwise.
    check(
      !/(^|\s)node\s/.test(line.text)
      || line.text.includes("macos-release-candidate.mjs check-scope"),
      `"${line.step}" runs a node script other than the scope check after the candidate`
      + ` is staged and before the commit; the judge phase must not generate anything`,
    );
  }
  // Ordering alone is a claim about the YAML. The guard is what makes the job
  // itself notice: it compares the index tree written before the suite against
  // the index tree after it, and refuses to commit a tree that moved.
  const window = exec.slice(suite + 1, commit).map((line) => line.text).join("\n");
  check(
    window.includes("git write-tree"),
    "nothing between the web suite and the commit proves the tested tree survived;"
    + " expected a git write-tree comparison",
  );
  check(
    window.includes("git diff --quiet"),
    "nothing between the web suite and the commit proves the working tree is unchanged;"
    + " expected a git diff --quiet guard",
  );
}

// 4. The whole candidate is judged and frozen before anything immutable exists.
before(bump, create, "the release is created before the documents are bumped");
before(suite, create, "the release is created before the web suite runs");
before(build, create, "the release is created before the web build runs");
before(scope, create, "the release is created before the candidate scope is checked");
before(commit, create, "the candidate is not committed before the release is created");
for (const restore of restores) {
  before(restore, create, "archived locales are restored only after the release is created");
}

// 5. Delivery comes last, and is only a push.
before(create, push, "metadata is delivered before the release exists");

// 6. Nothing that can newly fail, and nothing that can create or replace an
//    immutable artifact, may live in the delivery step. Its inputs are a commit
//    that already passed and a remote ref; re-running the suite there is what
//    made the old job fail after the point of no return, and rebuilding or
//    re-uploading there would replace assets a user may already have fetched.
if (push >= 0) {
  const step = publish[exec[push].stepIndex];
  const code = step.code.join("\n");
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
      !code.includes(forbidden),
      `"${step.name}" runs ${forbidden}; delivery must push already-tested bytes and nothing else`,
    );
  }
  check(
    !/git push[^\n]*--force/.test(code),
    `"${step.name}" force-pushes; a release commit must never overwrite main`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} publication-order assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `ok: the macos publish job writes, then stages, then judges the staged bytes, then `
  + `freezes them, and only then creates the immutable release `
  + `(${publish.length} steps, ${exec.length} commands checked)\n`,
);
