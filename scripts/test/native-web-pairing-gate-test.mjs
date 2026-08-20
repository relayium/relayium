#!/usr/bin/env node
// scripts/test/native-web-pairing-gate-test.mjs — the two delivery gates that
// stand between a cross-client regression and a user, asserted on every push.
//
// ## Gate 1: the heterogeneous acceptance actually runs somewhere hosted
//
// `scripts/native-web-pairing-acceptance.sh` is the only thing in this
// repository that can see the 1.2.5 defect: two capable peers, each individually
// correct, reaching DIFFERENT conclusions about what the other could speak.
// Every other pairing test has a double on one side — `code-room.mjs` replaces
// `window.WebSocket`, and every Swift "peer" in `LinkPairingRoomTests` is
// Swift-authored — and a double cannot disagree with the implementation that
// wrote it.
//
// For its first months that script existed and nothing ran it. A local script
// nobody is required to run is documentation, and the regression it describes
// recurs at exactly the rate it did before the script was written.
//
// ## Gate 2: the generated wire vectors still match their generator
//
// `apps/RelayiumKit/Tests/Fixtures/*-wire-vectors.json` are transcriptions of
// the Web implementation that the Swift suites assert against. If the Web wire
// moves and the fixtures are not regenerated, every Swift vector test still
// passes — against the OLD wire — and the two implementations have diverged with
// a green board. `web/scripts/check-wire-vectors.mjs` is the check; this test is
// what requires it to run, and to run BEFORE the acceptance, so a drifted
// fixture is reported in seconds rather than after a fifteen-minute macOS run.
//
// ## Why these assertions live here and not in the workflow
//
// Nothing else can see any of it. The YAML is valid with the acceptance step
// deleted, with `web/**` dropped from the path filter, with `continue-on-error:
// true` added, or with the two steps in the other order. actionlint is happy in
// every one of those shapes. The only other signal would be a second
// cross-client regression reaching a user — which is the signal this whole task
// exists to stop relying on. So it is asserted here, on every push, by
// `repo-hygiene.yml`, which has no path filter of its own.
//
// Deliberately no YAML dependency, for the same reason as
// `macos-publish-order-test.mjs`: `web/` is the only Node project in this
// repository and this test must run without installing it. The parsing is
// indentation-based and fails loudly if a file's shape changes.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

/** The acceptance, the vector gate, and this test's own host workflow. */
const ACCEPTANCE = "scripts/native-web-pairing-acceptance.sh";
const ACCEPTANCE_WORKFLOW = "native-web-pairing.yml";
const VECTOR_CHECK = "npm run test:vectors";
const VECTOR_CHECKER = "web/scripts/check-wire-vectors.mjs";
const GUARD_TEST = "scripts/test/native-web-pairing-gate-test.mjs";

/**
 * Every tree that is an INPUT to the acceptance run, and must therefore trigger
 * it. Dropping any one of these from the path filter is the cheapest possible
 * way to disable this gate without deleting anything, so each is asserted by
 * name for both `push` and `pull_request`.
 */
const REQUIRED_PATHS = [
  // The native half: RelayiumKit, the link workspace, the peer binary.
  "apps/**",
  // The browser half: the bundle, the e2e harness and driver, AND the
  // wire-vector generators the first step of the job re-runs.
  "web/**",
  // The hub the two clients meet on: /api/pair, the pairing room, the ws join
  // budget the script paces itself against.
  "server/**",
  // The acceptance itself and the shared isolation library it is built from.
  "scripts/**",
  // The job's own definition, so an edit to it is checked by itself.
  `.github/workflows/${ACCEPTANCE_WORKFLOW}`,
];

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

// ── minimal, anchor-aware readers for the shapes these workflows use ─────────

/** The lines of the top-level `on:` block. */
function onBlock(workflow) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/**
 * `{ event -> string[] | null }` for every event in `on:`, where `null` means
 * the event declares no path filter and therefore fires on every change.
 *
 * `web.yml` and the pairing workflow both define the list once under `push` with
 * a YAML anchor and reference it from `pull_request`, so the anchors have to be
 * resolved rather than read twice — a test that only looked at the literal list
 * would report `pull_request` as unfiltered and pass for the wrong reason.
 */
