#!/usr/bin/env node
// scripts/test/ci-lane-selector-test.mjs — the merge gate's lane selection,
// judged against the same oracle the trigger policy is judged against.
//
// ## What can go wrong here, and why nothing else would see it
//
// `merge-gate.yml` is the one status `main`'s protection can require, and it
// only means anything if the lanes it calls are the lanes the change set
// actually needs. `scripts/ci/select-lanes.mjs` decides that, from the lanes'
// own `push.paths` filters. Two ways of getting it wrong leave every workflow
// syntactically valid, actionlint happy and the board green:
//
//   * SELECT TOO MUCH and a documentation edit buys a 60-minute signing lane
//     and a 75-minute iOS build. Expensive, visible, self-correcting.
//   * SELECT TOO LITTLE and the required gate reports GREEN over code that no
//     lane compiled. That is the fail-open shape the aggregate exists to close,
//     arriving through the aggregate itself, and nothing downstream reports it.
//
// So the selection is asserted as a SET per path — too broad and too narrow
// fail the same way — against `scripts/test/fixtures/ci-path-selection.mjs`.
//
// ## Why that fixture and not a table in this file
//
// `scripts/test/ci-event-policy-test.mjs` judges the same 28 rows with a
// completely different implementation: a general YAML parser and a
// character-walking glob compiler, where the selector carries a narrow
// `on.push.paths` extractor and a split-on-stars compiler. One oracle, two
// readers. Emptying a lane's `push.paths` therefore fails in BOTH files from
// one edit; had the rows been copied into each, a copy-paste would have made
// the two agree while both were wrong.
//
// ## And the closure nothing else can state
//
// A lane can be added to `select-lanes.mjs` and left out of the gate's `uses:`;
// added to `uses:` and left out of `needs:`; or given an `if:` that reads a
// selector output nobody publishes. Each is silent — the gate goes green with
// the lane never running. Section 5 asserts the three-way closure across all
// three declarations, including that every condition uses the BRACKET form,
// because `needs.select.outputs.swift-package` is parsed as subtraction and
// evaluates to the empty string.
//
// ## Section 7 is what makes the rest of this file worth running
//
// Every rule above is mutated in a copy of the real workflows and required to
// complain by its own wording. A policy check that has never been observed
// failing is indistinguishable from one that cannot.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PATH_MATRIX } from "./fixtures/ci-path-selection.mjs";
import {
  CHANGED_FILE_CAP,
  CONTROL_FILES,
  LANES,
  SelectAll,
  classifyPattern,
  decide,
  matchesFilter,
  readPushPaths,
  selectLanes,
} from "../ci/select-lanes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

const GATE = "merge-gate.yml";
const SELECT_JOB = "select";
const GATE_JOB = "merge-gate";
/**
 * Called with no condition, and therefore not selectable.
 *
 * ORDER IS LOAD-BEARING: the gate's `UNCONDITIONAL_LANES` shell literal is
 * compared against this array WITHOUT sorting, so the two are the same sequence
 * or the check below fails by name.
 *
 * `compat` is here rather than among the selector's lanes because `compat.yml`
 * carries no `paths:` filter at all — a wire-compatibility contract a new
 * platform can route around by existing is not a contract — so there is nothing
 * for the selector to select and the gate requires it to SUCCEED on every pull
 * request.
 *
 * It used also to be the one called lane that KEPT its own `pull_request:`
 * trigger, and that exception is gone: protection edit B made `merge-gate` the
 * sole required context, so the bare `wire-vectors` compat reported directly
 * stopped being what a pull request is judged against, and the direct trigger
 * came out. Section 1's ban on that trigger still iterates the SELECTOR's lanes
 * rather than every lane the gate calls, because those are the lanes this file
 * owns; compat's trigger shape — `push: main` and `workflow_call` present,
 * `pull_request` absent, permanently — is asserted by
 * `scripts/test/ci-event-policy-test.mjs`'s GOVERNED table, and §6o there owns
 * the input and concurrency surface the retired discriminator left behind.
 */
