#!/usr/bin/env node
// scripts/test/native-web-pairing-gate-test.mjs — the two delivery gates that
// stand between a cross-client regression and a user, and the handoff between
// the two workflows that now hold them, asserted on every push.
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
// ## Gate 2: the generated wire vectors still match their generator — in compat.yml
//
// `apps/RelayiumKit/Tests/Fixtures/*-wire-vectors.json` are transcriptions of
// the Web implementation that the Swift suites assert against. If the Web wire
// moves and the fixtures are not regenerated, every Swift vector test still
// passes — against the OLD wire — and the two implementations have diverged with
// a green board. `web/scripts/check-wire-vectors.mjs` is the check.
//
// It used to be the first step of the pairing job, and this file used to require
// it to run BEFORE the acceptance. It is now a workflow of its own — `compat.yml`
// — for two reasons the ordering rule could not express:
//
//   * it needs a checkout and Node, not a macOS runner, a Go toolchain, an
//     `npm ci` and a Chrome. Hosting a seconds-long contract check inside a
//     45-minute platform job charges the platform's setup for it;
//   * a path filter is per-WORKFLOW. As a step of the FILTERED pairing workflow
//     the vector gate ran only when the pairing trees changed, so a narrowed
//     filter — or a future `apps/android/**` root with its own workflow — would
//     stop being covered by the cross-language contract without anybody deciding
//     to grant that exemption.
//
// So there is deliberately no "vectors before acceptance" assertion below. They
// are separate workflows now; GitHub starts them concurrently and neither can
// order the other. What replaces it is stronger: the vector command must occur
// EXACTLY ONCE in executable workflow YAML, in `compat.yml` and nowhere else,
// and `compat.yml` must stay unfiltered, cheap and fail-closed. Moving the
// command back into the pairing job — the shape this repository actually had —
// is what section 3 rejects by name.
//
// ## What this file owns, and what ci-event-policy-test.mjs owns
//
// `scripts/test/ci-event-policy-test.mjs` owns the whole CI event policy: every
// governed workflow's push/pull_request/concurrency rules, the platform roots
// and their single owners, compiled-glob path behaviour, and the future
// Android/Windows roots. It is deliberately not duplicated here.
//
// This file owns the HANDOFF: the live acceptance's one hosted macOS home, the
// exact path filter that starts it, and the fact that the cheap half of the same
// cross-language contract has left that job for the always-on gate and stayed
// there intact. Those two halves are one design decision, and this is the file
// that fails when half of it is undone.
//
// ## Why these assertions live here and not in the workflow
//
// Nothing else can see any of it. The YAML is valid with the acceptance step
// deleted, with `web/**` dropped from the path filter, with `apps/**` widened
// back over `apps/ios/**`, with `continue-on-error: true` added, or with
// `npm run test:vectors` pasted back into the macOS job. actionlint is happy in
// every one of those shapes. The only other signal would be a second
// cross-client regression reaching a user — which is the signal this whole task
// exists to stop relying on. So it is asserted here, on every push, by
// `repo-hygiene.yml`, which has no path filter of its own.
//
// ## Why the contract is a function of a workflow world
//
// Sections 1–3 read a `Map` of workflow sources and RETURN their complaints
// rather than pushing them. Section 4 is why: it breaks one property at a time in
// a copy of the real workflows and requires the matching complaint by its own
// wording. A boundary check that cannot fail for the reason it was written is the
// most expensive kind of green.
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

/** The acceptance, the vector gate, the two workflows, and this test's own host. */
const ACCEPTANCE = "scripts/native-web-pairing-acceptance.sh";
const ACCEPTANCE_WORKFLOW = "native-web-pairing.yml";
const COMPAT_WORKFLOW = "compat.yml";
const VECTOR_CHECK = "npm run test:vectors";
/**
 * The forms that REWRITE the tracked fixtures. Neither may appear in any job.
 *
 * Both are matched precisely. A bare `--write` was the previous rule and it is
 * wrong twice over: it is not the writing form of anything on its own, and it
 * appears in unrelated commands — `--write` is prettier's, and any future
 * codegen or formatting step in any workflow would have been reported here as a
 * fixture-rewriting gate. The two real forms are the npm script that passes the
 * flag, and the checker invoked directly with it.
 */
const VECTOR_WRITERS = [
  { label: "npm run gen:vectors", test: (text) => text.includes("gen:vectors") },
  {
    label: "check-wire-vectors.mjs --write",
    test: (text) => /check-wire-vectors\.mjs(?:[^\n]*\s)?--write\b/.test(text),
  },
];
const VECTOR_CHECKER = "web/scripts/check-wire-vectors.mjs";
const GUARD_TEST = "scripts/test/native-web-pairing-gate-test.mjs";

/**
 * The aggregate merge gate, and the caller job id each governed workflow is
 * called under.
 *
 * The pairing workflow and this guard's host both used to carry their own
 * `pull_request:` trigger. They no longer do, and the reason is not tidiness: a
 * path-filtered workflow that does not trigger emits NO check run at all — not
 * a skipped one, not a neutral one — so branch protection could never tell "the
 * acceptance passed" from "the acceptance was legitimately not selected" from
 * "the acceptance never ran". `merge-gate.yml` runs unfiltered on every pull
 * request, CALLS each lane, and reports the one always-present context that can
 * be required.
 *
 * `compat.yml` is deliberately NOT in this list, and what keeps it out narrowed
 * again rather than went away. The gate calls it as an unconditional lane and
 * that call is now its ONLY pull-request entry point — its own `pull_request:`
 * trigger went with protection edit B, which made `merge-gate` the sole
 * required context, so the bare `wire-vectors` it used to report directly is no
 * longer what a pull request is judged against. What this list is FOR is the
 * caller-job-id assertions in section 2b, and compat's own caller shape is
 * owned by `scripts/test/ci-event-policy-test.mjs` — its GOVERNED trigger table
 * and its aggregate roster, in both directions. Restating it here would add a
 * second place to update and no coverage. Section 3c below reads `compat.yml`'s
 * `push` filter, which is the only filtered event it has left, and its `push:
 * main` trigger, which is permanent: `relayium-ops`' `deploy/promote.sh` reads
 * the bare `wire-vectors` check run off a `main` commit before it promotes, and
 * nothing else puts one there.
 */
const AGGREGATE = "merge-gate.yml";
const ACCEPTANCE_GATE_JOB = "native-web-pairing";
const GUARD_HOST_GATE_JOB = "repo-hygiene";

/** Escape a workflow file name for use inside a regular expression. */
const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every tree that is an INPUT to the live acceptance run, and must therefore
 * trigger it. Dropping any one of these from the path filter is the cheapest
 * possible way to disable this gate without deleting anything, so each is
 * asserted by name against `push`, which is the only filtered event this
 * workflow has left. There used to be a second, aliased copy of the list under
 * `pull_request:` and this rule ran against both; the trigger moved into
 * `merge-gate.yml`, and 2b asserts that call instead.
 *
 * The list is deliberately narrow. `apps/**` and `scripts/**` — the shape this
 * filter had — are rejected below: see BARE_GLOBS.
 */
const REQUIRED_PATHS = [
  // The native half that is actually compiled: the acceptance runs
  // `swift build --product LocalTransferPeer` against this package, and the peer
  // binary, the link workspace and the `AppEnvironment` that assembles it all
  // live inside it.
  //
  // `apps/mac/**` is deliberately NOT here. The shipped macOS app is what this
  // acceptance speaks for, but it is not an input to the run: the script builds
  // exactly `server` and `apps/RelayiumKit` and serves the Web bundle, and no
  // file under `apps/mac/` is read, compiled or served by it. The app target is
  // SwiftUI views over `RelayiumAppKit`, which lives in the package below — so
  // the logic this run exercises still triggers it. Watching `apps/mac/**` here
  // would start a 45-minute macOS runner that rebuilds nothing it touched.
  // `NON_INPUT_PATHS` below asserts that, so "not listed" cannot decay into
  // "listed again by whoever finds the omission surprising".
  "apps/RelayiumKit/**",
  // The browser half: the bundle, the e2e harness and the driver.
  "web/**",
  // The hub the two clients meet on: /api/pair, the pairing room, the ws join
  // budget the script paces itself against.
  "server/**",
  // The acceptance itself and the shared isolation library it sources, named ONE
  // FILE AT A TIME rather than by their directory.
  "scripts/native-web-pairing-acceptance.sh",
  "scripts/lib/local-acceptance.sh",
  // The job's own definition, so an edit to it is checked by itself.
  `.github/workflows/${ACCEPTANCE_WORKFLOW}`,
];

