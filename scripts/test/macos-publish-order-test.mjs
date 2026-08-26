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
//   deliver       candidate branch, merge-gate on that SHA, protected-main push
//   publish       gh release create, last
//
// Nothing else in this repository can see any of that. The YAML is valid in
// either order, actionlint is happy in either order, and the only other signal
// is another permanent release with nothing behind it. So the order is asserted
// here, on every push, by repo-hygiene.
//
// ## Where the job lives now
//
// The publish job MOVED. It used to sit in `.github/workflows/macos.yml`, beside
// the ordinary push/pull_request verification lanes, which made the workflow
// that runs on every commit also the workflow holding `contents: write`, a `gh
// release create` and a `git push origin …:main`. It now lives in
// `.github/workflows/macos-release.yml`, which has no `push:` and no
// `pull_request:` at all, and `macos-release.yml` calls in the other direction
// — the release workflow invokes the CI workflow as a reusable build.
//
// So this file reads TWO workflows. The ordering assertions below are unchanged
// and are made against the release workflow, where the job is; and one further
// assertion is made against the CI workflow, that the job is not ALSO there.
// That second half is what stops the split from being undone by a copy: a
// publish or notarization job restored into `macos.yml` would be reachable from
// an ordinary `pull_request` event, and every ordering rule below would still
// pass while reasoning about the copy in the other file.
//
// Deliberately no YAML dependency. `web/` is the only Node project in this
// repository and this test must run without it — and adding a parser to the
// dependency graph of a release-safety check is the wrong trade. The publish job
// is found by indentation and split on step boundaries, which is enough to ask
// "which command ran first" and fails loudly if the file's shape changes.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The workflow the publish job lives in, and the only manual release entry point. */
const WORKFLOW = ".github/workflows/macos-release.yml";
const workflowPath = resolve(repoRoot, WORKFLOW);

/**
 * The CI half, which must contain none of it.
 *
 * Read as text rather than parsed: the assertion is an ABSENCE, and the
 * structural job scan below is enough to make it. A parser would add a
 * dependency for the sake of a question that is answered by which keys exist.
 */
const CI_WORKFLOW = ".github/workflows/macos.yml";
const ciWorkflowPath = resolve(repoRoot, CI_WORKFLOW);

/** The jobs that may only ever exist in the release workflow. */
const RELEASE_ONLY_JOBS = ["publish", "notarize-stage"];

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
    // The step exactly as written, `run: |` body and all. Section 7 executes
    // that body against a stubbed `gh`, and it needs the real indentation to
    // recover it.
    raw: step.lines,
    // Comment lines dropped, so a marker named in a rationale is not mistaken
    // for a command. Every rationale in this job names the commands it is
    // explaining, so without this the test would agree with the prose rather
    // than with the code.
    code: step.lines.filter((line) => !/^\s*#/.test(line)),
  }));
}

const workflow = await readFile(workflowPath, "utf8");
const publish = steps(jobLines(workflow, "publish"));
const workflowCode = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

check(publish.length > 0, "the publish job has no steps");

// The verified server catalog is generated beside the isolated release-Web
// tree, travels in the notarized artifact, and is copied into the same frozen
// candidate as the appcast. Leaving out any one leg reproduces the production
// defect where the public release exists but the runtime admin cannot select it.
const seedCatalog = workflowCode.indexOf(
  'cp server/account/macos_release_catalog.json "$server_catalog"',
);
const stageRelease = workflowCode.indexOf("node web/scripts/stage-macos-release.mjs");
check(seedCatalog >= 0, "the notarization stage does not seed the server release catalog");
check(stageRelease >= 0 && seedCatalog < stageRelease,
  "the server release catalog must be seeded before release staging");
