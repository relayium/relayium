#!/usr/bin/env node
// scripts/test/ci-event-policy-test.mjs — the trigger, concurrency and race-lane
// policy that nothing in GitHub Actions can check for itself.
//
// ## What went wrong, twice
//
// 1. Every workflow here listened to `push` with no branch filter AND to
//    `pull_request`. A branch with an open PR therefore ran each workflow
//    TWICE per commit against an identical tree — including a ~44 minute race
//    lane. Nothing reports that: both runs are green, and the duplicate is
//    only visible if you count the runs.
//
// 2. The obvious concurrency fix, `group: <workflow>-${{ github.ref }}`, is
//    actively unsafe. GitHub cancels an older PENDING run in a group when a
//    newer one arrives, and it does that even with `cancel-in-progress: false`.
//    Two merges in quick succession put two `main` runs in one `refs/heads/main`
//    group and the first is cancelled — so a commit that was never verified
//    shows a *cancelled* check rather than a missing or failed one, which reads
//    as "someone stopped it" rather than "this is untested".
//
// The rule that satisfies both: group by PR NUMBER when there is one, and by
// `github.run_id` — unique per run — for everything else. Then a PR supersedes
// only itself and nothing can ever cancel a `main`, dispatch or scheduled run.
//
// ## And the race lane
//
// `go.yml`'s race gate was one `go test -race -timeout 45m ./...` measured at
// ~43m35s, i.e. a lane that expires before it detects. It is now an eight-way
// shard matrix over `server/account` plus one job for every other package, and
// the full serial run moved to a non-gating nightly workflow so ordering
// defects stay visible. Each of those pieces is individually deletable without
// breaking any YAML: drop the matrix and one shard's tests silently stop being
// race-checked; add a retry and a real race becomes a rerun; give the nightly a
// `pull_request:` trigger and the 44-minute gate is back.
//
// Every one of those is asserted below, because all of them leave the workflow
// syntactically valid — no YAML check, and no linter GitHub runs, would object
// to any of them — and the next signal would be a race reaching production.
//
// ## And the platform boundary
//
// Section 6 governs which workflow owns which platform, which is the same class
// of invisible property one level up. `apps/mac/**` belongs to `macos.yml` and
// `apps/ios/**` to `ios.yml`; `apps/RelayiumKit/**` is APPLE-SHARED and fans out
// to both on purpose; `compat.yml` is the always-on, unfiltered wire-
// compatibility gate every platform must pass. The failure mode is not a broken
// build but an inherited one: a coarse `apps/**` or `scripts/**` filter silently
// adopts the next platform root the day somebody creates it, so a future
// `apps/android/` change would start a macOS runner that builds nothing it
// touched — exactly what `apps/**` did to iOS before the native split. The
// checks are written against COMPILED GLOBS rather than against the literal
// lists, so "too broad" and "too narrow" fail the same way, and section 7 mutates
// the parsed workflows to prove each of them can actually fail.
//
// `docs/CI-PLATFORM-BOUNDARY.md` states the boundary in prose. This file is what
// makes it true.
//
// ## And the paid-runner budget
//
// Section 6i governs the two most expensive lanes, `ios.yml` and `release.yml`,
// against two failures that leave the YAML perfectly valid. A job with no
// `timeout-minutes` inherits GitHub's SIX-HOUR default, so one wedged run holds
// a paid macOS runner — or a release job with the signing key on disk — for six
// hours instead of turning the board red in minutes; both files had no timeout
// at all. And `ios.yml` honoured a `[macos-only]` marker in a `main` commit
// message, which let a commit message skip the iOS build: a skipped check does
// not report red, it reports nothing, so the skip was invisible in the merge box
// on the one branch where this workflow is the only thing that compiles iOS.
// Both are fixed, and both are asserted here — including the GENERAL shape of
// the escape, so it cannot return as `[skip-ios]` or any other spelling.
//
// ## And the name the required check is required BY
//
// Section 6j is the one property of `main`'s branch protection that source can
// hold up its half of. Protection requires exactly one context — the job name
// `wire-vectors`, bound to GitHub Actions `app_id` 15368 — and that binding
// stops a differently-owned check of the same name from satisfying it. It does
// nothing about a SECOND job named `wire-vectors` in this repository: that is
// the same app posting the same context, so an unrelated green lane can stand in
// for the contract gate. Section 6j therefore asserts, across every workflow
// file on disk rather than only the governed ones, that `compat.yml` still
// declares that job and that nothing else declares it.
//
// ## Why the YAML parser is written out here, and what checks IT
//
// Same reason as macos-publish-order-test.mjs and native-web-pairing-gate-test.mjs:
// `web/` is the only Node project in this repository, and a guard that runs on
// every pull request must not need `npm ci` first. The parser below covers the
// subset these workflows use and throws on anything it does not understand,
// rather than guessing.
//
// A hand-written parser is the one thing here that could make every policy
// check below pass vacuously: mis-read a workflow, get `undefined` where the
// policy expected a value, and the assertions are testing the parser's failure
// rather than the workflow. Two things guard against that, and both run every
// time this file does:
//
//  1. `assertParserReadsTheWorkflowSubset()` parses an embedded fixture that
//     exercises every construct these governed workflows use — block mappings and
//     sequences, inline sequences, `|` and `>-` block scalars, anchors and
//     aliases, quoted values containing `#`, and the `on:` key surviving as the
//     string "on" rather than YAML 1.1's boolean — and asserts the exact
//     resulting object.
//  2. `assertParseWasNotVacuous()` requires each governed workflow to have come
//     out with a non-empty `on`, `jobs` and `concurrency`, so a parse that
//     silently produced an empty document cannot read as a policy pass.
//
// There is deliberately no second, real YAML implementation in the loop. This
// guard gates every pull request, and giving it a Python or npm dependency to
// install first would trade a checkable risk for an outage that blocks merges.

import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

// ── the policy, stated once ─────────────────────────────────────────────────

/**
 * The workflows this policy binds, and whether each is expected to offer a
 * manual `workflow_dispatch`. Naming them explicitly is the point: a workflow
 * silently dropped from this list would stop being checked, so the list is the
 * assertion.
 */
const GOVERNED = [
  { file: "go.yml", dispatch: true },
  { file: "macos.yml", dispatch: true },
  { file: "ios.yml", dispatch: true },
  { file: "web.yml", dispatch: true },
  // The always-on, deliberately UNFILTERED compatibility gate. It is in this
  // list — and not merely in section 6 — so it is bound by the same trigger and
  // concurrency policy as every heavy workflow it runs in front of.
  { file: "compat.yml", dispatch: true },
  { file: "native-web-pairing.yml", dispatch: true },
  { file: "repo-hygiene.yml", dispatch: false },
];

const NIGHTLY = "account-race-nightly.yml";

const GROUP = "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}";
const CANCEL = "${{ github.event_name == 'pull_request' }}";

const ACCOUNT_PKG = "github.com/relayium/relayium/account";
const SHARD_HELPER = "scripts/go-race-shard.go";
const SHARDS = 8;

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

// ── a parser for the YAML subset these workflows use ────────────────────────

class YamlError extends Error {}

/**
 * Parses block mappings, block sequences, inline `[a, b]` sequences, block
 * scalars (`|`, `>`, with optional chomping indicator), anchors and aliases.
 * Everything is returned as a string, array or plain object; no scalar is
 * coerced to a number or boolean, so `on:` stays the string "on" instead of
 * becoming YAML 1.1's `true`.
 */
function parseYaml(text) {
  const lines = text.split("\n");
  const anchors = new Map();
  let i = 0;

  const indentOf = (line) => line.length - line.trimStart().length;
  const isBlank = (line) => line.trim() === "";
  const isComment = (line) => /^\s*#/.test(line);
  const skip = () => {
    while (i < lines.length && (isBlank(lines[i]) || isComment(lines[i]))) i += 1;
  };

  /** Everything indented deeper than `parentIndent`, verbatim. */
  function blockScalar(parentIndent) {
    const out = [];
    while (i < lines.length) {
      if (isBlank(lines[i])) { out.push(""); i += 1; continue; }
      if (indentOf(lines[i]) <= parentIndent) break;
      out.push(lines[i]); i += 1;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    if (out.length === 0) return "";
    const strip = indentOf(out.find((l) => l !== "") ?? "");
    // Clip chomping: a block scalar keeps exactly one trailing newline. Matching
    // YAML here rather than approximating it is what lets this parser be diffed
    // against a real implementation.
    return out.map((l) => l.slice(strip)).join("\n") + "\n";
  }

  /** Drops a trailing ` # comment`, but not a `#` inside quotes. */
  function stripComment(raw) {
    let quote = null;
    for (let k = 0; k < raw.length; k += 1) {
      const ch = raw[k];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "#" && (k === 0 || /\s/.test(raw[k - 1]))) return raw.slice(0, k);
    }
    return raw;
  }

  function unquote(raw) {
    const v = raw.trim();
    if (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function scalar(raw) {
    const v = stripComment(raw).trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      return inner === "" ? [] : inner.split(",").map((part) => unquote(part));
    }
    return unquote(v);
  }

  /**
   * A value written after `key:` on the same line, or the block beneath it.
   * `keyIndent` is the column the key started at.
   */
  function value(rest, keyIndent) {
    let raw = rest.trim();
    let anchor = null;
    const anchored = raw.match(/^&([A-Za-z0-9_-]+)\s*(.*)$/);
    if (anchored) { anchor = anchored[1]; raw = anchored[2].trim(); }
    const alias = raw.match(/^\*([A-Za-z0-9_-]+)\s*$/);
    if (alias) {
      if (!anchors.has(alias[1])) throw new YamlError(`unknown alias *${alias[1]}`);
      return anchors.get(alias[1]);
    }

    let out;
    if (/^[|>][-+]?\d*$/.test(raw)) {
      out = blockScalar(keyIndent);
    } else if (raw === "" || raw.startsWith("#")) {
      // Either a nested block or an empty value; the indentation decides.
      const save = i;
      skip();
      if (i < lines.length && indentOf(lines[i]) > keyIndent) {
        out = node(keyIndent + 1);
      } else {
        i = save;
        out = null;
      }
    } else {
      out = scalar(raw);
    }
    if (anchor) anchors.set(anchor, out);
    return out;
  }

  function node(minIndent) {
    skip();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return null;
    return /^\s*-(\s|$)/.test(lines[i]) ? sequence(ind) : mapping(ind);
  }

  function sequence(ind) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      if (indentOf(lines[i]) !== ind || !/^\s*-(\s|$)/.test(lines[i])) break;
      const rest = lines[i].slice(ind + 1).replace(/^\s/, "");
      if (rest.trim() === "" || rest.trim().startsWith("#")) {
        i += 1;
        out.push(node(ind + 1));
      } else if (/^[^\s:#][^:#]*:(\s|$)/.test(rest)) {
        // `- key: v` opens a mapping whose other keys line up two columns in.
        // Rewriting the dash to spaces lets the mapping parser see all of them.
        lines[i] = " ".repeat(ind + 2) + rest;
        out.push(mapping(ind + 2));
      } else {
        i += 1;
        out.push(scalar(rest));
      }
    }
    return out;
  }

  function mapping(ind) {
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      if (indentOf(lines[i]) !== ind) break;
      const m = lines[i].match(/^\s*([^:#\s][^:#]*?)\s*:(.*)$/);
      if (!m) {
        throw new YamlError(`cannot parse line ${i + 1}: ${JSON.stringify(lines[i])}`);
      }
      const key = unquote(m[1]);
      const rest = m[2];
      i += 1;
      out[key] = value(rest, ind);
    }
    return out;
  }

  const doc = node(0);
  skip();
  if (i < lines.length) {
    throw new YamlError(`trailing content at line ${i + 1}: ${JSON.stringify(lines[i])}`);
  }
  return doc;
}

// ── prove the parser before trusting anything it produces ───────────────────

/** Deep structural equality, enough for the plain objects/arrays/strings above. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Every construct the governed workflows actually use, parsed and compared
 * against the exact object it must produce.
 *
 * Each line here corresponds to something real: `paths: &paths` / `*paths` is
 * how web.yml and native-web-pairing.yml share one path list, `run: |` is every
 * shell step, the `${{ ... }}` concurrency values are quoted expressions
 * containing braces, and `on:` is the key YAML 1.1 would otherwise turn into
 * the boolean `true` and hide from every check below.
 */
function assertParserReadsTheWorkflowSubset() {
  const fixture = [
    "name: sample",
    "on:",
    "  push:",
    "    branches:",
    "      - main",
    "    paths: &paths",
    "      - 'web/**'",
    "      - '.github/workflows/web.yml'",
    "  pull_request:",
    "    paths: *paths",
    "  workflow_dispatch:",
    "",
    "# a full-line comment",
    "concurrency:",
    "  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 25",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    "        shard: [0, 1, 2]",
    "    steps:",
    "      - uses: actions/checkout@abc123 # v6.0.2",
    "      - name: shell step",
    "        run: |",
    "          go test -race -count=1 \\",
    "            -run \"$RUN_REGEX\" ./account",
    "      - name: folded",
    "        run: >-",
    "          one",
    "  quoted:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo \"not # a comment\"",
    "",
  ].join("\n");

  const want = {
    name: "sample",
    on: {
      push: { branches: ["main"], paths: ["web/**", ".github/workflows/web.yml"] },
      pull_request: { paths: ["web/**", ".github/workflows/web.yml"] },
      workflow_dispatch: null,
    },
    concurrency: { group: GROUP, "cancel-in-progress": CANCEL },
    jobs: {
      build: {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": "25",
        strategy: { "fail-fast": "false", matrix: { shard: ["0", "1", "2"] } },
        steps: [
          { uses: "actions/checkout@abc123" },
          { name: "shell step", run: "go test -race -count=1 \\\n  -run \"$RUN_REGEX\" ./account\n" },
          { name: "folded", run: "one\n" },
        ],
      },
      quoted: {
        "runs-on": "ubuntu-latest",
        steps: [{ run: 'echo "not # a comment"' }],
      },
    },
  };

  let got;
  try {
    got = parseYaml(fixture);
  } catch (err) {
    check(false, `the YAML parser threw on its own fixture: ${err.message}. Every policy check `
      + `below reads values through it, so they would all be testing the parser rather than the `
      + `workflows.`);
    return;
  }
  check(
    deepEqual(got, want),
    `the YAML parser no longer reads the workflow subset correctly.\n  got:  ${JSON.stringify(got)}\n`
    + `  want: ${JSON.stringify(want)}\n`
    + `Every assertion in this file reads through this parser, so a parser that returns the wrong `
    + `value — or undefined — makes the policy checks pass or fail for the wrong reason.`,
  );
  // Stated separately, because it is the one that fails SILENTLY: YAML 1.1
  // resolves the bare key `on` to the boolean true, and a parser that did so
  // would leave doc.on undefined and every trigger check below would be
  // asserting against nothing.
  check(
    got && typeof got === "object" && "on" in got && !("true" in got),
    `the parser resolved the \`on:\` key to something other than the string "on". Every trigger `
    + `check in this file reads \`doc.on\`, so they would all be inspecting undefined.`,
  );
}

assertParserReadsTheWorkflowSubset();

// ── load every governed workflow ────────────────────────────────────────────

const files = [...GOVERNED.map((g) => g.file), NIGHTLY];
const docs = new Map();
for (const file of files) {
  let text;
  try {
    text = await readFile(resolve(workflowsDir, file), "utf8");
  } catch {
    check(false, `${file} is missing. It is named in this test's policy list, so removing or `
      + `renaming it without updating that list would silently drop it from the trigger and `
      + `concurrency policy.`);
    continue;
  }
  try {
    docs.set(file, parseYaml(text));
  } catch (err) {
    check(false, `${file} could not be parsed: ${err.message}`);
  }
}

/**
 * Workflows this file parses for their RUNNER BUDGET and escape hatches only.
 *
 * `release.yml` is deliberately NOT in `GOVERNED`. It is tag-triggered, has no
 * `concurrency:` block and answers to none of the trigger rules in sections 1-3,
 * so listing it there would assert things about it that are not true. But it is
 * one of the two most expensive lanes here — the other is `ios.yml`, which IS
 * governed — and section 6i has to be able to read its jobs.
 *
 * Parsed here rather than in the loop above so `assertParseWasNotVacuous()`
 * keeps applying its `on`/`concurrency`/`jobs` rule to governed workflows only.
 * A parse failure is still a reported failure, not a silent skip.
 */
const BUDGET_ONLY = ["release.yml"];
for (const file of BUDGET_ONLY) {
  let text;
  try {
    text = await readFile(resolve(workflowsDir, file), "utf8");
  } catch {
    check(false, `${file} is missing. It is named in this test's runner-budget list, so removing `
      + `or renaming it without updating that list would silently drop it from the timeout and `
      + `escape-hatch policy in section 6i.`);
    continue;
  }
  try {
    docs.set(file, parseYaml(text));
  } catch (err) {
    check(false, `${file} could not be parsed: ${err.message}`);
  }
}

/**
 * A parse that produced an empty or near-empty document must not read as a
 * policy pass. Each governed workflow has, at minimum, a trigger map, a
 * concurrency block and at least one job; if any of those came out missing, the
 * checks further down would be inspecting `undefined` and reporting on it as
 * though the workflow said so.
 */
function assertParseWasNotVacuous() {
  for (const file of files) {
    const doc = docs.get(file);
    if (!doc) continue; // already reported as missing or unparseable
    check(
      doc.on && typeof doc.on === "object" && Object.keys(doc.on).length > 0,
      `${file}: parsed with no \`on:\` triggers at all. That is a parser failure, not a workflow `
      + `without triggers — GitHub would not run it.`,
    );
    check(
      doc.concurrency && typeof doc.concurrency === "object",
      `${file}: parsed with no \`concurrency:\` block.`,
    );
    check(
      doc.jobs && typeof doc.jobs === "object" && Object.keys(doc.jobs).length > 0,
      `${file}: parsed with no jobs.`,
    );
  }
}

assertParseWasNotVacuous();

/** The steps of every job, flattened, with the job name attached. */
function allSteps(doc) {
  const out = [];
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) out.push({ jobName, job, step });
  }
  return out;
}

