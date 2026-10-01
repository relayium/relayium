#!/usr/bin/env node
// scripts/test/ui-test-budget-test.mjs — the Apple UI test jobs end a hang as a
// FAILED step with its evidence kept, not as a cancelled job with none.
//
// ## The failure this pins (audit D-M3, 2026-09-28)
//
// `ios-ui-smoke` ran 28–40 minutes against a 45-minute job budget, and no
// xcodebuild UI run carried a per-test timeout, so one wedged XCUITest held the
// runner until the JOB timed out. GitHub reports a job timeout as `cancelled`,
// and the evidence uploads were conditioned on `failure()` or on
// `outcome == success || failure` — so exactly the run that hung kept no
// `.xcresult`, and the only evidence of where it hung was discarded.
//
// ## What each UI test job must hold
//
//   1. its xcodebuild `test` step has an `id:` and a `timeout-minutes:`
//      strictly BELOW every value the job's own `timeout-minutes` can take, so
//      a hang ends inside the step (reported `failure`) with time left for the
//      upload;
//   2. that xcodebuild invocation enables XCTest's own per-test timeout —
//      `-test-timeouts-enabled YES` with a `-maximum-test-execution-time-allowance`
//      and a `-default-test-execution-time-allowance` of at most 600 s;
//   3. its evidence step runs on `cancelled` as well: `always()` guarded by the
//      test step's outcome, naming `cancelled` — never a bare `failure()`.
//
// And every `xcodebuild … test` invocation anywhere in macos.yml and ios.yml
// carries the flags in (2), so a new UI job cannot be added without them.
//
// Deliberately a line reader over these two files rather than a YAML parser:
// the shapes are fixed and the self-test below mutates each property and
// requires it to be reported by name.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fullPathOf } from "../ci/ci-evidence-view.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_ALLOWANCE_S = 600;

const JOBS = [
  { file: "macos.yml", job: "ui-smoke", step: "ui_smoke", evidence: "Upload macOS UI smoke result evidence" },
  { file: "ios.yml", job: "ios-ui-smoke", step: "ui_smoke", evidence: "Retain UI smoke diagnosis" },
  { file: "ios.yml", job: "ios-ipad-shell", step: "ipad_shell", evidence: "Retain iPad shell diagnosis" },
];

/** The lines of job `name` (4-space body), or null. */
function jobLines(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]) && !/^\S/.test(lines[end])) end += 1;
  return lines.slice(start + 1, end);
}

