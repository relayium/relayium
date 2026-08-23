#!/usr/bin/env node
// scripts/ci/select-lanes.mjs — which reusable lanes `merge-gate.yml` must call
// for one pull request, decided from the lanes' own path filters.
//
// ## What this replaces, and what it must never become
//
// `main`'s protection can require a context only if that context ALWAYS
// reports. A path-filtered workflow that does not trigger emits no check run at
// all, so branch protection cannot tell "lane passed" from "lane skipped
// legitimately" from "lane never ran" — which is why eight lanes report red
// today and nothing stops the merge.
//
// The aggregate gate fixes that by calling every lane itself, unconditionally
// reporting one job, and judging the lanes' results. To do that it has to know
// which lanes a diff selects, and there are exactly two ways to know:
//
//   1. a second declaration of every lane's paths, in JSON or in the gate; or
//   2. the lanes' own `on: push: paths:` lists.
//
// (1) is a drift surface whose equivalence test is harder to write than the
// selector. This file is (2). The workflows' filters stay the ONLY statement of
// what watches what, and `scripts/test/fixtures/ci-path-selection.mjs` is the
// oracle that says whether this file reads them correctly.
//
// ## Dependency-free, on purpose
//
// This runs before anything is installed, in the job that decides whether the
// expensive lanes run at all. `web/` is the only Node project here, so an
// `npm ci` in front of the merge gate would trade a checkable risk for an
// outage that blocks every merge. Node's standard library and nothing else.
//
// The YAML reader below is therefore NOT a parser. It extracts one block —
// `on.push.paths` — from one file, and throws on anything it does not
// recognise. `scripts/test/ci-event-policy-test.mjs` reads the same filters
// with a general parser and a separate glob compiler, and both are judged
// against the same fixture rows. Two implementations, one oracle: a bug in
// either shows up as a disagreement rather than as a quietly wrong gate.
//
// ## Fail closed means SELECT MORE, never less
//
// Under-selection is the only failure here that produces a GREEN gate over
// untested code. Over-selection costs runner minutes. So every uncertainty
// resolves to "run every conditional lane":
//
//   * the files API failed, or the step that called it said so;
//   * `changed_files` is missing, negative, or at or above GitHub's 3000-file cap;
//   * the response is not the shape this file understands, or its entry count
//     disagrees with `changed_files` (a truncated or half-paginated read);
//   * a lane workflow is missing, or its `push.paths` block is unreadable;
//   * a filter entry is not one of the four pattern shapes below;
//   * a control file changed — this script, the gate, or the fixture — because
//     those decide what runs, and a pull request that edits them is judged by
//     its own edit;
//   * anything at all throws.
//
// A control-file change buying a full macOS run is the honest price of that
// last rule, and it is deliberate.
//
// ## What it cannot do
//
// GitHub runs `pull_request` workflows from the PR HEAD, so a pull request that
// edits this file is selected by its own copy. The control-file rule stops the
// ACCIDENT — an innocent gate edit runs everything rather than nothing — and
// stops nothing deliberate. That is inherent to GitHub Actions; the mitigation
// is a `pull_request_target` integrity check, deliberately deferred while this
// repository has one writer. See docs/CI-PLATFORM-BOUNDARY.md.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultWorkflowsDir = resolve(repoRoot, ".github/workflows");

/**
 * The conditional lanes, and the reusable workflow each caller job calls.
 *
 * The `id` is the CALLER JOB ID in `merge-gate.yml` and the name of this
 * script's output for that lane. It is not always the workflow's own name:
 * `contracts.yml` and `ops-deploy-contract.yml` both declare a job literally
 * called `go-contract`, and the caller job id is what disambiguates the two in
 * the check list — hence `ops-contract`.
 *
 * `repo-hygiene` is deliberately absent. It carries no path filter, the gate
 * calls it with no `if:`, and a lane that always runs has nothing to select.
 * `compat` is absent for the same reason and no longer for a different one:
 * the gate now calls it, unconditionally, and `compat.yml` carries no `paths:`
 * filter either — so there is nothing here to select and the gate requires it
 * to SUCCEED on every pull request rather than to match a selection. It is
 * still the one called lane that keeps its own `pull_request:` trigger, because
 * it reports the bare `wire-vectors` context `main` requires; see
 * docs/CI-PLATFORM-BOUNDARY.md for the staged order.
 */