const runText = (job) => (job?.steps ?? []).map((s) => s?.run ?? "").join("\n");

// ── 1. push runs only on main, and pull_request is untouched ────────────────

for (const { file, dispatch } of GOVERNED) {
  const doc = docs.get(file);
  if (!doc) continue;
  const on = doc.on;
  check(on && typeof on === "object", `${file}: no \`on:\` mapping`);
  if (!on || typeof on !== "object") continue;

  check("push" in on, `${file}: lost its \`push\` trigger, so \`main\` is no longer verified directly`);
  check("pull_request" in on, `${file}: lost its \`pull_request\` trigger, so branch work is no longer gated`);

  const push = on.push;
  const branches = push && typeof push === "object" ? push.branches : undefined;
  check(
    Array.isArray(branches) && branches.length === 1 && branches[0] === "main",
    `${file}: \`push.branches\` is ${JSON.stringify(branches)}, want exactly ["main"]. `
    + `Without it a branch push and its pull request both run this workflow against the same `
    + `tree — two identical runs per commit, both green, and nothing reports the duplicate.`,
  );

  // The path filters decide what this workflow can SEE. They are cumulative
  // between the two events by construction (web.yml and native-web-pairing.yml
  // share one anchored list), and narrowing either one silently stops a tree
  // from triggering its own gate.
  const pushPaths = push && typeof push === "object" ? (push.paths ?? null) : null;
  const prPaths = on.pull_request && typeof on.pull_request === "object"
    ? (on.pull_request.paths ?? null)
    : null;
  const same = JSON.stringify(pushPaths) === JSON.stringify(prPaths);
  check(
    same,
    `${file}: \`push.paths\` and \`pull_request.paths\` differ (${JSON.stringify(pushPaths)} vs `
    + `${JSON.stringify(prPaths)}). A change must trigger the same checks on a pull request as `
    + `on main, or a gate that passes on the branch is simply not run after the merge.`,
  );

  check(
    ("workflow_dispatch" in on) === dispatch,
    `${file}: workflow_dispatch is ${"workflow_dispatch" in on ? "present" : "absent"}, `
    + `want ${dispatch ? "present" : "absent"}`,
  );

  check(
    !("schedule" in on),
    `${file}: gained a \`schedule\` trigger. Scheduled runs of a gating workflow burn runners `
    + `on a tree nobody changed; put the scheduled lane in its own workflow.`,
  );
}

// ── 2. concurrency: PR number, run_id for everything else ───────────────────

for (const file of files) {
  const doc = docs.get(file);
  if (!doc) continue;
  const group = doc.concurrency?.group;
  const cancel = doc.concurrency?.["cancel-in-progress"];

  check(
    group === GROUP,
    `${file}: concurrency.group is ${JSON.stringify(group)}, want ${JSON.stringify(GROUP)}.`,
  );
  check(
    cancel === CANCEL,
    `${file}: concurrency.cancel-in-progress is ${JSON.stringify(cancel)}, want `
    + `${JSON.stringify(CANCEL)} — only a pull request may supersede its own earlier run.`,
  );
  // Stated separately from the equality check above so the reason survives a
  // future edit that reformats the expression.
  check(
    typeof group !== "string" || !group.includes("github.ref"),
    `${file}: concurrency.group keys on \`github.ref\`. Every \`main\` run then shares one `
    + `group, and GitHub cancels an older PENDING run in a group even with `
    + `cancel-in-progress: false — so a quick second merge silently cancels the first `
    + `commit's verification and main shows a cancelled check for untested code.`,
  );
  check(
    typeof group !== "string" || group.includes("github.run_id"),
    `${file}: concurrency.group has no \`github.run_id\` fallback, so non-PR events share a `
    + `group and can cancel one another.`,
  );
}

// ── 3. the account race lane is sharded, and the shards really run ──────────

const go = docs.get("go.yml");
if (go) {
  const shardJobs = Object.entries(go.jobs ?? {}).filter(
    ([, job]) => job?.strategy?.matrix?.shard !== undefined,
  );
  check(
    shardJobs.length === 1,
    `go.yml: expected exactly one job with a \`strategy.matrix.shard\`; found ${shardJobs.length}. `
    + `That matrix is the only thing splitting the ~43m35s account race lane into finite pieces.`,
  );

  if (shardJobs.length === 1) {
    const [name, job] = shardJobs[0];
    const shard = job.strategy.matrix.shard;
    check(
      Array.isArray(shard) && shard.length === SHARDS
        && shard.map(String).join(",") === Array.from({ length: SHARDS }, (_, k) => k).join(","),
      `go.yml/${name}: matrix.shard is ${JSON.stringify(shard)}, want 0..${SHARDS - 1}. `
      + `A missing index is a set of tests that silently stops being race-checked.`,
    );
    check(
      job.strategy["fail-fast"] === "false",
      `go.yml/${name}: strategy.fail-fast is ${JSON.stringify(job.strategy["fail-fast"])}, want false — `
      + `one shard reporting a race must not cancel the other seven and leave them unknown.`,
    );

    const text = runText(job);
    check(
      text.includes(SHARD_HELPER),
      `go.yml/${name}: no longer invokes ${SHARD_HELPER}, which is what proves the eight shards `
      + `partition the test list exactly.`,
    );
    check(
      /-shards\s+8/.test(text) && /-shard\s+'?\$\{\{\s*matrix\.shard/.test(text),
      `go.yml/${name}: does not pass \`-shards 8\` and the matrix index to ${SHARD_HELPER}, so `
      + `every shard would run the same tests.`,
    );
    check(
      /go test .*-race/.test(text) && /-run\s+"\$RUN_REGEX"/.test(text),
      `go.yml/${name}: does not run \`go test -race\` restricted to the shard's \`-run\` regex.`,
    );
    assertNoRetryAndFiniteTimeouts("go.yml", name, job, text);
  }

  // The other half of ./... — everything the shards do not cover.
  const restJobs = Object.entries(go.jobs ?? {}).filter(([jobName, job]) => {
    const text = runText(job);
    return jobName !== shardJobs[0]?.[0] && /go test .*-race/.test(text);
  });
  check(
    restJobs.length === 1,
    `go.yml: expected exactly one non-account race job; found ${restJobs.length}. Without it every `
    + `package outside server/account stops being race-checked, and the board stays green.`,
  );
  if (restJobs.length === 1) {
    const [name, job] = restJobs[0];
    const text = runText(job);
    check(
      text.includes("go list ./..."),
      `go.yml/${name}: does not enumerate packages with \`go list ./...\`, so a newly added package `
      + `would not be race-checked until someone remembered to add it.`,
    );
    check(
      text.includes(`grep -v '^${ACCOUNT_PKG}$'`),
      `go.yml/${name}: does not exclude exactly \`${ACCOUNT_PKG}\`. An unanchored or broader `
      + `exclusion would also drop a future account/... subpackage from every race lane.`,
    );
    assertNoRetryAndFiniteTimeouts("go.yml", name, job, text);
  }
}

/**
 * A race lane must be bounded and must not be allowed to try again. A retry
 * turns an intermittent race — the only kind the detector usually finds — into
 * a rerun that passes, and `continue-on-error` turns the whole lane advisory.
 */
function assertNoRetryAndFiniteTimeouts(file, name, job, text) {
  const timeout = Number(job["timeout-minutes"]);
  check(
    Number.isFinite(timeout) && timeout > 0,
    `${file}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a finite `
    + `positive number. An unbounded race job hangs for GitHub's 6-hour default.`,
  );
  check(
    /-timeout\s+\d+[ms]/.test(text),
    `${file}/${name}: the go test command has no finite \`-timeout\`, so Go's 10-minute default `
    + `per-package bound applies and reports as a test failure with a goroutine dump.`,
  );
  check(
    /-count=1/.test(text),
    `${file}/${name}: the go test command dropped \`-count=1\`, so a cached PASS can stand in for `
    + `a run that never happened.`,
  );
  check(
    !/retry|retries/i.test(text),
    `${file}/${name}: a retry appeared in the race command. A flaky race lane is a real timing `
    + `assumption; rerunning it until it passes deletes the only evidence.`,
  );
  check(
    job["continue-on-error"] === undefined,
    `${file}/${name}: continue-on-error makes this race lane advisory rather than a gate.`,
  );
  for (const step of job.steps ?? []) {
    check(
      step["continue-on-error"] === undefined,
      `${file}/${name}: a step sets continue-on-error, which lets the race lane report green `
      + `after failing.`,
    );
  }
}