/**
 * The two globs this filter is not allowed to go back to.
 *
 * `apps/**` matched `apps/ios/**`, so an iOS-only change started a 45-minute
 * macOS pairing runner that builds nothing it touched, and it matched
 * `apps/README.md`, which is an input to nothing. `scripts/**` matched every Go,
 * release and iOS script in the repository. Both would silently adopt a future
 * `apps/android/**` root or Android script the day it appeared — a cost nobody
 * chose to pay, for evidence the run cannot produce.
 *
 * `ci-event-policy-test.mjs` rejects the same widening as compiled-glob
 * BEHAVIOUR across every governed workflow. This is the literal form, in the one
 * file that explains why this particular filter is the list it is.
 */
const BARE_GLOBS = ["apps/**", "scripts/**"];

/**
 * Trees this filter must NOT name, stated as literal globs for the same reason
 * BARE_GLOBS is: they are the ones a reader greps for.
 *
 * `apps/mac/**` is here on evidence, not on taste. Dependency inspection of
 * `scripts/native-web-pairing-acceptance.sh` finds exactly one build call —
 * `acceptance_build "$repo/server" "$repo/apps/RelayiumKit"`, which resolves to
 * `swift build --product LocalTransferPeer` inside that package — plus a `vite
 * build` of `web/`. Nothing under `apps/mac/` is read, compiled or served. A
 * macOS-app-only change therefore starts `macos.yml` and the two always-on
 * workflows, and adding it back here would buy a 45-minute macOS runner per
 * commit for evidence the run cannot produce.
 *
 * `ci-event-policy-test.mjs` asserts the same thing as compiled-glob behaviour
 * across every governed workflow; this is the literal form, in the file that
 * explains why this particular filter is the list it is.
 */
const NON_INPUT_PATHS = ["apps/mac/**"];

/**
 * The subtree of a listed input that is NOT an input, and the exclusion that
 * says so.
 *
 * `apps/RelayiumKit/**` above is real — the acceptance runs `swift build
 * --product LocalTransferPeer` against this package. Its TEST TARGET is not:
 * `swift build` builds PRODUCTS and never compiles `Tests/`, and this run loads
 * no fixture from `Tests/Fixtures/` — it mints a live pairing code against a
 * real server and drives two live peers, so frozen bytes cannot change its
 * outcome. A test-only edit used to start a 45-minute Swift + Go + Chrome macOS
 * runner that could not observe it: the same non-input cost `apps/mac/**` is
 * excluded for, one directory in. `swift-package.yml` runs those files.
 *
 * ORDER IS LOAD-BEARING, which is why the two are named separately and their
 * positions compared. GitHub evaluates a `paths:` list against each changed file
 * in order and the LAST match wins, so the exclusion has to FOLLOW the positive
 * it qualifies; swapped, it is overridden by that positive and does nothing,
 * while the YAML stays valid and the diff reads as a reordering.
 *
 * This is the LITERAL form, in the file that explains why this particular filter
 * is the list it is — the same division of labour `BARE_GLOBS` and
 * `NON_INPUT_PATHS` already have. The compiled-glob behaviour of this exclusion,
 * in this filter and in `macos.yml`'s and `ios.yml`'s, belongs to
 * `scripts/test/swift-ci-boundary-test.mjs`: a narrowed negation, a re-included
 * fixture directory and the package source that must still trigger are all
 * judged there, against real paths, for all three heavy consumers at once.
 */
const PACKAGE_SOURCE_GLOB = "apps/RelayiumKit/**";
const PACKAGE_TESTS_NEGATION = "!apps/RelayiumKit/Tests/**";

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

// ── minimal, anchor-aware readers for the shapes these workflows use ─────────

/**
 * A workflow with its whole-line comments removed.
 *
 * Every "does this file run X" question below has to be asked of the CODE. Each
 * of these workflows explains itself at length and names the commands it is
 * explaining — `compat.yml` names the writing form of the vector generator in
 * order to forbid it, and the pairing workflow quotes `npm run test:vectors`
 * while explaining that it no longer runs it — so matching raw text would make
 * the test agree with the prose, report a rationale as an invocation, and fail
 * for reasons that are not defects.
 */
const stripComments = (text) =>
  text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

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
 * Anchors are resolved rather than read twice. The governed workflows used to
 * define the list once under `push` with `&paths` and alias it from
 * `pull_request:`, and a reader that only saw the literal list would have
 * reported `pull_request` as unfiltered and passed for the wrong reason. The
 * live files carry the anchor with nothing aliasing it now — but section 4
 * writes an aliased `pull_request:` back onto the pairing workflow to prove the
 * duplicate-trigger rule fires, and that mutated text is read through this
 * function, so alias resolution stays load-bearing rather than vestigial. It
 * used also to be exercised by reading `compat.yml` on both events; that file
 * has one filtered event left, and the mutation is now what keeps this code
 * path honest.
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

/**
 * The branch list of one event in `on:`, or `[]` when it declares none.
 *
 * Only the branches: a `paths:` list lives at the same indentation, and reading
 * it as a branch would make a workflow that gained a path filter look like a
 * workflow that gained a branch.
 */
function branchesOf(workflow, wanted) {
  const lines = onBlock(workflow);
  if (lines === null) return [];
  const branches = [];
  let event = null;
  let collecting = false;
  for (const line of lines) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const eventAt = line.match(/^ {2}([A-Za-z_]+):/);
    if (eventAt) { event = eventAt[1]; collecting = false; continue; }
    if (/^ {4}branches:\s*$/.test(line)) { collecting = event === wanted; continue; }
    if (/^ {4}\S/.test(line)) { collecting = false; continue; }
    const item = collecting && line.match(/^ {6}- ['"]?([^'"\s]+)['"]?\s*$/);
    if (item) branches.push(item[1]);
  }
  return branches;
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

/**
 * The job that runs `marker`, found by the COMMAND rather than by name, so
 * renaming a job is allowed and losing its command is not.
 */
function jobRunning(workflow, marker) {
  const name = jobNames(workflow)
    .find((job) => stripComments((jobLines(workflow, job) ?? []).join("\n")).includes(marker));
  if (name === undefined) return null;
  const lines = jobLines(workflow, name);
  const jobSteps = steps(lines);
  return {
    name,
    text: stripComments(lines.join("\n")),
    steps: jobSteps,
    exec: jobSteps.flatMap((step, stepIndex) =>
      step.code.map((text) => ({ text, step: step.name, stepIndex }))),
  };
}

/**
 * The top-level jobs of `gateSource` whose `uses:` calls `workflow`.
 *
 * By the `uses:` line rather than by the job key, for the same reason
 * `jobRunning` finds a job by its command: renaming a caller is allowed, and
 * losing the call is not. The name is still checked separately, because the
 * caller job id is the check-run prefix.
 */
function gateCallersOf(gateSource, workflow) {
  if (gateSource === undefined) return [];
  const uses = new RegExp(`^ {4}uses:\\s*\\./\\.github/workflows/${reEscape(workflow)}\\s*$`, "m");
  return jobNames(gateSource)
    .filter((job) => uses.test(stripComments((jobLines(gateSource, job) ?? []).join("\n"))));
}

const workflowFiles = (await readdir(workflowsDir)).filter((name) => /\.ya?ml$/.test(name));
const workflows = new Map(
  await Promise.all(
    workflowFiles.map(async (name) => [name, await readFile(resolve(workflowsDir, name), "utf8")]),
  ),
);
const code = new Map(workflowFiles.map((name) => [name, stripComments(workflows.get(name))]));

// ── the handoff contract, as a function of a world of workflows ─────────────
//
// Sections 1, 2 and 3 live in here so section 4 can run them against a mutated
// copy. Returning messages rather than pushing them is the whole design: the
// real world's messages are appended to `failures`, and each mutation must
// produce a specific one.

