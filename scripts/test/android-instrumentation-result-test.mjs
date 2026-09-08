#!/usr/bin/env node
// scripts/test/android-instrumentation-result-test.mjs — the emulator matrix's
// pass/fail rule, judged against the logs a broken device actually produces.
//
// `am instrument` exits 0 almost unconditionally: for a crashed process, for a
// missing instrumentation, for a target package that is not installed, and for
// a run that printed nothing at all. A driver that trusts the exit status — or
// that only greps for the word FAILURES — reports every one of those as a pass.
// That is not hypothetical: it is the ordinary failure mode of a long emulator
// run, and it turns the update acceptance into a very slow `true`.
//
// So `scripts/lib/instrumentation-result.sh` requires POSITIVE evidence, and
// this file EXECUTES that program against recorded log shapes. It deliberately
// does not re-implement the rule: a test that mirrors the logic it is checking
// passes whenever the two copies agree, including when both are wrong.
//
// SDK-free and device-free on purpose — it needs no emulator, so the rule that
// guards the expensive lane is itself checked on every push.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const classifier = join(repoRoot, "scripts", "lib", "instrumentation-result.sh");

const failures = [];
let checked = 0;

/** Run the real program. Returns { code, stderr }. */
function classify(logText, expected = 1, { omitFile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relayium-instr-"));
  const log = join(dir, "run.log");
  try {
    if (!omitFile) writeFileSync(log, logText);
    try {
      execFileSync("bash", [classifier, log, String(expected)], { encoding: "utf8", stdio: "pipe" });
      return { code: 0, stderr: "" };
    } catch (err) {
      return { code: err.status ?? 1, stderr: [err.stdout, err.stderr].filter(Boolean).join("") };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectRejected(name, logText, opts) {
  checked += 1;
  const { code } = classify(logText, 1, opts);
  if (code === 0) failures.push(`${name}: accepted a run that produced no passing test`);
}

function expectAccepted(name, logText, expected = 1) {
  checked += 1;
  const { code, stderr } = classify(logText, expected);
  if (code !== 0) failures.push(`${name}: rejected a genuinely passing run — ${stderr.trim()}`);
}

// ── the shape of a real, single, passing test ───────────────────────────────

const PASS = `INSTRUMENTATION_STATUS: class=com.relayium.android.UpdateAcceptanceTest
INSTRUMENTATION_STATUS: current=1
INSTRUMENTATION_STATUS: id=AndroidJUnitRunner
INSTRUMENTATION_STATUS: numtests=1
INSTRUMENTATION_STATUS: stream=
INSTRUMENTATION_STATUS: test=futureVersionOffersDownloadWithNotes
INSTRUMENTATION_STATUS_CODE: 1
INSTRUMENTATION_STATUS: class=com.relayium.android.UpdateAcceptanceTest
INSTRUMENTATION_STATUS: current=1
INSTRUMENTATION_STATUS: numtests=1
INSTRUMENTATION_STATUS: stream=.
INSTRUMENTATION_STATUS: test=futureVersionOffersDownloadWithNotes
INSTRUMENTATION_STATUS_CODE: 0
INSTRUMENTATION_RESULT: stream=

Time: 8.412

OK (1 test)


INSTRUMENTATION_CODE: -1
`;

expectAccepted("a single passing test", PASS);

// ── every way a run produces nothing, with rc=0 ─────────────────────────────

expectRejected("an empty log", "");
expectRejected("a missing log", "", { omitFile: true });
expectRejected("whitespace only", "\n\n   \n");

// The app died. `am instrument` still exits 0.
expectRejected(
  "a crashed process",
  `INSTRUMENTATION_STATUS: id=ActivityManagerService
INSTRUMENTATION_STATUS: Error=Process crashed.
INSTRUMENTATION_STATUS_CODE: -1
INSTRUMENTATION_ABORTED: System has crashed.
INSTRUMENTATION_CODE: 0
`,
);

// The instrumentation was never installed. Nothing ran; rc is still 0.
expectRejected(
  "a missing instrumentation",
  `INSTRUMENTATION_STATUS: id=ActivityManagerService
INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: ComponentInfo{com.relayium.android.debug.test/androidx.test.runner.AndroidJUnitRunner}
INSTRUMENTATION_STATUS_CODE: -1
INSTRUMENTATION_FAILED: com.relayium.android.debug.test/androidx.test.runner.AndroidJUnitRunner
INSTRUMENTATION_CODE: 0
`,
);

expectRejected(
  "a shortMsg process crash",
  `INSTRUMENTATION_STATUS: shortMsg=Process crashed.
INSTRUMENTATION_STATUS_CODE: 0
INSTRUMENTATION_CODE: -1
`,
);

// A test that ran and FAILED.
expectRejected(
  "an assertion failure",
  `INSTRUMENTATION_STATUS: numtests=1
INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: not displayed
INSTRUMENTATION_STATUS_CODE: -2
INSTRUMENTATION_RESULT: stream=
FAILURES!!!
INSTRUMENTATION_CODE: -1
`,
);

// Started, never finished: the killed-run shape. One status=1 and no status=0.
expectRejected(
  "a test that started and never finished",
  `INSTRUMENTATION_STATUS: numtests=1
INSTRUMENTATION_STATUS: test=futureVersionOffersDownloadWithNotes
INSTRUMENTATION_STATUS_CODE: 1
INSTRUMENTATION_CODE: 0
`,
);

// Passed, but the run itself was cancelled rather than completing.
expectRejected(
  "a passing test with a cancelled terminal",
  PASS.replace("INSTRUMENTATION_CODE: -1", "INSTRUMENTATION_CODE: 0"),
);

// The filter matched nothing: zero tests, and a clean-looking log.
expectRejected(
  "a run where the class filter matched nothing",
  `INSTRUMENTATION_RESULT: stream=

Time: 0.001

OK (0 tests)


INSTRUMENTATION_CODE: -1
`,
);

// ── the count is exact, not a floor ─────────────────────────────────────────
//
// The driver runs ONE method per invocation. A log carrying two passes means it
// ran something other than what was asked for.
{
  checked += 1;
  const twice = PASS.replace(
    "INSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_RESULT",
    "INSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_RESULT",
  );
  if (classify(twice, 1).code === 0) {
    failures.push("two passing tests were accepted where exactly one was expected");
  }
  // …and asking for two accepts two, so the rule is a count and not a cap.
  if (classify(twice, 2).code !== 0) {
    failures.push("two passing tests were rejected when two were expected");
  }
  checked += 1;
}

// ── the driver must actually use it ─────────────────────────────────────────

{
  checked += 1;
  const driver = execFileSync("cat", [join(repoRoot, "scripts", "android-update-acceptance.sh")], {
    encoding: "utf8",
  });
  const code = driver
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  if (!/lib\/instrumentation-result\.sh/.test(code)) {
    failures.push("android-update-acceptance.sh does not use lib/instrumentation-result.sh");
  }
  // The old negative-only rule must not come back alongside it.
  if (/rc" -ne 0 \] \|\| grep -qE '\^INSTRUMENTATION_/.test(code)) {
    failures.push("android-update-acceptance.sh still classifies with an inline negative grep");
  }
}

if (failures.length > 0) {
  console.error(`android-instrumentation-result-test: FAIL (${failures.length}/${checked})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`android-instrumentation-result-test: ok (${checked} cases)`);