// ── 4. the nightly serial lane exists, and is not a gate ────────────────────

const nightly = docs.get(NIGHTLY);
if (nightly) {
  const on = nightly.on ?? {};
  check(
    "schedule" in on && "workflow_dispatch" in on,
    `${NIGHTLY}: must run on \`schedule\` and \`workflow_dispatch\`; found ${JSON.stringify(Object.keys(on))}.`,
  );
  check(
    !("push" in on) && !("pull_request" in on),
    `${NIGHTLY}: gained a \`push\` or \`pull_request\` trigger. This is the full ~44 minute serial `
    + `account race that the eight-way split replaced — making it gating again puts that wait back `
    + `in front of every change, which is the entire thing the split was for.`,
  );

  const jobs = Object.entries(nightly.jobs ?? {});
  check(jobs.length >= 1, `${NIGHTLY}: has no jobs`);
  const text = jobs.map(([, job]) => runText(job)).join("\n");
  check(
    /-shuffle=on/.test(text),
    `${NIGHTLY}: lost \`-shuffle=on\`. Running the package in a fixed order is what the shards `
    + `already do; the shuffle is the only thing here that can surface a test that passes only `
    + `because of what ran before it.`,
  );
  check(
    /-count=1/.test(text) && !/-run\s/.test(text),
    `${NIGHTLY}: must run the WHOLE account package with -count=1 and no \`-run\` filter — a `
    + `filtered serial run cannot see cross-test state either.`,
  );
  check(
    /\.\/account\b/.test(text),
    `${NIGHTLY}: does not run ./account`,
  );
  check(
    !/retry|retries/i.test(text),
    `${NIGHTLY}: a retry appeared. An ordering-dependent failure that is retried away is exactly `
    + `the defect this lane exists to report.`,
  );
  for (const [name, job] of jobs) {
    const timeout = Number(job["timeout-minutes"]);
    check(
      Number.isFinite(timeout) && timeout > 0,
      `${NIGHTLY}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a `
      + `finite positive number.`,
    );
  }
}

// ── 5. the native split, and the path boundaries that make it real ──────────
//
// macOS and iOS shared one workflow file. `macos.yml` carried an `ios-build`
// job — two iOS xcodebuilds, an iOS UI smoke and three acceptance runs — behind
// a filter of `apps/**` plus `scripts/**`. The consequence was not a broken
// build but a permanently mis-sized one: every macOS-only change started an iOS
// runner, every iOS-only change started the macOS signing lane, and a Go-shard
// or release-script edit started both.
//
// The split is a FILE split because it had to be. A path filter is per-workflow:
// no arrangement of jobs, `if:` conditions or matrices inside one file can make
// two platforms trigger on different trees. So the correction is only real if
// two things stay true together — the jobs live in the right file, AND each
// file's filter actually selects its own platform. Either one alone is
// cosmetic, and both are invisible to YAML validity, actionlint and every other
// check in this repository.
//
// The failure this section exists to name out loud is the regression, not the
// abstraction: `ios-build` reappearing in `macos.yml`, or one native filter
// growing back to `apps/**`.

const MACOS = "macos.yml";
const IOS = "ios.yml";
const SHARED_KIT = "apps/RelayiumKit/**";
const IOS_PROJECT = "-project apps/ios/Relayium.xcodeproj";
const MACOS_PROJECT = "-project apps/mac/Relayium.xcodeproj";

/**
 * A GitHub path filter compiled to a regular expression.
 *
 * `**` crosses `/`, a single `*` does not, and everything else is literal —
 * which is what makes `server/account/deviceinbox*` in web.yml match
 * `deviceinbox.go` but not a file in a subdirectory. Every regex
 * metacharacter is escaped, so `.github/workflows/go.yml` cannot match
 * `xgithub/workflows/go.yml` through an unescaped dot.
 */