/** Every handoff complaint about one world, as messages. */
function handoffFailures(sources) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const files = [...sources.keys()].sort();
  const codeOf = (file) => stripComments(sources.get(file) ?? "");

  /** The index of the single executable line in `job` that runs `marker`. */
  const onlyLine = (file, job, marker, label) => {
    const matches = job.exec.filter((line) => line.text.includes(marker));
    if (matches.length !== 1) {
      need(
        false,
        `expected exactly one command in ${file}'s ${job.name} job to run ${label} (${marker});`
        + ` found ${matches.length}`,
      );
      return -1;
    }
    return job.exec.indexOf(matches[0]);
  };

  /**
   * The three one-line ways to keep a gate's command and lose its authority: let
   * the step skip, let it be advisory, or detach the command from its own exit
   * status. None is visible to YAML validity or to actionlint.
   */
  const needUnsoftened = (file, job, index, label) => {
    if (index < 0) return;
    const stepText = job.steps[job.exec[index].stepIndex].code.join("\n");
    need(
      !/^\s{8}if:/m.test(stepText),
      `the ${label} step in ${file} has an "if:"; a gate that can skip itself is not a gate`,
    );
    need(
      !/continue-on-error/.test(stepText),
      `the ${label} step in ${file} sets continue-on-error; its failure must fail the job`,
    );
    need(
      !/\|\|\s*(true|:|echo|exit 0)/.test(job.exec[index].text),
      `the ${label} command in ${file} swallows its own exit status`
      + ` ("${job.exec[index].text.trim()}")`,
    );
  };

  // ── 1. the live acceptance has one hosted home, and it is a macOS job ──────

  const hosting = files.filter((file) => codeOf(file).includes(ACCEPTANCE));
  need(
    hosting.length === 1,
    `expected exactly one workflow to run ${ACCEPTANCE}; found ${hosting.length}`
    + `${hosting.length ? ` (${hosting.join(", ")})` : ""}.`
    + ` It is the only gate that can see two DIFFERENT implementations disagree, so it must`
    + ` exist — and running it twice buys a second macOS runner and no new evidence.`,
  );
  need(
    hosting.includes(ACCEPTANCE_WORKFLOW),
    `${ACCEPTANCE_WORKFLOW} does not run ${ACCEPTANCE}`,
  );

  const pairingWorkflow = sources.get(ACCEPTANCE_WORKFLOW);
  if (pairingWorkflow === undefined) {
    need(false, `.github/workflows/${ACCEPTANCE_WORKFLOW} does not exist`);
  } else {
    const host = jobRunning(pairingWorkflow, ACCEPTANCE);
    need(host !== null, `no job in ${ACCEPTANCE_WORKFLOW} runs ${ACCEPTANCE}`);

    if (host !== null) {
      const runsOn = host.text.match(/^ {4}runs-on:\s*(\S+)/m)?.[1];
      need(
        runsOn !== undefined && /^macos-/.test(runsOn),
        `the ${host.name} job runs on "${runsOn}"; the acceptance builds a Swift product and`
        + ` drives the macOS app's own link workspace, so only a macOS runner can host it`,
      );
      need(
        host.text.includes("timeout-minutes:"),
        `the ${host.name} job declares no timeout-minutes; a wedged pairing round would otherwise`
        + ` hold a macOS runner until the repository default expires`,
      );
      // A job that may skip or may fail advisorily is not a gate. Both are one
      // line to add and invisible to every other check.
      need(
        !/^ {4}if:/m.test(host.text),
        `the ${host.name} job has a job-level "if:"; this acceptance reads no secrets and must`
        + ` run on every triggering event, fork pull requests included`,
      );
      need(
        !/continue-on-error/.test(host.text),
        `the ${host.name} job sets continue-on-error; an advisory cross-client acceptance is`
        + ` indistinguishable from no acceptance`,
      );

      // Deliberately no "the vector gate runs before this" assertion: the vector
      // gate is a separate workflow now, and nothing in this job can order it.
      // Section 3 is what replaces that rule.
      const acceptance = onlyLine(
        ACCEPTANCE_WORKFLOW, host, ACCEPTANCE, "the native-to-browser acceptance",
      );
      needUnsoftened(ACCEPTANCE_WORKFLOW, host, acceptance, "acceptance");
    }
  }

  // ── 2. every owning tree triggers it, and no glob wider than one ──────────

  const pairingTriggers = pairingWorkflow === undefined ? null : triggers(pairingWorkflow);
  need(
    pairingWorkflow === undefined || pairingTriggers !== null,
    `${ACCEPTANCE_WORKFLOW} declares no "on:" block`,
  );
  if (pairingTriggers !== null) {
    // `push` only. This workflow's own `pull_request:` trigger moved into
    // `merge-gate.yml`, which calls it — so `push` is the only filtered event
    // left to judge, and pull-request reachability is a different claim,
    // asserted against the gate in 2b below rather than by looking for a
    // trigger that is correctly absent.
    //
    // Everything inside this loop is unchanged: the same required inputs, the
    // same rejected bare globs, the same non-inputs, the same ordered negation.
    // `push` is restricted to `main`, so this filter is also what re-verifies
    // the merge commit, and `relayium-ops`' `deploy/promote.sh` reads check runs
    // there before it promotes.
    for (const event of ["push"]) {
      if (!pairingTriggers.has(event)) {
        need(false, `${ACCEPTANCE_WORKFLOW} does not run on ${event}`);
        continue;
      }
      const paths = pairingTriggers.get(event);
      // No filter at all is stricter than any list, and therefore fine.
      if (paths === null) continue;
      for (const required of REQUIRED_PATHS) {
        need(
          paths.includes(required),
          `${ACCEPTANCE_WORKFLOW}'s ${event} filter does not cover "${required}", which is a real`
          + ` input to the acceptance run — a change there could break the two clients' agreement`
          + ` and never start this job`,
        );
      }
      for (const bare of BARE_GLOBS) {
        need(
          !paths.includes(bare),
          `${ACCEPTANCE_WORKFLOW}'s ${event} filter lists the bare glob "${bare}". It matches`
          + ` trees that are not inputs to this run today — an iOS-only change, a release script —`
          + ` AND every tree somebody adds tomorrow, so the next platform root starts a 45-minute`
          + ` macOS runner that builds nothing it touched. Name the files this run consumes.`,
        );
      }
      for (const notAnInput of NON_INPUT_PATHS) {
        need(
          !paths.includes(notAnInput),
          `${ACCEPTANCE_WORKFLOW}'s ${event} filter lists "${notAnInput}", which is not an input`
          + ` to this run. The acceptance builds \`server\` and \`apps/RelayiumKit\` and serves the`
          + ` Web bundle; nothing under that tree is read, compiled or served by it, so watching`
          + ` it charges a 45-minute macOS runner per commit for evidence the run cannot produce.`
          + ` The macOS app's logic lives in \`apps/RelayiumKit/**\`, which this filter does name.`,
        );
      }

      // The exclusion that carves the package's test target back out of the
      // input above it: present, and BELOW the positive it qualifies.
      const sourceAt = paths.indexOf(PACKAGE_SOURCE_GLOB);
      const negationAt = paths.indexOf(PACKAGE_TESTS_NEGATION);
      need(
        negationAt !== -1,
        `${ACCEPTANCE_WORKFLOW}'s ${event} filter does not list "${PACKAGE_TESTS_NEGATION}"; it`
        + ` lists [${paths.join(", ")}]. \`swift build --product LocalTransferPeer\` builds`
        + ` PRODUCTS and never compiles the package's test target, and this run loads no fixture`
        + ` from it — so without that entry a test-only edit starts a 45-minute Swift + Go +`
        + ` Chrome macOS runner that cannot observe the change. \`swift-package.yml\` is what runs`
        + ` those files.`,
      );
      need(
        sourceAt === -1 || negationAt === -1 || negationAt > sourceAt,
        `${ACCEPTANCE_WORKFLOW}'s ${event} filter lists "${PACKAGE_TESTS_NEGATION}" at position`
        + ` ${negationAt + 1}, BEFORE "${PACKAGE_SOURCE_GLOB}" at position ${sourceAt + 1}. GitHub`
        + ` applies a \`paths:\` list per changed file in order and the LAST match wins, so in that`
        + ` order the exclusion is overridden by the very pattern it qualifies and does nothing at`
        + ` all. The YAML stays valid, actionlint stays happy, the diff reads as a reordering, and`
        + ` every run the entry removes comes back.`,
      );
    }

    // ── 2b. the acceptance is still reachable from a pull request ───────────
    //
    // `push` above is restricted to `main`, so on a branch this workflow is
    // reached exclusively by `merge-gate.yml` calling it. That is a better
    // arrangement than the aliased `pull_request:` filter it replaced — one
    // always-present required context instead of eight sometimes-present ones —
    // and it is also a new way to lose the only cross-client acceptance in this
    // repository, in three shapes that each leave every file valid and
    // actionlint happy:
    //
    //   * this workflow drops `workflow_call:`, so the gate's `uses:` cannot
    //     resolve. That does not skip one lane; it fails the WHOLE gate run to
    //     LOAD, so the required context reports nothing and the merge box shows
    //     a MISSING check rather than a red one;
    //   * the gate stops calling it. Both files are fine, and a change to
    //     `web/`, `server/` or the package can reach `main` with the two
    //     implementations never once made to talk to each other;
    //   * the gate itself grows a `pull_request` path filter, which re-creates
    //     the absent-check failure one level up and for every lane at once.
    //
    // None is visible to section 2's filter rules, so the gate is read from
    // disk. "The gate covers it" is exactly the assumption this section exists
    // to stop being an assumption.
    const declares = (key) => pairingTriggers.has(key);
    need(
      declares("workflow_call"),
      `${ACCEPTANCE_WORKFLOW} declares no "workflow_call:", so ${AGGREGATE} cannot call it and no`
      + ` pull request runs the acceptance at all — its own \`pull_request\` trigger is gone. It is`
      + ` worse than one missing lane: an unresolvable \`uses:\` fails the entire gate run to load,`
      + ` so the one required context reports nothing rather than red.`,
    );
    need(
      !declares("pull_request"),
      `${ACCEPTANCE_WORKFLOW} declares its own "pull_request:" trigger again. ${AGGREGATE} already`
      + ` calls it, so every commit on a branch with an open pull request runs the acceptance`
      + ` TWICE — once directly, once through the gate — which is two 45-minute macOS runners for`
      + ` one answer.`,
    );

    const gateSource = sources.get(AGGREGATE);
    need(
      gateSource !== undefined,
      `.github/workflows/${AGGREGATE} does not exist, and it is the ONLY way a pull request now`
      + ` reaches ${ACCEPTANCE_WORKFLOW}. Without it the one gate that can see two DIFFERENT`
      + ` implementations disagree runs on \`main\` and nowhere else — after the merge that`
      + ` introduced the disagreement.`,
    );
    if (gateSource !== undefined) {
      const gateTriggers = triggers(gateSource);
      need(
        gateTriggers !== null && gateTriggers.has("pull_request"),
        `${AGGREGATE} declares no "pull_request:" trigger; it is the pull-request entry point`
        + ` every lane here gave up its own trigger for.`,
      );
      const gatePaths = gateTriggers?.get("pull_request") ?? null;
      need(
        gatePaths === null,
        `${AGGREGATE} gained a pull_request path filter ([${(gatePaths ?? []).join(", ")}]). The`
        + ` gate is the one workflow that must start on EVERY pull request: a filtered gate emits`
        + ` no check run for the changes it skips, which is the absent-required-context failure`
        + ` these lanes were converted to avoid, restored one level up and for all of them at once.`,
      );

      const callers = gateCallersOf(gateSource, ACCEPTANCE_WORKFLOW);
      need(
        callers.length === 1,
        `${AGGREGATE} declares ${callers.length} job(s) [${callers.join(", ")}] calling`
        + ` "./.github/workflows/${ACCEPTANCE_WORKFLOW}"; want exactly one. Zero is the live`
        + ` acceptance unreachable from any pull request while its filter still names every tree it`
        + ` consumes — the 1.2.5 defect lands, and the first signal is a user. Two is a second`
        + ` 45-minute macOS runner and no new evidence.`,
      );
      need(
        callers.length !== 1 || callers[0] === ACCEPTANCE_GATE_JOB,
        `${AGGREGATE} calls ${ACCEPTANCE_WORKFLOW} from job "${callers[0]}"; want`
        + ` "${ACCEPTANCE_GATE_JOB}". The caller job id is the check-run prefix, and it is the key`
        + ` the gate's own selector output and \`needs:\` roster are matched against by name.`,
      );
    }
  }

  // ── 3. the cheap half of the same contract lives in compat.yml, intact ────

  // 3a. Once, and only there. Two hosts is the same seconds-long check paid for
  //     twice; a host that is the filtered macOS job is the arrangement the
  //     boundary was created to end.
  const vectorLines = files.flatMap((file) =>
    codeOf(file).split("\n")
      .filter((line) => line.includes(VECTOR_CHECK))
      .map((line) => ({ file, line: line.trim() })));
  need(
    vectorLines.length === 1,
    `"${VECTOR_CHECK}" appears ${vectorLines.length} times in executable workflow YAML`
    + `${vectorLines.length ? ` (${vectorLines.map((v) => `${v.file}: ${v.line}`).join("; ")})` : ""};`
    + ` want exactly once. Zero is the cross-language wire contract silently unchecked — every`
    + ` Swift vector suite would keep passing against the OLD wire. Two is the same seconds-long`
    + ` check paid for twice, and historically one copy sat behind a path filter.`,
  );
  const vectorHosts = [...new Set(vectorLines.map((v) => v.file))].sort();
  need(
    vectorHosts.length === 1 && vectorHosts[0] === COMPAT_WORKFLOW,
    `"${VECTOR_CHECK}" runs in [${vectorHosts.join(", ")}]; want exactly [${COMPAT_WORKFLOW}],`
    + ` the always-on gate with no path filter at all`,
  );
  need(
    pairingWorkflow === undefined || !codeOf(ACCEPTANCE_WORKFLOW).includes(VECTOR_CHECK),
    `${ACCEPTANCE_WORKFLOW} runs "${VECTOR_CHECK}" again. That is exactly the shape the platform`
    + ` boundary removed: a contract check that judges every implementation, hosted inside ONE`
    + ` platform's filtered 45-minute job, so it runs only when that platform's trees change and a`
    + ` second platform bypasses it by existing. It belongs in ${COMPAT_WORKFLOW}.`,
  );

  // 3b. The verifying form only, anywhere. `gen:vectors` rewrites the tracked
  //     fixtures, which in CI would turn the gate into a machine that agrees
  //     with whatever it just produced. `compat.yml`'s own header promises that
  //     this file asserts it.
  const writers = files
    .flatMap((file) => VECTOR_WRITERS
      .filter((form) => form.test(codeOf(file)))
      .map((form) => `${file} (${form.label})`));
  need(
    writers.length === 0,
    `[${writers.join(", ")}] run the WRITING form of the vector generator`
    + ` (${VECTOR_WRITERS.map((form) => form.label).join(" / ")}); CI must verify the tracked`
    + ` bytes, never regenerate them`,
  );

  // 3c. And the gate it landed in is still a gate: unfiltered, cheap, finite,
  //     fail-closed. Every one of these is one line to add and leaves the YAML
  //     valid; each turns the always-required check into an optional one.
  //
  //     "Always-required" is a property of the workflow FILE and that is all
  //     this section can assert: compat.yml runs on every triggering event and
  //     reports red when the contract breaks. Whether a red result BLOCKS a
  //     merge is GitHub branch-protection configuration on `main`, which lives
  //     in repository settings, not in this repository's source, and is not
  //     asserted anywhere here. That protection now requires the top-level
  //     `merge-gate` and nothing else, after protection edit B removed the bare
  //     `wire-vectors`. The CALLED run's context, `compat / wire-vectors`, is
  //     not itself a required context either: it reaches the merge button only
  //     through the aggregate, which judges the `compat` lane's result. The
  //     bare `wire-vectors` still matters off the merge button — it is the
  //     check run `relayium-ops`' `deploy/promote.sh` reads on a `main` commit,
  //     which is why `push: main` is asserted below and is permanent.
  //     Nothing below should be read as evidence that any of it is configured.
  const compatWorkflow = sources.get(COMPAT_WORKFLOW);
  if (compatWorkflow === undefined) {
    need(
      false,
      `.github/workflows/${COMPAT_WORKFLOW} does not exist, and it is the only home left for`
      + ` "${VECTOR_CHECK}" — the check every platform, present and future, has to pass`,
    );
  } else {
    const compatTriggers = triggers(compatWorkflow);
    need(compatTriggers !== null, `${COMPAT_WORKFLOW} declares no "on:" block`);
    if (compatTriggers !== null) {
      // `push` only, and that is the permanent shape rather than a narrowing of
      // this check. This file's own `pull_request:` trigger is gone: a pull
      // request reaches the contract through `${AGGREGATE}`'s unconditional
      // `compat` lane, and the gate carries no path filter of its own — section
      // 2b already reads that off disk. `push` is the one filtered event left
      // here, and the filter it must not have is asserted on it.
      for (const event of ["push"]) {
        if (!compatTriggers.has(event)) {
          need(
            false,
            `${COMPAT_WORKFLOW} does not run on ${event}; a \`main\` commit would carry no`
            + ` \`wire-vectors\` check run, and \`relayium-ops\`' \`deploy/promote.sh\` refuses to`
            + ` promote without one — production promotion wedges rather than a pull request`
            + ` failing`,
          );
          continue;
        }
        const paths = compatTriggers.get(event);
        need(
          paths === null,
          `${COMPAT_WORKFLOW} gained a ${event} path filter ([${(paths ?? []).join(", ")}]).`
          + ` It must have none: a filter is precisely how a narrowed tree or a new platform root`
          + ` stops being covered by the cross-language contract without anybody deciding to`
          + ` exempt it. Always-required means always-run.`,
        );
      }
    }
    const compatBranches = branchesOf(compatWorkflow, "push");
    need(
      compatBranches.length === 1 && compatBranches[0] === "main",
      `${COMPAT_WORKFLOW}'s push trigger runs on [${compatBranches.join(", ")}]; want exactly`
      + ` [main]. A branch push plus its own pull request is two identical runs of one commit,`
      + ` and dropping \`main\` leaves the branch nothing re-verifies after a merge.`,
    );

    const gate = jobRunning(compatWorkflow, VECTOR_CHECK);
    need(gate !== null, `no job in ${COMPAT_WORKFLOW} runs "${VECTOR_CHECK}"`);
    if (gate !== null) {
      const runsOn = gate.text.match(/^ {4}runs-on:\s*(\S+)/m)?.[1];
      need(
        runsOn === "ubuntu-latest",
        `${COMPAT_WORKFLOW}'s ${gate.name} job runs on "${runsOn}"; the always-on gate must stay`
        + ` on ubuntu-latest. A macOS or Windows runner turns a seconds-long contract check into`
        + ` a platform build charged on every commit, and the first response to that bill is the`
        + ` path filter this gate must never have.`,
      );
      const timeout = gate.text.match(/^ {4}timeout-minutes:\s*(\S+)/m)?.[1];
      need(
        Number.isFinite(Number(timeout)) && Number(timeout) > 0,
        `${COMPAT_WORKFLOW}'s ${gate.name} job declares no finite timeout-minutes (found`
        + ` ${JSON.stringify(timeout)}); an unbounded always-on job holds a runner for GitHub's`
        + ` six-hour default on every single commit`,
      );
      need(
        !/^ {4}if:/m.test(gate.text),
        `${COMPAT_WORKFLOW}'s ${gate.name} job has a job-level "if:"; it reads no secrets and must`
        + ` run on every triggering event, fork pull requests included`,
      );
      need(
        !/continue-on-error/.test(gate.text),
        `${COMPAT_WORKFLOW}'s ${gate.name} job sets continue-on-error; an advisory compatibility`
        + ` gate is indistinguishable from no compatibility gate`,
      );
      need(
        !/retry|retries/i.test(gate.text),
        `${COMPAT_WORKFLOW}'s ${gate.name} job retries. This gate compares frozen bytes against`
        + ` their generator; there is nothing intermittent for a retry to smooth over, so a retry`
        + ` here only reports the roll that agreed rather than the code.`,
      );

      // The command has to remain a command: one executable line, inside a step
      // of this job, not swallowed and not skippable.
      const vectors = onlyLine(
        COMPAT_WORKFLOW, gate, VECTOR_CHECK, "the wire-vector zero-diff gate",
      );
      needUnsoftened(COMPAT_WORKFLOW, gate, vectors, "wire-vector gate");
    }
  }

  return out;
}