const UNCONDITIONAL = ["compat", "repo-hygiene"];

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const laneIds = LANES.map((lane) => lane.id);
const laneIdOf = (workflow) => LANES.find((lane) => lane.workflow === workflow)?.id;

// ── 1. the lanes the selector names are real, called workflows ──────────────

for (const lane of LANES) {
  let text = null;
  try {
    text = readFileSync(resolve(workflowsDir, lane.workflow), "utf8");
  } catch {
    check(false, `${lane.workflow} is named by the selector as lane \`${lane.id}\`, but it is not `
      + `in .github/workflows/. The gate's \`uses:\` would be unresolvable and the WHOLE run `
      + `would fail to load — fail closed, but opaque: \`merge-gate\` never reports at all, and `
      + `the merge box shows a missing required check rather than a red one.`);
    continue;
  }
  check(
    /^\s{2}workflow_call:\s*$/m.test(text),
    `${lane.workflow} declares no \`workflow_call:\`, so \`${GATE}\` cannot call it. A lane the `
    + `gate cannot call is a lane that never runs on a pull request at all.`,
  );
  check(
    !/^\s{2}pull_request:\s*$/m.test(text),
    `${lane.workflow} still declares its own \`pull_request:\` trigger. It would then run TWICE `
    + `for every commit on a branch with an open pull request — once directly, once through the `
    + `gate — which is the duplicate this conversion exists to avoid.`,
  );
}

// ── 2. the pattern vocabulary, capped on purpose ────────────────────────────
//
// A hand-written glob compiler is a bug farm, so the compiler stays general and
// the VOCABULARY stays narrow: four shapes, asserted here. A fifth fails by
// name, which forces whoever introduces it to teach the selector, the policy
// test's compiler and the fixture about it in the same commit — rather than
// discovering the disagreement as a lane that silently stopped being selected.

const shapesSeen = new Map();
for (const lane of LANES) {
  let patterns;
  try {
    patterns = readPushPaths(readFileSync(resolve(workflowsDir, lane.workflow), "utf8"), lane.workflow);
  } catch (err) {
    check(false, `${lane.workflow}: the selector cannot read its \`push.paths\`: ${err.message}. `
      + `That filter is the only statement of what this lane watches, so an unreadable one makes `
      + `the gate select every lane on every pull request.`);
    continue;
  }
  for (const pattern of patterns) {
    const shape = classifyPattern(pattern);
    check(
      shape !== null,
      `${lane.workflow}: the filter entry ${JSON.stringify(pattern)} is a FIFTH pattern shape. `
      + `The permitted four are \`prefix/**\`, \`!prefix/**\`, an exact literal path and `
      + `\`dir/basename*\`. Extend \`classifyPattern\`, the policy test's compiler and the shared `
      + `fixture together, in this commit — a shape only one of the two implementations `
      + `understands is a lane the gate and the policy disagree about.`,
    );
    if (shape !== null) shapesSeen.set(shape, (shapesSeen.get(shape) ?? 0) + 1);
  }
}
// Every shape the vocabulary permits must actually occur, or the assertion
// above is passing on shapes nothing exercises.
for (const shape of ["tree", "tree-exclusion", "literal", "basename"]) {
  check(
    (shapesSeen.get(shape) ?? 0) > 0,
    `no lane filter uses the \`${shape}\` pattern shape any more, so the matcher's handling of it `
    + `is judged by nothing on disk. Either a filter changed and this vocabulary should shrink `
    + `with it, or an entry was lost.`,
  );
}

// ── 3. the trigger matrix, as lane selection ────────────────────────────────
//
// The same rows `ci-event-policy-test.mjs` compiles against its own parser, run
// through the selector the gate actually executes. `want` names path-filtered
// WORKFLOWS; the selector answers in lane ids, and the two are mapped through
// the selector's own table so a renamed lane fails here rather than silently
// mapping to nothing.