/** Steps of a job as { keys: Map, run: string } — keys at the step's own indent. */
function stepsOf(lines) {
  const steps = [];
  let current = null;
  let runIndent = -1;
  for (const line of lines) {
    const item = /^( {6})- (.*)$/.exec(line);
    if (item) {
      current = { keys: new Map(), run: "" };
      steps.push(current);
      runIndent = -1;
      const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(item[2]);
      if (kv) current.keys.set(kv[1], kv[2]);
      if (kv?.[1] === "run") runIndent = 8;
      continue;
    }
    if (!current) continue;
    if (runIndent !== -1 && (line.trim() === "" || line.startsWith(" ".repeat(runIndent + 2)))) {
      current.run += `${line}\n`;
      continue;
    }
    runIndent = -1;
    const kv = /^ {8}([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) {
      current.keys.set(kv[1], kv[2]);
      if (kv[1] === "run") { runIndent = 8; current.run += `${kv[2]}\n`; }
    }
  }
  return steps;
}

/** Every value the job's `timeout-minutes` can take: a number, or each matrix `timeout`. */
function jobTimeouts(lines) {
  const raw = lines.find((line) => /^ {4}timeout-minutes:/.test(line))?.split(":")[1].trim();
  if (raw === undefined) return [];
  if (/^\d+$/.test(raw)) return [Number(raw)];
  const key = /\$\{\{\s*matrix\.([A-Za-z_]+)\s*\}\}/.exec(raw)?.[1];
  if (!key) return [];
  return lines.map((line) => new RegExp(`^\\s+${key}:\\s*(\\d+)\\s*$`).exec(line)?.[1])
    .filter(Boolean).map(Number);
}

/** Problems with one xcodebuild `test` invocation's per-test timeout flags. */
function flagProblems(run, where) {
  const problems = [];
  if (!/-test-timeouts-enabled\s+YES\b/.test(run)) {
    problems.push(`${where}: xcodebuild test runs without \`-test-timeouts-enabled YES\`, so a hung UI test holds the runner until the job times out`);
  }
  for (const flag of ["-maximum-test-execution-time-allowance", "-default-test-execution-time-allowance"]) {
    const value = new RegExp(`${flag}\\s+(\\d+)\\b`).exec(run)?.[1];
    if (value === undefined) problems.push(`${where}: xcodebuild test runs without \`${flag} <seconds>\``);
    else if (Number(value) > MAX_ALLOWANCE_S || Number(value) <= 0) {
      problems.push(`${where}: \`${flag} ${value}\` is outside (0, ${MAX_ALLOWANCE_S}] seconds`);
    }
  }
  return problems;
}

export function budgetProblems(files) {
  const problems = [];
  for (const { file, job, step, evidence } of JOBS) {
    const text = files[file];
    const lines = jobLines(text, job);
    if (lines === null) { problems.push(`${file}: job \`${job}\` is gone; update this test with it`); continue; }
    const where = `${file}/${job}`;
    const timeouts = jobTimeouts(lines);
    if (timeouts.length === 0) problems.push(`${where}: no readable job timeout-minutes`);
    const steps = stepsOf(lines);
    const test = steps.find((s) => s.keys.get("id") === step);
    if (!test) { problems.push(`${where}: no step with \`id: ${step}\` — the evidence guard has nothing to read`); continue; }
    const stepTimeout = Number(test.keys.get("timeout-minutes"));
    if (!Number.isInteger(stepTimeout) || stepTimeout <= 0) {
      problems.push(`${where}: the \`${step}\` step has no numeric timeout-minutes, so a hang ends as a job timeout (cancelled) instead of a failed step`);
    } else if (timeouts.some((t) => stepTimeout >= t)) {
      problems.push(`${where}: the \`${step}\` step's timeout-minutes ${stepTimeout} is not below the job's [${timeouts.join(", ")}]`);
    }
    if (!/xcodebuild[\s\S]*\btest\s*$/m.test(test.run)) {
      problems.push(`${where}: the \`${step}\` step no longer runs \`xcodebuild … test\``);
    }
    problems.push(...flagProblems(test.run, `${where} step ${step}`));

    const upload = steps.find((s) => s.keys.get("name") === evidence);
    if (!upload) { problems.push(`${where}: the evidence step "${evidence}" is gone`); continue; }
    const condition = upload.keys.get("if") ?? "";
    const guarded = /always\(\)/.test(condition) && condition.includes(`steps.${step}.outcome`)
      && /['"]cancelled['"]/.test(condition);
    if (!guarded) {
      problems.push(`${where}: "${evidence}" runs \`if: ${condition}\`; it must run when the \`${step}\` step `
        + `was CANCELLED (a job timeout), i.e. \`always()\` plus \`steps.${step}.outcome\` naming 'cancelled'`);
    }
  }
  // Every xcodebuild `test` invocation in these files carries the flags.
  for (const file of ["macos.yml", "ios.yml"]) {
    const blocks = files[file].split(/\n(?= {6}- )/);
    for (const block of blocks) {
      if (!/xcodebuild[^\n]*(?:\\\n[^\n]*)*\btest\s*$/m.test(block)) continue;
      const name = /name:\s*(.*)/.exec(block)?.[1] ?? "(unnamed step)";
      problems.push(...flagProblems(block, `${file} step "${name}"`));
    }
  }
  return problems;
}

function selfTest(files) {
  const failures = [];
  const mutate = (file, from, to) => {
    if (!files[file].includes(from)) throw new Error(`${file} no longer contains ${JSON.stringify(from)}`);
    return { ...files, [file]: files[file].replace(from, to) };
  };
  const cases = [
    ["the macOS upload condition reverted to success/failure only",
      () => mutate("macos.yml",
        `if: always() && contains(fromJSON('["success","failure","cancelled"]'), steps.ui_smoke.outcome)`,
        `if: always() && (steps.ui_smoke.outcome == 'success' || steps.ui_smoke.outcome == 'failure')`),
      /macos\.yml\/ui-smoke: "Upload macOS UI smoke result evidence" runs/],
    ["the iOS diagnosis back on bare failure()",
      () => mutate("ios.yml",
        `if: always() && contains(fromJSON('["failure","cancelled"]'), steps.ui_smoke.outcome)`,
        "if: failure()"),
      /ios\.yml\/ios-ui-smoke: "Retain UI smoke diagnosis" runs/],
    ["the per-test timeout switch removed from the iPad run",
      () => {
        const at = files["ios.yml"].indexOf("ios-ipad-shell.xcresult\" \\\n            -test-timeouts-enabled YES");
        if (at === -1) throw new Error("ios.yml iPad flags moved");
        return { ...files, "ios.yml": files["ios.yml"].slice(0, at)
          + files["ios.yml"].slice(at).replace("-test-timeouts-enabled YES \\\n            ", "") };
      },
      /ios\.yml\/ios-ipad-shell step ipad_shell: xcodebuild test runs without `-test-timeouts-enabled YES`/],
    ["the macOS step budget raised to the job's",
      () => mutate("macos.yml", "        timeout-minutes: 24\n", "        timeout-minutes: 30\n"),
      /macos\.yml\/ui-smoke: the `ui_smoke` step's timeout-minutes 30 is not below/],
    ["an allowance above ten minutes",
      () => mutate("ios.yml", "-maximum-test-execution-time-allowance 300", "-maximum-test-execution-time-allowance 900"),
      /-maximum-test-execution-time-allowance 900` is outside/],
  ];
  for (const [name, build, expect] of cases) {
    let world;
    try { world = build(); } catch (err) { failures.push(`self-test "${name}" could not apply: ${err.message}`); continue; }
    const problems = budgetProblems(world);
    if (!problems.some((p) => expect.test(p))) {
      failures.push(`self-test "${name}" went unreported (want ${expect}); got: ${problems.join(" | ") || "nothing"}`);
    }
  }
  return { failures, count: cases.length };
}

const files = Object.fromEntries(["macos.yml", "ios.yml"]
  .map((f) => [f, fullPathOf(f, readFileSync(resolve(repoRoot, ".github/workflows", f), "utf8"))]));
const problems = budgetProblems(files);
const self = problems.length === 0 ? selfTest(files) : { failures: [], count: 0 };
const all = [...problems, ...self.failures];
if (all.length > 0) {
  console.error(`ui-test-budget-test: ${all.length} failure(s)`);
  for (const p of all) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`ui-test-budget-test: OK (${JOBS.length} Apple UI test jobs end a hang as a failed step and keep `
  + `their .xcresult on cancellation; every xcodebuild test in macos.yml/ios.yml has a per-test timeout; `
  + `${self.count} mutations each reported)`);