for (const message of handoffFailures(new Map(workflows))) failures.push(message);

// ── 4. the proof that sections 1–3 can fail ─────────────────────────────────
//
// Each case below breaks ONE property in a copy of the real workflows and
// requires the matching complaint by its own wording — not merely "something
// failed", which a mis-read file or an unrelated typo would also satisfy.
//
// The shapes named here are the ones this repository has actually had or would
// plausibly return to: the vector command back inside the filtered macOS job, a
// second copy of it, a path filter on the always-on gate, the bare `apps/**` and
// `scripts/**` globs, `apps/mac/**` re-adopted into a run that does not read it,
// a compat job that may skip, may be advisory or may be re-rolled until it
// agrees, and either writing form of the vector generator reaching CI.
//
// One case carries `refute` instead of `expect`: an unrelated `--write` step,
// which must NOT be reported as a fixture-rewriting gate. False complaints cost
// what missing ones do, one step later — they are what gets a contract widened
// until it says nothing.

/** A copy of the real workflow sources for one mutation to break. */
const realSources = () => new Map(workflows);

/**
 * Replace the first occurrence of `from` in one workflow.
 *
 * Throwing when the anchor is gone is deliberate: a mutation that silently
 * stopped applying would leave the world unbroken and this section would be
 * asserting nothing, which is the exact failure it exists to prevent.
 */