function triggers(workflow) {
  const lines = onBlock(workflow);
  if (lines === null) return null;
  const events = new Map();
  const anchors = new Map();
  let event = null;
  let collecting = null;
  for (const line of lines) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const eventAt = line.match(/^ {2}([A-Za-z_]+):/);
    if (eventAt) {
      event = eventAt[1];
      collecting = null;
      if (!events.has(event)) events.set(event, null);
      continue;
    }
    if (event === null) continue;
    const alias = line.match(/^ {4}paths:\s*\*([A-Za-z0-9_-]+)\s*$/);
    if (alias) {
      events.set(event, anchors.get(alias[1]) ?? []);
      collecting = null;
      continue;
    }
    const declared = line.match(/^ {4}paths(?:-ignore)?:\s*(?:&([A-Za-z0-9_-]+))?\s*$/);
    if (declared) {
      collecting = [];
      events.set(event, collecting);
      if (declared[1]) anchors.set(declared[1], collecting);
      continue;
    }
    const item = collecting !== null && line.match(/^ {6}- ['"]?([^'"]+)['"]?\s*$/);
    if (item) { collecting.push(item[1]); continue; }
    if (/^ {4}\S/.test(line)) collecting = null;
  }
  return events;
}

/** The lines of one top-level job, by its two-space-indented key. */
function jobLines(workflow, job) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^ {2}\S/.test(line)) { end = i; break; }
  }
  return lines.slice(start, end);
}

/** Every top-level job key in a workflow, in file order. */
function jobNames(workflow) {
  const lines = workflow.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) return [];
  const names = [];
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break;
    const at = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (at) names.push(at[1]);
  }
  return names;
}

/**
 * The job's steps in order, each split into its raw lines and its EXECUTABLE
 * lines (comments dropped).
 *
 * Comments matter here for the same reason they do in the publish-order test:
 * every rationale in these jobs names the command it is explaining, so a test
 * that matched raw text would agree with the prose rather than with the code —
 * and would keep passing after the step itself was deleted and its comment left
 * behind.
 */