for (const [path, want, why] of PATH_MATRIX) {
  const wantIds = want.map((workflow) => {
    const id = laneIdOf(workflow);
    check(
      id !== undefined,
      `the shared fixture expects ${JSON.stringify(path)} to start ${workflow}, but the selector `
      + `names no lane for that workflow. A lane dropped from \`LANES\` stops being called by the `
      + `gate while every fixture row that names it keeps passing through this hole.`,
    );
    return id;
  }).filter((id) => id !== undefined).sort();

  let got;
  try {
    got = [...selectLanes([path])].sort();
  } catch (err) {
    check(false, `selecting lanes for ${JSON.stringify(path)} threw: ${err.message}`);
    continue;
  }
  check(
    deepEqual(got, wantIds),
    `changing "${path}" selects [${got.join(", ")}]; want [${wantIds.join(", ")}] — ${why}.`,
  );
}

// ── 4. renames, deletions, the cap, the control files, every error path ─────
//
// Everything section 3 cannot reach, because it hands the selector a bare path
// list while the gate hands it a files-API response.

/** A `pulls/{n}/files` response, as `gh api --paginate --slurp` returns one. */
const response = (...files) => ({
  LANE_SELECTOR_STATUS: "ok",
  LANE_SELECTOR_CHANGED_FILES: String(files.length),
  LANE_SELECTOR_FILES: "(in memory)",
  __payload: [files],
});
const run = (env) => decide(env, { readFile: () => JSON.stringify(env.__payload) });

const renamed = run(response({
  filename: "docs/moved-away.md",
  previous_filename: "web/src/lib/pair.ts",
  status: "renamed",
}));
check(
  renamed.has("web") && renamed.has("native-web-pairing"),
  `a rename OUT of \`web/\` selected [${[...renamed].join(", ")}], which does not include the `
  + `lanes that watch the path it left. The files API reports \`previous_filename\` precisely so `
  + `this case is visible; \`git diff --name-only\` with default rename detection reports the new `
  + `path alone, and a lane that stops being selected by a rename is a GREEN gate over code that `
  + `no suite compiled.`,
);

const deleted = run(response({ filename: "web/src/lib/pair.ts", status: "removed" }));
check(
  deleted.has("web"),
  `deleting \`web/src/lib/pair.ts\` selected [${[...deleted].join(", ")}]. A deletion is an `
  + `ordinary change to that path and must run the lane that owns it — deleting a module is `
  + `exactly when its suite has something to say.`,
);

/** Every condition that must resolve to "run every conditional lane". */
const FAIL_CLOSED = [
  {
    name: "the files API step reported a failure",
    env: { ...response({ filename: "docs/x.md" }), LANE_SELECTOR_STATUS: "api-error-1" },
  },
  {
    name: "the change set is at GitHub's 3000-file API cap",
    env: { ...response({ filename: "docs/x.md" }), LANE_SELECTOR_CHANGED_FILES: String(CHANGED_FILE_CAP) },
  },
  {
    name: "`changed_files` is absent from the event",
    env: { ...response({ filename: "docs/x.md" }), LANE_SELECTOR_CHANGED_FILES: undefined },
  },
  {
    name: "the response is short of the count the event declared",
    env: { ...response({ filename: "docs/x.md" }), LANE_SELECTOR_CHANGED_FILES: "9" },
  },
  {
    name: "the response is malformed",
    env: { ...response({ filename: "docs/x.md" }), __payload: { files: [] } },
  },
  {
    name: "an entry carries no `filename`",
    env: { ...response({ filename: "docs/x.md" }), __payload: [[{ status: "added" }]] },
  },
  ...CONTROL_FILES.map((control) => ({
    name: `${control} is part of the change set`,
    env: response({ filename: control }),
  })),
];