function withText(sources, file, from, to) {
  const text = sources.get(file);
  if (text === undefined) throw new Error(`${file} is not in the world`);
  if (!text.includes(from)) throw new Error(`anchor not found in ${file}: ${JSON.stringify(from)}`);
  sources.set(file, text.replace(from, to));
  return sources;
}

const MUTATIONS = [
  {
    name: "the vector gate moves back into the filtered macOS pairing job",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "      - name: Install web dependencies\n",
      "      - name: Regenerate the cross-language wire vectors and require zero diff\n"
      + "        working-directory: web\n"
      + "        run: npm run test:vectors\n"
      + "      - name: Install web dependencies\n",
    ),
    expect: /native-web-pairing\.yml runs "npm run test:vectors" again/,
  },
  {
    name: "the vector gate is duplicated inside compat.yml",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW,
      "        run: npm run test:vectors",
      "        run: npm run test:vectors\n"
      + "      - name: And once more, for luck\n"
      + "        working-directory: web\n"
      + "        run: npm run test:vectors",
    ),
    expect: /appears 2 times in executable workflow YAML/,
  },
  {
    name: "compat.yml gains a push path filter",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW,
      "    branches:\n      - main\n",
      "    branches:\n      - main\n    paths:\n      - 'web/**'\n",
    ),
    expect: /compat\.yml gained a push path filter/,
  },
  // The `pull_request` counterpart of the case above is gone with the trigger
  // it filtered. `compat.yml` has one filtered event left, so there is no second
  // filter here to narrow — and whether the direct trigger may return at all is
  // `scripts/test/ci-event-policy-test.mjs`'s rule, mutated there rather than
  // restated here. Leaving the case in place would have meant a mutation whose
  // anchor no longer exists, which `withText` correctly throws on.
  {
    name: "the pairing filter is widened back to the bare `apps/**`",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "      - 'apps/RelayiumKit/**'\n",
      "      - 'apps/**'\n",
    ),
    expect: /native-web-pairing\.yml's push filter lists the bare glob "apps\/\*\*"/,
  },
  {
    name: "the pairing filter re-adopts `apps/mac/**`, which the run does not read",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "      - 'apps/RelayiumKit/**'\n",
      "      - 'apps/mac/**'\n      - 'apps/RelayiumKit/**'\n",
    ),
    expect: /push filter lists "apps\/mac\/\*\*", which is not an input to this run/,
  },
  {
    name: "the pairing filter is widened back to the bare `scripts/**`",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "      - 'scripts/native-web-pairing-acceptance.sh'\n"
      + "      - 'scripts/lib/local-acceptance.sh'\n",
      "      - 'scripts/**'\n",
    ),
    expect: /native-web-pairing\.yml's push filter lists the bare glob "scripts\/\*\*"/,
  },
  {
    name: "the pairing filter stops naming the shared isolation library",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW, "      - 'scripts/lib/local-acceptance.sh'\n", "",
    ),
    expect: /filter does not cover "scripts\/lib\/local-acceptance\.sh"/,
  },
  {
    name: "the compat gate becomes advisory",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW,
      "  wire-vectors:\n    runs-on:",
      "  wire-vectors:\n    continue-on-error: true\n    runs-on:",
    ),
    expect: /compat\.yml's wire-vectors job sets continue-on-error/,
  },
  {
    name: "the compat gate is allowed to skip itself",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW,
      "  wire-vectors:\n    runs-on:",
      "  wire-vectors:\n    if: github.event_name == 'push'\n    runs-on:",
    ),
    expect: /compat\.yml's wire-vectors job has a job-level "if:"/,
  },
  {
    name: "the compat gate is re-rolled until it agrees",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW,
      "      - name: Regenerate the cross-language wire vectors",
      "      - name: Retry the flaky vector check\n"
      + "        uses: nick-fields/retry@ce71cc2ab81d554ebbe88c79ab5975992d79ba08 # v3.0.2\n"
      + "      - name: Regenerate the cross-language wire vectors",
    ),
    expect: /compat\.yml's wire-vectors job retries/,
  },
  {
    name: "the compat gate's command swallows its own exit status",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW, "run: npm run test:vectors", "run: npm run test:vectors || true",
    ),
    expect: /the wire-vector gate command in compat\.yml swallows its own exit status/,
  },
  {
    name: "the compat gate moves onto a macOS runner",
    mutate: (s) => withText(s, COMPAT_WORKFLOW, "    runs-on: ubuntu-latest", "    runs-on: macos-15"),
    expect: /compat\.yml's wire-vectors job runs on "macos-15"/,
  },
  {
    name: "the compat gate loses its bound",
    mutate: (s) => withText(s, COMPAT_WORKFLOW, "    timeout-minutes: 10\n", ""),
    expect: /compat\.yml's wire-vectors job declares no finite timeout-minutes/,
  },
  {
    name: "the compat gate starts REGENERATING the fixtures it checks",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW, "run: npm run test:vectors", "run: npm run gen:vectors",
    ),
    expect: /compat\.yml \(npm run gen:vectors\)/,
  },
  {
    name: "the compat gate calls the checker directly with --write",
    mutate: (s) => withText(
      s, COMPAT_WORKFLOW,
      "run: npm run test:vectors", "run: node scripts/check-wire-vectors.mjs --write",
    ),
    expect: /compat\.yml \(check-wire-vectors\.mjs --write\)/,
  },
  // The other direction, and the reason the two forms above are matched
  // precisely rather than by a bare `--write`: that flag belongs to prettier,
  // to formatters and to any future codegen step, and a workflow that gains one
  // is not a workflow that regenerates the tracked wire fixtures. Reported as a
  // fixture-rewriting gate, it would be a failure nobody could act on, in a file
  // whose whole authority is that its complaints are true.
  {
    name: "an unrelated step uses --write, and is NOT a vector writer",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "      - name: Install web dependencies\n        working-directory: web\n        run: npm ci\n",
      "      - name: Install web dependencies\n        working-directory: web\n        run: npm ci\n"
      + "      - name: Format the bundle sources\n        working-directory: web\n"
      + "        run: npx prettier --write src\n",
    ),
    refute: /run the WRITING form of the vector generator/,
  },

  // ── reachability from a pull request, now the gate's job (2b) ────────────
  //
  // This workflow's `push:` trigger is restricted to `main`, so on a branch the
  // acceptance is reached only by `merge-gate.yml` calling it. Each case below
  // breaks one link in that chain and leaves every file valid.
  {
    // The direct trigger, restored beside the call: two 45-minute macOS runners
    // for every commit on a branch with an open pull request, one answer.
    name: "the pairing workflow takes its own pull_request trigger back",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "  workflow_call:\n  workflow_dispatch:",
      "  pull_request:\n    paths: *paths\n  workflow_call:\n  workflow_dispatch:",
    ),
    expect: /native-web-pairing\.yml declares its own "pull_request:" trigger again/,
  },
  {
    // The opposite edit, and the one that takes the whole board with it: the
    // gate's `uses:` stops resolving, the entire run fails to LOAD, and the one
    // required context reports nothing rather than red.
    name: "the pairing workflow drops workflow_call, so the gate's uses: cannot resolve",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW, "  workflow_call:\n  workflow_dispatch:", "  workflow_dispatch:",
    ),
    expect: /native-web-pairing\.yml declares no "workflow_call:"/,
  },
  {
    // Both files stay valid and the acceptance simply stops being reachable from
    // a pull request. The quiet one: the filter still names every tree the run
    // consumes, and the 1.2.5 defect lands with a user as the first signal.
    name: "merge-gate stops calling the pairing lane",
    mutate: (s) => withText(
      s, AGGREGATE,
      "\n  native-web-pairing:\n    needs: select\n"
      + "    if: needs.select.outputs['native-web-pairing'] == 'true'\n"
      + "    uses: ./.github/workflows/native-web-pairing.yml\n",
      "\n",
    ),
    expect: /merge-gate\.yml declares 0 job\(s\) \[\] calling "\.\/\.github\/workflows\/native-web-pairing\.yml"/,
  },
  {
    // Still called, from a job id the gate's own selector output and `needs:`
    // roster do not name. The caller id is the check-run prefix.
    name: "merge-gate calls the pairing lane under a different job id",
    mutate: (s) => withText(
      s, AGGREGATE, "\n  native-web-pairing:\n    needs: select\n", "\n  pairing:\n    needs: select\n",
    ),
    expect: /merge-gate\.yml calls native-web-pairing\.yml from job "pairing"; want "native-web-pairing"/,
  },
  {
    // The gate itself filtered: it emits no check run for the pull requests it
    // skips, which is the absent-required-context failure these lanes were
    // converted to avoid — reintroduced one level up, for every lane at once.
    name: "the merge gate's pull_request trigger grows a path filter",
    mutate: (s) => withText(
      s, AGGREGATE,
      "  pull_request:\n",
      "  pull_request:\n    paths:\n      - 'web/**'\n",
    ),
    expect: /merge-gate\.yml gained a pull_request path filter/,
  },

  // ── the package's test target, carved back out of a real input ────────────
  //
  // Only the two LITERAL shapes, because only the literal form is this file's
  // half: a narrowed negation, a re-included fixture directory and the package
  // source that must still trigger are compiled-glob behaviour, and
  // `scripts/test/swift-ci-boundary-test.mjs` mutates all of those against all
  // three heavy consumers at once.
  {
    // The exclusion deleted. Cheap, invisible in a merge box, and it puts a
    // 45-minute macOS runner back on every XCTest case added to a package this
    // run compiles the products of.
    name: "the !apps/RelayiumKit/Tests/** exclusion is deleted from the filter",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "      - 'apps/RelayiumKit/**'\n      - '!apps/RelayiumKit/Tests/**'\n",
      "      - 'apps/RelayiumKit/**'\n",
    ),
    expect: /filter does not list "!apps\/RelayiumKit\/Tests\/\*\*"/,
  },
  {
    // The same two lines, swapped: under last-match-wins the exclusion is
    // overridden by the pattern it qualifies and does nothing, while every
    // membership check still passes.
    name: "the exclusion is moved ABOVE the positive it qualifies",
    mutate: (s) => withText(
      s, ACCEPTANCE_WORKFLOW,
      "      - 'apps/RelayiumKit/**'\n      - '!apps/RelayiumKit/Tests/**'\n",
      "      - '!apps/RelayiumKit/Tests/**'\n      - 'apps/RelayiumKit/**'\n",
    ),
    expect: /lists "!apps\/RelayiumKit\/Tests\/\*\*" at position 1, BEFORE/,
  },
];

