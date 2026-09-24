#!/usr/bin/env node
// scripts/test/ci-guard-coverage-test.mjs — every policy test in this directory
// is wired to an actual workflow run command.
//
// ## Why this exists
//
// `repo-hygiene.yml` and its siblings list each policy test as an EXPLICIT step.
// Nothing made the list complete, so adding a file under `scripts/test/` and
// forgetting the step produced a guard that never runs — which is worse than no
// guard, because the next reader believes the thing is protected and stops
// checking it by hand.
//
// It is not hypothetical. On 2026-09-22 `transport-claim-test.mjs` was written
// and very nearly committed with no step; looking for others turned up four that
// were already in that state — both iOS App Store validators' suites, the
// `acceptance_build` scratch-path contract, and the App Store candidate
// contract. All four had passed the whole time and proved nothing.
//
// ## What counts as a policy test, and what is deliberately not one
//
// The convention does the work, so there is no mute allowlist to drift:
//
//   - `scripts/test/*-test.mjs` and `scripts/test/*-test.sh` ARE policy tests.
//   - Everything else in this directory is not, and is excluded BY NAME rather
//     than by an exception list: `*-oracle.py` are decision oracles invoked by
//     the acceptance scripts (which are themselves in CI, and whose own guards
//     check that), `db-rollback-harness.sh` is a harness a human drives, and
//     `fixtures/` is data.
//
// A test may legitimately need a platform the cheap lane does not have —
// `ios-app-store-candidate-test.sh` exits 2 off Darwin because it drives an
// `xcodebuild` wrapper and reads plists with `plutil`. That is a reason to put
// it in a macOS workflow, not a reason to leave it unreferenced, so this checks
// only that SOME workflow runs it.
//
// ## What counts as "runs it"
//
// Until 2026-09-23 this was a substring search, so a file name in a YAML
// comment satisfied it: deleting `document-claims-test.mjs`'s step left it
// "covered" by a comment in `swift-package.yml`. Workflows mention these files
// in comments, step names and env values all the time, so only a run command
// counts, and only in one small, deliberately strict convention:
//
//   - the value of a step's `run:` key — the key's own position must be
//     `jobs.<job>.steps[<n>].run`; the same text under `env:`, `with:`,
//     `defaults:` or inside another value is data, not a command;
//   - the value is inline (plain, 'single' or "double" quoted) and is one
//     invocation, or it is a literal `|` block accepted only as a WHOLE: every
//     non-blank line is a `# comment`, a `set -e…`-style option line before
//     the first invocation, or an invocation — and an invocation that is not
//     the block's last command needs `set -e` before it;
//   - an invocation is exactly `node <path>.mjs`, `bash <path>.sh` or
//     `sh <path>.sh`, optionally followed by a ` # comment`, where <path> is
//     `scripts/test/<name>` (or `./scripts/test/<name>`), optionally quoted.
//
// Anything else does not count, even when it would run the test: arguments,
// `cd x && node …`, `|| true`, folded `>` blocks, multi-line plain scalars —
// and ANY block holding one other line, whether `echo`, a quote that spans
// lines, a function, an `if`/`case`/loop, a heredoc or a `\` continuation.
// Such a block is refused entirely rather than line by line, because telling
// which of its lines are code and which are data (a quoted string, a function
// body, a branch) takes a shell parser. Failing closed is the point — an
// unrecognised shape is reported as unwired, and the fix is to write the step
// in the convention, not to widen this reader into a YAML or shell parser.
// Every real invocation today is an inline one-liner.
//
// This is STATIC wiring. It proves a workflow step invokes the file; it does
// not prove the step's `if:`, triggers, path filters or job graph ever let it
// execute — those belong to `ci-event-policy-test.mjs` and the hosted logs —
// and it does not read the step's `shell:`, since each verb names its
// interpreter.
//
// ## Why it proves itself
//
// A scan that found no files, or matched nothing, would be as green as full
// coverage. So the real evaluation is followed by mutations: every real
// invocation is deleted in turn (its comments and mentions left in place) and
// must then be reported; a synthetic test must be recognised in every
// supported shape and rejected in every look-alike shape; an unwired name must
// be reported; and an empty listing must fail rather than pass vacuously.