for (const { name, env } of FAIL_CLOSED) {
  let thrown = null;
  try {
    run(env);
  } catch (err) {
    thrown = err;
  }
  check(
    thrown instanceof SelectAll,
    `${name}: the selector did not fail closed — it `
    + `${thrown === null ? "returned a selection" : `threw ${thrown}`}. Every uncertainty here `
    + `must select EVERY conditional lane. Over-selection costs runner minutes; under-selection `
    + `is a green required gate over untested code, and only one of those is recoverable.`,
  );
}

// And the other direction: an ordinary change must NOT select everything, or
// the rules above would be satisfied by a selector that always says yes.
const ordinary = run(response({ filename: "contracts/ops-deploy-v1.json" }));
check(
  deepEqual([...ordinary].sort(), ["ops-contract"]),
  `an ordinary one-file change selected [${[...ordinary].join(", ")}], want [ops-contract]. A `
  + `selector that fails closed on everything is a selector that has stopped selecting, and the `
  + `gate would take a PAID macOS runner on every pull request.`,
);

// The list itself, stated here as well as in the selector.
//
// Every case above iterates `CONTROL_FILES`, so REMOVING an entry would make
// the loop check one thing fewer and pass — the classic shape of a rule that
// weakens itself. These three are named because they are the files that decide
// what runs: the gate, the selector, and the oracle both readers are judged
// against. A change to any of them is judged by its own edit (GitHub runs
// `pull_request` workflows from the PR head), so the only honest answer is to
// run everything.
//
// Deliberately not the whole of `.github/workflows/`: every lane workflow
// already selects its own lane through that lane's filter, and widening this
// list would buy a full macOS run for every workflow edit with nothing gained.
check(
  deepEqual(CONTROL_FILES.slice().sort(), [
    ".github/workflows/merge-gate.yml",
    "scripts/ci/select-lanes.mjs",
    "scripts/test/fixtures/ci-path-selection.mjs",
  ].sort()),
  `the selector's control-file list is [${CONTROL_FILES.join(", ")}]. Dropping an entry makes a `
  + `pull request that edits the gate, the selector or the shared oracle select lanes by its own `
  + `modified rule and nothing else — and every fail-closed case above would keep passing, `
  + `because they iterate this list.`,
);

// ── 5. lane / uses / needs closure, in the gate itself ──────────────────────

const gateText = (() => {
  try {
    return readFileSync(resolve(workflowsDir, GATE), "utf8");
  } catch {
    check(false, `${GATE} is missing. It is the workflow that calls every lane and reports the `
      + `one always-present context \`main\` can require; without it nothing below is checked and `
      + `every lane is `
      + `once again unreachable from a pull request.`);
    return null;
  }
})();

/**
 * The gate's jobs, as raw blocks keyed by job id.
 *
 * Read structurally rather than parsed: this file must run with nothing
 * installed, and the closure below is about which STRINGS appear under which
 * job key — `uses:`, `if:`, `needs:` — not about a document model.
 */
function gateJobs(text) {
  const out = new Map();
  const lines = text.split("\n");
  let inJobs = false;
  let current = null;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const key = /^ {2}([A-Za-z0-9_][\w.-]*):\s*$/.exec(line)?.[1];
    if (key !== undefined) { current = key; out.set(key, []); continue; }
    if (current !== null) out.get(current).push(line);
  }
  return new Map([...out].map(([key, body]) => [key, body.join("\n")]));
}