for (const { name, mutate, expect, refute } of MUTATIONS) {
  let got;
  try {
    got = handoffFailures(mutate(realSources()));
  } catch (err) {
    check(false, `the handoff mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  const rendered = got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`;
  if (expect) {
    check(
      got.some((message) => expect.test(message)),
      `the pairing/compat handoff contract did NOT complain about "${name}". Expected a message`
      + ` matching ${expect}; got ${rendered}.`
      + ` A check that cannot fail for the reason it was written is not a check, and this one would`
      + ` report green while the boundary it names is already gone.`,
    );
  }
  // A `refute` case is the opposite obligation, and it is not decoration: a
  // contract that complains about shapes which are actually fine trains people
  // to widen it until it complains about nothing.
  if (refute) {
    check(
      !got.some((message) => refute.test(message)),
      `the pairing/compat handoff contract complained about "${name}", which is a legitimate`
      + ` shape. Expected NO message matching ${refute}; got ${rendered}.`,
    );
  }
}

// ── 5. this guard itself runs on every push ─────────────────────────────────

const guardHosts = workflowFiles.filter((name) => code.get(name).includes(GUARD_TEST));
check(
  guardHosts.length >= 1,
  `no workflow runs ${GUARD_TEST}; these assertions only hold if something executes them`,
);
for (const name of guardHosts) {
  const events = triggers(workflows.get(name));
  if (events === null) continue;

  // `push` is the only filtered event this host has left, and it is now the ONLY
  // thing that puts a check run on the `main` commit — `merge-gate.yml` runs on
  // `pull_request` only, and `relayium-ops`' `deploy/promote.sh` reads check runs
  // on `main` before it promotes. A host that lost this does not fail visibly
  // here; it wedges production promotion with `required check absent`.
  if (!events.has("push")) {
    check(false, `${name} runs ${GUARD_TEST} but not on push`);
  } else {
    check(
      events.get("push") === null,
      `${name} runs ${GUARD_TEST} behind a push path filter; it guards`
      + ` .github/workflows/, web/package.json and the acceptance script, so it must run on`
      + ` every push, exactly as macos-publish-order-test.mjs does`,
    );
    const branches = branchesOf(workflows.get(name), "push");
    check(
      branches.length === 1 && branches[0] === "main",
      `${name}'s push trigger runs on [${branches.join(", ")}]; want exactly [main]. Branch work`
      + ` reaches this host through ${AGGREGATE} now, so a branch push here is a second identical`
      + ` run of the same tree — and dropping \`main\` leaves nothing re-verifying the merge commit`
      + ` these guards are read from.`,
    );
  }

  // And pull requests, which this host no longer triggers on itself. The old
  // form of this check asked whether a `pull_request:` trigger had grown a path
  // filter; with the trigger gone that question answers "no" for the wrong
  // reason, and would have reported green with the host unreachable from a pull
  // request entirely. "No path filter" and "called with no condition" are the
  // same property stated at the two levels that now exist, so both are checked.
  check(
    events.has("workflow_call"),
    `${name} runs ${GUARD_TEST} but declares no "workflow_call:", so ${AGGREGATE} cannot call it`
    + ` and branch work reaches \`main\` without these assertions ever being executed. An`
    + ` unresolvable \`uses:\` also fails the whole gate run to load, so the required context`
    + ` reports nothing at all.`,
  );
  check(
    !events.has("pull_request"),
    `${name} runs ${GUARD_TEST} and declares its own "pull_request:" trigger again. ${AGGREGATE}`
    + ` already calls it unconditionally, so every commit on a branch with an open pull request`
    + ` runs all of this host's jobs twice for one answer.`,
  );

  const gateSource = workflows.get(AGGREGATE);
  check(
    gateSource !== undefined,
    `.github/workflows/${AGGREGATE} does not exist, and it is what runs ${GUARD_TEST} on a pull`
    + ` request now that ${name} has no \`pull_request\` trigger of its own`,
  );
  if (gateSource === undefined) continue;
  const callers = gateCallersOf(gateSource, name);
  check(
    callers.length === 1,
    `${AGGREGATE} declares ${callers.length} job(s) [${callers.join(", ")}] calling`
    + ` "./.github/workflows/${name}"; want exactly one. Zero is ${GUARD_TEST} — and every other`
    + ` cross-cutting guard hosted there — not running on any pull request, while the filtered`
    + ` lanes keep reporting green.`,
  );
  check(
    callers.length !== 1 || callers[0] === GUARD_HOST_GATE_JOB,
    `${AGGREGATE} calls ${name} from job "${callers[0]}"; want "${GUARD_HOST_GATE_JOB}"`,
  );
  for (const caller of callers) {
    const callerText = stripComments((jobLines(gateSource, caller) ?? []).join("\n"));
    check(
      !/^ {4}if:/m.test(callerText),
      `${AGGREGATE}/${caller} has a job-level "if:". This is the lane the gate must call with NO`
      + ` condition: it hosts the checks every change has to pass, and a condition here is the same`
      + ` hole a path filter on ${name} would be — reached by whichever pull requests the`
      + ` expression happens to select, and by no others.`,
    );
  }
}

// ── 6. the vector gate is wired end to end ──────────────────────────────────
//
// Two halves: the command exists and is wired to a documented script (below),
// and the table that command iterates still names the registrations CI depends
// on (6a/6b). The second half is what stops the gate from shrinking one array
// line at a time while every assertion above stays green.

check(
  existsSync(resolve(repoRoot, VECTOR_CHECKER)),
  `${VECTOR_CHECKER} does not exist, but ${COMPAT_WORKFLOW} runs "${VECTOR_CHECK}"`,
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

/**
 * The registrations that must survive inside `check-wire-vectors.mjs`'s table.
 *
 * Not every fixture in that table is listed here, and that is on purpose: this
 * is the floor, not an inventory. Each entry is a contract whose ONLY
 * enforcement is that the checker still names it, so dropping one line from a
 * JavaScript array would otherwise reduce what CI covers with nothing turning
 * red anywhere. `store-wire-vectors.json` and `crypto-vectors.json` are checked
 * by the same shape as everything else; these two have a reason to be pinned by
 * name here.
 *
 * `headerMustName` exists for the hybrid fixture only. That file is partly
 * hand-authored, so it carries a header telling the next editor which fields are
 * theirs and which are the generator's. A header that fell out of date — the
 * "hand-authored, not generated" text it used to carry — is an instruction to do
 * the exact thing the gate now rejects, so the header is required to name its
 * generator.
 */
const REQUIRED_VECTORS = [
  {
    generator: "web/scripts/gen-realtime-wire-vectors.mjs",
    fixture: "apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json",
    why: "the realtime wire vectors are the cross-language contract this gate exists for"
      + " — the delivery blocker that caused it named this fixture",
  },
  {
    generator: "web/scripts/gen-device-inbox-manifest-vectors.mjs",
    fixture: "apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json",
    headerMustName: "gen-device-inbox-manifest-vectors.mjs",
    why: "the Device Inbox v3 manifest is asserted by Go, TypeScript AND Swift against those"
      + " frozen `canonical` strings rather than re-derived, so an unregenerated or hand-edited"
      + " canonical byte string is not a red test — it is a wrong contract all three"
      + " implementations are then required to match, and the three of them agreeing is exactly"
      + " what everyone reads as proof",
  },
];

/**
 * A JavaScript source with its whole-line `//` comments removed.
 *
 * Same reason `stripComments` exists for the workflows, and it matters more
 * here: `check-wire-vectors.mjs` explains at length why each fixture is in its
 * table, and that prose NAMES every generator and every fixture path. Matching
 * raw text would let the table entry be deleted while the paragraph explaining
 * it survives — and the paragraph is the part nobody deletes.
 */
const stripJsComments = (text) =>
  text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");

/**
 * `Map<path, string>` -> complaints. Pure, so section 6b can break it on a copy.
 */
function registrationFailures(texts) {
  const out = [];
  const checker = texts.get(VECTOR_CHECKER);
  if (checker === undefined) {
    out.push(`${VECTOR_CHECKER} does not exist, but ${COMPAT_WORKFLOW} runs "${VECTOR_CHECK}"`);
    return out;
  }
  const code = stripJsComments(checker);
  for (const entry of REQUIRED_VECTORS) {
    // The table stores generator paths relative to `web/`, because that is the
    // working directory it runs them in.
    const inTable = entry.generator.replace(/^web\//, "");
    for (const [named, kind] of [[inTable, "generator"], [entry.fixture, "fixture"]]) {
      if (!code.includes(named)) {
        out.push(
          `${VECTOR_CHECKER}'s VECTORS table no longer names the ${kind} "${named}" in CODE`
          + ` (a mention in a comment does not count): ${entry.why}`,
        );
      }
    }
    if (!existsSync(resolve(repoRoot, entry.generator))) {
      out.push(`${entry.generator} does not exist, but ${VECTOR_CHECKER} is required to run it`);
    }
    if (!existsSync(resolve(repoRoot, entry.fixture))) {
      out.push(`${entry.fixture} does not exist, but the vector gate is required to reproduce it`);
    }
    if (entry.headerMustName === undefined) continue;
    const header = texts.get(entry.fixture);
    if (header !== undefined && !header.includes(entry.headerMustName)) {
      out.push(
        `${entry.fixture}'s "_" header no longer names "${entry.headerMustName}". That header is`
        + ` the only thing telling the next editor which fields are the generator's; one that`
        + ` still reads "hand-authored, not generated" instructs them to hand-edit the derived`
        + ` bytes, which is the edit the zero-diff gate rejects`,
      );
    }
  }
  return out;
}

/** The real sources these assertions are about, read once and reused by 6b. */
const registrationSources = new Map();
for (const path of [VECTOR_CHECKER, ...REQUIRED_VECTORS.map((entry) => entry.fixture)]) {
  const full = resolve(repoRoot, path);
  if (existsSync(full)) registrationSources.set(path, await readFile(full, "utf8"));
}
for (const message of registrationFailures(registrationSources)) failures.push(message);

// ── 6b. the proof that section 6 can fail ───────────────────────────────────
//
// Section 6 is a list of strings that must appear in another file, which is the
// single easiest kind of assertion to write in a way that can never fail — a
// typo'd path, a match against prose that always contains the name, a table read
// from the wrong file. Each case below deletes ONE registration and requires the
// complaint that names it.
//
// The third case is the one that motivated 6b: the checker's own header prose
// names every generator and fixture in the table, so a version of section 6 that
// matched raw text would report a commented-out registration as present.

const REGISTRATION_MUTATIONS = [
  {
    name: "the device-inbox v3 generator is dropped from the checker's table",
    mutate: (texts) => withText(
      texts, VECTOR_CHECKER,
      '    generator: "scripts/gen-device-inbox-manifest-vectors.mjs",\n', "",
    ),
    expect: /no longer names the generator "scripts\/gen-device-inbox-manifest-vectors\.mjs" in CODE/,
  },
  {
    name: "the device-inbox v3 fixture is dropped from the checker's table",
    mutate: (texts) => withText(
      texts, VECTOR_CHECKER,
      '    fixture: "apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json",\n', "",
    ),
    expect: /no longer names the fixture "apps\/RelayiumKit\/Tests\/Fixtures\/device-inbox-manifest-v3-vectors\.json" in CODE/,
  },
  {
    name: "the device-inbox v3 registration is commented out, leaving the prose that names it",
    mutate: (texts) => withText(
      texts, VECTOR_CHECKER,
      '    generator: "scripts/gen-device-inbox-manifest-vectors.mjs",\n'
      + '    fixture: "apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json",\n',
      '    // generator: "scripts/gen-device-inbox-manifest-vectors.mjs",\n'
      + '    // fixture: "apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json",\n',
    ),
    expect: /a mention in a comment does not count/,
  },
  {
    name: "the realtime registration is dropped from the checker's table",
    mutate: (texts) => withText(
      texts, VECTOR_CHECKER,
      '    generator: "scripts/gen-realtime-wire-vectors.mjs",\n', "",
    ),
    expect: /no longer names the generator "scripts\/gen-realtime-wire-vectors\.mjs" in CODE/,
  },
  {
    name: "the hybrid fixture's header reverts to claiming it is hand-authored",
    mutate: (texts) => withText(
      texts, "apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json",
      "gen-device-inbox-manifest-vectors.mjs", "a human, carefully",
    ),
    expect: /"_" header no longer names "gen-device-inbox-manifest-vectors\.mjs"/,
  },
  // And the other direction, for the same reason the workflow section carries a
  // `refute` case: a fixture that IS registered must not be reported merely
  // because an unrelated table entry moved around it.
  {
    name: "an unrelated fourth entry is added to the table, and nothing is missing",
    mutate: (texts) => withText(
      texts, VECTOR_CHECKER,
      "const VECTORS = [\n",
      "const VECTORS = [\n  {\n"
      + '    generator: "scripts/gen-something-else.mjs",\n'
      + '    fixture: "apps/RelayiumKit/Tests/Fixtures/something-else.json",\n  },\n',
    ),
    refute: /no longer names the/,
  },
];

for (const { name, mutate, expect, refute } of REGISTRATION_MUTATIONS) {
  let got;
  try {
    got = registrationFailures(mutate(new Map(registrationSources)));
  } catch (err) {
    check(false, `the registration mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  const rendered = got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`;
  if (expect) {
    check(
      got.some((message) => expect.test(message)),
      `the vector-registration policy did NOT complain about "${name}". Expected a message`
      + ` matching ${expect}; got ${rendered}. A registration list that cannot fail is a`
      + ` registration list that quietly shrinks.`,
    );
  }
  if (refute) {
    check(
      !got.some((message) => refute.test(message)),
      `the vector-registration policy complained about "${name}", which is a legitimate shape.`
      + ` Expected NO message matching ${refute}; got ${rendered}.`,
    );
  }
}

// ── 7. the acceptance is still the real thing ───────────────────────────────
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

// ── 8. the phase barrier is a barrier ───────────────────────────────────────
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
  `ok: ${ACCEPTANCE} runs in exactly one hosted macOS job, every input tree `
  + `(${REQUIRED_PATHS.join(", ")}) triggers it, no bare ${BARE_GLOBS.join(" / ")} does and `
  + `neither does ${NON_INPUT_PATHS.join(" / ")} — which the run never reads, compiles or `
  + `serves — \`${PACKAGE_TESTS_NEGATION}\` follows \`${PACKAGE_SOURCE_GLOB}\` so the package's `
  + `test target does not either (its compiled-glob behaviour is `
  + `scripts/test/swift-ci-boundary-test.mjs's), a pull request reaches that job only through `
  + `${AGGREGATE} — whose unfiltered \`pull_request\` trigger and single `
  + `${ACCEPTANCE_GATE_JOB} caller job are read from disk, as is its unconditional `
  + `${GUARD_HOST_GATE_JOB} call that runs this guard — "${VECTOR_CHECK}" runs exactly once and `
  + `only in `
  + `${COMPAT_WORKFLOW} — unfiltered on `
  + `push/main, its only filtered event now that ${AGGREGATE} is its sole pull-request entry `
  + `point, on ubuntu-latest, finite, fail-closed in workflow code (whether it BLOCKS a merge is `
  + `branch protection on \`main\`, which requires \`merge-gate\` alone — the called `
  + `\`compat / wire-vectors\` is consumed by the aggregate and is not itself a required `
  + `context, while the bare \`wire-vectors\` remains the check run production promotion reads `
  + `off a \`main\` commit — none of which is asserted here) and in `
  + `the verifying form — neither gate may skip or be advisory, `
  + `${MUTATIONS.length} mutations prove each of those can fail (and one that a legitimate `
  + `\`--write\` step is not reported), and the acceptance still proves both role assignments, `
  + `the SAS agreement, a real browser against a real server, and a phase barrier that waits for `
  + `the browser's exact message and file digest before the Mac is driven, and `
  + `${REQUIRED_VECTORS.length} vector registration(s) `
  + `(${REQUIRED_VECTORS.map((entry) => entry.fixture).join(", ")}) are still named in `
  + `${VECTOR_CHECKER}'s table in code rather than in prose, which `
  + `${REGISTRATION_MUTATIONS.length} further mutations prove can fail\n`,
);