import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const TEST_DIR = new URL("scripts/test/", root);
const WORKFLOW_DIR = new URL(".github/workflows/", root);

/** Files this directory holds that are NOT policy tests. Derived from the
 *  naming convention, never hand-listed — see the header. */
const isPolicyTest = (name) => name.endsWith("-test.mjs") || name.endsWith("-test.sh");

function realWorld() {
  const tests = readdirSync(TEST_DIR).filter(isPolicyTest).sort();
  const workflows = Object.fromEntries(
    readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => [f, readFileSync(new URL(f, WORKFLOW_DIR), "utf8")]),
  );
  return { tests, workflows };
}

const indentOf = (line) => line.length - line.trimStart().length;
const KEY = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]+):(?:\s+(.*?))?\s*$/;
const BLOCK_INDICATOR = /^([|>])[-+0-9]*(?:\s+#.*)?$/;
const isItem = (text) => text === "-" || text.startsWith("- ");

const INVOCATION = /^(node|bash|sh)\s+(["']?)(?:\.\/)?scripts\/test\/([A-Za-z0-9._-]+)\2(?:\s+#.*)?$/;
const verbFits = (verb, name) => (verb === "node" ? name.endsWith(".mjs") : name.endsWith(".sh"));

// The only other line a run block may hold: shell options, set before the
// first invocation. No quoting and no `;`, so it cannot open or close anything.
const SET_LINE = /^set(?:\s+(?:-[eux]*o\s+(?:errexit|nounset|pipefail|xtrace)|-[eux]+))+(?:\s+#.*)?$/;
const setsErrexit = (text) => /\s-[a-z]*e/.test(text) || /-o\s+errexit\b/.test(text);

/** The invocation lines of a literal `run: |` block, or none at all.
 *
 *  A block counts only WHOLE: every non-blank line must be a comment, a `set`
 *  line before the first invocation, or a direct invocation. One line of
 *  anything else — `echo '`, `f() {`, `if`, `case`, a heredoc, a `\`
 *  continuation — and no line of the block counts, because telling a later
 *  line's code from data (a quoted string, a function body, a branch not
 *  taken) takes a shell parser, and this is not one. An invocation that is not
 *  the block's last command also needs `set -e` before it, or the next
 *  command's status would replace its failure. */
function blockInvocations(content) {
  const commands = [];
  let errexit = false;
  for (const [raw, lineNo] of content) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (SET_LINE.test(line)) {
      if (commands.length > 0) return [];
      errexit ||= setsErrexit(line);
      continue;
    }
    if (!INVOCATION.test(line)) return [];
    commands.push({ line, lineNo, errexit });
  }
  return commands
    .filter((c, k) => c.errexit || k === commands.length - 1)
    .map(({ line, lineNo }) => ({ line, lineNo }));
}

/** The shell lines of every step's `run:` value in one workflow, as
 *  `{ line, lineNo }`. Only a key at `jobs.<job>.steps[<n>].run` is a step
 *  command: a `run:` under `env:`, `with:`, `defaults:`, or anywhere else is
 *  data. Lines that are not independently a command in the supported
 *  convention are left out rather than guessed at. */
function runLines(body) {
  const lines = body.split("\n");
  const out = [];
  // The mapping path to the current line, as `{ col, key }`: key is the
  // mapping key, "-" for a sequence item, or null for a line this reader does
  // not understand — which then poisons every path through it.
  const path = [];
  const enter = (col, key) => {
    while (path.length > 0 && path[path.length - 1].col >= col) path.pop();
    path.push({ col, key });
  };
  const atStepRun = () =>
    path.length === 5 &&
    path[0].key === "jobs" &&
    path[1].key !== null && path[1].key !== "-" &&
    path[2].key === "steps" &&
    path[3].key === "-" &&
    path[4].key === "run";

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "" || text.startsWith("#")) continue;
    if (isItem(text)) {
      enter(indentOf(lines[i]), "-");
      // A block scalar as the item itself (`- |`) is text, whatever it says.
      if (BLOCK_INDICATOR.test(text.slice(1).trim())) {
        while (i + 1 < lines.length && (lines[i + 1].trim() === "" || indentOf(lines[i + 1]) > indentOf(lines[i]))) i++;
        continue;
      }
    }
    const m = KEY.exec(lines[i]);
    if (!m) {
      if (!isItem(text)) enter(indentOf(lines[i]), null);
      continue;
    }
    const keyCol = lines[i].indexOf(m[2], m[1].length);
    enter(keyCol, m[2]);
    const isRun = atStepRun();
    const value = m[3] ?? "";

    // Whatever this key is, a block scalar's lines belong to it: consume them
    // so `run:` text inside, say, a `script: |` is never read as a key.
    const block = BLOCK_INDICATOR.exec(value);
    if (block) {
      const content = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() !== "" && indentOf(lines[j]) <= keyCol) break;
        content.push([lines[j], j + 1]);
      }
      i = j - 1;
      if (isRun && block[1] === "|") out.push(...blockInvocations(content)); // folded `>` joins lines
      continue;
    }

    if (!isRun || value === "") continue;
    // A plain scalar continued on more-indented lines is folded into one line.
    const next = lines.slice(i + 1).find((l) => l.trim() !== "");
    if (next !== undefined && indentOf(next) > keyCol) continue;
    let scalar = value;
    const dq = /^"([^"\\]*)"(?:\s+#.*)?$/.exec(value);
    const sq = /^'([^']*)'(?:\s+#.*)?$/.exec(value);
    if (dq) scalar = dq[1];
    else if (sq) scalar = sq[1];
    else if (/^["']/.test(value)) continue; // escapes or multi-line quoting: unsupported
    out.push({ line: scalar.trim(), lineNo: i + 1 });
  }
  return out;
}