if (gateText !== null) {
  const jobs = gateJobs(gateText);
  const jobIds = [...jobs.keys()];

  check(
    jobs.has(GATE_JOB),
    `${GATE} declares no \`${GATE_JOB}\` job; it declares [${jobIds.join(", ")}]. That job key `
    + `and its \`name:\` are the required status context, so its absence un-requires the gate `
    + `silently — protection would be waiting on a context nothing reports.`,
  );
  check(
    new RegExp(`^ {4}name: ${GATE_JOB}\\s*$`, "m").test(jobs.get(GATE_JOB) ?? ""),
    `${GATE}/${GATE_JOB} does not declare \`name: ${GATE_JOB}\`. The check-run name is what `
    + `branch protection matches, and a job that falls back to its key today is one rename away `
    + `from reporting a context nothing requires.`,
  );

  // The callers: exactly the selector's lanes plus the unconditional ones, one
  // `uses:` each. This list is every job in the gate that declares `uses:`, so
  // the per-caller rules below — local path, callee on disk, no
  // `timeout-minutes:`, no `secrets: inherit` — bind the unconditional lanes as
  // well, and always have. `ci-event-policy-test.mjs` §6n carries the stricter
  // per-lane rule that only `macos` may be forwarded any secret at all.
  const callerIds = jobIds.filter((id) => /^\s{4}uses:/m.test(jobs.get(id) ?? ""));
  check(
    deepEqual(callerIds.slice().sort(), [...laneIds, ...UNCONDITIONAL].sort()),
    `${GATE} calls [${callerIds.join(", ")}]; the selector names [${laneIds.join(", ")}] plus the `
    + `unconditional [${UNCONDITIONAL.join(", ")}]. A lane in the selector and not in the gate is `
    + `never called; a lane called and not selected by anything can only ever be skipped, and the `
    + `gate's two-way rule would then require it to be skipped forever.`,
  );

  for (const id of callerIds) {
    const body = jobs.get(id) ?? "";
    const target = /^\s{4}uses:\s*(\S+)\s*$/m.exec(body)?.[1];
    check(
      target !== undefined && /^\.\/\.github\/workflows\/[\w.-]+$/.test(target),
      `${GATE}/${id} declares \`uses: ${JSON.stringify(target)}\`. It must be a LOCAL path into `
      + `this repository's own \`.github/workflows/\`, so the lane that runs is the definition `
      + `under review — a remote or tagged reference judges the pull request by somebody else's `
      + `copy of the lane.`,
    );
    if (target !== undefined && target.startsWith("./")) {
      const file = target.replace(/^\.\//, "");
      let exists = true;
      try {
        readFileSync(resolve(repoRoot, file), "utf8");
      } catch {
        exists = false;
      }
      check(
        exists,
        `${GATE}/${id} calls ${file}, which is not on disk. GitHub fails the ENTIRE run to load, `
        + `so \`${GATE_JOB}\` never reports and the merge box shows a missing required check `
        + `rather than a red one — fail closed, and nearly impossible to diagnose from the PR.`,
      );
    }
    check(
      !/^\s{4}timeout-minutes:/m.test(body),
      `${GATE}/${id} declares \`timeout-minutes:\` on a \`uses:\` job. GitHub rejects that key on `
      + `a reusable-workflow call and the whole run fails to load; the budget belongs to the `
      + `called workflow's own jobs, where it already is.`,
    );
    check(
      !/secrets:\s*inherit/.test(body),
      `${GATE}/${id} declares \`secrets: inherit\`. That hands the callee EVERY secret this `
      + `repository holds — the signing certificate and the provisioning profiles today, whatever `
      + `is added tomorrow — to lanes that read no secret at all. Forward secrets one line at a `
      + `time or not at all.`,
    );
  }

  // The conditions: bracket form, reading this lane's own selector output.
  for (const id of laneIds) {
    const body = jobs.get(id) ?? "";
    const condition = /^\s{4}if:\s*(.+?)\s*$/m.exec(body)?.[1];
    check(
      condition === `needs.select.outputs['${id}'] == 'true'`,
      `${GATE}/${id} declares \`if: ${JSON.stringify(condition)}\`; want `
      + `\`needs.select.outputs['${id}'] == 'true'\`. BRACKET form, and not for tidiness: a hyphen `
      + `in an expression property path is parsed as SUBTRACTION, so `
      + `\`needs.select.outputs.${id}\` evaluates to the empty string, the condition is false on `
      + `every pull request, and the lane silently never runs while the gate stays green because `
      + `it was "not selected".`,
    );
  }
  for (const id of UNCONDITIONAL) {
    check(
      !/^\s{4}if:/m.test(jobs.get(id) ?? ""),
      `${GATE}/${id} has grown an \`if:\`. This lane hosts the guards every change must pass — `
      + `it carries no path filter for the same reason — so nothing may stand between a pull `
      + `request and it.`,
    );
  }

  // The `needs:` closure. A lane called above and missing here is invisible to
  // the aggregate: it can fail while `merge-gate` reports success.
  const needs = [...(jobs.get(GATE_JOB) ?? "").matchAll(/^\s{6}- (\S+)\s*$/gm)].map((m) => m[1]);
  check(
    deepEqual(needs.slice().sort(), [SELECT_JOB, ...laneIds, ...UNCONDITIONAL].sort()),
    `${GATE}/${GATE_JOB} depends on [${needs.join(", ")}]; want exactly `
    + `[${[SELECT_JOB, ...laneIds, ...UNCONDITIONAL].join(", ")}]. A lane called by the gate and `
    + `absent from \`needs:\` is a lane the aggregate cannot see: it can fail while `
    + `\`${GATE_JOB}\` reports success, which is the fail-open state this whole workflow exists `
    + `to replace.`,
  );
  check(
    /^\s{4}if:\s*always\(\)\s*$/m.test(jobs.get(GATE_JOB) ?? ""),
    `${GATE}/${GATE_JOB} does not declare \`if: always()\`. Without it the aggregate is SKIPPED `
    + `the moment any lane fails, and a skipped required context is an absent one — the merge box `
    + `would show nothing rather than red.`,
  );

  // The roster the aggregate judges, and the roster it depends on, are the
  // same set. The step's roster is a hardcoded literal on purpose; this is what
  // stops it from drifting away from the jobs above.
  const rosterOf = (name) => {
    const value = new RegExp(`^\\s*${name}='([^']*)'\\s*$`, "m").exec(jobs.get(GATE_JOB) ?? "")?.[1];
    return value === undefined ? null : value.split(/\s+/).filter(Boolean);
  };
  const conditionalRoster = rosterOf("CONDITIONAL_LANES");
  const unconditionalRoster = rosterOf("UNCONDITIONAL_LANES");
  check(
    conditionalRoster !== null && deepEqual(conditionalRoster.slice().sort(), laneIds.slice().sort()),
    `${GATE}/${GATE_JOB}'s CONDITIONAL_LANES roster is `
    + `${JSON.stringify(conditionalRoster)}; want the selector's lanes `
    + `[${laneIds.join(", ")}]. The roster is hardcoded so the aggregate fails on a missing key `
    + `rather than iterating whatever it was handed — which means it has to be kept equal to the `
    + `lanes, and this is what keeps it equal.`,
  );
  check(
    unconditionalRoster !== null && deepEqual(unconditionalRoster, UNCONDITIONAL),
    `${GATE}/${GATE_JOB}'s UNCONDITIONAL_LANES roster is `
    + `${JSON.stringify(unconditionalRoster)}; want [${UNCONDITIONAL.join(", ")}]. A lane moved `
    + `out of this roster stops being required to SUCCEED and starts being required to be `
    + `skipped — the wrong direction, silently.`,
  );

  // The gate is the one workflow with no path filter and no `push:`.
  check(
    !/^\s{2}push:/m.test(gateText),
    `${GATE} has grown a \`push:\` trigger. \`main\` is verified by each lane's own `
    + `\`push: branches: [main]\`, and routing it through the gate instead would stop every lane `
    + `from reporting a check run ON the \`main\` commit — which is what \`relayium-ops\`' `
    + `\`deploy/promote.sh\` reads before it promotes.`,
  );
  check(
    /^\s{2}pull_request:\s*$/m.test(gateText) && !/^\s{2}pull_request:\s*\n\s{4}paths:/m.test(gateText),
    `${GATE}'s \`pull_request:\` trigger is missing or has grown a path filter. A filtered gate `
    + `does not report on the changes it filters out, and a required context that sometimes does `
    + `not report blocks every pull request that does not select it.`,
  );
}

// ── 6. no other job in this repository may be named `merge-gate` ────────────
//
// The `app_id` binding branch protection uses answers a differently-owned check
// posting the same context. It cannot answer a SECOND job of this name in this
// repository: that is the same app, posting the same context, and which run the
// merge box reconciles the requirement against is not a property this
// repository controls.

const jobNameHosts = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name) && name !== GATE)
  .filter((name) => {
    const text = readFileSync(resolve(workflowsDir, name), "utf8");
    return new RegExp(`^ {2}${GATE_JOB}:\\s*$`, "m").test(text)
      || new RegExp(`^ {4}name: ${GATE_JOB}\\s*$`, "m").test(text);
  })
  .sort();
