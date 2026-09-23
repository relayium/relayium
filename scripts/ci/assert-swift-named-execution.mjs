#!/usr/bin/env node
// Named-execution proof for a `swift test` log.
//
// usage: node scripts/ci/assert-swift-named-execution.mjs <swift-test-log> <Class/method>...
//
// Exit 0 only if, in the log:
//   * every named case reported `passed` EXACTLY once, and
//   * no case of a named class reported anything else (skipped, failed), and
//   * every case a named class executed is one of the named cases.
//
// Why this exists: the Swift<->Go interop classes SKIP unless
// `RELAYIUM_SWIFT_INTEROP=1`, and a skipped XCTest case exits 0. Without this
// step a lost env var, a missing Go toolchain or a renamed case would leave the
// lane green over a proof that never ran. The named list is kept equal to the
// `func test…` names on disk by `scripts/test/swift-ci-boundary-test.mjs`, which
// also runs this script's own mutation cases.
//
// Exit 1 = the proof failed (reasons on stderr); exit 2 = usage error.
import { readFileSync } from "node:fs";
import process from "node:process";

export function checkNamedExecution(logText, wanted) {
  const problems = [];
  const malformed = wanted.filter((w) => !/^\w+\/test\w+$/.test(w));
  if (malformed.length) problems.push(`malformed case name(s): ${malformed.join(", ")}`);
  if (new Set(wanted).size !== wanted.length) problems.push("a case is named twice");

  const re = /Test Case '-\[RelayiumKitTests\.(\w+) (\w+)\]' (passed|failed|skipped)/g;
  const seen = new Map();
  for (const m of logText.matchAll(re)) {
    const key = `${m[1]}/${m[2]}`;
    seen.set(key, [...(seen.get(key) ?? []), m[3]]);
  }
  const classes = new Set(wanted.map((w) => w.split("/")[0]));
  for (const w of wanted) {
    const results = seen.get(w) ?? [];
    if (results.length !== 1 || results[0] !== "passed") {
      problems.push(`${w}: want exactly one "passed", got ${JSON.stringify(results)}`);
    }
  }
  for (const [key, results] of seen) {
    if (classes.has(key.split("/")[0]) && !wanted.includes(key)) {
      problems.push(`${key}: executed (${results.join(", ")}) but not named`);
    }
  }
  return problems;
}

function main(argv) {
  const [log, ...wanted] = argv;
  if (!log || wanted.length === 0) {
    process.stderr.write("usage: assert-swift-named-execution.mjs <swift-test-log> <Class/method>...\n");
    return 2;
  }
  let text;
  try {
    text = readFileSync(log, "utf8");
  } catch (err) {
    process.stderr.write(`named-execution proof FAILED: cannot read ${log}: ${err.message}\n`);
    return 1;
  }
  const problems = checkNamedExecution(text, wanted);
  if (problems.length) {
    process.stderr.write(`named-execution proof FAILED:\n  ${problems.join("\n  ")}\n`);
    return 1;
  }
  process.stdout.write(`named-execution proof: ${wanted.length} case(s) passed, none skipped\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