export const LANES = [
  { id: "web", workflow: "web.yml" },
  { id: "go", workflow: "go.yml" },
  { id: "macos", workflow: "macos.yml" },
  { id: "ios", workflow: "ios.yml" },
  { id: "swift-package", workflow: "swift-package.yml" },
  { id: "native-web-pairing", workflow: "native-web-pairing.yml" },
  { id: "contracts", workflow: "contracts.yml" },
  { id: "ops-contract", workflow: "ops-deploy-contract.yml" },
];

/**
 * Files that decide what the gate runs. Changing any of them selects every
 * lane.
 *
 * Not a general "CI files" rule: `.github/workflows/web.yml` already selects
 * the `web` lane through that lane's own filter, and widening this list to the
 * whole directory would make every workflow edit a full macOS run for no added
 * safety. These three are the ones no lane filter covers and that no lane
 * result would reflect.
 */
export const CONTROL_FILES = [
  ".github/workflows/merge-gate.yml",
  "scripts/ci/select-lanes.mjs",
  "scripts/test/fixtures/ci-path-selection.mjs",
];

/**
 * GitHub's own ceiling on `pulls/{n}/files`. At or above it the response is
 * truncated and the cumulative change set is unknowable, so the gate stops
 * pretending to know it.
 */
export const CHANGED_FILE_CAP = 3000;

/** Selecting every lane is a decision, not a crash; it carries its reason. */
export class SelectAll extends Error {}

const warn = (message) => process.stderr.write(`select-lanes: ${message}\n`);

// ── the four pattern shapes, and nothing else ───────────────────────────────

/**
 * Which of the four permitted `paths:` shapes `pattern` is, or `null`.
 *
 * A hand-written glob compiler is a bug farm, so the vocabulary is capped
 * rather than the compiler made clever. Every entry in every lane's filter
 * today is one of:
 *
 *   1. `prefix/**`            a whole tree
 *   2. `!prefix/**`           a subtree excluded from one above it
 *   3. `dir/file.ext`         one exact file, no metacharacter
 *   4. `dir/basename*`        one basename prefix (`server/account/deviceinbox*`)
 *
 * A fifth shape returns `null` and the caller selects every lane, which forces
 * whoever introduces it to teach this file and the fixture about it in the same
 * commit. Negation is permitted only on shape 1: the ordered last-match-wins
 * semantics below are subtle enough with one exclusion form, and no filter here
 * has ever needed another.
 */
export function classifyPattern(pattern) {
  if (typeof pattern !== "string" || pattern === "") return null;
  const negated = pattern.startsWith("!");
  const body = negated ? pattern.slice(1) : pattern;
  if (body === "") return null;

  if (body.endsWith("/**")) {
    const prefix = body.slice(0, -3);
    if (prefix === "" || prefix.includes("*")) return null;
    return negated ? "tree-exclusion" : "tree";
  }
  // Only a whole-tree entry may be negated.
  if (negated) return null;
  if (!body.includes("*")) return "literal";
  // `dir/basename*`: exactly one `*`, at the very end, with a real basename in
  // front of it. `dir/*` is excluded deliberately — it reads like "this
  // directory" and means "every name in it, but not below it", which is a
  // distinction nobody gets right at a glance.
  if (/^[^*]+\*$/.test(body) && !body.endsWith("/*") && body.includes("/")) return "basename";
  return null;
}

/**
 * A permitted glob, compiled to an anchored regular expression.
 *
 * `**` spans separators, `*` does not, and every other regex metacharacter is
 * escaped — so `.github/workflows/go.yml` cannot match `xgithub/workflows/go`
 * through an unescaped dot.
 *
 * Written as escape-the-gaps-between-stars rather than as a character walk,
 * which is the shape `ci-event-policy-test.mjs` uses. Same behaviour, different
 * code, on purpose: the fixture is only cross-validation if the two sides can
 * be wrong independently.
 */