check(
  jobNameHosts.length === 0,
  `[${jobNameHosts.join(", ")}] also declare a job named \`${GATE_JOB}\`. That is the required `
  + `status context: a second job of this name is the same GitHub App posting the same context, `
  + `so an unrelated green lane can satisfy the requirement on behalf of the aggregate that never `
  + `ran. Only ${GATE} may declare it.`,
);

// ── 7. the proof that sections 2, 3 and 4 can fail ──────────────────────────
//
// Each case breaks ONE property in a COPY of the real workflows and requires
// the matching complaint by its own wording. A world is a temporary directory
// of workflow files, because that is exactly the interface the selector reads.

function world(mutate) {
  const dir = mkdtempSync(resolve(tmpdir(), "relayium-lane-selector-"));
  const files = new Map(
    LANES.map((lane) => [lane.workflow, readFileSync(resolve(workflowsDir, lane.workflow), "utf8")]),
  );
  mutate(files);
  for (const [name, text] of files) writeFileSync(resolve(dir, name), text);
  return dir;
}

/** Replace one lane's whole `push.paths` sequence with `entries`. */
function withPaths(files, workflow, entries) {
  const text = files.get(workflow);
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^ {4}paths:/.test(line));
  if (at === -1) throw new Error(`${workflow} declares no \`push.paths\` to replace`);
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^ {6}/.test(lines[end]))) end += 1;
  files.set(workflow, [
    ...lines.slice(0, at + 1),
    ...entries.map((entry) => `      - '${entry}'`),
    ...lines.slice(end),
  ].join("\n"));
}