function steps(lines) {
  const stepsAt = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (stepsAt < 0) return [];
  const found = [];
  for (const line of lines.slice(stepsAt + 1)) {
    if (/^ {6}- /.test(line)) {
      found.push({ name: line.replace(/^ {6}- (name|uses):\s*/, "").trim(), lines: [line] });
    } else if (found.length > 0) {
      found[found.length - 1].lines.push(line);
    }
  }
  return found.map((step) => ({
    name: step.name,
    lines: step.lines,
    code: step.lines.filter((line) => !/^\s*#/.test(line)),
  }));
}

const workflowFiles = (await readdir(workflowsDir)).filter((name) => /\.ya?ml$/.test(name));
const workflows = new Map(
  await Promise.all(
    workflowFiles.map(async (name) => [name, await readFile(resolve(workflowsDir, name), "utf8")]),
  ),
);

/**
 * A workflow with its whole-line comments removed.
 *
 * Every "does this file run X" question below has to be asked of the CODE. Each
 * of these workflows explains itself at length and names the commands it is
 * explaining — this file's own home workflow describes the writing form of the
 * vector generator in order to forbid it — so matching raw text would make the
 * test agree with the prose, report a rationale as a second invocation, and fail
 * for reasons that are not defects.
 */
const code = new Map(
  workflowFiles.map((name) => [
    name,
    workflows.get(name).split("\n").filter((line) => !/^\s*#/.test(line)).join("\n"),
  ]),
);

// ── 1. the acceptance has exactly one hosted home, and it is a macOS job ─────

const hosting = workflowFiles.filter((name) => code.get(name).includes(ACCEPTANCE));
check(
  hosting.length === 1,
  `expected exactly one workflow to run ${ACCEPTANCE}; found ${hosting.length}`
  + `${hosting.length ? ` (${hosting.join(", ")})` : ""}.`
  + ` It is the only gate that can see two DIFFERENT implementations disagree, so it must`
  + ` exist — and running it twice buys a second macOS runner and no new evidence.`,
);
check(
  hosting.includes(ACCEPTANCE_WORKFLOW),
  `${ACCEPTANCE_WORKFLOW} does not run ${ACCEPTANCE}`,
);

const pairingWorkflow = workflows.get(ACCEPTANCE_WORKFLOW);
if (!pairingWorkflow) {
  process.stderr.write(`FAIL: .github/workflows/${ACCEPTANCE_WORKFLOW} does not exist\n`);
  process.exit(1);
}

// The job that hosts it, found by the command rather than by name, so renaming
// the job is allowed and losing the command is not.
const hostJobName = jobNames(pairingWorkflow)
  .find((name) => (jobLines(pairingWorkflow, name) ?? [])
    .filter((line) => !/^\s*#/.test(line)).join("\n").includes(ACCEPTANCE));
check(hostJobName !== undefined, `no job in ${ACCEPTANCE_WORKFLOW} runs ${ACCEPTANCE}`);

if (hostJobName !== undefined) {
  const host = jobLines(pairingWorkflow, hostJobName);
  const hostText = host.filter((line) => !/^\s*#/.test(line)).join("\n");

  const runsOn = hostText.match(/^ {4}runs-on:\s*(\S+)/m)?.[1];
  check(
    runsOn !== undefined && /^macos-/.test(runsOn),
    `the ${hostJobName} job runs on "${runsOn}"; the acceptance builds a Swift product and`
    + ` drives the macOS app's own link workspace, so only a macOS runner can host it`,
  );
  check(
    hostText.includes("timeout-minutes:"),
    `the ${hostJobName} job declares no timeout-minutes; a wedged pairing round would otherwise`
    + ` hold a macOS runner until the repository default expires`,
  );
  // A job that may skip or may fail advisorily is not a gate. Both are one line
  // to add and invisible to every other check.
  check(
    !/^ {4}if:/m.test(hostText),
    `the ${hostJobName} job has a job-level "if:"; this acceptance reads no secrets and must`
    + ` run on every triggering event, fork pull requests included`,
  );
  check(
    !/continue-on-error/.test(hostText),
    `the ${hostJobName} job sets continue-on-error; an advisory cross-client acceptance is`
    + ` indistinguishable from no acceptance`,
  );

  const hostSteps = steps(host);
  const exec = hostSteps.flatMap((step, stepIndex) =>
    step.code.map((text) => ({ text, step: step.name, stepIndex })));

  /** The index of the single executable line containing `marker`. */
  function lineRunning(marker, label) {
    const matches = exec.filter((line) => line.text.includes(marker));
    if (matches.length !== 1) {
      failures.push(
        `expected exactly one command in the ${hostJobName} job to run ${label} (${marker});`
        + ` found ${matches.length}`,
      );
      return -1;
    }
    return exec.indexOf(matches[0]);
  }

  const vectors = lineRunning(VECTOR_CHECK, "the wire-vector zero-diff gate");
  const acceptance = lineRunning(ACCEPTANCE, "the native-to-browser acceptance");

  // 1a. Order. The vector gate is seconds long and judges the same cross-language
  //     contract from the frozen-bytes side; the acceptance is a fifteen-minute
  //     live run. Reporting a drifted fixture after the long run is a worse
  //     version of the same red.
  if (vectors >= 0 && acceptance >= 0) {
    check(
      vectors < acceptance,
      `the wire-vector gate runs AFTER the acceptance in the ${hostJobName} job; it must run`
      + ` before, so a fixture that no longer matches its generator fails in seconds`,
    );
  }

  // 1b. The verifying form only. `gen:vectors` rewrites the tracked fixtures,
  //     which in CI would turn the gate into a machine that agrees with whatever
  //     it just produced.
  check(
    !code.get(ACCEPTANCE_WORKFLOW).includes("gen:vectors")
    && !code.get(ACCEPTANCE_WORKFLOW).includes("--write"),
    `${ACCEPTANCE_WORKFLOW} runs the WRITING form of the vector generator; CI must verify`
    + ` the tracked bytes, never regenerate them`,
  );

  // 1c. Neither gate may be softened at the step level.
  for (const [index, label] of [[vectors, "wire-vector gate"], [acceptance, "acceptance"]]) {
    if (index < 0) continue;
    const step = hostSteps[exec[index].stepIndex];
    const stepText = step.code.join("\n");
    check(
      !/^\s{8}if:/m.test(stepText),
      `the ${label} step has an "if:"; a gate that can skip itself is not a gate`,
    );
    check(
      !/continue-on-error/.test(stepText),
      `the ${label} step sets continue-on-error; its failure must fail the job`,
    );
    check(
      !/\|\|\s*(true|:|echo|exit 0)/.test(exec[index].text),
      `the ${label} command swallows its own exit status ("${exec[index].text.trim()}")`,
    );
  }
}

// ── 2. every owning tree triggers it ────────────────────────────────────────

const pairingTriggers = triggers(pairingWorkflow);
check(pairingTriggers !== null, `${ACCEPTANCE_WORKFLOW} declares no "on:" block`);
if (pairingTriggers !== null) {
  for (const event of ["push", "pull_request"]) {
    if (!pairingTriggers.has(event)) {
      check(false, `${ACCEPTANCE_WORKFLOW} does not run on ${event}`);
      continue;
    }
    const paths = pairingTriggers.get(event);
    // No filter at all is stricter than any list, and therefore fine.
    if (paths === null) continue;
    for (const required of REQUIRED_PATHS) {
      check(
        paths.includes(required),
        `${ACCEPTANCE_WORKFLOW}'s ${event} filter does not cover "${required}", which is a real`
        + ` input to the acceptance run — a change there could break the two clients' agreement`
        + ` and never start this job`,
      );
    }
  }
}

// ── 3. this guard itself runs on every push ─────────────────────────────────

const guardHosts = workflowFiles.filter((name) => code.get(name).includes(GUARD_TEST));
check(
  guardHosts.length >= 1,
  `no workflow runs ${GUARD_TEST}; these assertions only hold if something executes them`,
);
for (const name of guardHosts) {
  const events = triggers(workflows.get(name));
  if (events === null) continue;
  for (const event of ["push", "pull_request"]) {
    if (!events.has(event)) {
      check(false, `${name} runs ${GUARD_TEST} but not on ${event}`);
      continue;
    }
    check(
      events.get(event) === null,
      `${name} runs ${GUARD_TEST} behind a ${event} path filter; it guards`
      + ` .github/workflows/, web/package.json and the acceptance script, so it must run on`
      + ` every ${event}, exactly as macos-publish-order-test.mjs does`,
    );
  }
}

// ── 4. the vector gate is wired end to end ──────────────────────────────────

check(
  existsSync(resolve(repoRoot, VECTOR_CHECKER)),
  `${VECTOR_CHECKER} does not exist, but the pairing job runs "${VECTOR_CHECK}"`,
);

const pkgPath = resolve(repoRoot, "web/package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
check(
  (pkg.scripts?.["test:vectors"] ?? "").includes("check-wire-vectors.mjs"),
  `web/package.json's "test:vectors" does not run check-wire-vectors.mjs`,
);
check(
  !(pkg.scripts?.["test:vectors"] ?? "").includes("--write"),
  `web/package.json's "test:vectors" passes --write; the verifying form must not regenerate`,
);
check(
  (pkg.scripts?.["gen:vectors"] ?? "").includes("--write"),
  `web/package.json has no "gen:vectors" writing form; a check that cannot be satisfied by a`
  + ` documented command is a check people delete`,
);

if (existsSync(resolve(repoRoot, VECTOR_CHECKER))) {
  const checker = await readFile(resolve(repoRoot, VECTOR_CHECKER), "utf8");
  // The fixture the delivery blocker named, plus the generator that owns it.
  // Both are asserted to be IN the checker's table and to exist on disk, so
  // renaming either without updating the table fails here rather than silently
  // reducing what the gate covers.
  const REQUIRED_VECTORS = [
    ["web/scripts/gen-realtime-wire-vectors.mjs", "scripts/gen-realtime-wire-vectors.mjs"],
    ["apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json",
      "apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json"],
  ];
  for (const [onDisk, inTable] of REQUIRED_VECTORS) {
    check(
      checker.includes(inTable),
      `${VECTOR_CHECKER} no longer names "${inTable}"; the realtime wire vectors are the`
      + ` cross-language contract this gate exists for`,
    );
    check(existsSync(resolve(repoRoot, onDisk)), `${onDisk} does not exist`);
  }
}

// ── 5. the acceptance is still the real thing ───────────────────────────────
//
// Wiring a script into CI proves nothing if the script can be hollowed out
// afterwards. These are the four properties that make it the only test in the
// repository that can see two implementations disagree; a version without them
// would still be green in the job above and would prove nothing at all.

// Comment lines dropped for the same reason as in the workflows: that script
// explains at length what it runs and why, so a deleted command whose rationale
// was left behind would still match every marker below.
const acceptanceSource = (await readFile(resolve(repoRoot, ACCEPTANCE), "utf8"))
  .split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
for (const [marker, why] of [
  ["e2e/native-pairing-browser.mjs",
    "the browser half — without a real Chrome on the real bundle there is only one implementation here"],
  ["acceptance_start_server",
    "a real server — a fake hub cannot refuse, race or mis-route the way the real one did"],
  ["vite build",
    "the real built bundle — a stale dist would make this evidence about a build nobody ships"],
  ["seen_initiator",
    "both role assignments — the shipped regression appeared on one side only and read as \"fails about half the time\""],
  ["seen_responder",
    "both role assignments — see above; one side proved is half the role space unproved"],
  ["compared_sas",
    "the SAS comparison — the one cell where the two clients' derived digits are put side by side"],
  ["browser_half_landed_on_mac",
    "the phase barrier — the run's contract is BIDIRECTIONAL transfer, and without this wait the Mac"
    + " is driven while the browser is still sending, so a red round cannot be told apart from an"
    + " interleaving the gate never set out to exercise"],
]) {
  check(
    acceptanceSource.includes(marker),
    `${ACCEPTANCE} no longer contains "${marker}": ${why}`,
  );
}
// The bounded round loop must still FAIL when a half is unproved, rather than
// reporting the half it got. `|| fail` is part of each pattern deliberately: the
// cheapest way to neuter one of these is to leave the sentence and detach it
// from the exit — `|| true # was: fail "…"` matches a bare text search and
// changes the run from red to green.
check(
  /\|\|\s*fail "never observed the browser as INITIATOR/.test(acceptanceSource)
  && /\|\|\s*fail "never observed the browser as RESPONDER/.test(acceptanceSource)
  && /\|\|\s*fail "no round compared the two clients' SAS/.test(acceptanceSource),
  `${ACCEPTANCE} no longer FAILS when a role assignment or the SAS comparison went unobserved;`
  + ` a run that reports the half it happened to get is how the shipped regression was written off`,
);

// ── 6. the phase barrier is a barrier ───────────────────────────────────────
//
// Three ways to keep the marker above and lose the property it names, none of
// which anything else in this repository can see: let the wait time out without
// failing, move it after the Mac is driven, or weaken what it waits FOR.

check(
  /\|\|\s*fail "the browser's message and file never reached the Mac/.test(acceptanceSource)
  && /\|\|\s*fail "the browser half exited before its message and file reached the Mac/
    .test(acceptanceSource),
  `${ACCEPTANCE}'s phase barrier no longer FAILS when the browser's half never lands or the browser`
  + ` exits under it; a barrier that falls through on timeout restores the crossing it removed and`
  + ` reports it as a byte comparison failure`,
);

// Ordering is the whole point: the same wait placed after the two /drive calls
// keeps every marker and proves nothing.
const barrierAt = acceptanceSource.indexOf(`fail "the browser's message and file never reached the Mac`);
const driveAt = acceptanceSource.indexOf("POST /drive");
check(
  barrierAt >= 0 && driveAt >= 0 && barrierAt < driveAt,
  `${ACCEPTANCE} drives the Mac before it waits for the browser's half to land; the barrier must`
  + ` complete BEFORE the first /drive call or the two sides cross exactly as they did before it`,
);

// And what it waits for stays exact: the browser's own message text, the file's
// own name, and that file's digest. Dropping the digest would let a partially
// written receipt satisfy the barrier that the comparison below would reject.
const barrierCall = acceptanceSource.split("\n")
  .find((line) => line.includes('browser_half_landed_on_mac "$observed"'));
check(
  barrierCall !== undefined
  && barrierCall.includes("$web_message_text")
  && barrierCall.includes("$web_file_name")
  && barrierCall.includes("$web_file_sha"),
  `${ACCEPTANCE}'s phase barrier no longer waits on the exact browser message, file name AND file`
  + ` digest (found: ${barrierCall ?? "no call at all"}); anything less can be satisfied by bytes`
  + ` the final comparison would reject`,
);

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} delivery-gate assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `ok: ${ACCEPTANCE} runs in exactly one hosted macOS job, every owning tree `
  + `(${REQUIRED_PATHS.join(", ")}) triggers it, the wire-vector zero-diff gate runs before it, `
  + `neither may skip or be advisory, and the acceptance still proves both role assignments, `
  + `the SAS agreement, a real browser against a real server, and a phase barrier that waits for `
  + `the browser's exact message and file digest before the Mac is driven\n`,
);
