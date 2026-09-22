#!/usr/bin/env node
// scripts/test/ci-guard-coverage-test.mjs — every policy test in this directory
// is actually run by a workflow.
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
// only that SOME workflow names it.
//
// ## Why it proves itself
//
// A scan that found no files, or matched nothing, would be as green as full
// coverage. So the real evaluation is followed by two mutations: a test file
// that no workflow names must be reported, and a directory listing that has
// somehow become empty must fail rather than pass vacuously.

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

/** Which workflows name this test. A step may invoke it through `node`, `bash`,
 *  `sh` or a composite line; all of them contain the file name, which is what is
 *  searched for — the point is reachability, not the exact verb. */
function referencedBy(name, workflows) {
  return Object.entries(workflows).filter(([, body]) => body.includes(name)).map(([f]) => f);
}

function evaluate(w) {
  const problems = [];
  if (w.tests.length === 0) {
    problems.push("no policy tests were found at all — this scan proves nothing, and that is itself the failure");
  }
  for (const t of w.tests) {
    if (referencedBy(t, w.workflows).length === 0) {
      problems.push(`${t}: no workflow runs it — a guard CI never runs is worse than no guard`);
    }
  }
  return problems;
}

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };

const world = realWorld();
for (const p of evaluate(world)) fail(p);

// The mutations. Each must be caught, or this file is decoration.
if (failed === 0) {
  const unwired = { ...world, tests: [...world.tests, "a-guard-nobody-runs-test.mjs"] };
  if (evaluate(unwired).length !== 1) fail("an unreferenced test was not reported — the scan does not actually check references");

  const empty = { ...world, tests: [] };
  if (evaluate(empty).length !== 1) fail("an empty directory passed — the scan would be green having read nothing");
}

if (failed > 0) {
  console.error(`\nci-guard-coverage: ${failed} failure(s)`);
  process.exit(1);
}
console.log(`ok ci-guard-coverage: ${world.tests.length} policy tests, every one named by at least one of ${Object.keys(world.workflows).length} workflows; 2 mutations caught`);