const MUTATIONS = [
  {
    name: "a lane's path filter is emptied",
    mutate: (files) => withPaths(files, "go.yml", []),
    // The same edit must fail in ci-event-policy-test.mjs's PATH_MATRIX rows.
    // That is the cross-validation, and it is why the fixture is shared.
    expect: /go\.yml: declares no `push\.paths` entries/,
    onSelect: true,
  },
  {
    name: "a lane's filter grows a fifth pattern shape",
    mutate: (files) => withPaths(files, "contracts.yml", ["contracts/**/*.json"]),
    expect: /is not one of the four permitted pattern shapes/,
    onSelect: true,
  },
  {
    name: "a lane workflow is deleted out from under the gate",
    mutate: (files) => files.delete("swift-package.yml"),
    expect: /swift-package\.yml could not be read/,
    onSelect: true,
  },
  {
    name: "a lane's filter is widened to a tree it does not own",
    mutate: (files) => withPaths(files, "contracts.yml", [
      "contracts/device-inbox-admission-v1.json", "apps/**", ".github/workflows/contracts.yml",
    ]),
    path: "apps/ios/Relayium/RelayiumApp.swift",
    expectSelected: ["contracts", "ios"],
  },
  {
    name: "a lane's filter is narrowed off the tree it owns",
    mutate: (files) => withPaths(files, "web.yml", [".github/workflows/web.yml"]),
    path: "web/src/lib/pair.ts",
    expectSelected: ["native-web-pairing"],
  },
  {
    name: "an ordered exclusion is moved above the pattern it qualifies",
    mutate: (files) => withPaths(files, "macos.yml", [
      "!apps/RelayiumKit/Tests/**", "apps/mac/**", "apps/RelayiumKit/**",
      ".github/workflows/macos.yml",
    ]),
    path: "apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json",
    // With the negation first the positive re-includes the excluded subtree,
    // so macOS starts on a test-only edit again. `web` is expected: it names
    // that fixture one file at a time on purpose.
    expectSelected: ["macos", "swift-package", "web"],
  },
];