check(
  workflowCode.includes("${{ runner.temp }}/server/account/macos_release_catalog.json"),
  "the notarized release artifact omits the staged server release catalog",
);
check(
  workflowCode.includes(
    'cp "$RUNNER_TEMP/release/server/account/macos_release_catalog.json"'),
  "the publish candidate does not restore the artifact-derived server release catalog",
);

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
const syncHistory = lineRunning(
  "macos-release-candidate.mjs sync-cli-release-history",
  "the CLI release-history synchronization",
);
const install = lineRunning("npm ci", "the dependency install");
const genPages = lineRunning("npm run gen:pages", "page generation");
const typecheck = lineRunning("npm run check", "the typecheck");
const build = lineRunning("npm run build", "the web build");
const stage = lineRunning("git add -A", "the candidate staging");
const scope = lineRunning("macos-release-candidate.mjs check-scope", "the candidate scope check");
const suite = lineRunning("npm test -- --run", "the web test suite");
const commit = lineRunning("git commit -m", "the candidate commit");
const create = lineRunning("gh release create", "the immutable release creation");
const candidatePush = lineRunning("refs/heads/$candidate_branch", "the candidate-branch push");
const gateDispatch = lineRunning("gh workflow run merge-gate.yml", "the candidate gate dispatch");
const gateWatch = lineRunning("gh run watch", "the candidate gate result");
const push = lineRunning("$CANDIDATE:main", "the protected-main delivery push");

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
before(bump, syncHistory, "CLI release history is synchronized before the documents are bumped");
before(syncHistory, genPages, "pages are generated before CLI release history is synchronized");
before(genPages, build, "the build runs before the first page generation");
before(install, genPages, "pages are generated before dependencies are installed");
before(bump, stage, "the candidate is staged before the documents are bumped");
before(syncHistory, stage, "the candidate is staged before CLI release history is synchronized");
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
  "macos-release-candidate.mjs sync-cli-release-history",
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
before(syncHistory, create, "the release is created before CLI release history is synchronized");
before(suite, create, "the release is created before the web suite runs");
before(build, create, "the release is created before the web build runs");
before(scope, create, "the release is created before the candidate scope is checked");
before(commit, create, "the candidate is not committed before the release is created");
for (const restore of restores) {
  before(restore, create, "archived locales are restored only after the release is created");
}

// 5. The frozen candidate is checked on its own SHA before protected main
//    moves, and the immutable public release is created only after delivery.
before(commit, candidatePush, "the candidate branch is pushed before the candidate is frozen");
before(candidatePush, gateDispatch, "merge-gate is dispatched before its candidate branch exists");
before(gateDispatch, gateWatch, "the candidate gate is watched before it is dispatched");
before(gateWatch, push, "protected main moves before the candidate gate reports success");
before(push, create, "the immutable release exists before its metadata reaches protected main");

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
    "macos-release-candidate.mjs sync-cli-release-history",
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

// 7. THE ALIAS. The release must decline the repository-wide `latest` marker,
//    and the job must prove that it did.
//
//    GitHub's `latest` is one pointer per REPOSITORY, not one per tag family,
//    and unless a release says otherwise GitHub gives it to whichever full
//    release is newest. This repository publishes two families from one repo:
//    the CLI as `v0.22.2` and friends, and the macOS app as `macos-v1.3.8`.
//    `web/public/install.sh` — the script behind
//    `curl -fsSL https://relayium.com/install.sh | sh` — fetches
//    `relayium_<os>_<arch>.tar.gz`, `checksums.txt` and `checksums.txt.sig`
//    from `/releases/latest/download`, and `web/public/install-node.sh` fetches
//    `relayium-node_<os>_<arch>.tar.gz` from the same place. A macOS release
//    carries none of them. So the moment a macOS release takes the alias, every
//    new install 404s — on a URL that is printed on the website, in the README
//    and in every tutorial, and that cannot be revised after the fact.
//
//    That is the observed defect: `macos-v1.3.8` took the alias from CLI
//    `v0.22.2` and the published installer stopped working. And it is the
//    SECOND time this alias has done it. On 2026-08-12 the central release
//    check cached `macos-v1.1.3` as the newest server release for exactly the
//    same reason. That one was closed by teaching the READER to stop trusting
//    the alias — `LatestTag`, in server/selfupdate/selfupdate.go, which scans
//    the release list instead. Nothing was ever done to the PRODUCER, so the
//    same cause simply surfaced somewhere the reader-side fix could not reach.
//    These assertions are the producer half.
//
//    They live here because nothing else in the repository can see it. The YAML
//    is valid with the flag and without it, actionlint is happy either way,
//    gh's default is invisible at the call site, a created release records no
//    trace of the flag that a later reader can inspect, and the next signal
//    after a regression is a stranger's failed install.