function pathFilterToRegExp(pattern) {
  let re = "";
  for (let k = 0; k < pattern.length; k += 1) {
    const ch = pattern[k];
    if (ch === "*") {
      if (pattern[k + 1] === "*") { re += "[\\s\\S]*"; k += 1; } else { re += "[^/]*"; }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

const matchesFilter = (patterns, path) =>
  patterns.some((pattern) => pathFilterToRegExp(pattern).test(path));

/** The `push` path filter of a governed workflow, or null when it has none. */
function pathsOf(file) {
  const push = docs.get(file)?.on?.push;
  const paths = push && typeof push === "object" ? push.paths : undefined;
  return Array.isArray(paths) ? paths : null;
}

/**
 * A job with the whole-line shell comments inside its `run:` block scalars
 * removed.
 *
 * The YAML parser above already drops YAML comments, but a `run: |` block is a
 * SCALAR: everything indented under it survives verbatim, shell comments
 * included. So a job that merely explains a command owns it as far as a text
 * search is concerned, and every ownership question in this file is a text
 * search — `-project apps/mac/Relayium.xcodeproj` written inside a `# was:`
 * line in ios.yml would report macOS as having two heavy owners, which is a
 * red board for a workflow that builds nothing of the sort. It fails the other
 * way too: the real command deleted and its rationale left behind reads as a
 * platform still being built.
 *
 * These jobs comment themselves at length and name the commands they are
 * explaining, so this is not hypothetical tidiness — it is the difference
 * between asserting the code and agreeing with the prose.
 */
function withoutRunComments(job) {
  const copy = structuredClone(job ?? null);
  for (const step of copy?.steps ?? []) {
    if (typeof step?.run !== "string") continue;
    step.run = step.run.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  }
  return copy;
}

/** Everything a job actually executes or configures, comments excluded. */
const jobBodies = (file) => Object.entries(docs.get(file)?.jobs ?? {})
  .map(([name, job]) => [name, JSON.stringify(withoutRunComments(job))]);

const workflowBody = (file) => jobBodies(file).map(([, body]) => body).join("\n");

// 5a. The regression, named. A job key is the one thing a reader greps for and
//     the one thing a careless revert restores wholesale.
if (docs.get(MACOS)) {
  check(
    !("ios-build" in (docs.get(MACOS).jobs ?? {})),
    `${MACOS} contains an \`ios-build\` job again. That job is iOS work — two iOS xcodebuilds, `
    + `the iOS UI smoke and the local/built-App acceptance — and it belongs to ${IOS}. While it `
    + `lives here, macOS and iOS share one path filter and one set of triggers, so the two `
    + `platforms cannot be started independently no matter what the filter says.`,
  );
}

// 5b. And the same regression arriving under a different job name. The name is
//     a convention; compiling the iOS project is the fact.
if (docs.get(MACOS)) {
  const offenders = jobBodies(MACOS)
    .filter(([, body]) => body.includes("apps/ios/"))
    .map(([name]) => name);
  check(
    offenders.length === 0,
    `${MACOS} job(s) ${offenders.join(", ")} reference \`apps/ios/\`. Renaming \`ios-build\` does `
    + `not separate the platforms; hosting ANY iOS build, test or acceptance in the macOS `
    + `workflow puts it back behind the macOS triggers.`,
  );
}
if (docs.get(IOS)) {
  const offenders = jobBodies(IOS)
    .filter(([, body]) => body.includes("apps/mac/"))
    .map(([name]) => name);
  check(
    offenders.length === 0,
    `${IOS} job(s) ${offenders.join(", ")} reference \`apps/mac/\`. The iOS workflow must contain `
    + `only iOS-relevant jobs, or the split is one-directional and macOS work runs twice.`,
  );
}

// 5c. Moved, not copied. A "split" that leaves the old job in place doubles the
//     cost of the exact change it was meant to make cheaper, and both runs are
//     green so nothing reports it.
for (const [marker, home, what] of [
  [IOS_PROJECT, IOS, "the iOS app build"],
  [MACOS_PROJECT, MACOS, "the macOS app build"],
]) {
  const hosts = GOVERNED.map((g) => g.file).filter((file) => workflowBody(file).includes(marker));
  check(
    hosts.length === 1 && hosts[0] === home,
    `${what} (\`${marker}\`) runs in ${hosts.length ? hosts.join(", ") : "no governed workflow"}; `
    + `want exactly ${home}. Two hosts is a duplicated macOS runner and no new evidence; zero is `
    + `a platform that stopped being built at all.`,
  );
}

// 5d. The shared package is the one tree that must start BOTH. It is what each
//     app compiles against, and a change there can break either one alone —
//     which is precisely what a per-platform split risks losing.
for (const file of [MACOS, IOS]) {
  const paths = pathsOf(file);
  if (paths === null) continue;
  check(
    paths.includes(SHARED_KIT),
    `${file}'s path filter does not list \`${SHARED_KIT}\`. RelayiumKit is shared source: a change `
    + `there compiles into both native apps, so it must start both native workflows. Dropping it `
    + `from one leaves that app's compatibility with the shared package unproven until something `
    + `else happens to touch it.`,
  );
}

// 5e. And the boundary in the other direction, asserted on the FILTER rather
//     than on the list, so a coarse `apps/**` fails here even though it "looks
//     like" it contains the right trees.
if (pathsOf(MACOS)) {
  check(
    !matchesFilter(pathsOf(MACOS), "apps/ios/Relayium/RelayiumApp.swift"),
    `${MACOS}'s path filter matches iOS-only source. An iOS change would start the macOS signing `
    + `lane — the certificate import, the notarization-capable jobs, the UI smoke — for a tree `
    + `none of them build. This is what \`apps/**\` did before the split.`,
  );
}
if (pathsOf(IOS)) {
  check(
    !matchesFilter(pathsOf(IOS), "apps/mac/Relayium/AccountView.swift"),
    `${IOS}'s path filter matches macOS-only source, so a macOS change starts an iOS runner that `
    + `builds nothing it changed.`,
  );
}

// 5f. Each filtered workflow must be able to see edits to ITSELF. Without this,
//     a change to a workflow's own triggers is merged having never run under
//     them.
for (const { file } of GOVERNED) {
  const paths = pathsOf(file);
  if (paths === null) continue;
  check(
    matchesFilter(paths, `.github/workflows/${file}`),
    `${file}'s path filter does not match \`.github/workflows/${file}\`, so an edit to this `
    + `workflow does not run this workflow and lands unverified.`,
  );
}

// 5g. The whole trigger matrix, as behaviour rather than as a list of globs.
//
// Each row is a real file and the exact set of governed, path-filtered
// workflows that must start for it. Asserting the SET is what catches a filter
// that is too broad and one that is too narrow with the same check — a list
// comparison only ever catches the edit somebody already thought about.
//
// Workflows with no path filter are excluded and asserted separately below;
// they run on everything by construction, so including them would make every
// row say the same thing.
//
// The matrix is evaluated against a WORLD rather than against module state, for
// the same reason section 6 is: section 7 hands it a mutated copy of the real
// workflows and requires the matching row to complain. A row asserted only
// against the checked-in filters is a row nobody has ever seen fail, and the
// most expensive thing in this file is a check that passes because it cannot
// fail. The real-world call sits next to section 6's, just above section 7.
const PATH_MATRIX = [
  ["server/account/pairroom.go", ["go.yml", "native-web-pairing.yml"],
    "server-only: no native runner may start"],
  ["server/go.mod", ["go.yml", "native-web-pairing.yml"],
    "the server module: still not a native trigger"],
  ["web/src/lib/pair.ts", ["native-web-pairing.yml", "web.yml"],
    "web-only: no native runner may start"],
  ["apps/mac/Relayium/AccountView.swift", ["macos.yml"],
    "macOS-only source: no iOS runner, and no pairing runner either. The acceptance builds "
    + "`server` and `apps/RelayiumKit` and serves the Web bundle; it never reads, compiles or "
    + "serves a file under apps/mac, so watching this tree would buy a 45-minute macOS runner "
    + "for evidence the run cannot produce. The app's logic lives in apps/RelayiumKit, which the "
    + "pairing filter does name"],
  ["apps/mac/scripts/package-dmg.sh", ["macos.yml"],
    "a macOS release script the macOS `test` job runs: macOS, not iOS, and not the pairing "
    + "acceptance, which does not package a DMG"],
  ["apps/ios/Relayium/RelayiumApp.swift", ["ios.yml"],
    "iOS-only source: no macOS signing lane, and — since the pairing filter was narrowed off "
    + "`apps/**` — no 45-minute macOS pairing runner either. That acceptance builds "
    + "apps/RelayiumKit and the Web bundle; nothing under apps/ios is an input to it"],
  ["apps/RelayiumKit/Sources/RelayiumKit/Crypto/SealedBox.swift",
    ["ios.yml", "macos.yml", "native-web-pairing.yml"],
    "SHARED source: both native workflows, or one app's break goes unseen"],
  ["scripts/ios-ui-session-acceptance.sh", ["ios.yml"],
    "the iOS built-App acceptance: the workflow that runs it, and only that one. The pairing "
    + "workflow does not source this script, and `scripts/**` is gone from its filter"],
  ["scripts/lib/local-acceptance.sh", ["ios.yml", "native-web-pairing.yml"],
    "the isolation library those acceptance runs are built from"],
  ["scripts/local-transfer-cleanup-test.sh", ["ios.yml"],
    "the launcher's own failure-path test, run by the iOS job and by nothing else"],
  ["scripts/go-race-shard.go", ["go.yml"],
    "a Go helper: it used to start the macOS signing lane through `scripts/**`, and then the "
    + "macOS pairing runner through the same glob in the pairing filter. Both are gone"],
  ["scripts/native-web-pairing-acceptance.sh", ["native-web-pairing.yml"],
    "the acceptance script itself: named one file at a time, so it starts its own workflow and "
    + "no other"],
  [".github/workflows/macos.yml", ["macos.yml"], "a workflow edit starts its own workflow only"],
  [".github/workflows/ios.yml", ["ios.yml"], "and the same for the new one"],
  [".github/workflows/go.yml", ["go.yml"], "and for an unrelated one"],
  ["apps/README.md", [],
    "documentation under apps/: not an input to any native build and not an input to the "
    + "pairing acceptance either, so NO path-filtered workflow starts. `apps/**` in the pairing "
    + "filter matched it only because it was coarse"],
  ["apps/android/app/src/main/kotlin/Main.kt", [],
    "a platform root that does not exist yet: no current workflow may adopt it. This is the "
    + "whole point of removing `apps/**` — the day somebody creates this file, the ONLY thing "
    + "that runs is what its own new workflow says, plus the unfiltered always-on gates"],
  ["apps/windows/Relayium/App.xaml.cs", [],
    "the same, for the other plausible future root"],
  ["scripts/android-emulator-acceptance.sh", [],
    "a future Android script: `scripts/**` in a macOS-runner workflow is how it would have "
    + "inherited a macOS runner without anybody choosing that"],
  ["scripts/windows-package.ps1", [],
    "and the same for a future Windows packaging script"],
  ["docs/billing-transparency.md", ["web.yml"],
    "a document that is TEST INPUT, which is why it is not in the empty-set group above. "
    + "`web/scripts/pages/billing-doc-pointers.test.mjs` reads this file and asserts every "
    + "`symbol` (`path:line`) pointer in it still resolves, and that test runs inside web.yml's "
    + "`npm test` step — so the document is an input to that suite exactly like a source file, "
    + "and an edit to it must start the suite that judges it. Exactly web.yml and nothing else: "
    + "no other governed workflow runs that test. Named one file at a time rather than through "
    + "`docs/**`, which would start the full web suite, the accessibility scan and three "
    + "headless-Chrome journeys for every unrelated document in the repository"],
];

/**
 * Every trigger-matrix disagreement about one world, as messages.
 *
 * Mirrors `platformBoundaryFailures`: it returns rather than pushes, so the
 * real world's messages become failures at the call site and section 7 can
 * assert that a specific mutation produces a specific row's complaint.
 */
function pathMatrixFailures(world) {
  const out = [];
  const filtered = world.governed
    .map((entry) => entry.file)
    .filter((file) => wPaths(world, file) !== null);
  for (const [path, want, why] of PATH_MATRIX) {
    const got = filtered.filter((file) => matchesFilter(wPaths(world, file), path)).sort();
    if (deepEqual(got, [...want].sort())) continue;
    out.push(
      `changing "${path}" starts [${got.join(", ")}]; want [${want.join(", ")}] — ${why}.`,
    );
  }
  return out;
}

// The matrix above only means what it says if the excluded workflows really are
// the unfiltered ones. `repo-hygiene.yml` is deliberately unfiltered: it hosts
// this guard and the other cross-cutting ones, which must run on every change.
// Only files that actually parsed are judged here: a workflow reported missing
// above has no filter to have lost, and saying so twice buries the real cause.
const unfiltered = GOVERNED.map((g) => g.file)
  .filter((file) => docs.has(file) && pathsOf(file) === null);
check(
  deepEqual(unfiltered, ["compat.yml", "repo-hygiene.yml"]),
  `the set of governed workflows with NO push path filter is [${unfiltered.join(", ")}], want `
  + `[compat.yml, repo-hygiene.yml]. Both are unfiltered ON PURPOSE and for the same reason — `
  + `repo-hygiene hosts the cross-cutting guards, compat hosts the wire-compatibility contract `
  + `every platform must pass — and both must therefore run on every change. A THIRD entry is a `
  + `workflow that lost its filter and now runs on every change, including the macOS signing `
  + `lane on a documentation edit; a MISSING entry is a gate that a new platform root can `
  + `bypass by existing. Either way the matrix above stops covering it.`,
);

// ── 6. platform roots, their owners, and the always-on compatibility gate ───
//
// Section 5 separated macOS from iOS. This section states the RULE that split
// was an instance of, so the next platform cannot re-create the same defect by
// simply existing.
//
//   * A platform root (`apps/mac`, `apps/ios`, one day `apps/android` or
//     `apps/windows`) has exactly ONE heavy owner: the workflow that builds,
//     tests, signs and releases it. Nothing else may start a heavy build from
//     that root.
//   * `apps/RelayiumKit` is APPLE-SHARED, not cross-platform. It is Swift and it
//     links WebRTC and Sodium through SwiftPM, so it fans out to macOS AND iOS
//     deliberately — and to nothing else.
//   * A truly cross-platform contract — the cross-language wire vectors — is a
//     FAST gate and lives in `compat.yml`, which has no path filter at all, so
//     every platform present and future has to pass it. Unfiltered and
//     fail-closed is what this file asserts; making a red result block a merge
//     is branch protection (`compat / wire-vectors`) and is not asserted here.
//   * A workflow may watch a tree it does not own only when that tree is a real
//     INPUT — something the run reads, compiles or serves. `apps/mac/**` is the
//     worked example in the other direction: `native-web-pairing.yml` speaks FOR
//     the macOS app, builds `apps/RelayiumKit` and `server` and serves the Web
//     bundle, and never reads a file under `apps/mac/`, so it does not watch it.
//   * A future platform root and the workflow that owns it are created in the
//     SAME commit. A root with no workflow is source nothing compiles; a
//     workflow with no root is a placeholder reporting a green check for a
//     platform that does not exist, which reads as coverage and is not.
//
// All of it is invisible to YAML validity and to actionlint: a filter widened
// back to `apps/**` is valid, a placeholder `echo` job is valid, and
// `continue-on-error: true` on the compatibility gate is valid. Section 7 then
// mutates the parsed workflows to prove every assertion here can actually fail,
// because a policy check that cannot fail is the most expensive kind of green.
//
// `docs/CI-PLATFORM-BOUNDARY.md` is the prose. This is the enforcement.

const COMPAT = "compat.yml";
const NWP = "native-web-pairing.yml";
const SHARED_APPLE_ROOT = "apps/RelayiumKit";
const SHARED_APPLE_SAMPLE = "apps/RelayiumKit/Sources/RelayiumKit/Crypto/SealedBox.swift";
const VECTOR_COMMAND = "npm run test:vectors";
const VECTOR_WRITER = "gen:vectors";

/**
 * The job key `compat.yml` declares — and therefore the second half of the
 * required status context `compat / wire-vectors`, which GitHub renders as the
 * workflow's `name:` and the job key joined.
 *
 * It is a constant here because section 6j asserts BOTH directions of it: that
 * `compat.yml` still declares this exact name, and that nothing else in this
 * repository declares it too.
 */
const COMPAT_JOB = "wire-vectors";

const RELEASE = "release.yml";

/**
 * The commit-message escape that used to live in `ios.yml`, and the general
 * shape of it.
 *
 * `[macos-only]` in a `main` commit message skipped the iOS build outright. The
 * literal marker is rejected so it cannot come back verbatim; the regexp is
 * rejected so it cannot come back as `[skip-ios]`, `[no-ci]` or any other
 * spelling of "let whoever writes the commit decide whether the gate runs".
 */
const SKIP_MARKER = "[macos-only]";
const COMMIT_MESSAGE_CONDITION = /head_commit|event\.commits|\.message\b/;

/**
 * The two most expensive lanes, and what a job in each is allowed to cost.
 *
 * `max` is asserted in BOTH directions for the same reason the self-host bound
 * is: absent, a job inherits GitHub's six-hour default; declared at some large
 * number, it is that same default wearing a disguise. The ceilings sit above
 * the real bounds these files carry, so a deliberate adjustment is possible and
 * a six-hour "bound" is not.
 */
const RUNNER_BUDGETS = [
  {
    file: IOS,
    max: 90,
    why: "a PAID macOS runner is held by a build that will never finish — a simulator that never "
      + "boots, an acceptance child that never exits",
  },
  {
    file: RELEASE,
    max: 60,
    why: "a wedged release job holds a runner with the release signing key materialized on disk",
  },
];

/** This file, and the unfiltered workflow that has to execute it. */
const SELF_TEST = "scripts/test/ci-event-policy-test.mjs";
const SELF_HOST = "repo-hygiene.yml";
const SELF_COMMAND = `node ${SELF_TEST}`;
/** Minutes. This file parses a handful of small YAML documents; it needs seconds. */
const SELF_TIMEOUT_MAX = 10;

/** The platform roots that exist today, and the one workflow that owns each. */
const PLATFORM_OWNERS = [
  {
    label: "macOS",
    root: "apps/mac",
    workflow: MACOS,
    marker: MACOS_PROJECT,
    sample: "apps/mac/Relayium/AccountView.swift",
  },
  {
    label: "iOS",
    root: "apps/ios",
    workflow: IOS,
    marker: IOS_PROJECT,
    sample: "apps/ios/Relayium/RelayiumApp.swift",
  },
];

/**
 * The platform roots that do NOT exist yet, named here on purpose.
 *
 * Naming them is what turns "nothing to check" into a checkable rule: today the
 * assertion is that neither the root nor its workflow exists, and the moment
 * either appears alone this file says so. `build` is the evidence that the
 * workflow does real work rather than echoing — the one property a placeholder
 * cannot fake without becoming a real build.
 */
const FUTURE_PLATFORMS = [
  {
    label: "Android",
    root: "apps/android",
    workflow: "android.yml",
    sample: "apps/android/app/src/main/kotlin/Main.kt",
    build: /gradlew|gradle\b|sdkmanager|kotlinc|\badb\b/,
  },
  {
    label: "Windows",
    root: "apps/windows",
    workflow: "windows.yml",
    sample: "apps/windows/Relayium/App.xaml.cs",
    build: /msbuild|dotnet\s|cargo\s|cmake\b|signtool|Invoke-Pester/,
  },
];

/** Every workflow file on disk, with whole-line comments removed. */
const stripComments = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
const workflowTexts = new Map(
  readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, stripComments(readFileSync(resolve(workflowsDir, name), "utf8"))]),
);

/**
 * The directories directly under `apps/`, read from disk rather than listed.
 *
 * This is what makes the future-platform rule non-vacuous: the day somebody
 * runs `mkdir apps/android`, this set changes and the checks below have
 * something to disagree with. A hard-coded list could not notice.
 */
const appRoots = (() => {
  try {
    return readdirSync(resolve(repoRoot, "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `apps/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
})();

/**
 * Everything the checks below read, in one mutable value.
 *
 * Section 7 hands them a MODIFIED copy of this and requires them to complain,
 * which is only possible because they read a world rather than module state.
 */
function realWorld() {
  return {
    governed: GOVERNED.map((entry) => ({ ...entry })),
    docs: new Map([...docs].map(([file, doc]) => [file, structuredClone(doc)])),
    texts: new Map(workflowTexts),
    roots: new Set(appRoots),
  };
}

const wPaths = (world, file) => {
  const push = world.docs.get(file)?.on?.push;
  const paths = push && typeof push === "object" ? push.paths : undefined;
  return Array.isArray(paths) ? paths : null;
};

/** Would a change to `path` start `file`? Compiled globs, not list membership. */
const wTriggers = (world, file, path) => {
  const paths = wPaths(world, file);
  if (paths === null) return world.docs.has(file); // no filter: everything starts it
  return matchesFilter(paths, path);
};

// Comments stripped for the same reason as in `jobBodies`: ownership is a
// property of the command, not of the sentence next to it.
const wJobBody = (world, file) =>
  JSON.stringify(Object.values(world.docs.get(file)?.jobs ?? {}).map(withoutRunComments));

/**
 * The job keys a workflow file declares — for EVERY workflow file on disk, not
 * only the parsed ones.
 *
 * A parsed document is authoritative wherever one exists. For every other file
 * the keys are read structurally from the comment-stripped source: the `jobs:`
 * mapping at column 0, then the keys at the first indentation level under it,
 * stopping at the next top-level key. Deeper lines — a step's `name:`, a `run:`
 * block scalar's contents — sit at a greater indent and are skipped by the
 * equality test, so a command that happens to contain `wire-vectors:` cannot be
 * mistaken for a job.
 *
 * Reading the text rather than parsing every file is deliberate. The parser in
 * this file covers the subset the GOVERNED workflows use and THROWS on anything
 * it does not understand, so parsing all ten workflows to look up one name would
 * turn an unrelated construct in an unrelated workflow — `auto-release.yml`
 * today, anything added tomorrow — into a policy failure with nothing wrong.
 * Job-name collision does not need a governed workflow to happen in, so the
 * lookup must not need one either.
 */
function jobKeysOf(world, file) {
  const doc = world.docs.get(file);
  if (doc) return Object.keys(doc.jobs ?? {});
  const text = world.texts.get(file);
  if (text === undefined) return [];
  const keys = [];
  let indent = null;
  let inJobs = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs mapping
    const match = /^(\s+)([A-Za-z0-9_][\w.-]*):/.exec(line);
    if (!match) continue;
    if (indent === null) indent = match[1].length;
    if (match[1].length === indent) keys.push(match[2]);
  }
  return keys;
}

/**
 * The run lines of a job that are actual work.
 *
 * A placeholder job is syntactically a job: it has a runner, a timeout and a
 * step. What it does not have is a command, and `echo`/`true`/`exit 0` is how
 * one is written. Everything else counts, so this cannot be satisfied by
 * commenting the real command out either.
 */
function realRunLines(job) {
  return (job?.steps ?? [])
    .flatMap((step) => String(step?.run ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => !/^(echo\b|printf\b|true$|:$|exit 0$|set\s+-|shopt\b)/.test(line));
}

/**
 * Every platform-boundary complaint about one world, as messages.
 *
 * Returning rather than pushing is the whole design: the real world's messages
 * are appended to `failures`, and section 7 asserts that specific mutations
 * produce specific messages.
 */
function platformBoundaryFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const governedFiles = world.governed.map((entry) => entry.file);
  const filtered = governedFiles.filter((file) => wPaths(world, file) !== null);
  const allPlatforms = [...PLATFORM_OWNERS, ...FUTURE_PLATFORMS];

  // 6a. One platform root, one heavy owner — asserted from the build command
  //     rather than from a job name, and from the FILTER rather than from the
  //     path list, so "too broad" and "too narrow" both fail here.
  for (const platform of PLATFORM_OWNERS) {
    const hosts = governedFiles.filter((file) => wJobBody(world, file).includes(platform.marker));
    need(
      hosts.length === 1 && hosts[0] === platform.workflow,
      `platform root ${platform.root}: the ${platform.label} app build (\`${platform.marker}\`) `
      + `runs in [${hosts.join(", ")}]; want exactly [${platform.workflow}]. A platform root has `
      + `exactly one heavy owner — two hosts is a second platform runner per commit and no new `
      + `evidence, zero is a platform that quietly stopped being built.`,
    );
    need(
      wTriggers(world, platform.workflow, platform.sample),
      `platform root ${platform.root}: its owning workflow ${platform.workflow} does not trigger `
      + `on "${platform.sample}". An owner its own root cannot start is not an owner, and the `
      + `platform lands unbuilt with a green board.`,
    );
    for (const other of allPlatforms) {
      if (other.root === platform.root) continue;
      if (!world.docs.has(other.workflow)) continue;
      need(
        !wTriggers(world, other.workflow, platform.sample),
        `platform root ${platform.root} also starts ${other.workflow}, which owns ${other.root}. `
        + `Platform roots do not fan out: a change under ${platform.root} must not start another `
        + `platform's heavy build. This is exactly what a coarse \`apps/**\` filter does, and it `
        + `is what the macOS/iOS split was for.`,
      );
    }
  }

  // 6b. No governed filter may be coarse enough to adopt a root by accident —
  //     stated twice, once as the literal glob a reader greps for and once as
  //     behaviour, because a future `apps/*/**` would pass the literal check.
  for (const file of filtered) {
    const paths = wPaths(world, file);
    for (const bare of ["apps/**", "apps/*", "apps/*/**", "scripts/**", "scripts/*"]) {
      need(
        !paths.includes(bare),
        `${file}'s path filter lists the bare glob \`${bare}\`. It matches trees that are not `
        + `inputs to this workflow today AND every tree somebody adds tomorrow, so the next `
        + `platform root or platform script inherits this runner without anybody choosing that. `
        + `Name the files and directories this workflow actually consumes.`,
      );
    }
    const spanned = allPlatforms.filter((p) => matchesFilter(paths, p.sample)).map((p) => p.root);
    need(
      spanned.length <= 1,
      `${file}'s path filter matches more than one platform root (${spanned.join(", ")}). One `
      + `workflow that starts on two platforms' source cannot be started for one of them alone, `
      + `no matter how its jobs are conditioned — path filters are per-workflow.`,
    );
  }

  // 6c. The Apple-shared package: exactly two owners, and not one more.
  const appleOwners = PLATFORM_OWNERS
    .filter((platform) => wTriggers(world, platform.workflow, SHARED_APPLE_SAMPLE))
    .map((platform) => platform.workflow)
    .sort();
  need(
    deepEqual(appleOwners, [IOS, MACOS].sort()),
    `the Apple-shared package ${SHARED_APPLE_ROOT} fans out to [${appleOwners.join(", ")}]; want `
    + `exactly [${[IOS, MACOS].sort().join(", ")}]. Both native apps compile against it, so a `
    + `change there can break either one alone; dropping it from one filter leaves that app's `
    + `compatibility with the shared package unproven until something else happens to touch it.`,
  );
  for (const platform of PLATFORM_OWNERS) {
    const paths = wPaths(world, platform.workflow);
    if (paths === null) continue;
    need(
      paths.includes(`${SHARED_APPLE_ROOT}/**`),
      `${platform.workflow}'s path filter no longer names \`${SHARED_APPLE_ROOT}/**\`. Stated `
      + `separately from the fan-out check above so the reason survives a filter that happens to `
      + `match the shared package through some broader glob.`,
    );
  }
  for (const future of FUTURE_PLATFORMS) {
    if (!world.docs.has(future.workflow)) continue;
    need(
      !wTriggers(world, future.workflow, SHARED_APPLE_SAMPLE),
      `${future.workflow} triggers on ${SHARED_APPLE_ROOT}. That package is APPLE-SHARED, not `
      + `cross-platform: it is Swift, it links WebRTC and Sodium through SwiftPM, and nothing `
      + `outside macOS and iOS compiles it. A ${future.label} workflow watching it burns a runner `
      + `on every Apple change and proves nothing. Truly cross-platform contracts belong in `
      + `${COMPAT}.`,
    );
  }

  // 6d. The pairing acceptance is a macOS+browser gate, not an iOS one — and
  //     narrowing it past its OWN inputs is asserted in the same place, because
  //     that is the failure a "make the filter smaller" edit actually causes.
  if (world.docs.has(NWP)) {
    const ios = PLATFORM_OWNERS.find((platform) => platform.root === "apps/ios");
    need(
      !wTriggers(world, NWP, ios.sample),
      `${NWP} triggers on ${ios.root}. Its acceptance compiles ${SHARED_APPLE_ROOT} and the Web `
      + `bundle and drives a macOS peer against a real Chrome; no file under ${ios.root} is an `
      + `input to it. An iOS-only change would start a 45-minute macOS runner that builds nothing `
      + `it touched.`,
    );
    // The INPUTS, each of which the run actually reads, compiles or serves.
    // Every entry here was checked against the script rather than against the
    // workflow's own prose: `scripts/native-web-pairing-acceptance.sh` builds
    // `server` and `apps/RelayiumKit` (`swift build --product
    // LocalTransferPeer`) and `vite build`s `web/`, and sources exactly one
    // library. Nothing else is loaded.
    for (const [input, why] of [
      [SHARED_APPLE_SAMPLE, "the Swift half it actually compiles"],
      ["web/src/lib/pair.ts", "the browser half's own pairing code"],
      ["server/account/pairroom.go", "the real hub the two clients meet on"],
      ["scripts/native-web-pairing-acceptance.sh", "the acceptance script itself"],
      ["scripts/lib/local-acceptance.sh", "the isolation library that script sources"],
    ]) {
      need(
        wTriggers(world, NWP, input),
        `${NWP} no longer triggers on "${input}" — ${why}. Narrowing a filter past the run's own `
        + `inputs disables the gate as effectively as deleting the step, and is cheaper to do by `
        + `accident.`,
      );
    }
    // And the tree that is NOT an input, stated in the same place, because the
    // two errors are one decision made in opposite directions and a file that
    // only asserted the narrowing would invite the widening.
    //
    // `apps/mac/**` is what this acceptance SPEAKS FOR and is still not what it
    // reads: the app target is SwiftUI views over `RelayiumAppKit`, which lives
    // under `apps/RelayiumKit/**` and IS watched above. An apps/mac-only change
    // must therefore start `macos.yml` — plus the two unfiltered always-on
    // workflows — and no 45-minute macOS pairing runner.
    const mac = PLATFORM_OWNERS.find((platform) => platform.root === "apps/mac");
    need(
      !wTriggers(world, NWP, mac.sample),
      `${NWP} triggers on ${mac.root} ("${mac.sample}"), which is not an input to it. The `
      + `acceptance builds \`server\` and ${SHARED_APPLE_ROOT} and serves the Web bundle; no file `
      + `under ${mac.root} is read, compiled or served by the run, so this filter charges a `
      + `45-minute macOS runner per commit for evidence it cannot produce. The macOS app's own `
      + `logic is in ${SHARED_APPLE_ROOT}, which this filter already names.`,
    );
  }

  // 6e. Absence or completeness, for the roots that do not exist yet.
  const known = new Set([
    ...PLATFORM_OWNERS.map((platform) => platform.root),
    ...FUTURE_PLATFORMS.map((future) => future.root),
    SHARED_APPLE_ROOT,
  ]);
  for (const root of [...world.roots].sort()) {
    need(
      known.has(root),
      `unknown platform root "${root}" exists under apps/. Every root is either a platform with `
      + `exactly one owning workflow or the Apple-shared package; a root this policy has never `
      + `heard of is source with no declared owner, no declared filter and no declared release `
      + `pipeline. Add it to PLATFORM_OWNERS or FUTURE_PLATFORMS in the same commit that creates `
      + `it, together with the workflow that builds it.`,
    );
  }
  for (const future of FUTURE_PLATFORMS) {
    const rootExists = world.roots.has(future.root);
    const workflowExists = world.texts.has(future.workflow);

    need(
      !(rootExists && !workflowExists),
      `${future.root}/ exists but .github/workflows/${future.workflow} does not. A platform root `
      + `and the workflow that owns it are created in the SAME commit: until then nothing `
      + `compiles, tests or signs that source, and the board is green only because nobody asked.`,
    );
    need(
      !(workflowExists && !rootExists),
      `.github/workflows/${future.workflow} exists but ${future.root}/ does not. A platform `
      + `workflow with no real source is a placeholder — it reports a green ${future.label} check `
      + `for a platform that does not exist, which is worse than an absent check because it looks `
      + `like coverage.`,
    );
    if (!rootExists || !workflowExists) continue;

    need(
      world.governed.some((entry) => entry.file === future.workflow),
      `${future.workflow} exists but is not in this test's GOVERNED list, so the push/pull_request `
      + `and concurrency policy above does not bind it — it may run twice per commit, or cancel a `
      + `\`main\` run, and nothing would say so. Add it there in the same commit.`,
    );
    const doc = world.docs.get(future.workflow);
    if (!doc) {
      need(false, `${future.workflow} exists but was not parsed, so nothing below judged it.`);
      continue;
    }
    need(
      wTriggers(world, future.workflow, future.sample),
      `${future.workflow} does not trigger on its own root ${future.root} (tried `
      + `"${future.sample}"). A platform workflow pointed at the wrong root is a check that never `
      + `runs, and its platform ships unbuilt behind a green board.`,
    );
    for (const other of allPlatforms) {
      if (other.root === future.root) continue;
      need(
        !wTriggers(world, future.workflow, other.sample),
        `${future.workflow} also triggers on ${other.root}, which it does not build.`,
      );
    }
    const jobs = Object.entries(doc.jobs ?? {});
    const buildJobs = jobs.filter(
      ([, job]) => future.build.test(runText(job)) && realRunLines(job).length > 0,
    );
    need(
      buildJobs.length >= 1,
      `${future.workflow} has no job that actually builds or tests ${future.root}: no run step `
      + `matching ${future.build} whose command is more than an \`echo\`. A workflow that only `
      + `echoes reports a green ${future.label} check for source nobody compiled.`,
    );
    for (const [name, job] of jobs) {
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${future.workflow}/${name}: timeout-minutes is `
        + `${JSON.stringify(job["timeout-minutes"])}, want a finite positive number.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${future.workflow}/${name}: continue-on-error makes this platform's gate advisory.`,
      );
      need(
        !/retry|retries/i.test(runText(job)),
        `${future.workflow}/${name}: a retry appeared; a platform build that is re-rolled until it `
        + `passes reports the run that agreed rather than the code.`,
      );
    }
  }

  // 6f. The always-on compatibility gate: unfiltered, cheap, fail-closed, finite.
  //
  //     All four are properties of the workflow FILE, which is the only thing
  //     this test can read. They make the gate always-RUN — it starts on every
  //     triggering event and reports red when the contract breaks. They do not
  //     make a red result BLOCK a merge: that is branch protection on `main`,
  //     the status context `compat / wire-vectors`, and it lives in repository
  //     settings rather than in this repository's source. Nothing below is
  //     evidence that it is configured, and no message here should be read as
  //     claiming it is. The one half of that context this file CAN check is its
  //     job name, and section 6j does.
  need(
    world.texts.has(COMPAT),
    `${COMPAT} is missing. It is the always-required wire-compatibility gate — the one check `
    + `every platform, present and future, has to pass — and nothing else in this repository runs `
    + `\`${VECTOR_COMMAND}\`.`,
  );
  const compat = world.docs.get(COMPAT);
  if (compat) {
    need(
      wPaths(world, COMPAT) === null,
      `${COMPAT} gained a push path filter (${JSON.stringify(wPaths(world, COMPAT))}). It must `
      + `have none: a filter is precisely how a new platform root — or a tree somebody narrowed — `
      + `stops being covered by the cross-language contract without anybody deciding to exempt it. `
      + `Always-required means always-run.`,
    );
    const pr = compat.on?.pull_request;
    need(
      !(pr && typeof pr === "object" && pr.paths),
      `${COMPAT} gained a pull_request path filter, so branch work can reach \`main\` without the `
      + `compatibility gate having run on it.`,
    );
    const jobs = Object.entries(compat.jobs ?? {});
    need(jobs.length >= 1, `${COMPAT} has no jobs, so the always-on gate checks nothing.`);
    for (const [name, job] of jobs) {
      need(
        job["runs-on"] === "ubuntu-latest",
        `${COMPAT}/${name} runs on ${JSON.stringify(job["runs-on"])}; the always-on gate must stay `
        + `on the cheapest hosted runner. A macOS or Windows runner here turns a seconds-long `
        + `contract check into a platform build charged on every single commit, and the first `
        + `response to that bill is to add the path filter the check must not have.`,
      );
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${COMPAT}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a `
        + `finite positive number. An unbounded always-on job holds a runner for GitHub's 6-hour `
        + `default on every commit.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${COMPAT}/${name}: continue-on-error makes the compatibility gate advisory, and an `
        + `advisory contract check is indistinguishable from no contract check.`,
      );
      need(
        job.if === undefined,
        `${COMPAT}/${name}: a job-level "if:" lets the always-on gate skip itself. It reads no `
        + `secrets and must run on every triggering event, fork pull requests included.`,
      );
      const text = runText(job);
      need(
        !/retry|retries/i.test(text),
        `${COMPAT}/${name}: a retry appeared. This gate compares frozen bytes against their `
        + `generator; there is nothing intermittent for a retry to smooth over, so a retry here `
        + `only hides a real divergence.`,
      );
      need(
        !/\|\|\s*(true|:|echo|exit 0)/.test(text),
        `${COMPAT}/${name}: a command swallows its own exit status, so the gate reports green `
        + `after failing.`,
      );
      need(
        realRunLines(job).length > 0,
        `${COMPAT}/${name}: has no real run step — every run line is an \`echo\` or a no-op. A `
        + `placeholder job reports a green compatibility check for a contract nobody verified.`,
      );
      for (const step of job.steps ?? []) {
        need(
          step["continue-on-error"] === undefined,
          `${COMPAT}/${name}: a step sets continue-on-error, which lets the gate report green `
          + `after failing.`,
        );
        need(
          step.if === undefined,
          `${COMPAT}/${name}: a step sets "if:", and a gate that can skip itself is not a gate.`,
        );
      }
    }
  }

  // 6g. And the command itself: once, in the right place, in the verifying form.
  const vectorHosts = [...world.texts]
    .filter(([, text]) => text.includes(VECTOR_COMMAND))
    .map(([file]) => file)
    .sort();
  need(
    deepEqual(vectorHosts, [COMPAT]),
    `\`${VECTOR_COMMAND}\` runs in [${vectorHosts.join(", ")}]; want exactly [${COMPAT}]. Zero `
    + `hosts is the cross-language wire contract silently unchecked — every Swift vector suite `
    + `would keep passing against the OLD wire. Two hosts is the same seconds-long check paid for `
    + `twice, and historically one of them sat behind a path filter a new platform could bypass.`,
  );
  const writers = [...world.texts]
    .filter(([, text]) => text.includes(VECTOR_WRITER))
    .map(([file]) => file)
    .sort();
  need(
    writers.length === 0,
    `[${writers.join(", ")}] run the WRITING form of the vector generator (\`${VECTOR_WRITER}\`). `
    + `CI must verify the tracked bytes, never regenerate them — a gate that rewrites the fixture `
    + `it is checking agrees with whatever it just produced.`,
  );

  // 6h. And the one property none of the above can establish about itself:
  //     that something actually RUNS this file, on everything, fail-closed.
  //
  //     Every assertion in sections 5–7 is worth exactly what its execution is
  //     worth. Delete the step that invokes it and all of them go quiet: no
  //     YAML breaks, actionlint is happy, the board is green, and the next
  //     signal is a coarse filter charging a macOS runner on a documentation
  //     edit — or a platform root that never got built. The same is true of the
  //     cheaper edits: a job-level `if:`, a `continue-on-error:`, or a `|| true`
  //     on the command each leave the invocation visibly present and its verdict
  //     unable to stop anything.
  //
  //     It must be the UNFILTERED host, too. Behind a path filter this policy
  //     would run only when the trees that filter happens to name change, which
  //     is the exact defect section 6f exists to reject one level down: a check
  //     every change must pass, reachable only by some changes.
  //
  //     And the invocation must be BOUNDED by a number somebody chose. A job
  //     with no `timeout-minutes` inherits GitHub's six-hour default, so this
  //     policy hanging — a parser loop on a malformed document, a runner that
  //     never finishes booting — holds a runner for six hours on every commit
  //     instead of turning the board red in minutes. A declared bound far above
  //     what the work takes is the same default wearing a number, so the
  //     ceiling is asserted in both directions.
  const selfHostDoc = world.docs.get(SELF_HOST);
  need(
    selfHostDoc !== undefined,
    `${SELF_HOST} is missing, and it is what runs \`${SELF_COMMAND}\` on every pull request and `
    + `every \`main\` push. Without it nothing in this file is executed and every assertion above `
    + `is inert.`,
  );
  if (selfHostDoc) {
    need(
      wPaths(world, SELF_HOST) === null,
      `${SELF_HOST} gained a push path filter (${JSON.stringify(wPaths(world, SELF_HOST))}). It `
      + `hosts this policy, which judges .github/workflows/ and apps/ as a whole, so a filter `
      + `means the boundary is only checked when the trees that filter happens to name change — `
      + `the same exemption-by-omission section 6f rejects for ${COMPAT}.`,
    );
    const selfPr = selfHostDoc.on?.pull_request;
    need(
      !(selfPr && typeof selfPr === "object" && selfPr.paths),
      `${SELF_HOST} gained a pull_request path filter, so branch work can reach \`main\` without `
      + `this policy having run on it.`,
    );

    // Found by the COMMAND, so renaming the job is allowed and losing its
    // invocation is not.
    const hosts = Object.entries(selfHostDoc.jobs ?? {})
      .filter(([, job]) => realRunLines(job).some((line) => line.includes(SELF_COMMAND)));
    need(
      hosts.length === 1,
      `${hosts.length} job(s) in ${SELF_HOST} run \`${SELF_COMMAND}\`; want exactly one. Zero is `
      + `this entire policy file present in the repository and executed by nothing — the most `
      + `expensive kind of green, because the assertions still read as coverage. Two is the same `
      + `seconds-long check charged twice.`,
    );
    for (const [name, job] of hosts) {
      need(
        job.if === undefined,
        `${SELF_HOST}/${name}: a job-level "if:" lets the job that runs \`${SELF_COMMAND}\` skip `
        + `itself. This policy reads no secrets and must run on every triggering event, fork pull `
        + `requests included.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${SELF_HOST}/${name}: continue-on-error makes this policy advisory. An advisory boundary `
        + `check reports the same green as a passing one and stops nothing.`,
      );
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${SELF_HOST}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want `
        + `a finite positive number. Undeclared, this job inherits GitHub's 6-hour default, so a `
        + `hang in the policy that gates every commit holds a runner for six hours instead of `
        + `reporting red in minutes.`,
      );
      need(
        !(Number.isFinite(timeout) && timeout > SELF_TIMEOUT_MAX),
        `${SELF_HOST}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, above `
        + `the ${SELF_TIMEOUT_MAX}-minute ceiling. This policy parses a few small YAML documents `
        + `and finishes in seconds; a bound that large is the 6-hour default wearing a number, and `
        + `it buys nothing that a real hang would not spend.`,
      );
      for (const step of job.steps ?? []) {
        need(
          step["continue-on-error"] === undefined,
          `${SELF_HOST}/${name}: a step sets continue-on-error, which lets the job report green `
          + `after this policy failed.`,
        );
        need(
          step.if === undefined,
          `${SELF_HOST}/${name}: a step sets "if:", and a policy that can skip itself is not a `
          + `policy.`,
        );
      }
      const selfLine = realRunLines(job).find((line) => line.includes(SELF_COMMAND));
      need(
        !/\|\|\s*(true|:|echo|exit 0)/.test(selfLine ?? ""),
        `${SELF_HOST}/${name}: the \`${SELF_COMMAND}\` command swallows its own exit status `
        + `("${(selfLine ?? "").trim()}"), so every failure above is reported as a pass.`,
      );
    }
  }

  // 6i. The paid-runner budget, and the absence of commit-message escapes.
  //
  //     Two properties of the two most expensive lanes in this repository.
  //     Neither is visible to YAML validity or to actionlint, neither is covered
  //     by anything above, and both were live defects until they were fixed.
  //
  //     TIMEOUTS. A job with no `timeout-minutes` inherits GitHub's SIX-HOUR
  //     default. Both `ios.yml` and `release.yml` had none. On `ios.yml` that is
  //     a paid macOS runner held for six hours by a simulator that never booted;
  //     on `release.yml` it is a wedged release job sitting for six hours with
  //     the signing key materialized on disk. The ceiling is asserted in the
  //     other direction too, exactly as in 6h: a bound declared far above what
  //     the work takes is the six-hour default wearing a number.
  //
  //     ESCAPES. `ios.yml` honoured a `[macos-only]` marker in a `main` commit
  //     message, which let a commit message skip the iOS build. A skipped check
  //     does not report red — it reports NOTHING — so the skip was invisible in
  //     the merge box, it applied on `main` after review where this workflow is
  //     the only thing that compiles iOS at all, and it was reachable by exactly
  //     the commit least likely to deserve it. The removal is asserted rather
  //     than remembered, in three independent ways: the literal marker must not
  //     reappear in either file; no job- or step-level condition may read a
  //     commit message, whatever marker it names; and `ios.yml` must carry no
  //     job-level `if:` at all.
  //
  //     The marker check reads the COMMENT-STRIPPED text, so both files may
  //     still explain in prose what was removed and why — which they do. That
  //     text comes from `world.texts`, which is loaded from every workflow file
  //     on disk and therefore covers `release.yml` even though it is parsed for
  //     its budget only and is deliberately absent from `GOVERNED`. Its presence
  //     is ASSERTED rather than assumed: a budget file whose text never reached
  //     the world would make the marker check inspect the empty string and pass,
  //     which is the same silent non-assertion section 7 exists to prevent.
  for (const budget of RUNNER_BUDGETS) {
    const doc = world.docs.get(budget.file);
    need(
      doc !== undefined,
      `${budget.file} is missing or did not parse, so its runner budget and its escape hatches `
      + `are unchecked. It is named in this policy on purpose: dropping it from the list is how `
      + `an expensive lane stops being bounded without anybody deciding to unbound it.`,
    );
    if (!doc) continue;

    const jobs = Object.entries(doc.jobs ?? {});
    need(
      jobs.length >= 1,
      `${budget.file} parsed with no jobs, so every per-job assertion below would pass by `
      + `inspecting nothing.`,
    );

    for (const [name, job] of jobs) {
      const declared = JSON.stringify(job["timeout-minutes"]);
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${budget.file}/${name}: timeout-minutes is ${declared}, want a finite positive number. `
        + `Undeclared, this job inherits GitHub's 6-hour default, so ${budget.why}.`,
      );
      need(
        !(Number.isFinite(timeout) && timeout > budget.max),
        `${budget.file}/${name}: timeout-minutes is ${declared}, above the ${budget.max}-minute `
        + `ceiling. A bound that large is the 6-hour default wearing a number — it would not stop `
        + `the case it exists for, where ${budget.why}.`,
      );

      for (const condition of [job.if, ...(job.steps ?? []).map((step) => step?.if)]) {
        if (typeof condition !== "string") continue;
        need(
          !COMMIT_MESSAGE_CONDITION.test(condition),
          `${budget.file}/${name}: a condition reads the commit message (${JSON.stringify(condition)}). `
          + `Whatever marker it names, that is the \`${SKIP_MARKER}\` escape returning in a new `
          + `spelling: it hands the decision about whether this gate runs to whoever writes the `
          + `commit, and a skipped check reports nothing rather than red.`,
        );
      }
    }

    const text = world.texts.get(budget.file);
    need(
      text !== undefined,
      `${budget.file} is parsed for its runner budget but its comment-stripped source never `
      + `reached this world, so the \`${SKIP_MARKER}\` marker check below would inspect nothing `
      + `and report a pass. The text and the parsed document have to arrive together.`,
    );
    need(
      !(text ?? "").includes(SKIP_MARKER),
      `${budget.file} contains the \`${SKIP_MARKER}\` commit-message marker again, outside a `
      + `whole-line comment. That escape let a commit message skip the iOS build; an escape hatch `
      + `in a gate is not a gate.`,
    );
  }

  //     And the general form, for the one file the escape actually lived in.
  //     A step-level `if:` is still fine — the failure-only diagnosis upload is
  //     one — because a step that runs only on failure cannot skip the build.
  const iosDoc = world.docs.get(IOS);
  if (iosDoc) {
    for (const [name, job] of Object.entries(iosDoc.jobs ?? {})) {
      need(
        job.if === undefined,
        `${IOS}/${name}: a job-level "if:" is back (${JSON.stringify(job.if)}). This job is the `
        + `only thing in this repository that compiles iOS; it reads no secrets, so it runs on `
        + `fork pull requests, and it must run on every event its path filter admits. A job-level `
        + `condition is exactly where the \`${SKIP_MARKER}\` escape lived.`,
      );
    }
  }

  // 6j. The job half of the required status context, and the collision the
  //     `app_id` binding cannot see.
  //
  //     `main`'s protection requires exactly one context. The API reports it as
  //     the job name `wire-vectors`, bound to GitHub Actions `app_id` 15368, and
  //     the merge box renders it `compat / wire-vectors` — the workflow's
  //     `name:` and the job key joined.
  //
  //     The `app_id` binding answers exactly one threat: a DIFFERENTLY OWNED
  //     check — another GitHub App, or an external service posting a commit
  //     status — publishing the same context name and satisfying the requirement
  //     on behalf of a gate that never ran. It cannot answer the other one. A
  //     job key `wire-vectors` declared in a SECOND workflow in this repository
  //     is GitHub Actions, it is `app_id` 15368, and it produces a status with
  //     the same job name. Which run the merge box then reconciles the single
  //     requirement against is not a property this repository controls, so a
  //     green `wire-vectors` from some cheap unrelated lane can stand in for the
  //     cross-language contract gate — and it reports green, not missing.
  //
  //     Branch protection cannot prevent that; a settings read-back cannot
  //     detect it; and it leaves every workflow file syntactically valid. Only
  //     uniqueness of the name inside this repository prevents it, and that is
  //     checkable here, so it is checked here.
  //
  //     Both directions are asserted, because either alone would be vacuous.
  //     "No OTHER workflow declares it" passes trivially in a tree where
  //     `compat.yml` is gone or its job has been renamed — precisely the tree
  //     where the required context is satisfied by nothing at all. So the
  //     positive half comes first, and it fails loudly.
  //
  //     The scan covers EVERY workflow file on disk rather than the GOVERNED
  //     list: `release.yml`, `auto-release.yml` and anything added tomorrow can
  //     declare a job name just as well as a governed workflow can, and a rule
  //     that only inspected the governed set would miss the collision in the
  //     files least likely to be reviewed for it. See `jobKeysOf`.
  //
  //     This asserts the NAME, not the setting. It is not evidence that the
  //     context is required, and it does not license any change to branch
  //     protection or to a workflow's job names — renaming this job would
  //     silently un-require the gate, which is why the name is pinned here.
  const compatJobNames = jobKeysOf(world, COMPAT);
  need(
    compatJobNames.includes(COMPAT_JOB),
    `${COMPAT} declares no job named \`${COMPAT_JOB}\`; it declares `
    + `[${compatJobNames.join(", ")}]. That name is half of the required status context `
    + `\`compat / ${COMPAT_JOB}\`: rename or remove the job and \`main\`'s single required check `
    + `is a context nothing in this repository ever reports, so the requirement is satisfied by `
    + `no run rather than by a passing one. It also makes the uniqueness check below vacuous — `
    + `there is nothing left for a second workflow to collide with.`,
  );
  const jobNameHosts = [...world.texts.keys()]
    .filter((file) => file !== COMPAT)
    .filter((file) => jobKeysOf(world, file).includes(COMPAT_JOB))
    .sort();
  need(
    jobNameHosts.length === 0,
    `[${jobNameHosts.join(", ")}] also declare a job named \`${COMPAT_JOB}\`, which is the job `
    + `half of \`main\`'s single required status context \`compat / ${COMPAT_JOB}\`. This is the `
    + `one substitution the \`app_id\` binding cannot stop: a second job of this name in this `
    + `repository is the SAME app, so its status carries the same context and the requirement can `
    + `be satisfied by a lane that never checked the wire contract. Give the job a different name `
    + `— only ${COMPAT} may declare \`${COMPAT_JOB}\`.`,
  );

  return out;
}

