import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `page-shell.mjs` runs a fixed four-scenario inventory in a real browser and
 * fails loud when fewer than four finish. This guard reads its SOURCE, not its
 * output, and pins the shape that makes that failure mode possible in the first
 * place:
 *
 *  - all four scenario names are still the ones `SCENARIOS` runs;
 *  - the pass/fail check compares against a fixed literal count, not
 *    `SCENARIOS.length` — deleting an entry shrinks the array and its own
 *    length agree with each other, so a length-only check would still print a
 *    false N/N success (the exact failure the Phase 3D C2 lease calls out);
 *  - no `catch` sits between a scenario call and the counter that trusts it,
 *    which would let a swallowed scenario still increment `ran`;
 *  - the new CI step in `.github/workflows/web.yml` runs unconditionally —
 *    no `if:` guard, no `continue-on-error: true` — so it cannot become a
 *    silent no-op.
 *
 * Mirrors `apps-hierarchy-contract.test.mjs`'s idiom: a source-shape guard, not
 * a run of the scenarios themselves, so a regression here is caught in the
 * ordinary `npm test` step before the browser lane even starts.
 */

// `process.cwd()` is vitest's root (`web/`), same convention as the sibling
// source-contract test.
const SOURCE = readFileSync(resolve(process.cwd(), "e2e/page-shell.mjs"), "utf8");
const WORKFLOW = readFileSync(resolve(process.cwd(), "../.github/workflows/web.yml"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(process.cwd(), "package.json"), "utf8");

const SCENARIO_NAMES = [
  "authLandingScenario",
  "appsHierarchyScenario",
  "pricingHierarchyScenario",
  "unsupportedLayoutScenario",
];

/** The `main()` body, so assertions about the run loop cannot be satisfied by
 * unrelated text elsewhere in the file (a scenario's own error message, say). */
function mainBody() {
  const start = SOURCE.indexOf("async function main()");
  expect(start, "main() is no longer greppable in page-shell.mjs").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\nawait withWatchdog(", start);
  expect(end, "main() no longer ends before the withWatchdog call").toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("the four page-shell scenarios are all present and all run", () => {
  it("names every scenario as a top-level function", () => {
    for (const name of SCENARIO_NAMES) {
      expect(SOURCE, `${name} is no longer defined`).toMatch(new RegExp(`async function ${name}\\(`));
    }
  });

  it("runs all four, and only these four, from one inventory array", () => {
    const match = SOURCE.match(/const SCENARIOS = \[([^\]]*)\];/);
    expect(match, "SCENARIOS array is no longer declared as a plain literal").not.toBeNull();
    const listed = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    expect(listed).toEqual(SCENARIO_NAMES);
  });
});

describe("a dropped scenario cannot still report a false pass", () => {
  it("declares a fixed expected count, not a reference to SCENARIOS.length", () => {
    expect(SOURCE).toMatch(/const EXPECTED_SCENARIO_COUNT = 4;/);
  });

  it("checks the run count against that fixed constant", () => {
    const body = mainBody();
    expect(body, "main() no longer compares against EXPECTED_SCENARIO_COUNT").toMatch(
      /ran !== EXPECTED_SCENARIO_COUNT/,
    );
    // The one comparison this guard exists to forbid: agreeing with itself
    // after an entry is deleted.
    expect(body, "the pass/fail check fell back to comparing against the mutable array length").not.toMatch(
      /ran !== SCENARIOS\.length/,
    );
  });

  it("counts scenarios with no catch between the call and the counter", () => {
    const body = mainBody();
    const loopStart = body.indexOf("for (const scenario of SCENARIOS)");
    expect(loopStart, "the run-all loop is no longer written as a plain for-of").toBeGreaterThan(-1);
    const loopEnd = body.indexOf("\n    }", loopStart);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loopBody = body.slice(loopStart, loopEnd);
    expect(loopBody, "the run-all loop swallows a scenario's error before ran++ can be trusted").not.toMatch(
      /catch/,
    );
    expect(loopBody).toMatch(/ran\+\+/);
  });
});

describe("the hosted CI step cannot become a silent no-op", () => {
  it("runs the new npm script as its own unconditional step", () => {
    const idx = WORKFLOW.indexOf("run: npm run test:e2e:page-shell");
    expect(idx, "no step in web.yml runs test:e2e:page-shell").toBeGreaterThan(-1);
    const dashIdx = WORKFLOW.lastIndexOf("\n      - ", idx);
    expect(dashIdx, "test:e2e:page-shell is not its own step entry").toBeGreaterThan(-1);
    const nextDash = WORKFLOW.indexOf("\n      - ", dashIdx + 1);
    const step = nextDash === -1 ? WORKFLOW.slice(dashIdx) : WORKFLOW.slice(dashIdx, nextDash);
    expect(step, "the page-shell step is guarded by an if: condition").not.toMatch(/\bif:/);
    expect(step, "the page-shell step tolerates its own failure").not.toMatch(/continue-on-error:\s*true/);
  });

  it("is wired into exactly one CI step", () => {
    const occurrences = WORKFLOW.split("test:e2e:page-shell").length - 1;
    expect(occurrences, "test:e2e:page-shell is wired into more than one step").toBe(1);
  });

  it("package.json's npm script runs the moved file", () => {
    expect(PACKAGE_JSON).toMatch(/"test:e2e:page-shell":\s*"node e2e\/page-shell\.mjs"/);
  });
});