export function compileGlob(body) {
  const escape = (text) => text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
  let source = "";
  let rest = body;
  for (;;) {
    const at = rest.indexOf("*");
    if (at === -1) { source += escape(rest); break; }
    source += escape(rest.slice(0, at));
    if (rest[at + 1] === "*") { source += "[\\s\\S]*"; rest = rest.slice(at + 2); }
    else { source += "[^/]*"; rest = rest.slice(at + 1); }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Would GitHub start a workflow carrying `patterns` for a change to `path`?
 *
 * ORDERED, LAST MATCH WINS — not `some()`. GitHub evaluates the list against
 * each changed file in order and the last pattern that matches decides, so a
 * `!` entry excludes and a later positive entry re-includes. Three filters here
 * follow `apps/RelayiumKit/**` with `!apps/RelayiumKit/Tests/**`; read as an
 * unordered `some()` every file in that excluded subtree would still select the
 * lane, and the whole fixture would be judging a filter nobody compiled.
 */
export function matchesFilter(patterns, path) {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (!compileGlob(body).test(path)) continue;
    matched = !negated;
  }
  return matched;
}

// ── the one block this file reads out of a workflow ─────────────────────────

/** Everything before an unquoted `#`, so a `#` inside a pattern survives. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** A sequence item's scalar, with one layer of matching quotes removed. */
function unquote(raw, where) {
  const text = raw.trim();
  if (text.length > 1 && ((text.startsWith("'") && text.endsWith("'"))
    || (text.startsWith('"') && text.endsWith('"')))) {
    return text.slice(1, -1);
  }
  if (text === "" || /["']/.test(text)) {
    throw new SelectAll(`${where}: cannot read the filter entry ${JSON.stringify(raw)}`);
  }
  return text;
}

/**
 * The `on: push: paths:` list of one workflow, verbatim.
 *
 * Deliberately an extractor and not a parser. It walks to `on:` at column 0,
 * to `push:` at two spaces, to `paths:` at four, and collects the `- ` items
 * below it. Everything else in the file is ignored, and every shape it does not
 * recognise throws — including an alias (`paths: *paths`), which no lane uses
 * on `push` and which would otherwise silently read as an empty filter.
 *
 * An empty or absent filter is an ERROR here rather than "matches everything".
 * Every lane this script selects is path-filtered by design; one that lost its
 * filter is a lane whose cost nobody decided, and the gate should say so by
 * running everything rather than by guessing which way the omission meant.
 */
export function readPushPaths(text, where) {
  const lines = text.split("\n").map(stripComment);
  const indentOf = (line) => line.length - line.trimStart().length;
  const blank = (line) => line.trim() === "";

  let i = lines.findIndex((line) => line.trimEnd() === "on:");
  if (i === -1) throw new SelectAll(`${where}: no top-level \`on:\` block`);

  let inPush = false;
  let inPaths = false;
  const paths = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (blank(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;            // the next top-level key ends `on:`
    if (indent === 2) { inPush = line.trim().startsWith("push:"); inPaths = false; continue; }
    if (!inPush) continue;
    if (indent === 4) {
      const body = line.trim();
      if (!body.startsWith("paths:")) { inPaths = false; continue; }
      const rest = body.slice("paths:".length).trim();
      // `paths: &paths` declares an anchor and keeps its list below; anything
      // else on that line — an alias, an inline sequence — is not read here.
      if (rest !== "" && !/^&[A-Za-z0-9_-]+$/.test(rest)) {
        throw new SelectAll(`${where}: \`push.paths\` is written as ${JSON.stringify(rest)}, `
          + `which this reader does not understand`);
      }
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (indent !== 6 || !line.trim().startsWith("- ")) {
      throw new SelectAll(`${where}: unexpected line inside \`push.paths\`: `
        + `${JSON.stringify(line.trim())}`);
    }
    paths.push(unquote(line.trim().slice(2), where));
  }

  if (paths.length === 0) {
    throw new SelectAll(`${where}: declares no \`push.paths\` entries, so what it watches is `
      + `unknown to the gate`);
  }
  for (const pattern of paths) {
    if (classifyPattern(pattern) === null) {
      throw new SelectAll(`${where}: the filter entry ${JSON.stringify(pattern)} is not one of `
        + `the four permitted pattern shapes`);
    }
  }
  return paths;
}

/** One lane's filter, read from disk, with a missing file failing closed. */
function laneFilter(workflowsDir, workflow) {
  let text;
  try {
    text = readFileSync(resolve(workflowsDir, workflow), "utf8");
  } catch (err) {
    throw new SelectAll(`${workflow} could not be read (${err.code ?? err.message}); a lane the `
      + `gate calls but cannot find would make the whole run fail to load`);
  }
  return readPushPaths(text, workflow);
}

// ── the decision ────────────────────────────────────────────────────────────

/**
 * The lane ids selected by `paths`, judged against the filters on disk.
 *
 * `paths` is the CUMULATIVE change set: every `filename` in the pull request's
 * files API response plus every `previous_filename`. Both halves matter. A
 * rename out of `web/` still has to run `web`, and the API is the only source
 * that reports the old path — `git diff --name-only` with default rename
 * detection reports the new path alone and would under-select, which is the one
 * failure mode that produces a green gate over untested code.
 *
 * Deletions arrive as an ordinary `filename` and select their lane, which is
 * correct: deleting `web/foo.ts` must run `web`.
 */
export function selectLanes(paths, { workflowsDir = defaultWorkflowsDir } = {}) {
  const selected = new Set();
  // Every lane's filter is read even after a match, so an unreadable filter in
  // a lane that happened not to be selected still fails closed.
  for (const lane of LANES) {
    const patterns = laneFilter(workflowsDir, lane.workflow);
    if (paths.some((path) => matchesFilter(patterns, path))) selected.add(lane.id);
  }
  return selected;
}

/**
 * The changed paths carried by a `pulls/{n}/files` response.
 *
 * Two shapes are accepted because `gh api --paginate --slurp` returns an array
 * of PAGES while a single unpaginated read returns an array of file objects.
 * A mixture is neither, and is rejected: a half-read response that still parsed
 * is exactly the silent truncation this function exists to catch.
 */
export function changedPathsOf(payload) {
  if (!Array.isArray(payload)) {
    throw new SelectAll("the pull request files response is not a JSON array");
  }
  const isObject = (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry);
  let entries;
  if (payload.length === 0) entries = [];
  else if (payload.every(Array.isArray)) entries = payload.flat();
  else if (payload.every(isObject)) entries = payload;
  else throw new SelectAll("the pull request files response mixes page arrays and file objects");

  const filenames = [];
  const all = [];
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.filename !== "string" || entry.filename === "") {
      throw new SelectAll("the pull request files response contains an entry with no `filename`");
    }
    filenames.push(entry.filename);
    all.push(entry.filename);
    const previous = entry.previous_filename;
    if (previous === undefined || previous === null) continue;
    if (typeof previous !== "string" || previous === "") {
      throw new SelectAll(`the \`previous_filename\` of ${JSON.stringify(entry.filename)} is `
        + `neither absent nor a path`);
    }
    all.push(previous);
  }
  return { filenames, all };
}

/**
 * Everything between the environment and a set of lane ids, with each
 * fail-closed condition stated once and by name.
 */
export function decide(env, { workflowsDir = defaultWorkflowsDir, readFile = readFileSync } = {}) {
  const status = env.LANE_SELECTOR_STATUS;
  if (status !== "ok") {
    throw new SelectAll(`the step that called the pull request files API reported `
      + `${JSON.stringify(status ?? null)} rather than "ok"`);
  }

  const declared = Number(env.LANE_SELECTOR_CHANGED_FILES);
  if (!Number.isInteger(declared) || declared < 0 || env.LANE_SELECTOR_CHANGED_FILES === "") {
    throw new SelectAll(`the event payload's \`changed_files\` is `
      + `${JSON.stringify(env.LANE_SELECTOR_CHANGED_FILES ?? null)}, which is not a count`);
  }
  if (declared >= CHANGED_FILE_CAP) {
    throw new SelectAll(`the pull request declares ${declared} changed files, at or above `
      + `GitHub's ${CHANGED_FILE_CAP}-file API cap, so the cumulative change set is not knowable`);
  }

  const filesPath = env.LANE_SELECTOR_FILES;
  if (typeof filesPath !== "string" || filesPath === "") {
    throw new SelectAll("no pull request files payload was handed to the selector");
  }
  let payload;
  try {
    payload = JSON.parse(readFile(filesPath, "utf8"));
  } catch (err) {
    throw new SelectAll(`the pull request files payload could not be read or parsed: ${err.message}`);
  }

  const { filenames, all } = changedPathsOf(payload);
  // The count the event declared and the count the API returned must agree.
  // They disagree when pagination stopped early or a page was dropped, and a
  // short list under-selects — silently, and in the one direction that matters.
  if (filenames.length !== declared) {
    throw new SelectAll(`the files API returned ${filenames.length} file(s) but the event `
      + `declares ${declared} changed file(s)`);
  }

  for (const control of CONTROL_FILES) {
    if (all.includes(control)) {
      throw new SelectAll(`${control} is part of this pull request, and it decides what the gate `
        + `runs; a change to it is judged by running every lane`);
    }
  }

  return selectLanes(all, { workflowsDir });
}

// ── the self-test ───────────────────────────────────────────────────────────

/**
 * The proof that this file still does what the gate assumes, runnable with
 * nothing installed and nothing checked out but this repository.
 *
 * It exists for the same reason `scripts/list-go-fuzz-targets.sh --self-test`
 * does: every fail-closed branch above is a branch that has never been observed
 * failing in production, and a fail-closed check nobody has seen fail is
 * indistinguishable from a broken one.
 *
 * `scripts/test/ci-lane-selector-test.mjs` judges this file against the shared
 * fixture; this proves the parts that fixture cannot reach — the reader's own
 * shape handling, the pattern vocabulary, and that each fail-closed condition
 * really selects every lane.
 */
const FIXTURE = `name: fixture
on:
  push:
    branches:
      - main
    paths: &paths
      - 'web/**'            # a tree
      - '!web/node_modules/**'
      - 'server/account/deviceinbox*'
      - 'docs/a#b.md'
  pull_request:
    paths: *paths
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
`;

function selfTest() {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const threw = (fn) => {
    try { fn(); return null; } catch (err) { return err; }
  };

  // 1. The reader, against a document exercising every construct it meets: an
  //    anchor on the key, a quoted `#` inside a value, a trailing comment, a
  //    negation, and an aliased `pull_request` block it must NOT read.
  const read = readPushPaths(FIXTURE, "fixture");
  need(
    JSON.stringify(read) === JSON.stringify([
      "web/**", "!web/node_modules/**", "server/account/deviceinbox*", "docs/a#b.md",
    ]),
    `the push.paths reader produced ${JSON.stringify(read)}`,
  );

  // 2. The vocabulary: the four shapes, and a fifth that must be refused.
  for (const [pattern, want] of [
    ["web/**", "tree"],
    ["!apps/RelayiumKit/Tests/**", "tree-exclusion"],
    [".github/workflows/go.yml", "literal"],
    ["server/account/deviceinbox*", "basename"],
  ]) {
    need(classifyPattern(pattern) === want,
      `classifyPattern(${JSON.stringify(pattern)}) is ${JSON.stringify(classifyPattern(pattern))}, `
      + `want ${JSON.stringify(want)}`);
  }
  for (const pattern of ["**/*.ts", "web/*", "!web/foo.ts", "a*b*", "*", "", "!"]) {
    need(classifyPattern(pattern) === null,
      `classifyPattern(${JSON.stringify(pattern)}) accepted a shape outside the vocabulary`);
  }

  // 3. The matcher, including the ordering the exclusions depend on.
  const ordered = ["apps/RelayiumKit/**", "!apps/RelayiumKit/Tests/**"];
  for (const [patterns, path, want] of [
    [ordered, "apps/RelayiumKit/Sources/A.swift", true],
    [ordered, "apps/RelayiumKit/Tests/A.swift", false],
    [["!apps/RelayiumKit/Tests/**", "apps/RelayiumKit/**"], "apps/RelayiumKit/Tests/A.swift", true],
    [["server/account/deviceinbox*"], "server/account/deviceinbox_test.go", true],
    [["server/account/deviceinbox*"], "server/account/deviceinbox/sub.go", false],
    [[".github/workflows/go.yml"], "xgithub/workflows/go_yml", false],
    [["web/**"], "web", false],
  ]) {
    need(matchesFilter(patterns, path) === want,
      `matchesFilter(${JSON.stringify(patterns)}, ${JSON.stringify(path)}) is `
      + `${matchesFilter(patterns, path)}, want ${want}`);
  }

  // 4. Every fail-closed condition, one at a time, each proved to reach the
  //    all-lanes branch rather than merely to throw something.
  const files = "/nonexistent/pr-files.json";
  const ok = { LANE_SELECTOR_STATUS: "ok", LANE_SELECTOR_CHANGED_FILES: "1", LANE_SELECTOR_FILES: files };
  const payload = (value) => ({ readFile: () => JSON.stringify(value) });
  for (const [why, env, options] of [
    ["a failed API step", { ...ok, LANE_SELECTOR_STATUS: "api-error" }, payload([])],
    ["a missing changed_files", { ...ok, LANE_SELECTOR_CHANGED_FILES: undefined }, payload([])],
    ["a non-numeric changed_files", { ...ok, LANE_SELECTOR_CHANGED_FILES: "many" }, payload([])],
    ["the 3000-file cap", { ...ok, LANE_SELECTOR_CHANGED_FILES: String(CHANGED_FILE_CAP) }, payload([])],
    ["no payload path", { ...ok, LANE_SELECTOR_FILES: "" }, payload([])],
    ["an unreadable payload", ok, { readFile: () => { throw new Error("ENOENT"); } }],
    ["a payload that is not JSON", ok, { readFile: () => "{" }],
    ["a payload that is not an array", ok, payload({ files: [] })],
    ["an entry with no filename", ok, payload([{ status: "added" }])],
    ["a mixed page/object payload", { ...ok, LANE_SELECTOR_CHANGED_FILES: "2" },
      payload([[{ filename: "web/a.ts" }], { filename: "web/b.ts" }])],
    ["a short response", { ...ok, LANE_SELECTOR_CHANGED_FILES: "2" }, payload([{ filename: "web/a.ts" }])],
    ...CONTROL_FILES.map((control) => [
      `a change to ${control}`, ok, payload([{ filename: control }]),
    ]),
  ]) {
    const err = threw(() => decide(env, options));
    need(err instanceof SelectAll,
      `${why} did not fail closed; decide() ${err === null ? "returned a selection" : `threw ${err}`}`);
  }

  // 5. And the real filters on disk are readable and inside the vocabulary.
  //    This is the branch that would otherwise only be exercised by the very
  //    pull request that broke it, in the job that decides whether the
  //    expensive lanes run.
  for (const lane of LANES) {
    const err = threw(() => laneFilter(defaultWorkflowsDir, lane.workflow));
    need(err === null, `${lane.workflow} is not readable as a lane filter: ${err?.message}`);
  }

  if (problems.length === 0) {
    process.stdout.write(`select-lanes: self-test OK (${LANES.length} lanes)\n`);
    return 0;
  }
  for (const problem of problems) warn(`self-test: ${problem}`);
  return 1;
}

// ── the command ─────────────────────────────────────────────────────────────

function main(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") return selfTest();
  if (argv.length > 0) {
    warn(`unknown argument ${JSON.stringify(argv[0])}; usage: select-lanes.mjs [--self-test]`);
    return 2;
  }

  let selected;
  try {
    selected = decide(process.env);
    warn(`selected [${[...selected].join(", ") || "none"}]`);
  } catch (err) {
    // Every fail-closed condition lands here, and so does anything unforeseen.
    // The reason is printed because a full macOS run with no explanation is how
    // a fail-closed gate acquires a reputation for being broken.
    warn(`selecting every conditional lane: ${err instanceof SelectAll ? err.message : `${err}`}`);
    selected = new Set(LANES.map((lane) => lane.id));
  }

  // Exactly one line per lane, exactly the lane ids the gate's roster names.
  // A missing or extra key is a roster mismatch the gate fails on, so this loop
  // is deliberately over the table rather than over what was selected.
  for (const lane of LANES) process.stdout.write(`${lane.id}=${selected.has(lane.id)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