for (const message of platformBoundaryFailures(realWorld())) failures.push(message);
for (const message of pathMatrixFailures(realWorld())) failures.push(message);

// ── 7. the proof that sections 5g and 6 can fail ────────────────────────────
//
// Every check above reads a world instead of module state precisely so this can
// exist. Each case below breaks ONE property in a copy of the real workflows and
// requires the matching complaint by its own wording — not merely "something
// failed", which a broken parser or an unrelated typo would also satisfy.
//
// Both world-driven check sets run against each mutated world: the platform
// boundary and the trigger matrix. A mutation is free to disturb rows it was
// not written for — the assertion is that the named complaint is PRESENT, never
// that it is alone — and a trigger-matrix row is only worth having once some
// mutation has actually made it fail.
//
// This is the guard against the most expensive outcome available here: a policy
// file that passes because it is asserting nothing.

/** Set a workflow's push and pull_request filters together, the way the anchor does. */
function withPaths(world, file, paths) {
  const on = world.docs.get(file).on;
  on.push.paths = paths;
  on.pull_request = { ...(on.pull_request ?? {}), paths };
  return world;
}

/**
 * Remove exactly one entry from a workflow's shared filter.
 *
 * Derived from the world rather than restated as a replacement list, so it
 * removes ONE thing however the filter grows later, and throws when the entry
 * is already gone — the same discipline as `withCommandJob`. A mutation that
 * quietly stopped removing anything would leave the world unbroken, and the
 * case below it would pass while asserting nothing.
 */
