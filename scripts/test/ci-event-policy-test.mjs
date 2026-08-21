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
//     exercises every construct these five workflows use — block mappings and
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
  { file: "web.yml", dispatch: true },
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
 * Every construct the five governed workflows actually use, parsed and compared
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

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`ci-event-policy-test: ${failures.length} failure(s)\n`);
  for (const message of failures) console.error(`  ✗ ${message}\n`);
  process.exit(1);
}
console.log(`ci-event-policy-test: OK (${GOVERNED.length} governed workflows + ${NIGHTLY})`);