for (const { name, mutate, expect, expectSelected, path, onSelect } of MUTATIONS) {
  let dir;
  try {
    dir = world(mutate);
  } catch (err) {
    check(false, `the lane-selector mutation "${name}" could not build its world: ${err.message}. `
      + `A mutation that stopped applying leaves the world unbroken, and its case would then pass `
      + `while asserting nothing.`);
    continue;
  }
  let got = null;
  let thrown = null;
  try {
    got = [...selectLanes([path ?? "web/src/lib/pair.ts"], { workflowsDir: dir })].sort();
  } catch (err) {
    thrown = err;
  }
  if (onSelect) {
    check(
      thrown instanceof SelectAll && expect.test(thrown.message),
      `the lane selector did NOT fail closed on "${name}". Expected a \`SelectAll\` matching `
      + `${expect}; got ${thrown === null ? `the selection [${got.join(", ")}]` : `${thrown}`}. `
      + `A fail-closed branch nobody has seen fail is indistinguishable from a broken one.`,
    );
    continue;
  }
  check(
    thrown === null && deepEqual(got, expectSelected.slice().sort()),
    `the lane selector did not notice "${name}". Changing ${JSON.stringify(path)} selected `
    + `${thrown === null ? `[${got.join(", ")}]` : `nothing (${thrown})`}; the mutated filters `
    + `mean [${expectSelected.join(", ")}]. A selection rule that cannot be made wrong is not `
    + `being checked.`,
  );
}

// And the matcher's own ordering, stated where a reader looks for it rather
// than only inside the selector's self-test.
for (const [patterns, path, want] of [
  [["apps/RelayiumKit/**", "!apps/RelayiumKit/Tests/**"], "apps/RelayiumKit/Tests/A.swift", false],
  [["apps/RelayiumKit/**", "!apps/RelayiumKit/Tests/**"], "apps/RelayiumKit/Sources/A.swift", true],
  [["server/account/deviceinbox*"], "server/account/deviceinbox_admission.go", true],
  [["server/account/deviceinbox*"], "server/account/deviceinbox/nested.go", false],
]) {
  check(
    matchesFilter(patterns, path) === want,
    `matchesFilter(${JSON.stringify(patterns)}, ${JSON.stringify(path)}) is `
    + `${matchesFilter(patterns, path)}, want ${want}. GitHub evaluates a \`paths:\` list in `
    + `ORDER and the last match decides; read as an unordered \`some()\` every exclusion in this `
    + `repository stops excluding.`,
  );
}

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`ci-lane-selector-test: ${failures.length} failure(s)\n`);
  for (const message of failures) console.error(`  ✗ ${message}\n`);
  process.exit(1);
}
console.log(
  `ci-lane-selector-test: OK (${LANES.length} conditional lanes, ${PATH_MATRIX.length} fixture `
  + `rows, ${CONTROL_FILES.length} control files, ${MUTATIONS.length} mutations)`,
);