function withoutPath(world, file, path) {
  const paths = wPaths(world, file);
  if (paths === null || !paths.includes(path)) {
    throw new Error(`${file}'s path filter does not list ${path}, so there is nothing to remove`);
  }
  return withPaths(world, file, paths.filter((entry) => entry !== path));
}

/** Mutate the first job of a workflow. */
function withJob(world, file, mutate) {
  const jobs = world.docs.get(file).jobs;
  mutate(jobs[Object.keys(jobs)[0]]);
  return world;
}

/**
 * Mutate the job in `file` that runs `command`, and the step carrying it.
 *
 * Throwing when no such job exists is deliberate: a mutation that silently
 * stopped applying would leave the world unbroken, and the case below it would
 * pass by asserting nothing — the failure this whole section exists to prevent.
 */
function withCommandJob(world, file, command, mutate) {
  for (const [name, job] of Object.entries(world.docs.get(file)?.jobs ?? {})) {
    const step = (job.steps ?? []).find((s) => String(s?.run ?? "").includes(command));
    if (step) { mutate(job, step, name); return world; }
  }
  throw new Error(`no job in ${file} runs ${command}`);
}

/** A plausible future platform workflow, as the parser would have produced it. */
function syntheticPlatform({ workflow, root, run, timeout = "30" }) {
  return {
    name: workflow.replace(/\.ya?ml$/, ""),
    on: {
      push: { branches: ["main"], paths: [`${root}/**`, `.github/workflows/${workflow}`] },
      pull_request: { paths: [`${root}/**`, `.github/workflows/${workflow}`] },
      workflow_dispatch: null,
    },
    concurrency: { group: GROUP, "cancel-in-progress": CANCEL },
    jobs: {
      build: {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": timeout,
        steps: [
          { uses: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd" },
          { name: "Build", run: `${run}\n` },
        ],
      },
    },
  };
}

/** Add a workflow to a world as if it were on disk and governed. */
function addWorkflow(world, file, doc) {
  world.docs.set(file, doc);
  world.texts.set(file, JSON.stringify(doc));
  world.governed.push({ file, dispatch: true });
  return world;
}

const ANDROID = FUTURE_PLATFORMS.find((future) => future.root === "apps/android");

/** A governed workflow that is parsed, and a real one that deliberately is not. */
const WEB = "web.yml";
const AUTO_RELEASE = "auto-release.yml";

const MUTATIONS = [
  {
    name: "native-web-pairing.yml regains a bare `apps/**` filter",
    mutate: (world) => withPaths(world, NWP, [
      "apps/**", "web/**", "server/**", `.github/workflows/${NWP}`,
    ]),
    expect: /native-web-pairing\.yml triggers on apps\/ios/,
  },
  {
    name: "a governed workflow regains a bare `scripts/**` filter",
    mutate: (world) => withPaths(world, IOS, [
      "apps/ios/**", "apps/RelayiumKit/**", "scripts/**", `.github/workflows/${IOS}`,
    ]),
    expect: /ios\.yml's path filter lists the bare glob `scripts\/\*\*`/,
  },
  {
    name: "macos.yml adopts apps/ios, re-welding the two Apple platforms",
    mutate: (world) => withPaths(world, MACOS, [
      "apps/mac/**", "apps/ios/**", "apps/RelayiumKit/**", `.github/workflows/${MACOS}`,
    ]),
    expect: /platform root apps\/ios also starts macos\.yml/,
  },
  {
    name: "ios.yml stops watching the Apple-shared package",
    mutate: (world) => withPaths(world, IOS, [
      "apps/ios/**", `.github/workflows/${IOS}`,
    ]),
    expect: /apps\/RelayiumKit fans out to \[macos\.yml\]/,
  },
  {
    name: "an apps/android root appears with no android.yml",
    mutate: (world) => { world.roots.add("apps/android"); return world; },
    expect: /apps\/android\/ exists but \.github\/workflows\/android\.yml does not/,
  },
  {
    name: "an android.yml placeholder appears with no apps/android source",
    mutate: (world) => addWorkflow(world, ANDROID.workflow, syntheticPlatform({
      workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
    })),
    expect: /android\.yml exists but apps\/android\/ does not/,
  },
  {
    name: "android.yml and apps/android both exist, but the job only echoes",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      return addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: 'echo "android build: TODO"',
      }));
    },
    expect: /android\.yml has no job that actually builds or tests apps\/android/,
  },
  {
    name: "android.yml exists but its filter names the wrong root",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withPaths(world, ANDROID.workflow, [
        "apps/mac/**", `.github/workflows/${ANDROID.workflow}`,
      ]);
    },
    expect: /android\.yml does not trigger on its own root apps\/android/,
  },
  {
    name: "android.yml claims the Apple-shared package as cross-platform",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withPaths(world, ANDROID.workflow, [
        "apps/android/**", "apps/RelayiumKit/**", `.github/workflows/${ANDROID.workflow}`,
      ]);
    },
    expect: /android\.yml triggers on apps\/RelayiumKit/,
  },
  {
    name: "android.yml's build job loses its timeout",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withJob(world, ANDROID.workflow, (job) => { delete job["timeout-minutes"]; });
    },
    expect: /android\.yml\/build: timeout-minutes is undefined/,
  },
  {
    name: "android.yml's build job becomes advisory",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withJob(world, ANDROID.workflow, (job) => { job["continue-on-error"] = "true"; });
    },
    expect: /android\.yml\/build: continue-on-error makes this platform's gate advisory/,
  },
  {
    name: "android.yml's build job retries until it agrees",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow,
        root: ANDROID.root,
        run: "./gradlew assembleDebug || ./gradlew assembleDebug # retry once",
      }));
      return world;
    },
    expect: /android\.yml\/build: a retry appeared/,
  },
  {
    name: "an unknown apps/ root appears with no declared owner",
    mutate: (world) => { world.roots.add("apps/linux"); return world; },
    expect: /unknown platform root "apps\/linux" exists under apps\//,
  },
  {
    name: "compat.yml gains a push path filter",
    mutate: (world) => withPaths(world, COMPAT, ["web/**", `.github/workflows/${COMPAT}`]),
    expect: /compat\.yml gained a push path filter/,
  },
  {
    name: "compat.yml gains a pull_request-only path filter",
    mutate: (world) => {
      world.docs.get(COMPAT).on.pull_request = { paths: ["web/**"] };
      return world;
    },
    expect: /compat\.yml gained a pull_request path filter/,
  },
  {
    name: "compat.yml moves onto a platform runner",
    mutate: (world) => withJob(world, COMPAT, (job) => { job["runs-on"] = "macos-15"; }),
    expect: /compat\.yml\/wire-vectors runs on "macos-15"/,
  },
  {
    name: "compat.yml's job becomes advisory",
    mutate: (world) => withJob(world, COMPAT, (job) => { job["continue-on-error"] = "true"; }),
    expect: /continue-on-error makes the compatibility gate advisory/,
  },
  {
    name: "compat.yml's gate step becomes advisory",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1]["continue-on-error"] = "true";
    }),
    expect: /compat\.yml\/wire-vectors: a step sets continue-on-error/,
  },
  {
    name: "compat.yml's gate step can skip itself",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1].if = "github.event_name == 'push'";
    }),
    expect: /compat\.yml\/wire-vectors: a step sets "if:"/,
  },
  {
    name: "compat.yml's job can skip itself",
    mutate: (world) => withJob(world, COMPAT, (job) => { job.if = "github.actor != 'dependabot'"; }),
    expect: /compat\.yml\/wire-vectors: a job-level "if:"/,
  },
  {
    name: "compat.yml loses its timeout",
    mutate: (world) => withJob(world, COMPAT, (job) => { delete job["timeout-minutes"]; }),
    expect: /compat\.yml\/wire-vectors: timeout-minutes is undefined/,
  },
  {
    name: "compat.yml retries the contract check until it agrees",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1].run = "npm run test:vectors --retries 3";
    }),
    expect: /compat\.yml\/wire-vectors: a retry appeared/,
  },
  {
    name: "compat.yml swallows the contract check's exit status",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1].run = "npm run test:vectors || true";
    }),
    expect: /compat\.yml\/wire-vectors: a command swallows its own exit status/,
  },
  {
    name: "compat.yml becomes a placeholder that only echoes",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1].run = 'echo "wire vectors: TODO"';
    }),
    expect: /compat\.yml\/wire-vectors: has no real run step/,
  },
  // These two break the SAME check in opposite directions, so each demands the
  // host list it actually produces rather than the shared tail of the message.
  // Matching `want exactly [compat.yml]` would have let either mutation be
  // satisfied by the other's complaint — and, worse, by the complaint from a
  // world where the check had stopped working altogether.
  {
    name: "the vector command reappears in native-web-pairing.yml as well",
    mutate: (world) => {
      world.texts.set(NWP, `${world.texts.get(NWP)}\n        run: ${VECTOR_COMMAND}\n`);
      return world;
    },
    expect: /`npm run test:vectors` runs in \[compat\.yml, native-web-pairing\.yml\]/,
  },
  {
    name: "the vector command disappears from every workflow",
    mutate: (world) => {
      world.texts.set(COMPAT, world.texts.get(COMPAT).replace(VECTOR_COMMAND, "npm run check"));
      return world;
    },
    expect: /`npm run test:vectors` runs in \[\]; want exactly \[compat\.yml\]/,
  },
  {
    name: "compat.yml is deleted outright",
    mutate: (world) => { world.texts.delete(COMPAT); world.docs.delete(COMPAT); return world; },
    expect: /compat\.yml is missing/,
  },
  {
    name: "a workflow starts running the WRITING form of the generator",
    mutate: (world) => {
      world.texts.set(COMPAT, world.texts.get(COMPAT).replace(VECTOR_COMMAND, "npm run gen:vectors"));
      return world;
    },
    expect: /run the WRITING form of the vector generator/,
  },
  {
    name: "the pairing filter re-adopts apps/mac, which the acceptance never reads",
    mutate: (world) => withPaths(world, NWP, [
      "apps/mac/**", "apps/RelayiumKit/**", "web/**", "server/**",
      "scripts/native-web-pairing-acceptance.sh", "scripts/lib/local-acceptance.sh",
      `.github/workflows/${NWP}`,
    ]),
    expect: /native-web-pairing\.yml triggers on apps\/mac .*which is not an input to it/,
  },
  // A marker inside a `run:` block's own shell comment must NOT create
  // ownership. This is the only case here that asserts an ABSENCE, and it is
  // the direction that costs a red board on correct code: ios.yml explaining a
  // macOS command would otherwise report macOS as having two heavy owners.
  {
    name: "a macOS build marker appears inside an ios.yml run-block comment",
    mutate: (world) => {
      const jobs = world.docs.get(IOS).jobs;
      const job = jobs[Object.keys(jobs)[0]];
      (job.steps ??= []).push({
        name: "Note the macOS counterpart",
        run: `# the macOS half of this is ${MACOS_PROJECT}, built in ${MACOS}\nxcodebuild -list\n`,
      });
      return world;
    },
    refute: /platform root apps\/mac: the macOS app build .* runs in \[ios\.yml, macos\.yml\]/,
  },
  // ── the self-host check (6h) ─────────────────────────────────────────────
  {
    name: "repo-hygiene.yml stops running this policy at all",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.run = 'echo "ci-event-policy: TODO"';
    }),
    expect: /0 job\(s\) in repo-hygiene\.yml run `node scripts\/test\/ci-event-policy-test\.mjs`/,
  },
  {
    name: "the job that runs this policy becomes advisory",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["continue-on-error"] = "true";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: continue-on-error makes this policy advisory/,
  },
  {
    name: "the job that runs this policy is allowed to skip itself",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job.if = "github.actor != 'dependabot[bot]'";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: a job-level "if:"/,
  },
  {
    name: "the step that runs this policy is allowed to skip itself",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.if = "github.event_name == 'push'";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: a step sets "if:"/,
  },
  {
    name: "this policy's command swallows its own exit status",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.run = `${step.run} || true`;
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: the `node scripts\/test\/ci-event-policy-test\.mjs` command swallows/,
  },
  {
    name: "the job that runs this policy loses its timeout",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    name: "the job that runs this policy declares a zero timeout",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["timeout-minutes"] = "0";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is "0", want a finite positive number/,
  },
  {
    name: "the job that runs this policy declares a non-numeric timeout",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["timeout-minutes"] = "soon";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is "soon", want a finite positive number/,
  },
  {
    name: "the job that runs this policy declares a timeout above the ceiling",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["timeout-minutes"] = "360";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is "360", above the 10-minute ceiling/,
  },
  {
    name: "repo-hygiene.yml gains a push path filter, hiding this policy behind it",
    mutate: (world) => withPaths(world, SELF_HOST, [
      "web/**", `.github/workflows/${SELF_HOST}`,
    ]),
    expect: /repo-hygiene\.yml gained a push path filter/,
  },
  // 6i, one property at a time. Each of these was the real state of the tree
  // until the architecture-resilience P0 pass, so none of them is hypothetical.
  {
    name: "ios.yml loses its runner timeout and inherits GitHub's 6-hour default",
    mutate: (world) => withJob(world, IOS, (job) => { delete job["timeout-minutes"]; }),
    expect: /ios\.yml\/ios-build: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    name: "release.yml loses its runner timeout",
    mutate: (world) => withJob(world, RELEASE, (job) => { delete job["timeout-minutes"]; }),
    expect: /release\.yml\/goreleaser: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    name: "release.yml declares a bound that is the 6-hour default wearing a number",
    mutate: (world) => withJob(world, RELEASE, (job) => { job["timeout-minutes"] = "360"; }),
    expect: /release\.yml\/goreleaser: timeout-minutes is "360", above the 60-minute ceiling/,
  },
  {
    name: "ios.yml declares a non-numeric timeout, which GitHub would ignore",
    mutate: (world) => withJob(world, IOS, (job) => { job["timeout-minutes"] = "soon"; }),
    expect: /ios\.yml\/ios-build: timeout-minutes is "soon", want a finite positive number/,
  },
  {
    name: "the [macos-only] escape returns to ios.yml under a different marker",
    mutate: (world) => withJob(world, IOS, (job) => {
      job.if = "!contains(github.event.head_commit.message, '[skip-ios]')";
    }),
    expect: /ios\.yml\/ios-build: a condition reads the commit message/,
  },
  {
    name: "a release step learns to skip itself on a commit-message marker",
    mutate: (world) => withJob(world, RELEASE, (job) => {
      job.steps[0].if = "!contains(github.event.head_commit.message, '[no-release]')";
    }),
    expect: /release\.yml\/goreleaser: a condition reads the commit message/,
  },
  {
    name: "ios.yml regains a job-level condition of any shape",
    mutate: (world) => withJob(world, IOS, (job) => { job.if = "github.actor != 'nobody'"; }),
    expect: /ios\.yml\/ios-build: a job-level "if:" is back/,
  },
  {
    name: "the literal [macos-only] marker returns to ios.yml as live YAML",
    mutate: (world) => {
      world.texts.set(IOS, `${world.texts.get(IOS)}\n    if: "${SKIP_MARKER}"\n`);
      return world;
    },
    expect: /ios\.yml contains the `\[macos-only\]` commit-message marker again/,
  },
  {
    // The opposite obligation: a step that runs only when the job already
    // failed cannot skip a build, and `ios.yml` carries exactly one. A budget
    // check that fired on it would be widened until it fired on nothing.
    name: "a failure-only diagnosis step keeps its `if:`",
    mutate: (world) => withJob(world, IOS, (job) => {
      job.steps[job.steps.length - 1].if = "failure()";
    }),
    refute: /ios\.yml\/ios-build: a condition reads the commit message/,
  },
  {
    // 6i again, in the direction the check itself can fail SILENTLY. The marker
    // assertion reads `world.texts`, and a budget lane whose text never arrives
    // would have it inspect the empty string and report a pass — the same
    // non-assertion this whole section exists to prevent. So the guard that
    // catches that has its own mutation, exactly like every rule it protects.
    name: "release.yml's comment-stripped source never reaches this world",
    mutate: (world) => { world.texts.delete(RELEASE); return world; },
    expect: /release\.yml is parsed for its runner budget but its comment-stripped source never reached this world/,
  },
  // ── the required status context's job name (6j) ──────────────────────────
  // A collision here is the one substitution `app_id` 15368 cannot refuse,
  // because the impostor is the same app. Both cases below leave every workflow
  // valid, actionlint quiet and the board green.
  {
    name: "web.yml declares a second job named wire-vectors — same repo, same app, same context",
    mutate: (world) => {
      world.docs.get(WEB).jobs[COMPAT_JOB] = {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": "5",
        steps: [{ name: "Check", run: "npm run check\n" }],
      };
      return world;
    },
    expect: /\[web\.yml\] also declare a job named `wire-vectors`/,
  },
  {
    // And in a workflow this policy deliberately does not parse, which is where
    // the collision is least likely to be noticed by a reader. Scanning only
    // GOVERNED would report green on this tree.
    name: "auto-release.yml, which is not parsed here, declares a wire-vectors job",
    mutate: (world) => {
      const text = world.texts.get(AUTO_RELEASE);
      world.texts.set(AUTO_RELEASE, text.replace(
        /^jobs:\s*$/m,
        `jobs:\n  ${COMPAT_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n`,
      ));
      return world;
    },
    expect: /\[auto-release\.yml\] also declare a job named `wire-vectors`/,
  },
  {
    // The trigger-matrix half, and the row this file learned the hard way: the
    // document is not source, so nothing about web.yml LOOKS wrong without it.
    // Removing the one entry is exactly the edit a reader tidying a "docs file
    // in a web workflow" would make, and it is silent — `npm test` still runs
    // billing-doc-pointers.test.mjs, just never on a commit that only touched
    // the document it reads.
    name: "web.yml stops watching the billing document its own test suite reads",
    mutate: (world) => withoutPath(world, WEB, "docs/billing-transparency.md"),
    expect: /changing "docs\/billing-transparency\.md" starts \[\]; want \[web\.yml\]/,
  },
  {
    // The non-vacuity half. In this world the uniqueness check above is
    // trivially satisfied — nothing collides with a name nothing declares —
    // while `main`'s single required context is reported by no run at all.
    name: "compat.yml's job is renamed, so the required context is reported by nothing",
    mutate: (world) => {
      const jobs = world.docs.get(COMPAT).jobs;
      jobs.vectors = jobs[COMPAT_JOB];
      delete jobs[COMPAT_JOB];
      return world;
    },
    expect: /compat\.yml declares no job named `wire-vectors`; it declares \[vectors\]/,
  },
];