/** The whole `gh release create` invocation: its line plus every continuation. */
const createInvocation = (() => {
  if (create < 0) return "";
  const out = [exec[create].text];
  for (let i = create; /\\\s*$/.test(exec[i].text) && i + 1 < exec.length; i += 1) {
    out.push(exec[i + 1].text);
  }
  return out.join("\n");
})();

check(
  /--latest=false(\s|\\|$)/.test(createInvocation),
  "`gh release create` does not pass `--latest=false`, so GitHub hands the repository-wide"
  + " `latest` alias to this macOS release. web/public/install.sh downloads"
  + " relayium_<os>_<arch>.tar.gz, checksums.txt and checksums.txt.sig from"
  + " /releases/latest/download and a macOS release carries none of them, so every"
  + " `curl -fsSL https://relayium.com/install.sh | sh` 404s until a human moves the alias back.",
);

// The flag is one way to claim the alias; these are the others. Stated over
// every executable line of the workflow rather than over the create invocation,
// because a later `gh release edit --latest` or a raw `gh api -f make_latest=true`
// would take the alias back while the assertion above still passed.
const workflowExec = workflow
  .split("\n")
  .map((text, index) => ({ text, line: index + 1 }))
  .filter(({ text }) => !/^\s*#/.test(text));
for (const { text, line } of workflowExec) {
  for (const form of text.match(/--latest(=[^\s\\]*)?/g) ?? []) {
    check(
      form === "--latest=false",
      `${WORKFLOW}:${line} passes \`${form}\`. The only form this workflow may use is`
      + " `--latest=false`: `--latest`, `--latest=true` and `--latest=legacy` all give a macOS"
      + " release the repository-wide alias that web/public/install.sh downloads from.",
    );
  }
  check(
    !/make_latest/.test(text) || /make_latest=false/.test(text),
    `${WORKFLOW}:${line} sets \`make_latest\` directly through the API. A macOS release may`
    + " only ever send `make_latest=false`; the repository-wide alias belongs to the CLI"
    + " releases that web/public/install.sh downloads from /releases/latest/download.",
  );
}

// And the same property as BEHAVIOUR, because every assertion above is a claim
// about text. The publish step's shell is extracted and actually run against a
// stubbed `gh`, so the flag has to survive into the real invocation and the
// read-back has to reject the real defect. This is what fails if the job keeps
// the flag but stops checking, or checks but compares the wrong two strings.
{
  const step = create >= 0 ? publish[exec[create].stepIndex] : null;
  const body = (() => {
    if (step === null) return null;
    const at = step.raw.findIndex((text) => /^\s*run: \|\s*$/.test(text));
    if (at < 0) return null;
    const lines = step.raw.slice(at + 1);
    const first = lines.find((text) => text.trim() !== "");
    if (first === undefined) return null;
    const indent = /^ */.exec(first)[0].length;
    return lines.map((text) => text.slice(indent)).join("\n");
  })();

  check(body !== null, "the publish step that creates the release has no `run: |` body to execute");

  if (body !== null) {
    const scratch = mkdtempSync(join(tmpdir(), "macos-publish-alias-"));
    try {
      const script = join(scratch, "publish.sh");
      writeFileSync(script, body);

      // `gh release view` fails, which is the "release does not exist yet" path
      // — the one that creates. Everything else is recorded so the assertions
      // can read what the job actually asked GitHub for.
      const stub = join(scratch, "bin");
      mkdirSync(stub);
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/bin/sh",
          'if [ "$1" = "release" ] && [ "$2" = "view" ]; then exit 1; fi',
          'printf "%s\\n" "$*" >> "$GH_LOG"',
          'if [ "$1" = "release" ] && [ "$2" = "create" ]; then exit 0; fi',
          // The alias endpoint 404s when no release holds it; the stub says so
          // by failing, exactly as gh does.
          'if [ "$1" = "api" ]; then',
          '  [ -n "${FAKE_LATEST:-}" ] || exit 1',
          '  printf "%s\\n" "$FAKE_LATEST"',
          "  exit 0",
          "fi",
          'printf "unexpected gh invocation: %s\\n" "$*" >&2',
          "exit 90",
        ].join("\n"),
        { mode: 0o755 },
      );

      /** The stub's transcript, or "" when the run never reached it. */
      const readLog = (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return "";
        }
      };

      /** Run the publish body with `/releases/latest` reporting `latest`. */
      const run = (latest) => {
        const log = join(scratch, `gh-${Buffer.from(latest).toString("hex")}.log`);
        writeFileSync(log, "");
        const result = spawnSync("bash", [script], {
          encoding: "utf8",
          // Run in the scratch directory, never in the repository. Today the
          // create branch touches nothing but `gh`; a future edit that adds a
          // `git` command to it would otherwise run that command against this
          // checkout. The token is a stub for the same reason — the `gh` on
          // PATH is a stub, and no real credential belongs in a test child.
          cwd: scratch,
          env: {
            ...process.env,
            PATH: `${stub}:${process.env.PATH ?? ""}`,
            GH_TOKEN: "stub-token",
            GH_LOG: log,
            FAKE_LATEST: latest,
            GITHUB_REPOSITORY: "relayium/relayium",
            GITHUB_SHA: "0".repeat(40),
            GITHUB_RUN_ID: "1",
            RUNNER_TEMP: scratch,
            RELEASE_VERSION: "9.9.9",
          },
        });
        return { ...result, log: readLog(log) };
      };

      const cliLatest = run("v0.22.2");
      check(
        cliLatest.error === undefined,
        `the publish body could not be executed: ${cliLatest.error?.message}`,
      );
      check(
        cliLatest.log.includes("release create"),
        "executing the publish body never called `gh release create`, so the assertions below"
        + " would be judging a script that did nothing. The stub, the branch condition or the"
        + " step's shape has changed.",
      );
      check(
        /release create[^\n]*--latest=false(\s|$)/.test(cliLatest.log),
        "the executed publish body called `gh release create` WITHOUT `--latest=false`;"
        + ` gh received: ${cliLatest.log.trim().split("\n")[0]}`,
      );
      check(
        cliLatest.status === 0,
        "the publish body failed while the repository-wide `latest` alias pointed at the CLI"
        + ` release, which is the correct state: exit ${cliLatest.status}, ${cliLatest.stderr}`,
      );

      // The defect itself: the alias pointing at the macOS tag this job just
      // published. `macos-v1.3.8` sat in exactly this state with a green job.
      const macosLatest = run("macos-v9.9.9");
      check(
        macosLatest.status !== 0,
        "the publish body SUCCEEDED while the repository-wide `latest` alias pointed at its own"
        + " macOS release. That is the published defect: install.sh downloads from"
        + " /releases/latest/download and the macOS release has no CLI assets. The job must read"
        + " the alias back and fail.",
      );
      check(
        // Workflow annotations go to stdout, which is where every other
        // `::error::` in this job writes; both streams are read so the
        // assertion does not depend on which one the job chose.
        `${macosLatest.stdout}${macosLatest.stderr}`.includes("::error::"),
        "the publish body rejected the macOS release holding the `latest` alias without a"
        + ` \`::error::\` annotation, so the run would fail with no visible cause:`
        + ` ${macosLatest.stdout}${macosLatest.stderr}`,
      );

      // A repository where no release holds the alias is not a defect, and the
      // read-back must not invent one out of gh's 404.
      const noLatest = run("");
      check(
        noLatest.status === 0,
        "the publish body failed when `/releases/latest` reported no release at all. gh exits"
        + " non-zero there and that is a legitimate repository state, not a broken installer:"
        + ` exit ${noLatest.status}, ${noLatest.stderr}`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

// 8. And the half none of the above can see: the job is here and NOWHERE ELSE.
//
// Every rule above is a statement about one file. None of them notices a second
// copy of the publish job living in the CI workflow — where it would be
// reachable from `push` and `pull_request` rather than from a deliberate manual
// dispatch, and where it would need `contents: write` on the workflow that runs
// on every commit.
//
// That is not hypothetical: it is where the job WAS. The split is what made
// `macos.yml` structurally unable to publish, and "structurally" is worth
// exactly as much as the assertion that it stayed that way.
//
// Job keys are read the same way `jobLines` reads them — a two-space-indented
// key — so a job restored under any of these names fails here regardless of what
// its steps do. The command check that follows is the same rule stated against
// behaviour, so a publish job renamed to something innocuous fails too.
const ciWorkflow = await readFile(ciWorkflowPath, "utf8");

/**
 * The two-space-indented keys under the file's `jobs:` mapping, and only those.
 *
 * Scoped to the mapping rather than to the indentation alone: `on:` also has
 * two-space children — `push:`, `pull_request:`, `workflow_call:` — and a scan
 * that collected them would report trigger names as jobs in its own failure
 * message. Stopping at the next column-0 key is what keeps the list honest.
 */
const ciJobs = (() => {
  const out = [];
  let inJobs = false;
  for (const line of ciWorkflow.split("\n")) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const key = /^ {2}([A-Za-z0-9_][\w.-]*):\s*$/.exec(line)?.[1];
    if (key !== undefined) out.push(key);
  }
  return out;
})();

check(
  ciJobs.length > 0,
  `${CI_WORKFLOW} parsed to no jobs at all, so the absence checks below would pass by inspecting `
  + `nothing. Either the file moved or its shape changed; this test names it on purpose.`,
);
for (const job of RELEASE_ONLY_JOBS) {
  check(
    !ciJobs.includes(job),
    `${CI_WORKFLOW} declares a \`${job}\` job; it declares [${ciJobs.join(", ")}]. That job `
    + `belongs to ${WORKFLOW} and only there. In ${CI_WORKFLOW} it is reachable from \`push\` and `
    + `\`pull_request\`, it needs \`contents: write\` or a notarization key on the workflow that `
    + `runs on every commit, and every ordering rule in this file would keep passing while `
    + `judging the copy in the other file.`,
  );
}

// The same boundary stated as behaviour rather than as a job name. `git push`
// is deliberately not in this list: the CI workflow legitimately contains none,
// but neither does it need a rule here — the three below are the operations
// that create or replace something permanent, and a renamed job carrying any of
// them is the defect regardless of what the key is called.
const ciCode = ciWorkflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
for (const [command, why] of [
  ["gh release create", "creates an immutable public release"],
  ["gh release upload", "replaces the assets of one"],
  ["notarytool", "spends an Apple notarization submission"],
  ["contents: write", "grants the token that can push to `main`"],
]) {
  check(
    !ciCode.includes(command),
    `${CI_WORKFLOW} contains \`${command}\`, which ${why}. That workflow runs on every push to `
    + `\`main\` and every pull request; the operations that cannot be undone live in `
    + `${WORKFLOW}, behind a manual dispatch, and the separation is the only thing that makes `
    + `an ordinary CI event unable to reach them.`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} publication-order assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `ok: ${WORKFLOW}'s publish job writes, then stages, then judges the staged bytes, then `
  + `freezes them, and only then creates the immutable release `
  + `(${publish.length} steps, ${exec.length} commands checked); `
  + `the release declines the repository-wide \`latest\` alias and reads it back `
  + `(asserted by executing the publish body against a stubbed gh); `
  + `${CI_WORKFLOW} declares none of [${RELEASE_ONLY_JOBS.join(", ")}]\n`,
);