/** `{ workflow, lineNo, line }` for every supported invocation of `name`. */
function invocationsOf(name, workflows) {
  const found = [];
  for (const [workflow, body] of Object.entries(workflows)) {
    for (const { line, lineNo } of runLines(body)) {
      const m = INVOCATION.exec(line);
      if (m && m[3] === name && verbFits(m[1], name)) found.push({ workflow, lineNo, line });
    }
  }
  return found;
}

function evaluate(w) {
  const problems = [];
  if (w.tests.length === 0) {
    problems.push("no policy tests were found at all — this scan proves nothing, and that is itself the failure");
  }
  for (const t of w.tests) {
    if (invocationsOf(t, w.workflows).length === 0) {
      problems.push(`${t}: no workflow run command invokes it — a guard CI never runs is worse than no guard`);
    }
  }
  return problems;
}

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };

const world = realWorld();
for (const p of evaluate(world)) fail(p);

// The controls. Each must hold, or this file is decoration.
let mutations = 0;
if (failed === 0) {
  // Every real invocation, deleted in turn. The comments, names and other
  // mentions stay behind — exactly what the substring search used to accept.
  for (const t of world.tests) {
    const workflows = { ...world.workflows };
    for (const { workflow, lineNo, line } of invocationsOf(t, world.workflows)) {
      const lines = workflows[workflow].split("\n");
      lines[lineNo - 1] = lines[lineNo - 1].replace(line, "true");
      workflows[workflow] = lines.join("\n");
    }
    mutations++;
    const problems = evaluate({ tests: [t], workflows });
    if (problems.length !== 1) fail(`${t}: deleting its run command(s) went unnoticed — something else still counts as running it`);
  }

  const T = "fixture-guard-test.mjs";
  const S = "fixture-guard-test.sh";
  const steps = (...lines) => `jobs:\n  j:\n    steps:\n${lines.join("\n")}\n      - run: echo tail\n`;
  const sees = (name, yml) => invocationsOf(name, { "fixture.yml": yml }).length > 0;

  const recognised = {
    "inline plain": steps(`      - run: node scripts/test/${T}`),
    "inline with trailing comment": steps(`      - run: node scripts/test/${T} # why`),
    "named step": steps(`      - name: x`, `        run: node scripts/test/${T}`),
    "single-quoted scalar": steps(`      - run: 'node scripts/test/${T}'`),
    "double-quoted scalar": steps(`      - run: "node scripts/test/${T}"`),
    "shell-quoted path": steps(`      - run: node "scripts/test/${T}"`),
    "dot-slash path": steps(`      - run: node ./scripts/test/${T}`),
    "literal block": steps(`      - run: |`, `          set -eu`, `          node scripts/test/${T}`),
    "literal block, strip chomping": steps(`      - run: |-`, ``, `          node 'scripts/test/${T}'`),
    "block of comments, set and several calls": steps(`      - run: |`, `          # why`, `          set -euo pipefail`, `          node scripts/test/${T}`, `          node scripts/test/other-test.mjs`),
    "non-last call after set -o errexit": steps(`      - run: |`, `          set -o errexit`, `          node scripts/test/${T}`, `          node scripts/test/other-test.mjs`),
    "run after other step keys": steps(`      - name: x`, `        env:`, `          A: b`, `        with:`, `          script: |`, `            run: echo`, `        run: node scripts/test/${T}`),
    "step after an env look-alike": steps(`      - env:`, `          run: echo`, `        run: true`, `      - run: node scripts/test/${T}`),
    "job with other keys, second job":
      `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: true\n  b-2:\n    if: always()\n    needs: [a]\n    steps:\n      - uses: x@v1\n      - run: node scripts/test/${T}\n`,
  };
  for (const [shape, yml] of Object.entries(recognised)) {
    mutations++;
    if (!sees(T, yml)) fail(`supported shape not recognised: ${shape}`);
  }
  for (const verb of ["bash", "sh"]) {
    mutations++;
    if (!sees(S, steps(`      - run: ${verb} scripts/test/${S}`))) fail(`supported shape not recognised: ${verb}`);
  }

  const rejected = {
    "YAML comment": steps(`      # run: node scripts/test/${T}`, `      - run: true`),
    "comment inside a block": steps(`      - run: |`, `          # node scripts/test/${T}`, `          true`),
    "step name": steps(`      - name: node scripts/test/${T}`, `        run: true`),
    "env value": steps(`      - env:`, `          GUARD: node scripts/test/${T}`, `        run: true`),
    "echo only": steps(`      - run: echo node scripts/test/${T}`),
    "deleted call": steps(`      - run: true`),
    "path prefix": steps(`      - run: node other/scripts/test/${T}`),
    "longer file name": steps(`      - run: node scripts/test/old-${T}`),
    "subdirectory": steps(`      - run: node scripts/test/sub/${T}`),
    "wrong interpreter": steps(`      - run: sh scripts/test/${T}`),
    "failure swallowed": steps(`      - run: node scripts/test/${T} || true`),
    "composite line": steps(`      - run: cd . && node scripts/test/${T}`),
    "arguments": steps(`      - run: node scripts/test/${T} --skip`),
    "continued line": steps(`      - run: |`, `          echo \\`, `          node scripts/test/${T}`),
    "heredoc body": steps(`      - run: |`, `          cat <<EOF`, `          node scripts/test/${T}`, `          EOF`),
    "folded block": steps(`      - run: >`, `          echo`, `          node scripts/test/${T}`),
    "multi-line plain scalar": steps(`      - run: node scripts/test/${T}`, `          || true`),
    "inside another key's block": steps(`      - uses: actions/github-script@v7`, `        with:`, `          script: |`, `            run: node scripts/test/${T}`),
    // An env key that happens to be called `run` is data; the step's actual
    // command is the later `run: true`.
    "env key named run": steps(`      - env:`, `          run: node scripts/test/${T}`, `        run: true`),
    "with key named run": steps(`      - uses: x@v1`, `        with:`, `          run: node scripts/test/${T}`),
    "run beside steps, not in one": `jobs:\n  j:\n    run: node scripts/test/${T}\n    steps:\n      - run: true\n`,
    "defaults run": `defaults:\n  run: node scripts/test/${T}\njobs:\n  j:\n    steps:\n      - run: true\n`,
    "steps outside jobs": `other:\n  j:\n    steps:\n      - run: node scripts/test/${T}\n`,
    "jobs not at top level": `x:\n  jobs:\n    j:\n      steps:\n        - run: node scripts/test/${T}\n`,
    "steps displaced by a key this reader cannot parse": `jobs:\n  j:\n    steps:\n    "odd":\n      - run: node scripts/test/${T}\n`,
    "steps as a mapping": `jobs:\n  j:\n    steps:\n      x:\n        run: node scripts/test/${T}\n`,
    "jobs as a sequence": `jobs:\n  - steps:\n      - run: node scripts/test/${T}\n`,
    "under a key this reader cannot parse": steps(`      - name: x`, `        "odd key":`, `          run: node scripts/test/${T}`),
    // Whole-block refusal: each of these prints, defines or skips the line.
    "single-quoted string across lines": steps(`      - run: |`, `          echo '`, `          node scripts/test/${T}`, `          '`),
    "double-quoted string across lines": steps(`      - run: |`, `          echo "`, `          node scripts/test/${T}`, `          "`),
    "function body never called": steps(`      - run: |`, `          check() {`, `          node scripts/test/${T}`, `          }`),
    "conditional branch": steps(`      - run: |`, `          if false; then`, `          node scripts/test/${T}`, `          fi`),
    "case arm": steps(`      - run: |`, `          case x in`, `          y)`, `          node scripts/test/${T}`, `          ;;`, `          esac`),
    "loop body": steps(`      - run: |`, `          for f in; do`, `          node scripts/test/${T}`, `          done`),
    "call then an unsupported line": steps(`      - run: |`, `          node scripts/test/${T}`, `          echo done`),
    "non-last call without set -e": steps(`      - run: |`, `          set -u`, `          node scripts/test/${T}`, `          node scripts/test/other-test.mjs`),
    "errexit turned back off": steps(`      - run: |`, `          set -e`, `          set +e`, `          node scripts/test/${T}`, `          node scripts/test/other-test.mjs`),
    // In shell the `#'` line closes the string; it is not a comment there.
    "quote opened on a set line": steps(`      - run: |`, `          set -e; echo '`, `          node scripts/test/${T}`, `          #'`),
    "block-scalar item in steps": steps(`      - |`, `        run: node scripts/test/${T}`),
    "key nested under run": steps(`      - run:`, `          x: node scripts/test/${T}`),
    "set after the call": steps(`      - run: |`, `          node scripts/test/${T}`, `          set -e`),
    "no workflows at all": "",
  };
  for (const [shape, yml] of Object.entries(rejected)) {
    mutations++;
    if (sees(T, yml)) fail(`look-alike counted as running the test: ${shape}`);
  }

  mutations++;
  const unwired = { ...world, tests: [...world.tests, "a-guard-nobody-runs-test.mjs"] };
  if (evaluate(unwired).length !== 1) fail("an unreferenced test was not reported — the scan does not actually check references");

  mutations++;
  const empty = { ...world, tests: [] };
  if (evaluate(empty).length !== 1) fail("an empty directory passed — the scan would be green having read nothing");
}

if (failed > 0) {
  console.error(`\nci-guard-coverage: ${failed} failure(s)`);
  process.exit(1);
}
const invocations = world.tests.reduce((n, t) => n + invocationsOf(t, world.workflows).length, 0);
console.log(`ok ci-guard-coverage: ${world.tests.length} policy tests, each invoked by a run command (${invocations} invocations across ${Object.keys(world.workflows).length} workflows; static wiring, not proof of execution); ${mutations} controls held`);