for (const { name, mutate, expect, refute } of MUTATIONS) {
  let got;
  try {
    const world = mutate(realWorld());
    got = [...platformBoundaryFailures(world), ...pathMatrixFailures(world)];
  } catch (err) {
    check(false, `the CI trigger-policy mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  const rendered = got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`;
  if (expect) {
    check(
      got.some((message) => expect.test(message)),
      `the CI trigger policy did NOT complain about "${name}". Expected a message matching `
      + `${expect}; got ${rendered}. `
      + `A check that cannot fail for the reason it was written is not a check, and this one would `
      + `report green while the boundary it names is already gone.`,
    );
  }
  // The opposite obligation. A boundary that fires on shapes which are actually
  // fine gets widened until it fires on nothing, so the false positive and the
  // missing check have the same destination.
  if (refute) {
    check(
      !got.some((message) => refute.test(message)),
      `the CI trigger policy complained about "${name}", which is a legitimate shape. `
      + `Expected NO message matching ${refute}; got ${rendered}.`,
    );
  }
}

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`ci-event-policy-test: ${failures.length} failure(s)\n`);
  for (const message of failures) console.error(`  ✗ ${message}\n`);
  process.exit(1);
}
console.log(
  `ci-event-policy-test: OK (${GOVERNED.length} governed workflows + ${NIGHTLY}`
  + `, runner budget on ${RUNNER_BUDGETS.map((b) => b.file).join(" and ")})`,
);
